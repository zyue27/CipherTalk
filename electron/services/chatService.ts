import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { ChatServiceState } from './chat/state'
import { dbAdapter } from './dbAdapter'
import { wcdbService } from './wcdbService'
import type { StatsPartialError } from './statsConstants'
import {
  compareMessageCursorAsc,
  compareMessageCursorDesc,
  messageIdentityKey,
  type ChatSession,
  type ContactInfo,
  type Message,
  type ChatLabSourceMessage,
  type ChatRecordItem,
  type Contact,
} from './chat/types'
import {
  cleanAccountDirName,
  findAccountDir,
} from './chat/accountUtils'
import {
  cleanString,
  cleanSystemMessage,
  decodeBinaryContent,
  decodeHtmlEntities,
  decodeMaybeCompressed,
  decodeMessageContent,
  decodePackedInfo,
  extractXmlAttribute,
  extractXmlValue,
  looksLikeBase64,
  looksLikeHex,
  looksLikeWxid,
  stripSenderPrefix,
} from './chat/rowDecoders'
import {
  getMessageTypeLabel,
  parseChatHistory,
  parseEmojiInfo,
  parseFileInfo,
  parseImageDatNameFromRow,
  parseImageInfo,
  parseMessageContent,
  parseQuoteMessage,
  parseType49,
  parseVideoDuration,
  parseVideoMd5,
  parseVoiceDuration,
  parseVoipMessage,
  sanitizeQuotedContent,
} from './chat/contentParsers'
import { resolveWeComCorpName } from './chat/weComResolver'
import {
  getContacts,
  getContact,
  getContactAvatar,
  resolveTransferDisplayNames,
  getMyAvatarUrl,
  getMyUserInfo,
  getUinFromMiscDb,
} from './chat/contactQueries'
import { getSessionDetail } from './chat/sessionDetail'
import { getSessions } from './chat/sessionList'
import {
  getEmoticonDecryptionParams,
  decryptEmoticonCache,
  downloadEmoji,
} from './chat/emoji'
import {
  getMessageByLocalId,
  getMessageByLocalIdFromTable,
  getImageData,
  getVoiceData,
} from './chat/media'
import {
  findSessionTables,
  checkTableExists,
  resolveMyRowId,
  refreshMessageDbCache as refreshMessageDbCacheImpl,
} from './chat/tableResolver'
import {
  resolveRowIsSend,
  resolveMessageLocalType,
  isMessageVisibleForSession,
  normalizeMessagesForUi,
  updateSessionCursorFromPage,
  getMessagesViaNativeCursor,
  rowToMessage,
} from './chat/messageMapper'

export type {
  ChatSession,
  ContactInfo,
  Message,
  ChatLabSourceMessage,
  ChatRecordItem,
  Contact,
}

class ChatService extends EventEmitter {
  private state = new ChatServiceState()

  constructor() {
    super()
  }

  /**
   * 设置当前聚焦的会话 ID
   * 用于增量同步时只推送当前会话的消息
   */
  setCurrentSession(sessionId: string | null): void {
    this.state.currentSessionId = sessionId
  }

  /**
   * 启动屏预加载：DB 连接成功后在后台预热会话列表、联系人和前几个会话的消息。
   * startup.ts 通过 Promise.race 加 5s 超时调用此方法，保证不会无限阻塞启动屏。
   */
  async preloadData(): Promise<void> {
    const t0 = Date.now()
    try {
      const sessionsResult = await this.getSessions(0, 300)
      this.state.preloadCache.sessions = {
        success: sessionsResult.success,
        sessions: sessionsResult.sessions,
        hasMore: sessionsResult.hasMore
      }

      const contactsResult = await this.getContacts()
      this.state.preloadCache.contacts = contactsResult

      if (sessionsResult.success && sessionsResult.sessions?.length) {
        const topSessions = sessionsResult.sessions.slice(0, 5)
        await Promise.all(topSessions.map(async (session) => {
          const result = await this.getMessages(session.username, 0, 50)
          if (result.success) {
            this.state.preloadCache.messages.set(session.username, {
              success: result.success,
              messages: result.messages,
              hasMore: result.hasMore
            })
          }
        }))
      }

      this.state.preloadCache.builtAt = Date.now()
      console.log(`[ChatService] 预加载完成，耗时 ${Date.now() - t0}ms，会话 ${this.state.preloadCache.sessions?.sessions?.length ?? 0} 条，消息缓存 ${this.state.preloadCache.messages.size} 个会话`)
    } catch (e) {
      console.warn('[ChatService] 预加载失败:', e)
    }
  }

  /**
   * 连接数据库。业务层仍调用 chatService.connect，但实际句柄由 wcdbService Worker 管理。
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = String(this.state.configService.get('myWxid') || '').trim()
      const dbPath = String(this.state.configService.get('dbPath') || '').trim()
      const decryptKey = String(this.state.configService.get('decryptKey') || '').trim()

      if (!wxid || !dbPath || !decryptKey) {
        return { success: false, error: '数据库配置不完整' }
      }

      const opened = await wcdbService.open(dbPath, decryptKey, wxid)
      return opened ? { success: true } : { success: false, error: 'WCDB 打开失败' }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  /**
   * 关闭数据库连接（no-op；真正的 close 由 wcdbService 接管）
   */
  close(): void {
    // 清理本地缓存（真正的句柄由 wcdbService 的 Worker 管理）
    this.state.sessionTableCache.clear()
    this.state.sessionTableCacheTime = 0
    this.state.knownMessageDbFiles.clear()
    this.state.myRowIdCache.clear()
    this.state.hasName2IdCache.clear()
    this.state.contactColumnsCache = null
    this.state.weComCorpNameCache.clear()
    this.state.hasOpenImWordingTable = null
    this.state.avatarBase64Cache.clear()
    this.state.preloadCache.sessions = null
    this.state.preloadCache.contacts = null
    this.state.preloadCache.messages.clear()
    this.state.preloadCache.builtAt = 0
  }

  /**
   * 关闭指定的数据库文件（no-op；wcdbService 统一管理）
   */
  closeDatabase(_fileName: string): void {
    // 不再持有本地 better-sqlite3 句柄。清掉相关缓存即可。
    this.state.sessionTableCache.clear()
    this.state.sessionTableCacheTime = 0
    this.state.knownMessageDbFiles.clear()
    this.state.avatarBase64Cache.clear()
    this.state.contactColumnsCache = null
    this.state.weComCorpNameCache.clear()
    this.state.hasOpenImWordingTable = null
  }

  /**
   * 由 startup.ts 调用：把 monitorBridge 的变更事件桥接成 chatService 自身的 EventEmitter
   * 暂时只做事件转发；不在这里做 query 或 push。
   */
  attachMonitor(bridge: { on: (evt: string, cb: (p: any) => void) => void }): void {
    bridge.on('change', (payload) => {
      if (payload?.table === 'Session' || payload?.table === 'Message' || payload?.table === 'Contact') {
        this.emit('dbChange', payload)
      }
    })
  }

  /**
   * 获取会话列表
   */
  async getSessions(offset?: number, limit?: number): Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }> {
    return getSessions(this.state, offset, limit)
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    return getContacts(this.state)
  }

  /**
   * 刷新消息数据库缓存（解密后调用）
   */
  refreshMessageDbCache(): void {
    refreshMessageDbCacheImpl(this.state)
    // 尝试推送增量消息（fire-and-forget，避免把同步方法改成 async）
    void this.checkNewMessagesForCurrentSession()
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      // 消费预加载缓存（仅首页且缓存中有该会话）
      if (!offset && this.state.preloadCache.builtAt > 0 &&
          Date.now() - this.state.preloadCache.builtAt < this.state.PRELOAD_CACHE_TTL &&
          this.state.preloadCache.messages.has(sessionId)) {
        const cached = this.state.preloadCache.messages.get(sessionId)!
        this.state.preloadCache.messages.delete(sessionId)
        return cached
      }

      const normalizedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))

      if (Math.max(0, Math.floor(Number(offset) || 0)) === 0) {
        const nativeDirect = await wcdbService.getNativeMessages(sessionId, normalizedLimit + 1, 0)
        if (nativeDirect.success && nativeDirect.rows) {
          const normalized = normalizeMessagesForUi(
            nativeDirect.rows.map(row => rowToMessage(this.state, row)),
            sessionId,
            normalizedLimit
          )
          const page = normalized.messages
          updateSessionCursorFromPage(this.state, sessionId, page)
          return { success: true, messages: page, hasMore: normalized.hasExtra }
        }

        const nativeCursor = await getMessagesViaNativeCursor(this.state, sessionId, normalizedLimit)
        if (nativeCursor.success) {
          return nativeCursor
        }
      }

      // 获取当前用户的 wxid
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      // 使用缓存查找会话对应的数据库和表
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      // 从所有数据库收集消息
      let allMessages: Message[] = []
      const minFetchPerDb = Math.max(offset + limit + 1, 100)

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')

          // 获取当前用户的 rowid（使用缓存）
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          // 构造查询 SQL（与原 getPreparedStatement 语义一致）
          let sql: string
          let params: any[]
          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ? OFFSET ?`
            params = [myRowId, minFetchPerDb, 0]
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ? OFFSET ?`
            params = [minFetchPerDb, 0]
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY sort_seq DESC, create_time DESC, local_id DESC LIMIT ? OFFSET ?`
            params = [minFetchPerDb, 0]
          }

          const rows = await dbAdapter.all<any>('message', dbPath, sql, params)

          // 批量处理消息
          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

            // 只在需要时解析表情包和引用消息
            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let quotedEmojiMd5: string | undefined
            let quotedEmojiCdnUrl: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let isLivePhoto: boolean | undefined
            let videoMd5: string | undefined
            let videoDuration: number | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = parseImageDatNameFromRow(row)
              isLivePhoto = imageInfo.isLivePhoto
            } else if (localType === 43 && content) {
              videoMd5 = parseVideoMd5(content)
              videoDuration = parseVideoDuration(content)
            } else if (localType === 34 && content) {
              voiceDuration = parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
              quotedEmojiMd5 = quoteInfo.emojiMd5
              quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = parseChatHistory(content)
              }
            }

            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e: any) {
          // 检测数据库损坏错误
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            // 刷新缓存，强制重新解密
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询消息失败:', e)
          }
        }
      }

      // 按 sort_seq 降序排序（最新的在前）
      allMessages.sort(compareMessageCursorDesc)

      // 去重（同一条消息可能在多个数据库中）
      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        if (!isMessageVisibleForSession(sessionId, msg)) return false
        const key = messageIdentityKey(msg)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // 应用 offset 和 limit
      const hasMore = allMessages.length > offset + limit
      const messages = allMessages.slice(offset, offset + limit)

      // 反转使最新消息在最后（UI 显示顺序）
      messages.reverse()

      // 更新增量游标（仅在拉取最新一页时）
      if (offset === 0 && messages.length > 0) {
        const latestMsg = messages[messages.length - 1]
        const currentCursor = this.state.sessionCursor.get(sessionId) || 0
        if (latestMsg.sortSeq > currentCursor) {
          this.state.sessionCursor.set(sessionId, latestMsg.sortSeq)
        }
      }

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取指定时间之后的新消息。
   * 优先走 WeFlow native cursor；cursor 不可用时回退到现有最新页查询。
   */
  async getNewMessages(
    sessionId: string,
    minTime: number,
    limit: number = 1000
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    const normalizedMinTime = Number(minTime) > 1e12
      ? Math.floor(Number(minTime) / 1000)
      : Math.max(0, Math.floor(Number(minTime) || 0))
    const normalizedLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 1000)))

    try {
      const nativeResult = await wcdbService.getNewMessages(sessionId, normalizedMinTime, normalizedLimit)
      if (nativeResult.success) {
        let messages = (nativeResult.rows || [])
          .map(row => rowToMessage(this.state, row))
          .filter(msg => isMessageVisibleForSession(sessionId, msg))
          .filter(msg => Number(msg.createTime || 0) >= normalizedMinTime)

        const seen = new Set<string>()
        messages = messages
          .sort(compareMessageCursorAsc)
          .filter(msg => {
            const key = messageIdentityKey(msg)
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

        if (messages.length > 0) {
          const latestMsg = messages[messages.length - 1]
          const currentCursor = this.state.sessionCursor.get(sessionId) || 0
          if (latestMsg.sortSeq > currentCursor) {
            this.state.sessionCursor.set(sessionId, latestMsg.sortSeq)
          }
        }

        return { success: true, messages }
      }

      console.warn('[ChatService] native cursor getNewMessages 失败，回退到最新页查询:', nativeResult.error)
      const fallback = await this.getMessages(sessionId, 0, Math.min(normalizedLimit, 200))
      if (!fallback.success || !fallback.messages) {
        return { success: false, error: nativeResult.error || fallback.error || '获取新消息失败' }
      }
      return {
        success: true,
        messages: fallback.messages.filter(msg => Number(msg.createTime || 0) >= normalizedMinTime)
      }
    } catch (e) {
      console.error('ChatService: 获取新消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 摘要专用：按精确时间范围读取消息，并优先保留范围内最新消息。
   */
  async getMessagesByTimeRangeForSummary(
    sessionId: string,
    options: {
      startTime?: number
      endTime: number
      limit: number
    }
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      const normalizedLimit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 50
      const startTime = Number.isFinite(options.startTime) && Number(options.startTime) > 0
        ? Math.floor(Number(options.startTime))
        : undefined
      const endTime = Number.isFinite(options.endTime) && Number(options.endTime) > 0
        ? Math.floor(Number(options.endTime))
        : Math.floor(Date.now() / 1000)

      if (startTime !== undefined && startTime > endTime) {
        return { success: true, messages: [], hasMore: false }
      }

      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
      const dbTablePairs = await findSessionTables(this.state, sessionId)

      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allMessages: Message[] = []
      const fetchLimitPerDb = normalizedLimit + 1

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          const whereParts: string[] = []
          const params: Array<number> = []

          if (startTime !== undefined) {
            whereParts.push(hasName2IdTable ? 'm.create_time >= ?' : 'create_time >= ?')
            params.push(startTime)
          }

          whereParts.push(hasName2IdTable ? 'm.create_time <= ?' : 'create_time <= ?')
          params.push(endTime)

          const whereClause = `WHERE ${whereParts.join(' AND ')}`

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, ...params, fetchLimitPerDb])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          } else {
            sql = `SELECT *
                   FROM ${tableName}
                   ${whereClause}
                   ORDER BY sort_seq DESC, create_time DESC, local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          }

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)
            const parsedContent = parseMessageContent(content, localType)
            const xmlType = content ? extractXmlValue(content, 'type') : undefined
            const chatRecordList = content && (xmlType === '19' || localType === 49)
              ? parseChatHistory(content)
              : undefined

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: parsedContent || '',
              rawContent: content,
              chatRecordList
            })
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 摘要查询遇到损坏数据库: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 摘要时间范围查询失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorDesc)

      const seen = new Set<string>()
      const uniqueMessages = allMessages.filter((msg) => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = uniqueMessages.length > normalizedLimit
      const messages = uniqueMessages.slice(0, normalizedLimit)
      messages.reverse()

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 摘要时间范围查询失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 基于 sortSeq 游标，获取更早的消息（严格小于 cursorSortSeq）
   */
  async getMessagesBefore(
    sessionId: string,
    cursorSortSeq: number,
    limit: number = 50,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allMessages: Message[] = []
      const fetchLimitPerDb = Math.max(limit + 1, 50)
      const effectiveCursorCreateTime = cursorCreateTime ?? Number.MAX_SAFE_INTEGER
      const effectiveCursorLocalId = cursorLocalId ?? Number.MAX_SAFE_INTEGER

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq < ?
                     OR (m.sort_seq = ? AND m.create_time < ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq < ?
                     OR (m.sort_seq = ? AND m.create_time < ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     sort_seq < ?
                     OR (sort_seq = ? AND create_time < ?)
                     OR (sort_seq = ? AND create_time = ? AND local_id < ?)
                   )
                   ORDER BY sort_seq DESC, create_time DESC, local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }

          for (const row of rows) {
            allMessages.push(rowToMessage(this.state, row))
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询更早消息失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorDesc)

      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = allMessages.length > limit
      const messages = allMessages.slice(0, limit)
      messages.reverse()

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取更早消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 基于 sortSeq 游标，获取更新的消息（严格大于 cursorSortSeq）
   */
  async getMessagesAfter(
    sessionId: string,
    cursorSortSeq: number,
    limit: number = 50,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allMessages: Message[] = []
      const fetchLimitPerDb = Math.max(limit + 1, 50)
      const effectiveCursorCreateTime = cursorCreateTime ?? Number.MIN_SAFE_INTEGER
      const effectiveCursorLocalId = cursorLocalId ?? Number.MIN_SAFE_INTEGER

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq > ?
                     OR (m.sort_seq = ? AND m.create_time > ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq > ?
                     OR (m.sort_seq = ? AND m.create_time > ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     sort_seq > ?
                     OR (sort_seq = ? AND create_time > ?)
                     OR (sort_seq = ? AND create_time = ? AND local_id > ?)
                   )
                   ORDER BY sort_seq ASC, create_time ASC, local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let quotedEmojiMd5: string | undefined
            let quotedEmojiCdnUrl: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let isLivePhoto: boolean | undefined
            let videoMd5: string | undefined
            let videoDuration: number | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = parseImageDatNameFromRow(row)
              isLivePhoto = imageInfo.isLivePhoto
            } else if (localType === 43 && content) {
              videoMd5 = parseVideoMd5(content)
              videoDuration = parseVideoDuration(content)
            } else if (localType === 34 && content) {
              voiceDuration = parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
              quotedEmojiMd5 = quoteInfo.emojiMd5
              quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = parseChatHistory(content)
              }
            }

            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询更新消息失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorAsc)

      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = allMessages.length > limit
      const messages = allMessages.slice(0, limit)

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取更新消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * ChatLab Pull 轻量消息查询。
   * 只返回协议组装所需的最小字段，避免媒体路径解析和富结构展开。
   */
  async getMessagesForChatLab(
    sessionId: string,
    options?: {
      startTime?: number
      endTime?: number
      watermark?: number
      offset?: number
      limit?: number
    }
  ): Promise<{ success: boolean; messages?: ChatLabSourceMessage[]; hasMore?: boolean; error?: string }> {
    try {
      const normalizedOffset = Number.isFinite(options?.offset) ? Math.max(0, Math.floor(options?.offset || 0)) : 0
      const normalizedLimit = Number.isFinite(options?.limit) ? Math.max(1, Math.min(500, Math.floor(options?.limit || 100))) : 100
      const startTime = Number.isFinite(options?.startTime) && Number(options?.startTime) > 0
        ? Math.floor(Number(options?.startTime))
        : undefined
      const endTime = Number.isFinite(options?.endTime) && Number(options?.endTime) > 0
        ? Math.floor(Number(options?.endTime))
        : undefined
      const watermark = Number.isFinite(options?.watermark) && Number(options?.watermark) > 0
        ? Math.floor(Number(options?.watermark))
        : undefined
      const effectiveEndTime = endTime !== undefined && watermark !== undefined
        ? Math.min(endTime, watermark)
        : (endTime ?? watermark)

      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
      const dbTablePairs = await findSessionTables(this.state, sessionId)

      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      const allMessages: ChatLabSourceMessage[] = []
      const fetchLimitPerDb = Math.max(normalizedOffset + normalizedLimit + 1, 100)

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          const whereParts: string[] = []
          const params: Array<number> = []

          if (startTime) {
            whereParts.push(hasName2IdTable ? 'm.create_time >= ?' : 'create_time >= ?')
            params.push(startTime)
          }
          if (effectiveEndTime) {
            whereParts.push(hasName2IdTable ? 'm.create_time <= ?' : 'create_time <= ?')
            params.push(effectiveEndTime)
          }

          const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, ...params, fetchLimitPerDb])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          } else {
            sql = `SELECT *
                   FROM ${tableName}
                   ${whereClause}
                   ORDER BY sort_seq ASC, create_time ASC, local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          }

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)
            const parsedContent = parseMessageContent(content, localType)
            const xmlType = content ? extractXmlValue(content, 'type') : undefined
            const chatRecordList = content && (xmlType === '19' || localType === 49)
              ? parseChatHistory(content)
              : undefined

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: parsedContent || '',
              rawContent: content,
              chatRecordList
            })
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] ChatLab 查询遇到损坏数据库: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: ChatLab 轻量查询失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorAsc)

      const seen = new Set<string>()
      const uniqueMessages = allMessages.filter((msg) => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = uniqueMessages.length > normalizedOffset + normalizedLimit
      const messages = uniqueMessages.slice(normalizedOffset, normalizedOffset + normalizedLimit)

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: ChatLab 轻量查询失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取会话的所有语音消息（用于批量转写）
   * 复用 getMessages 的查询逻辑，只查询语音消息类型
   */
  async getAllVoiceMessages(
    sessionId: string
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      // 使用与 getMessages 相同的方法查找会话对应的表
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allVoiceMessages: Message[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          // 查询所有语音消息 (localType = 34)
          // 检查表结构
          const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${tableName}')`)
          const columnNames = columns.map((c: any) => c.name.toLowerCase())
          const hasTypeColumn = columnNames.includes('type')
          const hasLocalTypeColumn = columnNames.includes('local_type')

          // 构建 WHERE 条件
          let typeCondition = ''
          if (hasLocalTypeColumn && hasTypeColumn) {
            typeCondition = '(local_type = 34 OR type = 34)'
          } else if (hasLocalTypeColumn) {
            typeCondition = 'local_type = 34'
          } else if (hasTypeColumn) {
            typeCondition = 'type = 34'
          } else {
            console.warn(`[ChatService] 表 ${tableName} 没有 local_type 或 type 列，跳过`)
            continue
          }

          // 构建完整的 SQL 查询
          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE ${typeCondition}
                   ORDER BY m.sort_seq DESC`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE ${typeCondition}
                   ORDER BY m.sort_seq DESC`
            rows = await dbAdapter.all<any>('message', dbPath, sql)
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE ${typeCondition}
                   ORDER BY sort_seq DESC`
            rows = await dbAdapter.all<any>('message', dbPath, sql)
          }

          // 处理查询结果
          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)
            const voiceDuration = parseVoiceDuration(content)

            allVoiceMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: '',
              rawContent: content,
              voiceDuration
            })
          }
        } catch (e: any) {
          console.error(`[ChatService] 查询语音消息失败 (${dbPath}):`, e)
        }
      }

      // 按 sort_seq 降序排序
      allVoiceMessages.sort(compareMessageCursorDesc)

      // 去重
      const seen = new Set<string>()
      allVoiceMessages = allVoiceMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${allVoiceMessages.length} 条语音消息（去重后）`)

      return { success: true, messages: allVoiceMessages }
    } catch (e) {
      console.error('[ChatService] 获取所有语音消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取会话的所有图片消息（用于批量解密）
   */
  async getAllImageMessages(
    sessionId: string
  ): Promise<{ success: boolean; images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]; error?: string }> {
    try {
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      const images: { imageMd5?: string; imageDatName?: string; createTime?: number }[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${tableName}')`)
          const columnNames = columns.map((c: any) => c.name.toLowerCase())
          const hasLocalTypeColumn = columnNames.includes('local_type')
          const hasTypeColumn = columnNames.includes('type')

          let typeCondition = ''
          if (hasLocalTypeColumn && hasTypeColumn) {
            typeCondition = '(local_type = 3 OR type = 3)'
          } else if (hasLocalTypeColumn) {
            typeCondition = 'local_type = 3'
          } else if (hasTypeColumn) {
            typeCondition = 'type = 3'
          } else {
            continue
          }

          const rows = await dbAdapter.all<any>(
            'message',
            dbPath,
            `SELECT * FROM ${tableName} WHERE ${typeCondition}`
          )

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const imageInfo = parseImageInfo(content)
            const datName = parseImageDatNameFromRow(row)
            if (imageInfo.md5 || datName) {
              images.push({ imageMd5: imageInfo.md5, imageDatName: datName, createTime: row.create_time })
            }
          }
        } catch (e: any) {
          console.error(`[ChatService] 查询图片消息失败:`, e)
        }
      }

      // 去重
      const seen = new Set<string>()
      const unique = images.filter(img => {
        const key = img.imageMd5 || img.imageDatName || ''
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${unique.length} 条图片消息（去重后）`)
      return { success: true, images: unique }
    } catch (e) {
      console.error('[ChatService] 获取所有图片消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 根据日期获取消息（用于日期跳转）
   * @param sessionId 会话ID
   * @param targetTimestamp 目标日期的 Unix 时间戳（秒）
   * @param limit 返回消息数量
   * @returns 返回目标日期当天或之后最近的消息列表
   */
  async getMessagesByDate(
    sessionId: string,
    targetTimestamp: number,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; targetIndex?: number; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      // 计算目标日期的开始时间戳（当天 00:00:00）
      const targetDate = new Date(targetTimestamp * 1000)
      targetDate.setHours(0, 0, 0, 0)
      const dayStartTimestamp = Math.floor(targetDate.getTime() / 1000)

      // 从所有数据库查找目标日期或之后的第一条消息
      let allMessages: Message[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          // 查询目标日期或之后的消息，按时间升序获取
          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE m.create_time >= ?
                   ORDER BY m.create_time ASC, m.sort_seq ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, dayStartTimestamp, limit * 2])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE m.create_time >= ?
                   ORDER BY m.create_time ASC, m.sort_seq ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [dayStartTimestamp, limit * 2])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE create_time >= ?
                   ORDER BY create_time ASC, sort_seq ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [dayStartTimestamp, limit * 2])
          }

          // 处理消息
          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let quotedEmojiMd5: string | undefined
            let quotedEmojiCdnUrl: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let isLivePhoto: boolean | undefined
            let videoMd5: string | undefined
            let videoDuration: number | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = parseImageDatNameFromRow(row)
              isLivePhoto = imageInfo.isLivePhoto
            } else if (localType === 43 && content) {
              videoMd5 = parseVideoMd5(content)
              videoDuration = parseVideoDuration(content)
            } else if (localType === 34 && content) {
              voiceDuration = parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
              quotedEmojiMd5 = quoteInfo.emojiMd5
              quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = parseChatHistory(content)
              }
            }

            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e) {
          console.error('ChatService: 按日期查询消息失败:', e)
        }
      }

      // 按时间升序排序
      allMessages.sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq)

      // 去重
      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // 取前 limit 条
      const messages = allMessages.slice(0, limit)

      if (messages.length === 0) {
        return { success: true, messages: [], targetIndex: -1 }
      }

      return { success: true, messages, targetIndex: 0 }
    } catch (e) {
      console.error('ChatService: 按日期获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取指定月份中有消息的日期列表
   * @param sessionId 会话ID
   * @param year 年份
   * @param month 月份 (1-12)
   * @returns 有消息的日期字符串列表 (YYYY-MM-DD)
   */
  async getDatesWithMessages(
    sessionId: string,
    year: number,
    month: number
  ): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    try {
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: true, dates: [] }
      }

      // 计算该月的起止时间戳
      // 注意：month 参数是 1-12，但 Date 构造函数用 0-11
      const startDate = new Date(year, month - 1, 1, 0, 0, 0)
      const endDate = new Date(year, month, 0, 23, 59, 59, 999) // 下个月第0天即本月最后一天

      const startTimestamp = Math.floor(startDate.getTime() / 1000)
      const endTimestamp = Math.floor(endDate.getTime() / 1000)

      const datesSet = new Set<string>()

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          // 只查询 create_time 字段以优化性能
          const sql = `SELECT create_time FROM ${tableName}
                       WHERE create_time BETWEEN ? AND ?`

          const rows = await dbAdapter.all<{ create_time: number }>('message', dbPath, sql, [startTimestamp, endTimestamp])

          for (const row of rows) {
            const date = new Date(row.create_time * 1000)
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
            datesSet.add(dateStr)
          }
        } catch (e) {
          console.error(`ChatService: 查询表 ${tableName} 日期失败`, e)
        }
      }

      // 排序
      const sortedDates = Array.from(datesSet).sort()

      return { success: true, dates: sortedDates }
    } catch (e) {
      console.error('ChatService: 获取有消息的日期失败:', e)
      return { success: false, error: String(e) }
    }
  }


  async getContact(username: string): Promise<Contact | null> {
    return getContact(username)
  }

  /**
   * 获取联系人头像和显示名称（用于群聊消息）
   */
  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string; weComCorp?: string } | null> {
    return getContactAvatar(this.state, username)
  }

  /**
   * 解析转账消息中的付款方和收款方显示名称
   * 优先使用群昵称（从 chatroom_info 表），群昵称为空时回退到微信昵称/备注
   */
  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    return resolveTransferDisplayNames(this.state, chatroomId, payerUsername, receiverUsername)
  }

  /**
   * 获取当前用户的头像 URL
   */
  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    return getMyAvatarUrl(this.state)
  }

  /**
   * 获取当前用户的完整信息（昵称、微信号、头像）
   */
  async getMyUserInfo(): Promise<{
    success: boolean
    userInfo?: {
      wxid: string
      nickName: string
      alias: string
      avatarUrl: string
    }
    error?: string
  }> {
    return getMyUserInfo(this.state)
  }

  /**
   * 从 misc.db 获取 UIN（微信账号ID）
   * UIN 用于表情包缓存解密的密钥派生
   */
  async getUinFromMiscDb(): Promise<string | null> {
    return getUinFromMiscDb()
  }

  /**
   * 获取表情包缓存解密所需的 UIN 和 keyString
   * - UIN: 从 misc.db 获取，或从配置读取
   * - keyString: 使用 myWxid（已在配置中）
   */
  async getEmoticonDecryptionParams(): Promise<{ uin: string | null; keyString: string | null }> {
    return getEmoticonDecryptionParams(this.state)
  }

  /**
   * 解密表情包缓存文件
   * 使用 AES-128-CBC (IV=Key) + XOR 掩码
   * 密钥派生: MD5(str(UIN) + keyString + "EMOTICON") → 小写十六进制 → 前16字符
   */
  async decryptEmoticonCache(filePath: string): Promise<Buffer | null> {
    return decryptEmoticonCache(this.state, filePath)
  }

  /**
   * 下载或获取表情包本地缓存
   * 如果 cdnUrl 为空但 md5 存在，则尝试通过本地存储或多种拼接规则下载
   */
  async downloadEmoji(cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string): Promise<{ success: boolean; localPath?: string; cachePath?: string; error?: string }> {
    return downloadEmoji(this.state, cdnUrl, md5, productId, createTime, encryptUrl, aesKey)
  }

  /**
   * 获取会话详情信息
   */
  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: {
      wxid: string
      displayName: string
      remark?: string
      nickName?: string
      alias?: string
      avatarUrl?: string
      messageCount: number
      firstMessageTime?: number
      latestMessageTime?: number
      messageTables: { dbName: string; tableName: string; count: number }[]
      errors?: StatsPartialError[]
      partialFailureCount?: number
    }
    error?: string
  }> {
    return getSessionDetail(this.state, sessionId)
  }

  /**
   * 获取单条消息
   */
  public async getMessageByLocalId(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    return getMessageByLocalId(this.state, sessionId, localId)
  }

  /**
   * 从指定消息库/表读取消息。
   * randomMomentService 会先在具体表中抽样；这里必须用同一张表还原，避免 local_id 跨库/跨表重复导致消息和会话错配。
   */
  public async getMessageByLocalIdFromTable(
    sessionId: string,
    localId: number,
    tableName: string,
    dbPath: string
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    return getMessageByLocalIdFromTable(this.state, sessionId, localId, tableName, dbPath)
  }

  /**
   * 获取图片数据（base64）。
   * 与 WeFlow 一致，作为聊天页图片渲染的 localId 兜底通道。
   */
  async getImageData(sessionId: string, msgId: string, createTime?: number): Promise<{ success: boolean; data?: string; error?: string }> {
    return getImageData(this.state, sessionId, msgId, createTime)
  }

  /**
   * 获取语音数据（解码为 WAV base64）
   * 同一秒内可能有多条语音消息，需用 serverId 精确匹配，缺失时按 rowid 顺序映射兜底
   */
  async getVoiceData(
    sessionId: string,
    msgId: string,
    createTime?: number,
    serverId?: number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    return getVoiceData(this.state, sessionId, msgId, createTime, serverId)
  }

  /**
   * 启动自动增量同步（保留签名作为 no-op；实时同步已迁移到 monitorBridge）
   */
  startAutoSync(_intervalMs = 5000) {
    // no-op，等待 monitorBridge 推送
  }

  /**
   * 停止自动同步（保留签名作为 no-op）
   */
  stopAutoSync() {
    // no-op
  }

  /**
   * 检查数据库是否有更新（保留签名作为 no-op；真正的变更来自 monitorBridge）
   */
  async checkUpdates(_force: boolean = false) {
    // no-op
  }

  /**
   * 检查当前会话的新消息并推送（保留签名作为 no-op；真正的增量推送走 monitorBridge）
   */
  private async checkNewMessagesForCurrentSession(): Promise<void> {
    // no-op；等待 wcdb monitor 推送变更后再由 attachMonitor 处理
  }

  /**
   * 解析会话对应的消息表路径（可能跨多个 .db），供 randomMomentService 等模块使用。
   */
  public async getSessionMessageTables(sessionId: string): Promise<{ tableName: string; dbPath: string }[]> {
    return findSessionTables(this.state, sessionId)
  }
}

export const chatService = new ChatService()

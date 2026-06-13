import type { PersonaBuildProgress, PersonaProfile, PersonaRecord, PersonaStats } from './personaTypes'

type PersonaBuildLogger = {
  warn?(category: string, message: string, data?: unknown): void
  error?(category: string, message: string, data?: unknown): void
}

export interface PersonaBuildInput {
  sessionId: string
  displayName?: string
  logger?: PersonaBuildLogger | null
  onProgress?: (progress: PersonaBuildProgress) => void
}

export type PersonaBuildResult =
  | { success: true; persona: PersonaRecord }
  | { success: false; error: string }

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

export async function buildPersonaFromSession(input: PersonaBuildInput): Promise<PersonaBuildResult> {
  const sessionId = String(input.sessionId || '').trim()
  const displayName = String(input.displayName || '').trim() || sessionId
  const logger = input.logger || null
  const startedAt = Date.now()
  const sendProgress = (
    stage: PersonaBuildProgress['stage'],
    title: string,
    percent: number,
    detail?: string,
  ) => {
    input.onProgress?.({ sessionId, stage, title, percent, detail })
  }

  try {
    if (!sessionId) return { success: false, error: '缺少 sessionId' }

    const { resolveProviderConfig } = await import('../resolveProviderConfig')
    const { refreshResolvedProxyUrl } = await import('../../ai/proxyFetch')
    const providerConfig = resolveProviderConfig()
    await refreshResolvedProxyUrl()

    sendProgress('indexing', '正在读取聊天记录', 5)
    const { chatSearchIndexService } = await import('../../search/chatSearchIndexService')
    const messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, (p) => {
      sendProgress('indexing', '正在读取聊天记录', 10, p.message)
    }, 6000)

    sendProgress('corpus', '正在分析说话风格', 40)
    const { buildPersonaCorpus, MIN_FRIEND_MESSAGES, PROFILE_MAX_CHUNKS, mergeTurns, renderProfileChunks, extractPersonaPairs } =
      await import('./personaCorpus')
    const corpus = buildPersonaCorpus(messages, displayName)

    let groupCorpus: import('./personaGroupCorpus').PersonaGroupCorpus | null = null
    if (corpus.stats.friendMessageCount < MIN_FRIEND_MESSAGES) {
      sendProgress('corpus', '私聊语料不足，正在收集群聊发言', 42)
      try {
        const { collectGroupCorpus } = await import('./personaGroupCorpus')
        groupCorpus = await collectGroupCorpus(sessionId, displayName, (detail) => {
          sendProgress('corpus', '私聊语料不足，正在收集群聊发言', 44, detail)
        })
      } catch (e) {
        logger?.warn?.('Persona', '群聊语料收集失败，仅用私聊语料', { sessionId, ...errorToLogData(e) })
      }
      const totalFriendMessages = corpus.stats.friendMessageCount + (groupCorpus?.friendMessageCount || 0)
      if (totalFriendMessages < MIN_FRIEND_MESSAGES) {
        const groupNote = groupCorpus?.friendMessageCount
          ? `私聊 ${corpus.stats.friendMessageCount} 条 + 群聊 ${groupCorpus.friendMessageCount} 条`
          : `${corpus.stats.friendMessageCount} 条`
        const error = `与「${displayName}」的可用文本消息太少（${groupNote}，至少需要 ${MIN_FRIEND_MESSAGES} 条），不足以克隆`
        sendProgress('error', '克隆失败', 100, error)
        return { success: false, error }
      }
    }

    const stats: PersonaStats = {
      ...corpus.stats,
      ...(groupCorpus?.friendMessageCount
        ? { groupMessageCount: groupCorpus.friendMessageCount, groupSessionCount: groupCorpus.groupCount }
        : {}),
    }
    const turns = mergeTurns(messages)

    sendProgress('extracting', '正在提炼说话风格（调用 AI）', 48)
    const { agentProcessService } = await import('../agentProcessService')
    agentProcessService.setLogger(logger as never)
    const extracted = await agentProcessService.extractPersona({
      providerConfig,
      friendName: displayName,
      corpusText: corpus.corpusText,
      groupCorpusText: groupCorpus?.friendMessageCount ? groupCorpus.corpusText : undefined,
      stats,
    })

    const profileChunks = [...renderProfileChunks(turns, displayName), ...(groupCorpus?.profileChunks || [])]
      .slice(0, PROFILE_MAX_CHUNKS)
    const parts: Array<PersonaProfile | undefined> = new Array(profileChunks.length)
    let nextChunk = 0
    let doneChunks = 0
    await Promise.all(
      Array.from({ length: Math.min(3, profileChunks.length) }, async () => {
        while (nextChunk < profileChunks.length) {
          const myIndex = nextChunk++
          try {
            parts[myIndex] = await agentProcessService.extractProfileChunk({
              providerConfig,
              friendName: displayName,
              chunkText: profileChunks[myIndex],
            })
          } catch {
            // 单块失败跳过
          }
          doneChunks += 1
          sendProgress(
            'extracting',
            `正在提炼深层画像（${doneChunks}/${profileChunks.length}）`,
            55 + Math.round((doneChunks / profileChunks.length) * 25),
          )
        }
      }),
    )

    const validParts = parts.filter((p): p is PersonaProfile => !!p)
    let profile: PersonaProfile | null = null
    if (validParts.length > 0) {
      sendProgress('extracting', '正在合并深层画像', 82)
      try {
        profile = await agentProcessService.mergeProfile({ providerConfig, friendName: displayName, parts: validParts })
      } catch (e) {
        logger?.warn?.('Persona', '深层画像合并失败，降级为无深层画像', { sessionId, ...errorToLogData(e) })
      }
    }

    const { collectStickers, mergeStickers } = await import('./personaStickers')
    const stickers = mergeStickers(
      collectStickers(messages, (m) => m.isSend !== 1),
      groupCorpus?.stickers || [],
    )

    sendProgress('saving', '正在保存画像', 88)
    const { personaStore } = await import('./personaStore')
    const corpusUntil = messages.reduce((max, m) => Math.max(max, m.createTime), 0)
    const persona = personaStore.upsert({
      sessionId,
      displayName,
      card: extracted.card,
      fewShots: extracted.fewShots,
      stats,
      profile,
      stickers,
      corpusUntil,
      modelProvider: providerConfig.name,
      modelId: providerConfig.model,
    })

    try {
      const { personaPairStore } = await import('./personaPairStore')
      personaPairStore.replaceAll(sessionId, extractPersonaPairs(turns))
      sendProgress('saving', '正在为真实问答建索引', 92)
      await personaPairStore.embedPending(sessionId, (current, total) => {
        sendProgress('saving', `正在为真实问答建索引（${current}/${total}）`, 92 + Math.round((current / total) * 6))
      })
    } catch (e) {
      logger?.warn?.('Persona', '问答对索引构建失败（聊天时退回静态样本）', { sessionId, ...errorToLogData(e) })
    }

    sendProgress('done', '克隆完成', 100)
    logger?.warn?.('Persona', '画像构建完成', {
      sessionId,
      elapsedMs: Date.now() - startedAt,
      friendMessageCount: corpus.stats.friendMessageCount,
      groupMessageCount: groupCorpus?.friendMessageCount || 0,
      stickerCount: stickers.length,
      fewShotCount: persona.fewShots.length,
      profileChunkCount: profileChunks.length,
      hasProfile: !!profile,
      provider: providerConfig.name,
      model: providerConfig.model,
    })
    return { success: true, persona }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger?.error?.('Persona', '画像构建失败', { sessionId, elapsedMs: Date.now() - startedAt, ...errorToLogData(e) })
    sendProgress('error', '克隆失败', 100, message)
    return { success: false, error: message }
  }
}

import { Aperture, Image as ImageIcon, Loader2, Mic, RefreshCw, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Tooltip } from '@heroui/react'
import { DateJumpPicker } from './DateJumpPicker'
import type { ChatSession } from '../../../types/models'
import { isGroupChat } from '../utils/messageGuards'
import { SessionAvatar } from './SessionSidebar'

type Progress = {
  current: number
  total: number
}

interface ChatHeaderProps {
  currentSession: ChatSession
  currentSessionId: string | null
  isRefreshingMessages: boolean
  isLoadingMessages: boolean
  isUpdating: boolean
  onRefreshMessages: () => void | Promise<void>
  selectedDate: string
  onSelectedDateChange: (value: string) => void
  onJumpToDate: (dateValue?: string) => void | Promise<void>
  isJumpingToDate: boolean
  isBatchTranscribing: boolean
  batchTranscribeProgress: Progress
  onBatchTranscribe: () => void | Promise<void>
  isBatchDecrypting: boolean
  batchDecryptProgress: Progress
  onBatchDecrypt: () => void | Promise<void>
}

export function ChatHeader({
  currentSession,
  currentSessionId,
  isRefreshingMessages,
  isLoadingMessages,
  isUpdating,
  onRefreshMessages,
  selectedDate,
  onSelectedDateChange,
  onJumpToDate,
  isJumpingToDate,
  isBatchTranscribing,
  batchTranscribeProgress,
  onBatchTranscribe,
  isBatchDecrypting,
  batchDecryptProgress,
  onBatchDecrypt
}: ChatHeaderProps) {
  // 向量化（语义索引）状态：null=未知/未启用嵌入，count=已建片段数
  const [vecBuilding, setVecBuilding] = useState(false)
  const [vecStatus, setVecStatus] = useState<{ enabled: boolean; count: number } | null>(null)
  const [vecError, setVecError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setVecError(null)
    if (!currentSessionId) {
      setVecStatus(null)
      return
    }
    void window.electronAPI.embedding.sessionStatus(currentSessionId).then((res) => {
      if (!cancelled && res.success) setVecStatus({ enabled: !!res.enabled, count: res.count ?? 0 })
    })
    return () => { cancelled = true }
  }, [currentSessionId])

  const handleVectorize = async () => {
    if (!currentSessionId || vecBuilding) return
    setVecBuilding(true)
    setVecError(null)
    try {
      const res = await window.electronAPI.embedding.buildSession(currentSessionId)
      if (res.success) setVecStatus({ enabled: true, count: res.indexed ?? 0 })
      else setVecError(res.error || '向量化失败')
    } catch (e) {
      setVecError(e instanceof Error ? e.message : String(e))
    } finally {
      setVecBuilding(false)
    }
  }

  const vecDisabled = !currentSessionId || vecBuilding || (vecStatus !== null && !vecStatus.enabled)
  const vecTooltip = vecBuilding
    ? '正在向量化…'
    : vecError
      ? `向量化失败：${vecError}`
      : vecStatus && !vecStatus.enabled
        ? '未启用嵌入模型（设置 → 嵌入）'
        : vecStatus && vecStatus.count > 0
          ? `已向量化 ${vecStatus.count} 段 · 点击更新`
          : '为此会话建立语义索引'

  return (
    <div className="message-header">
      <SessionAvatar session={currentSession} size={40} />
      <div className="header-info">
        <h3>
          {currentSession.displayName || currentSession.username}
          {currentSession.isWeCom && (
            currentSession.weComCorp
              ? <span className="wecom-corp" title="企业微信">@{currentSession.weComCorp}</span>
              : <span className="wecom-badge" title="企业微信">企</span>
          )}
        </h3>
        {isGroupChat(currentSession.username) && (
          <div className="header-subtitle">群聊</div>
        )}
      </div>
      <div className="header-actions">
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="刷新消息"
              onPress={onRefreshMessages}
              isDisabled={isRefreshingMessages || isLoadingMessages}
            >
              <RefreshCw size={18} className={isRefreshingMessages || isUpdating ? 'animate-spin' : ''} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>刷新消息</Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="向量化（语义索引）"
              onPress={handleVectorize}
              isDisabled={vecDisabled}
            >
              {vecBuilding
                ? <Loader2 size={18} className="animate-spin" />
                : <Sparkles size={18} className={vecStatus && vecStatus.count > 0 ? 'text-primary' : ''} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{vecTooltip}</Tooltip.Content>
        </Tooltip>

        {!isGroupChat(currentSession.username) && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="查看朋友圈"
                onPress={() => window.electronAPI.window.openMomentsWindow(currentSession.username)}
              >
                <Aperture size={18} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>查看朋友圈</Tooltip.Content>
          </Tooltip>
        )}

        <DateJumpPicker
          value={selectedDate}
          onChange={onSelectedDateChange}
          onJump={onJumpToDate}
          disabled={!currentSessionId || isJumpingToDate}
          loading={isJumpingToDate}
        />

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="批量语音转文字"
              onPress={onBatchTranscribe}
              isDisabled={isBatchTranscribing || !currentSessionId}
            >
              {isBatchTranscribing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            {isBatchTranscribing ? `批量转写中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})` : '批量语音转文字'}
          </Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="批量解密图片"
              onPress={onBatchDecrypt}
              isDisabled={isBatchDecrypting || !currentSessionId}
            >
              {isBatchDecrypting ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            {isBatchDecrypting ? `批量解密中 (${batchDecryptProgress.current}/${batchDecryptProgress.total})` : '批量解密图片'}
          </Tooltip.Content>
        </Tooltip>
      </div>
    </div>
  )
}

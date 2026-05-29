export type Scope =
  | { kind: 'session'; sessionId: string; sessionName?: string }
  | { kind: 'global' }

export interface ProviderCfg {
  provider: string
  apiKey: string
  model: string
  enableThinking?: boolean
  temperature?: number
}

export interface ConversationHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ScopedSession {
  id: string
  name: string
}

export interface ConversationRequest {
  requestId: string
  scope: Scope
  conversationId?: number
  history: ConversationHistoryMessage[]
  message: string
  provider: ProviderCfg
  commandHint?: string
  forceThinking?: boolean
  readLimit?: number
  skillIds?: string[]
  scopedSessions?: ScopedSession[]
}

export type StreamEvent =
  | { type: 'content_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_done'; toolCall: { id?: string; function: { name: string; arguments: string } } }
  | { type: 'tool_result'; toolCallId?: string; toolName: string; result: unknown; error?: string }
  | { type: 'round_start' }
  | { type: 'message_done'; toolCalls?: unknown[] }

export type ProgressStatus = 'running' | 'completed' | 'failed'

export interface ProgressEvent {
  id: string
  stage: 'intent' | 'tool' | 'context' | 'retrieve' | 'analyze' | 'answer' | 'thought' | string
  status: ProgressStatus
  title: string
  displayName?: string
  nodeName?: string
  detail?: string
  toolName?: string
  query?: string
  count?: number
  createdAt?: number
  requestId?: string
  source?: string
  elapsedMs?: number
  diagnostics?: string[]
}

export interface ConversationSummary {
  id: number
  title: string
  preview: string
  updatedAt: number
}

export interface MessageRecord {
  id: number
  conversationId: number
  role: string
  content: string
  blocksJson?: string | null
  createdAt: number
}

export interface ConversationDetail extends ConversationSummary {
  messages: MessageRecord[]
}

export interface RunConversationResult {
  conversationId: number
}

export type StreamEmit = (event: StreamEvent) => void
export type ProgressEmit = (event: ProgressEvent) => void

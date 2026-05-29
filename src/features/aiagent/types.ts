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

export type MessageRole = 'user' | 'assistant'

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  streaming?: boolean
}

export interface ToolResult {
  kind: 'snippet' | 'terminal' | 'diff' | 'list'
  lang?: string
  text?: string
  items?: string[]
}

export interface ToolBlock {
  type: 'tool'
  name: string
  status: 'running' | 'ok' | 'error'
  args?: Record<string, unknown>
  result?: ToolResult | null
  duration?: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface CardBlock {
  type: 'card'
  kind: 'export-wizard'
  sessionId?: string
  sessionName?: string
}

export type AssistantBlock = ThinkingBlock | ToolBlock | TextBlock | CardBlock

export interface Message {
  id: string
  role: MessageRole
  content?: string
  blocks?: AssistantBlock[]
  streaming?: boolean
  attached?: AttachedResource[]
  progressEvents?: ProgressEvent[]
}

export interface ConversationItem {
  id: string
  title: string
  preview: string
  time: string
}

export interface ConversationGroup {
  group: string
  items: ConversationItem[]
}

export interface SlashCommand {
  command: string
  description: string
}

export interface AttachedResource {
  id: string
  label: string
  icon: 'database'
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpServer {
  id: string
  name: string
  toolCount: number
  status: McpServerStatus
  error?: string
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  builtin?: boolean
}

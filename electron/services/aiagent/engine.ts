import type {
  ConversationRequest,
  ProgressEmit,
  RunConversationResult,
  StreamEmit
} from './types'

export async function run(
  _request: ConversationRequest,
  _emit: StreamEmit,
  _onProgress: ProgressEmit,
  _signal: AbortSignal
): Promise<RunConversationResult> {
  throw new Error('[AIAgent] engine is not wired yet')
}

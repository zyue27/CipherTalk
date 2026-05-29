import type { Scope } from './types'

export type SessionScope = Extract<Scope, { kind: 'session' }>
export type GlobalScope = Extract<Scope, { kind: 'global' }>

export function isSessionScope(scope: Scope): scope is SessionScope {
  return scope.kind === 'session'
}

export function isGlobalScope(scope: Scope): scope is GlobalScope {
  return scope.kind === 'global'
}

export function resolveScope(scope: Scope): Scope {
  if (isGlobalScope(scope)) return { kind: 'global' }

  const sessionId = scope.sessionId.trim()
  if (!sessionId) {
    throw new Error('[AIAgent] session scope requires sessionId')
  }

  return {
    kind: 'session',
    sessionId,
    ...(scope.sessionName ? { sessionName: scope.sessionName } : {})
  }
}

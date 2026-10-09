import type { AdvisorDiagnostics, AdvisorQueryContext, AdvisorSessionSummary, AdvisorTurn, Evidence } from './types.ts'

export function defaultAdvisorQueryContext(): AdvisorQueryContext {
  return { selectedSourceIds: [], includeSimulationContext: true, selectedZoneIds: [], zoneScopeMode: 'all', sourceVisibility: 'public' }
}

export function queryContextForSession(turns: AdvisorTurn[]): AdvisorQueryContext {
  const context = [...turns].reverse().find((turn) => turn.queryContext)?.queryContext
  return context
    ? {
        selectedSourceIds: [...context.selectedSourceIds],
        includeSimulationContext: context.includeSimulationContext,
        selectedZoneIds: [...(context.selectedZoneIds ?? [])],
        zoneScopeMode: context.zoneScopeMode === 'focused' ? 'focused' : 'all',
        sourceVisibility: context.sourceVisibility === 'all' ? 'all' : 'public',
      }
    : defaultAdvisorQueryContext()
}

export function hasPersistedQueryContext(turns: AdvisorTurn[]) {
  return turns.some((turn) => turn.queryContext !== null)
}

export function diagnosticsForAdvisorTurn(turn: AdvisorTurn | null): AdvisorDiagnostics {
  if (!turn?.assistantMessage) {
    return {
      provider: 'local', privacy: 'local_only', requestedModel: null, requestedServiceTier: null, model: null, serviceTier: null, fallbackReason: null,
      path: [], gateReason: '아직 AI 재배 조언을 실행하지 않았습니다.', runId: null,
      backend: null, candidateCount: null, returnedCount: null, queryScope: null, channels: [],
    }
  }
  return {
    provider: turn.execution.provider,
    privacy: turn.execution.privacy,
    requestedModel: turn.execution.requestedModel,
    requestedServiceTier: turn.execution.requestedServiceTier,
    model: turn.execution.model,
    serviceTier: turn.execution.serviceTier,
    fallbackReason: turn.execution.fallbackReason,
    path: turn.assistantMessage.searchPath ?? [],
    gateReason: turn.assistantMessage.gateReason ?? '그래프 경로를 사용하지 않았습니다.',
    runId: turn.retrieval.runId,
    backend: turn.retrieval.backend,
    candidateCount: turn.retrieval.candidateCount,
    returnedCount: turn.retrieval.returnedCount,
    queryScope: turn.retrieval.queryScope,
    channels: turn.retrieval.channels,
  }
}

export function upsertAdvisorTurn(turns: AdvisorTurn[], next: AdvisorTurn) {
  const index = turns.findIndex((turn) => turn.id === next.id)
  if (index < 0) return [...turns, next]
  return turns.map((turn) => (turn.id === next.id ? next : turn))
}

export function evidenceForMessage(turns: AdvisorTurn[], messageId: string): Evidence[] {
  return turns.find((turn) => turn.assistantMessage?.id === messageId)?.evidence ?? []
}

export function latestCompletedTurn(turns: AdvisorTurn[]) {
  return [...turns].reverse().find((turn) => turn.status === 'complete') ?? null
}

export function advisorSummaryTurnForView(
  storedTurn: AdvisorTurn | null,
  sessions: AdvisorSessionSummary[],
  activeSessionId: string | null,
  activeTurns: AdvisorTurn[],
) {
  if (!activeSessionId || sessions[0]?.id !== activeSessionId) return storedTurn
  return latestCompletedTurn(activeTurns) ?? storedTurn
}

export function upsertAdvisorSession(sessions: AdvisorSessionSummary[], next: AdvisorSessionSummary) {
  return [...sessions.filter((session) => session.id !== next.id), next]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function filterAdvisorSessions(sessions: AdvisorSessionSummary[], query: string) {
  const normalized = query.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return sessions
  return sessions.filter((session) => `${session.title} ${session.preview}`.toLocaleLowerCase().replace(/\s+/g, ' ').includes(normalized))
}

export function nextSessionAfterDelete(sessions: AdvisorSessionSummary[], deletedId: string) {
  return sessions.find((session) => session.id !== deletedId) ?? null
}

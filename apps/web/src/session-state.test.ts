import assert from 'node:assert/strict'
import test from 'node:test'
import { advisorSummaryTurnForView, diagnosticsForAdvisorTurn, evidenceForMessage, filterAdvisorSessions, hasPersistedQueryContext, latestCompletedTurn, nextSessionAfterDelete, queryContextForSession, upsertAdvisorSession, upsertAdvisorTurn } from './session-state.ts'
import type { AdvisorSessionSummary, AdvisorTurn, Evidence } from './types.ts'

const execution = { provider: 'local' as const, privacy: 'local_only' as const, requestedModel: null, requestedServiceTier: null, model: null, serviceTier: null, fallbackReason: null }
const retrieval = { runId: null, backend: null, candidateCount: 0, returnedCount: 0, queryScope: null, channels: [] }

function evidence(id: string): Evidence {
  return {
    id, sourceId: id, sourceKind: 'public_knowledge', sourceGroupId: null, documentId: null, source: id, category: '공개 지식', excerpt: id, score: 1, locator: 'p. 1', path: 'Dense', selected: true,
    issuer: null, publishedYear: null, documentType: null, sourceUrl: null, summary: null, sourceLocator: null,
    crop: null, cultivationSystem: null, evidenceClass: null, growthStage: null, embeddingModel: null,
  }
}

function turn(id: string, evidenceId: string): AdvisorTurn {
  return {
    id,
    userMessage: { id: `${id}-user`, role: 'user', content: id, createdAt: '10:00' },
    assistantMessage: { id: `${id}-assistant`, role: 'assistant', content: id, createdAt: '10:01', evidenceIds: [evidenceId] },
    evidence: [evidence(evidenceId)], execution, retrieval, responseId: id, controlDrafts: [], toolTrace: null, agentRun: null, queryContext: { selectedSourceIds: [evidenceId], includeSimulationContext: false, selectedZoneIds: [], zoneScopeMode: 'all', sourceVisibility: 'public' }, status: 'complete', error: null,
  }
}

test('two advisor turns retain message-scoped evidence', () => {
  const turns = upsertAdvisorTurn(upsertAdvisorTurn([], turn('first', 'source-a')), turn('second', 'source-b'))
  assert.deepEqual(evidenceForMessage(turns, 'first-assistant').map((item) => item.id), ['source-a'])
  assert.deepEqual(evidenceForMessage(turns, 'second-assistant').map((item) => item.id), ['source-b'])
  assert.equal(latestCompletedTurn(turns)?.id, 'second')
})

test('session restoration uses the latest query context and diagnostics', () => {
  const first = turn('first', 'source-a')
  const baseSecond = turn('second', 'source-b')
  const second: AdvisorTurn = {
    ...baseSecond,
    assistantMessage: { ...baseSecond.assistantMessage!, searchPath: ['Dense', 'Graph'], gateReason: '그래프 활성' },
    execution: { ...execution, provider: 'llmgateway', privacy: 'public_only_remote' },
    retrieval: { ...retrieval, queryScope: 'public' },
    queryContext: { selectedSourceIds: ['source-b'], includeSimulationContext: true, selectedZoneIds: ['zone-b'], zoneScopeMode: 'focused', sourceVisibility: 'all' },
  }
  assert.deepEqual(queryContextForSession([first, second]), { selectedSourceIds: ['source-b'], includeSimulationContext: true, selectedZoneIds: ['zone-b'], zoneScopeMode: 'focused', sourceVisibility: 'all' })
  assert.equal(diagnosticsForAdvisorTurn(second).provider, 'llmgateway')
  assert.deepEqual(diagnosticsForAdvisorTurn(second).path, ['Dense', 'Graph'])
  assert.equal(diagnosticsForAdvisorTurn(second).queryScope, 'public')
  assert.deepEqual(queryContextForSession([]), { selectedSourceIds: [], includeSimulationContext: true, selectedZoneIds: [], zoneScopeMode: 'all', sourceVisibility: 'public' })
})

test('session restoration distinguishes an intentionally empty source context from a new session', () => {
  const saved = { ...turn('saved-empty', 'source-a'), queryContext: { selectedSourceIds: [], includeSimulationContext: true, selectedZoneIds: [], zoneScopeMode: 'all' as const, sourceVisibility: 'public' as const } }
  assert.equal(hasPersistedQueryContext([saved]), true)
  assert.deepEqual(queryContextForSession([saved]).selectedSourceIds, [])
  assert.equal(hasPersistedQueryContext([]), false)
})

test('completing one turn does not replace the other turn', () => {
  const first = turn('first', 'source-a')
  const second = { ...turn('second', 'source-b'), status: 'loading' as const, assistantMessage: null, evidence: [] }
  const completedSecond = turn('second', 'source-b')
  const turns = upsertAdvisorTurn(upsertAdvisorTurn([first], second), completedSecond)
  assert.equal(turns.length, 2)
  assert.equal(turns[0].evidence[0].id, 'source-a')
  assert.equal(turns[1].evidence[0].id, 'source-b')
})

function session(id: string, title: string, preview: string, updatedAt: string): AdvisorSessionSummary {
  return { id, farmId: 'farm-wasabi-a', title, preview, turnCount: 1, createdAt: updatedAt, updatedAt }
}

test('session updates stay unique and sort by latest activity', () => {
  const older = session('older', '근권 온도', '첫 조언', '2026-07-20T01:00:00Z')
  const newer = session('newer', '관수 점검', '둘째 조언', '2026-07-21T01:00:00Z')
  const updated = { ...older, preview: '갱신된 조언', updatedAt: '2026-07-22T01:00:00Z' }
  const sessions = upsertAdvisorSession([older, newer], updated)
  assert.deepEqual(sessions.map((item) => item.id), ['older', 'newer'])
  assert.equal(sessions[0].preview, '갱신된 조언')
})

test('session search covers title and preview without changing the source list', () => {
  const sessions = [
    session('root', '근권 온도', '냉각기 점검', '2026-07-21T01:00:00Z'),
    session('ec', '양액 관리', '공급 EC 상승', '2026-07-20T01:00:00Z'),
  ]
  assert.deepEqual(filterAdvisorSessions(sessions, '  공급   ec ').map((item) => item.id), ['ec'])
  assert.equal(sessions.length, 2)
  assert.equal(nextSessionAfterDelete(sessions, 'root')?.id, 'ec')
  assert.equal(nextSessionAfterDelete([sessions[0]], 'root'), null)
})

test('keeps the latest stored advice summary while the advisor opens as a new conversation', () => {
  const stored = turn('stored', 'source-a')
  const latest = session('latest', '최신 조언', '요약', '2026-07-22T01:00:00Z')
  assert.equal(advisorSummaryTurnForView(stored, [latest], null, []), stored)

  const fresh = turn('fresh', 'source-b')
  assert.equal(advisorSummaryTurnForView(stored, [latest], 'latest', [fresh]), fresh)
  assert.equal(advisorSummaryTurnForView(stored, [latest], 'older', [fresh]), stored)
})

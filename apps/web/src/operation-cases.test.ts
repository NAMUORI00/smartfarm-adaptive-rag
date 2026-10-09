import assert from 'node:assert/strict'
import test from 'node:test'
import { groupOperationCaseEvidence, incidentContextForTarget, operationCaseDateGroup, operationCaseProgress, operationCaseStatusLabel, operationCaseSummary, operationCaseTimelineDetail, sortOperationCases, truthModeLabel } from './operation-cases.ts'
import type { DashboardSnapshot, OperationCase } from './types.ts'

const incidents: DashboardSnapshot['incidents'] = [
  {
    id: 'incident-root', alertId: 'farm-wasabi-a:root_zone_temperature_c:threshold:high', occurrenceId: 'occ-root',
    zoneId: 'zone-a', severity: 'critical', status: 'open', message: '근권 온도 고온', openedAt: '2026-07-29T01:00:00Z', lastObservedAt: '2026-07-29T01:01:00Z', resolvedAt: null,
  },
  {
    id: 'incident-flow', alertId: 'farm-wasabi-a:irrigation-flow:crop-risk', occurrenceId: 'occ-flow',
    zoneId: 'zone-b', severity: 'warning', status: 'open', message: '관수 유량 부족', openedAt: '2026-07-29T01:00:00Z', lastObservedAt: '2026-07-29T01:01:00Z', resolvedAt: null,
  },
]

function operationCase(id: string, status: OperationCase['status'], observedAt: string): OperationCase {
  return {
    id, incidentId: id, alertId: id, occurrenceId: id, title: id, zoneId: 'zone-a', severity: 'warning', status,
    recoveryVerdict: status === 'resolved' ? 'recovered' : status === 'handoff' ? 'unrecovered' : 'pending',
    dataMode: 'simulated', inputMode: 'demo', openedAt: observedAt, lastObservedAt: observedAt, acknowledgedAt: null, resolvedAt: null,
    expectedOutcome: '', observedOutcome: '', nextAction: '', evidence: [], actions: [], timeline: [],
  }
}

test('shows an explicit input truth label without inferring live from data mode', () => {
  assert.equal(truthModeLabel('demo'), '실습 데이터')
  assert.equal(truthModeLabel('replay'), '기록 재생')
  assert.equal(truthModeLabel('live'), '현장 연결')
  assert.equal(truthModeLabel('unavailable'), '연결 확인')
})

test('links manual device actions to the exact active incident when unambiguous', () => {
  assert.equal(incidentContextForTarget(incidents, 'root_zone_chiller')?.occurrenceId, 'occ-root')
  assert.equal(incidentContextForTarget(incidents, 'irrigation_pump')?.occurrenceId, 'occ-flow')
  assert.equal(incidentContextForTarget(incidents, 'root_zone_chiller', 'zone-a')?.occurrenceId, 'occ-root')
  assert.equal(incidentContextForTarget(incidents, 'root_zone_chiller', 'zone-b'), null)
  assert.equal(incidentContextForTarget(incidents, 'irrigation_pump', 'zone-a'), null)
  assert.equal(incidentContextForTarget(incidents, 'irrigation_pump', 'zone-b')?.occurrenceId, 'occ-flow')
  assert.equal(incidentContextForTarget(incidents, 'air_temperature_sensor_reset'), null)
  assert.equal(incidentContextForTarget([incidents[0]], 'shade_curtain')?.occurrenceId, 'occ-root')
})

test('puts handoff and active cases before resolved history', () => {
  const sorted = sortOperationCases([
    operationCase('resolved', 'resolved', '2026-07-29T03:00:00Z'),
    operationCase('monitoring', 'monitoring', '2026-07-29T02:00:00Z'),
    operationCase('handoff', 'handoff', '2026-07-29T01:00:00Z'),
  ])
  assert.deepEqual(sorted.map((item) => item.id), ['handoff', 'monitoring', 'resolved'])
  assert.equal(operationCaseStatusLabel('handoff'), '현장 점검 필요')
})

test('summarizes a case as an operator-readable result', () => {
  const resolved = operationCase('resolved', 'resolved', '2026-07-29T12:00:00')
  resolved.observedOutcome = '센서 정상 범위 복귀를 확인했습니다.'
  assert.equal(operationCaseSummary(resolved), '센서 정상 범위 복귀를 확인했습니다.')

  const pending = operationCase('pending', 'awaiting_approval', '2026-07-29T12:00:00')
  assert.equal(operationCaseSummary(pending), '준비된 장치 조정을 확인하면 바로 반영합니다.')
})

test('maps each case to the four operator-facing progress steps', () => {
  const active = operationCase('active', 'needs_action', '2026-07-29T12:00:00')
  assert.deepEqual(operationCaseProgress(active).map((step) => step.state), ['completed', 'current', 'pending', 'pending'])

  const resolved = operationCase('resolved', 'resolved', '2026-07-29T12:00:00')
  assert.deepEqual(operationCaseProgress(resolved).map((step) => step.state), ['completed', 'completed', 'completed', 'completed'])

  const handoff = operationCase('handoff', 'handoff', '2026-07-29T12:00:00')
  assert.equal(operationCaseProgress(handoff).at(-1)?.state, 'attention')
})

test('groups records into familiar calendar labels', () => {
  const now = new Date('2026-07-29T15:00:00')
  assert.equal(operationCaseDateGroup('2026-07-29T09:00:00', now), '오늘')
  assert.equal(operationCaseDateGroup('2026-07-28T09:00:00', now), '어제')
  assert.equal(operationCaseDateGroup('2026-07-20T09:00:00', now), '7월 20일')
})

test('groups repeated operating observations and document chunks by their original source', () => {
  const groups = groupOperationCaseEvidence([
    { sourceId: 'farm:telemetry:air', title: '현재 센서·경보 관측', kind: 'operation', issuer: null, sourceUrl: null, sourceLocator: null },
    { sourceId: 'farm:alerts:latest', title: '현재 센서·경보 관측', kind: 'operation', issuer: null, sourceUrl: null, sourceLocator: null },
    { sourceId: 'document:page-1', title: '재배 자료', kind: 'document', issuer: '농촌진흥청', sourceUrl: 'https://example.test/guide.pdf#page=1', sourceLocator: '1쪽' },
    { sourceId: 'document:page-2', title: '재배 자료', kind: 'document', issuer: '농촌진흥청', sourceUrl: 'https://example.test/guide.pdf#page=2', sourceLocator: '2쪽' },
  ])
  assert.deepEqual(groups.map((group) => group.items.length), [2, 2])
  assert.equal(operationCaseTimelineDetail({ id: 'evidence', stage: 'evidence', state: 'completed', occurredAt: null, title: '근거 확인', detail: '문서와 운영 관측 4개를 확인했습니다.' }, groups.length), '원본 기준 근거 2개를 확인했습니다.')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { controlDraftCanBeReviewed, controlMatchesScenario, controlProgressForDraft, proposalForDraft } from './control-progress.ts'
import type { Approval, ControlDraft } from './types.ts'

const draft: ControlDraft = {
  id: 'draft-1', origin: 'verified_telemetry_rule', action: 'recalibrate_air_temperature_sensor', target: 'air_temperature_sensor_reset', zoneId: 'zone-a', value: true,
  rationale: '센서 드리프트 재보정', evidenceIds: ['evidence-1'], advisorMessageId: 'message-1',
  advisorRunId: 'advisor-1', alertId: 'farm-wasabi-a:air_temperature_c:sensor-health', alertOccurrenceId: 'occurrence-1', beforeState: 'fault',
}

function proposal(status: Approval['status'], overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'proposal-1', target: 'air_temperature_sensor_reset', zoneId: 'zone-a', requestedValue: '재보정 실행',
    action: '공기 온도 센서 재보정 재보정 실행', device: '공기 온도 센서 재보정', proposedBy: 'operator',
    reason: '센서 드리프트 재보정', impact: '', status, createdAt: '10:00',
    executionStatus: status === 'approved' ? 'applied_to_simulator' : status === 'failed' ? 'failed' : 'not_executed',
    executionId: null, correlationId: null, executedAt: null, failureReason: null,
    origin: 'verified_telemetry_rule', advisorRunId: 'advisor-1', evidenceIds: ['evidence-1'], alertId: draft.alertId, alertOccurrenceId: draft.alertOccurrenceId, verification: null,
    ...overrides,
  }
}

test('matches a proposal by advisor run or alert provenance', () => {
  assert.equal(proposalForDraft(draft, [proposal('waiting')])?.id, 'proposal-1')
  assert.equal(proposalForDraft({ ...draft, advisorRunId: null }, [proposal('waiting')])?.id, 'proposal-1')
  assert.equal(proposalForDraft({ ...draft, advisorRunId: 'new-run' }, [proposal('waiting')]), null)
  assert.equal(proposalForDraft({ ...draft, advisorRunId: 'other', alertId: 'other' }, [proposal('waiting')]), null)
})

test('matches duplicate logical targets only within the exact zone', () => {
  const zoneB = proposal('approved', { id: 'proposal-zone-b', zoneId: 'zone-b' })
  const zoneA = proposal('approved', { id: 'proposal-zone-a', zoneId: 'zone-a' })
  assert.equal(proposalForDraft(draft, [zoneB, zoneA])?.id, 'proposal-zone-a')
  assert.equal(proposalForDraft({ ...draft, zoneId: 'zone-b' }, [zoneA, zoneB])?.id, 'proposal-zone-b')
})

test('maps each incident to the device that can recover it', () => {
  assert.equal(controlMatchesScenario('root_zone_chiller', 'root_cooling_fault'), true)
  assert.equal(controlMatchesScenario('irrigation_pump', 'irrigation_blockage'), true)
  assert.equal(controlMatchesScenario('ventilation_fan', 'high_humidity_stagnation'), true)
  assert.equal(controlMatchesScenario('roof_vent', 'high_humidity_stagnation'), true)
  assert.equal(controlMatchesScenario('side_vent', 'high_humidity_stagnation'), true)
  assert.equal(controlMatchesScenario('irrigation_pump', 'ec_drift'), true)
  assert.equal(controlMatchesScenario('air_temperature_sensor_reset', 'temperature_sensor_drift'), true)
  assert.equal(controlMatchesScenario('side_vent', 'ventilation_stuck', 'farm-wasabi-a:relative_humidity_pct:threshold:high'), true)
  assert.equal(controlMatchesScenario('root_zone_chiller', 'temperature_sensor_drift'), false)
  assert.equal(controlMatchesScenario('irrigation_pump', 'ec_drift', 'farm-wasabi-a:supply_ec_ds_m:threshold:high'), true)
  assert.equal(controlMatchesScenario('irrigation_pump', 'irrigation_blockage', 'farm-wasabi-a:supply_ec_ds_m:threshold:high'), false)
})

test('separates permission, device change, and environmental recovery states', () => {
  assert.equal(controlProgressForDraft(draft, [], undefined, undefined, [draft.alertOccurrenceId!]).label, '허용 필요')
  assert.equal(controlProgressForDraft(draft, [proposal('waiting')], undefined, undefined, [draft.alertOccurrenceId!]).label, '변경 중')
  assert.equal(controlProgressForDraft(draft, [proposal('approved')]).label, '장치 반영 완료')
  assert.equal(controlProgressForDraft(draft, [proposal('approved')], 'recovery', 'temperature_sensor_drift').label, '환경 회복 중')
  assert.equal(controlProgressForDraft(draft, [proposal('approved')], 'recovered', 'temperature_sensor_drift').label, '해결됨')
  assert.equal(controlProgressForDraft(draft, [proposal('approved')], 'recovered', 'temperature_sensor_drift', [draft.alertOccurrenceId!]).label, '경보 지속')
  assert.equal(controlProgressForDraft(draft, [proposal('approved')], 'recovered', 'root_cooling_fault').label, '장치 반영 완료')
  assert.equal(controlProgressForDraft(draft, [proposal('rejected')]).label, '변경 안 됨')
})

test('retains the post-change verification on the matched advisor proposal', () => {
  const verified = proposal('approved', {
    verification: {
      status: 'verified',
      outcome: 'device_applied',
      checkedAt: '2026-07-22T01:00:00Z',
      targetState: '재보정 완료',
      requestedValue: true,
      detail: '요청한 상태가 반영되었습니다.',
    },
  })

  const progress = controlProgressForDraft(draft, [verified])
  assert.equal(progress.proposal?.verification?.status, 'verified')
  assert.equal(progress.proposal?.verification?.targetState, '재보정 완료')

  const uncertain = controlProgressForDraft(draft, [proposal('approved', {
    verification: {
      status: 'unavailable',
      outcome: 'unavailable',
      checkedAt: '2026-07-22T01:01:00Z',
      targetState: null,
      requestedValue: true,
      detail: '최신 상태를 다시 확인하지 못했습니다.',
    },
  })])
  assert.equal(uncertain.label, '결과 확인 필요')
  assert.equal(uncertain.stage, 'failed')
})

test('escalates a verified device change when environmental recovery is not observed', () => {
  const unrecovered = proposal('approved', {
    verification: {
      status: 'verified', outcome: 'unrecovered', checkedAt: '2026-07-22T01:04:00Z',
      targetState: 'on', requestedValue: true, detail: '환경 회복이 확인되지 않아 현장 점검이 필요합니다.',
    },
  })
  const progress = controlProgressForDraft(draft, [unrecovered])
  assert.equal(progress.stage, 'failed')
  assert.equal(progress.label, '현장 점검 필요')
})

test('uses authoritative recovery outcomes instead of completing at device application', () => {
  const pending = proposal('approved', {
    verification: {
      status: 'verified', outcome: 'recovery_pending', checkedAt: '2026-07-22T01:02:00Z',
      targetState: '재보정 반영', requestedValue: true, detail: '센서 회복을 확인하고 있습니다.',
    },
  })
  const resolved = proposal('approved', {
    verification: {
      status: 'verified', outcome: 'resolved', checkedAt: '2026-07-22T01:03:00Z',
      targetState: '정상', requestedValue: true, detail: '센서 경보 해소를 확인했습니다.',
    },
  })

  assert.equal(controlProgressForDraft(draft, [pending]).label, '환경 회복 중')
  assert.equal(controlProgressForDraft(draft, [pending]).stage, 'recovery')
  assert.equal(controlProgressForDraft(draft, [resolved]).label, '문제 해결')
  assert.equal(controlProgressForDraft(draft, [resolved]).stage, 'resolved')
})

test('keeps ended alert drafts as non-actionable history', () => {
  assert.equal(controlDraftCanBeReviewed(draft, [draft.alertOccurrenceId!]), true)
  assert.equal(controlDraftCanBeReviewed(draft, []), false)
  assert.equal(controlDraftCanBeReviewed({ ...draft, alertId: null, alertOccurrenceId: null }, []), true)
  assert.equal(controlDraftCanBeReviewed(draft, ['occurrence-2']), false)

  const ended = controlProgressForDraft(draft, [], undefined, undefined, [])
  assert.equal(ended.stage, 'archived')
  assert.equal(ended.label, '종료된 경보 기록')
  assert.equal(controlProgressForDraft(draft, [proposal('waiting')], undefined, undefined, []).stage, 'archived')
})

test('reports recovery only for the originating incident across every visible scenario', () => {
  const incidents: Array<{ scenarioId: string; target: Approval['target']; alertId: string }> = [
    { scenarioId: 'root_cooling_fault', target: 'root_zone_chiller', alertId: 'farm-wasabi-a:root_zone_temperature_c:threshold:high' },
    { scenarioId: 'irrigation_blockage', target: 'irrigation_pump', alertId: 'farm-wasabi-a:irrigation-flow:crop-risk' },
    { scenarioId: 'high_humidity_stagnation', target: 'ventilation_fan', alertId: 'farm-wasabi-a:relative_humidity_pct:threshold:high' },
    { scenarioId: 'ec_drift', target: 'irrigation_pump', alertId: 'farm-wasabi-a:supply_ec_ds_m:threshold:high' },
    { scenarioId: 'temperature_sensor_drift', target: 'air_temperature_sensor_reset', alertId: 'farm-wasabi-a:air_temperature_c:sensor-health' },
    { scenarioId: 'ventilation_stuck', target: 'side_vent', alertId: 'farm-wasabi-a:relative_humidity_pct:threshold:high' },
  ]
  for (const incident of incidents) {
    const incidentDraft = { ...draft, target: incident.target, alertId: incident.alertId }
    const incidentProposal = proposal('approved', { target: incident.target, alertId: incident.alertId })
    assert.equal(controlProgressForDraft(incidentDraft, [incidentProposal], 'recovery', incident.scenarioId).label, '환경 회복 중')
    assert.equal(controlProgressForDraft(incidentDraft, [incidentProposal], 'recovered', incident.scenarioId).label, '해결됨')
    assert.equal(controlProgressForDraft(incidentDraft, [incidentProposal], 'recovered', incident.scenarioId, [incidentDraft.alertOccurrenceId!]).label, '경보 지속')
  }
})

test('does not match an old draft or proposal to a recurring alert with the same alert id', () => {
  const recurringOccurrenceIds = ['occurrence-2']
  const oldProposal = proposal('waiting')

  assert.equal(controlDraftCanBeReviewed(draft, recurringOccurrenceIds), false)
  assert.equal(
    proposalForDraft(
      { ...draft, advisorRunId: null, alertOccurrenceId: 'occurrence-2' },
      [oldProposal],
    ),
    null,
  )
})

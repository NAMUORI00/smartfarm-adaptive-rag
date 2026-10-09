import type { Approval, ControlDraft } from './types.ts'
import { sameControlScope } from './operator-ui.ts'

export type ControlProgress = {
  stage: 'review' | 'waiting' | 'executed' | 'recovery' | 'resolved' | 'failed' | 'archived'
  label: string
  detail: string
  proposal: Approval | null
}

export function controlDraftCanBeReviewed(draft: ControlDraft, activeAlertOccurrenceIds: string[]) {
  return !draft.alertId || Boolean(
    draft.alertOccurrenceId && activeAlertOccurrenceIds.includes(draft.alertOccurrenceId),
  )
}

export function proposalForDraft(draft: ControlDraft, approvals: Approval[]) {
  const sameOccurrence = (proposal: Approval) => (
    sameControlScope(proposal, draft)
    && (!draft.alertId || proposal.alertOccurrenceId === draft.alertOccurrenceId)
  )
  if (draft.advisorRunId) {
    return approvals.find(
      (proposal) => proposal.advisorRunId === draft.advisorRunId && sameOccurrence(proposal),
    ) ?? null
  }
  return draft.alertId
    ? approvals.find((proposal) => proposal.alertId === draft.alertId && sameOccurrence(proposal)) ?? null
    : null
}

export function controlMatchesScenario(
  target: Approval['target'],
  scenarioId?: string,
  alertId?: string | null,
) {
  if (!scenarioId) return false
  const targetsByScenario: Record<string, Approval['target'][]> = {
    root_cooling_fault: ['root_zone_chiller'],
    irrigation_blockage: ['irrigation_pump'],
    high_humidity_stagnation: ['ventilation_fan', 'roof_vent', 'side_vent'],
    ventilation_stuck: ['ventilation_fan', 'side_vent'],
    ec_drift: ['irrigation_pump'],
    temperature_sensor_drift: ['air_temperature_sensor_reset'],
    high_temperature: ['ventilation_fan', 'roof_vent', 'side_vent', 'root_zone_chiller'],
    ec_rise: ['irrigation_pump'],
    moisture_low: ['irrigation_pump'],
    temperature_sensor_fault: ['air_temperature_sensor_reset'],
  }
  if (!(targetsByScenario[scenarioId]?.includes(target) ?? false)) return false
  if (alertId === undefined) return true
  if (!alertId) return false
  const alertPartsByScenario: Record<string, string[]> = {
    root_cooling_fault: ['root_zone_temperature_c:threshold:high'],
    irrigation_blockage: ['irrigation-flow:crop-risk', 'substrate_moisture_pct:threshold:low'],
    high_humidity_stagnation: ['relative_humidity_pct:threshold:high'],
    ventilation_stuck: ['relative_humidity_pct:threshold:high'],
    ec_drift: ['supply_ec_ds_m:threshold:high', 'drain_ec_ds_m:threshold:high'],
    temperature_sensor_drift: ['air_temperature_c:sensor-health'],
    high_temperature: ['air_temperature_c:threshold:high'],
    ec_rise: ['supply_ec_ds_m:threshold:high', 'drain_ec_ds_m:threshold:high'],
    moisture_low: ['substrate_moisture_pct:threshold:low'],
    temperature_sensor_fault: ['air_temperature_c:sensor-health'],
  }
  const normalizedAlertId = alertId.toLowerCase()
  return alertPartsByScenario[scenarioId]?.some((part) => normalizedAlertId.includes(part)) ?? false
}

export function controlProgressForDraft(
  draft: ControlDraft,
  approvals: Approval[],
  scenarioPhase?: 'normal' | 'ramp' | 'hold' | 'recovery' | 'recovered',
  scenarioId?: string,
  activeAlertOccurrenceIds: string[] = [],
): ControlProgress {
  const proposal = proposalForDraft(draft, approvals)
  if (!controlDraftCanBeReviewed(draft, activeAlertOccurrenceIds) && (!proposal || proposal.status === 'waiting')) {
    return { stage: 'archived', label: '종료된 경보 기록', detail: '경보가 끝나 이 조정안은 더 이상 허용하거나 실행할 수 없습니다.', proposal }
  }
  if (!proposal) return { stage: 'review', label: '허용 필요', detail: 'AI가 제안한 장치 조정을 확인하고 허용할 수 있습니다.', proposal: null }
  if (proposal.status === 'waiting') return { stage: 'waiting', label: '변경 중', detail: '장치에 변경 내용을 전달하고 있습니다.', proposal }
  if (proposal.status === 'rejected' || proposal.status === 'failed' || proposal.executionStatus === 'failed') {
    return { stage: 'failed', label: '변경 안 됨', detail: proposal.failureReason ?? '취소되었거나 장치 변경을 완료하지 못했습니다.', proposal }
  }
  if (proposal.verification?.outcome === 'device_pending') {
    return { stage: 'waiting', label: '장치 반영 중', detail: proposal.verification.detail, proposal }
  }
  if (proposal.verification && proposal.verification.status !== 'verified') {
    return { stage: 'failed', label: '결과 확인 필요', detail: proposal.verification.detail, proposal }
  }
  if (proposal.verification?.outcome === 'unrecovered') {
    return { stage: 'failed', label: '현장 점검 필요', detail: proposal.verification.detail, proposal }
  }
  if (proposal.verification?.outcome === 'recovery_pending') {
    return { stage: 'recovery', label: '환경 회복 중', detail: proposal.verification.detail, proposal }
  }
  if (proposal.verification?.outcome === 'resolved') {
    return { stage: 'resolved', label: '문제 해결', detail: proposal.verification.detail, proposal }
  }
  if (proposal.verification?.outcome === 'device_applied') {
    return { stage: 'executed', label: '장치 반영 완료', detail: proposal.verification.detail, proposal }
  }
  const matchingScenario = controlMatchesScenario(proposal.target, scenarioId, draft.alertId)
  const alertStillActive = Boolean(
    draft.alertOccurrenceId && activeAlertOccurrenceIds.includes(draft.alertOccurrenceId),
  )
  if (matchingScenario && scenarioPhase === 'recovery') return { stage: 'recovery', label: '환경 회복 중', detail: '장치 변경은 끝났고 센서 값이 정상으로 돌아오는지 확인하고 있습니다.', proposal }
  if (matchingScenario && scenarioPhase === 'recovered' && !alertStillActive) return { stage: 'resolved', label: '해결됨', detail: '장치 조정 후 센서가 정상 범위로 돌아왔습니다.', proposal }
  if (matchingScenario && scenarioPhase === 'recovered' && alertStillActive) return { stage: 'executed', label: '경보 지속', detail: '장치 변경 후에도 경보가 남아 있어 추가 확인이 필요합니다.', proposal }
  return { stage: 'executed', label: '장치 반영 완료', detail: '허용한 조정이 장치에 반영되었습니다.', proposal }
}

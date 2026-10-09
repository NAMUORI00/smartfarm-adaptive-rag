import type { ControlTarget, DashboardSnapshot, OperationCase, OperationCaseEvidence } from './types'

export type OperationCaseEvidenceGroup = {
  id: string
  items: OperationCaseEvidence[]
  representative: OperationCaseEvidence
}

function normalizedEvidenceUrl(value: string) {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.trim().replace(/\/$/, '').toLocaleLowerCase()
  }
}

export function groupOperationCaseEvidence(evidence: OperationCaseEvidence[]): OperationCaseEvidenceGroup[] {
  const grouped = new Map<string, OperationCaseEvidence[]>()
  for (const item of evidence) {
    const id = item.kind === 'operation'
      ? `operation:${item.title.trim().toLocaleLowerCase()}`
      : item.sourceUrl
        ? `url:${normalizedEvidenceUrl(item.sourceUrl)}`
        : `source:${item.sourceId}`
    grouped.set(id, [...(grouped.get(id) ?? []), item])
  }
  return [...grouped.entries()].map(([id, items]) => ({ id, items, representative: items[0] }))
}

export function operationCaseTimelineDetail(
  item: OperationCase['timeline'][number],
  evidenceGroupCount: number,
) {
  if (item.stage !== 'evidence') return item.detail
  return evidenceGroupCount ? `원본 기준 근거 ${evidenceGroupCount}개를 확인했습니다.` : item.detail
}

export function truthModeLabel(mode: DashboardSnapshot['inputMode']) {
  return ({
    demo: '실습 데이터',
    replay: '기록 재생',
    live: '현장 연결',
    mixed: '혼합 연결',
    unavailable: '연결 확인',
  } as const)[mode]
}

export function operationCaseStatusLabel(status: OperationCase['status']) {
  return ({
    needs_action: '확인 필요',
    awaiting_approval: '허용 대기',
    monitoring: '회복 확인 중',
    resolved: '해결됨',
    handoff: '현장 점검 필요',
  } as const)[status]
}

export function operationCaseSummary(record: OperationCase) {
  const observed = record.observedOutcome.trim()
  const nextAction = record.nextAction.trim()
  if (record.status === 'resolved') return observed || '센서가 정상 범위로 돌아온 것을 확인했습니다.'
  if (record.status === 'handoff') return observed || nextAction || '현장 확인이 필요한 상태입니다.'
  if (record.status === 'monitoring') return observed || '조치 후 센서가 정상 범위로 돌아오는지 확인하고 있습니다.'
  if (record.status === 'awaiting_approval') return nextAction || '준비된 장치 조정을 확인하면 바로 반영합니다.'
  return nextAction || record.expectedOutcome.trim() || '원인과 사용할 수 있는 조치를 확인하고 있습니다.'
}

export function operationCaseProgress(record: OperationCase) {
  const acknowledged = Boolean(record.acknowledgedAt) || record.status !== 'needs_action'
  const actionCompleted = record.actions.some((action) => action.status === 'approved' && Boolean(action.executedAt || action.executionId))
    || record.status === 'resolved'
  const actionPending = record.status === 'awaiting_approval' || record.actions.some((action) => action.status === 'pending_approval')
  return [
    { id: 'detected', label: '감지', state: 'completed' as const },
    { id: 'acknowledged', label: '확인', state: acknowledged ? 'completed' as const : 'current' as const },
    {
      id: 'action',
      label: record.actions.length ? '장치 조정' : '처리',
      state: actionCompleted ? 'completed' as const : record.status === 'handoff' ? 'attention' as const : actionPending ? 'current' as const : 'pending' as const,
    },
    {
      id: 'outcome',
      label: record.status === 'resolved' ? '정상 회복' : record.status === 'handoff' ? '현장 점검' : '회복',
      state: record.status === 'resolved' ? 'completed' as const : record.status === 'handoff' ? 'attention' as const : record.status === 'monitoring' ? 'current' as const : 'pending' as const,
    },
  ]
}

export function operationCaseDateGroup(value: string, now = new Date()) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '이전 기록'
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  const difference = Math.round((today - day) / 86_400_000)
  if (difference === 0) return '오늘'
  if (difference === 1) return '어제'
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(date)
}

export function sortOperationCases(records: OperationCase[]) {
  const priority: Record<OperationCase['status'], number> = {
    handoff: 0,
    needs_action: 1,
    awaiting_approval: 2,
    monitoring: 3,
    resolved: 4,
  }
  return [...records].sort((left, right) => (
    priority[left.status] - priority[right.status]
    || new Date(right.lastObservedAt).valueOf() - new Date(left.lastObservedAt).valueOf()
  ))
}

function incidentTargetScore(incident: DashboardSnapshot['incidents'][number], target: ControlTarget) {
  const text = `${incident.alertId} ${incident.message}`.toLowerCase()
  if (target === 'air_temperature_sensor_reset') return /air_temperature.*sensor|온도 센서|센서.*온도/.test(text) ? 5 : 0
  if (target === 'root_zone_chiller') return /root_zone_temperature|근권.*온도|냉각/.test(text) ? 5 : 0
  if (target === 'heater') return /root_zone_temperature.*low|air_temperature.*low|저온|난방/.test(text) ? 5 : 0
  if (target === 'irrigation_pump') return /irrigation|pump|flow|pressure|tank|관수|유량|압력|탱크/.test(text) ? 5 : 0
  if (target === 'ventilation_fan' || target === 'roof_vent' || target === 'side_vent') {
    return /humidity|air_temperature|ventilation|습도|재배실 온도|환기/.test(text) ? 4 : 0
  }
  if (target === 'shade_curtain') return /temperature.*high|ppfd|고온|광량|차광/.test(text) ? 3 : 0
  return 0
}

export function incidentContextForTarget(
  incidents: DashboardSnapshot['incidents'],
  target: ControlTarget,
  zoneId?: string | null,
) {
  const active = incidents.filter((incident) => (
    incident.status !== 'resolved'
    && (!zoneId || incident.zoneId === zoneId)
  ))
  const ranked = active
    .map((incident) => ({ incident, score: incidentTargetScore(incident, target) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
  if (ranked.length && (ranked.length === 1 || ranked[0].score > ranked[1].score)) return ranked[0].incident
  return !zoneId && active.length === 1 ? active[0] : null
}

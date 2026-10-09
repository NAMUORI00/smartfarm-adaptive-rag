type ApiValidationIssue = {
  type?: unknown
  loc?: unknown
  msg?: unknown
  ctx?: unknown
}

const validationFieldLabels: Record<string, string> = {
  action: '조정 방식',
  target: '장치',
  requested_action: '조정 방식',
  requested_target: '장치',
  value: '설정값',
  target_value: '설정값',
  zone_id: '적용 구역',
  zone_ids: '적용 구역',
  scenario_id: '테스트 상황',
  scenario_ids: '테스트 상황',
  rationale: '조정 사유',
  question: '질문',
  query: '검색어',
  evidence_ids: '답변 근거',
  advisor_run_id: 'AI 작업 정보',
  alert_id: '경보 연결 정보',
  alert_occurrence_id: '경보 연결 정보',
  context_alert_id: '경보 연결 정보',
  context_alert_occurrence_id: '경보 연결 정보',
  seed: '테스트 기준값',
}

function validationField(issue: ApiValidationIssue) {
  if (!Array.isArray(issue.loc)) return null
  const field = [...issue.loc].reverse().find((item) => typeof item === 'string' && item !== 'body')
  return typeof field === 'string' ? field : null
}

function validationContextNumber(issue: ApiValidationIssue, key: string) {
  if (!issue.ctx || typeof issue.ctx !== 'object') return null
  const value = (issue.ctx as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeApiErrorDetail(detail: unknown, statusCode: number) {
  if (typeof detail === 'string' && detail.trim()) {
    if (/[가-힣]/.test(detail)) return detail.trim()
    if (/already has the requested state/i.test(detail)) return '이미 선택한 상태입니다. 새 명령은 만들지 않았습니다.'
    if (/correlation|idempotency/i.test(detail)) return '같은 요청 번호의 내용을 확인하세요. 이전 요청을 다시 조회해 주세요.'
    return statusCode === 409 ? '장치·관측 또는 이전 요청 상태가 달라졌습니다. 최신 상태를 확인하세요.' : statusCode === 403 ? '이 작업을 실행할 권한이나 운영 조건을 확인하세요.' : '요청 결과를 확인하지 못했습니다. 연결과 입력 내용을 확인하세요.'
  }
  if (detail && !Array.isArray(detail) && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  if (!Array.isArray(detail)) return '농장 정보를 불러오지 못했습니다. 연결을 다시 확인해 주세요.'

  const issues = detail.filter((item): item is ApiValidationIssue => Boolean(item) && typeof item === 'object')
  if (issues.some((issue) => Array.isArray(issue.loc) && issue.loc[0] === 'header')) {
    return '요청 연결 정보를 확인하지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.'
  }
  const evidenceIssue = issues.find((issue) => validationField(issue) === 'evidence_ids')
  if (evidenceIssue) {
    const maximum = validationContextNumber(evidenceIssue, 'max_length')
    return maximum
      ? `답변 근거는 최대 ${maximum}개까지 사용할 수 있습니다.`
      : '답변 근거가 너무 많습니다. 필요한 자료만 선택해 주세요.'
  }

  const issue = issues[0]
  if (!issue) return statusCode === 422 ? '입력 내용을 확인해 주세요.' : '농장 정보를 불러오지 못했습니다. 연결을 다시 확인해 주세요.'
  const field = validationField(issue)
  const label = field ? validationFieldLabels[field] : null
  const type = typeof issue.type === 'string' ? issue.type : ''
  const rawMessage = typeof issue.msg === 'string' ? issue.msg.toLowerCase() : ''

  if (rawMessage.includes('normal cannot be combined')) return '정상 상태와 장애 테스트를 함께 선택할 수 없습니다.'
  if (rawMessage.includes('must be unique')) return '같은 테스트 상황이나 구역을 중복 선택할 수 없습니다.'
  if (rawMessage.includes('scenario_id must be included')) return '선택한 테스트 상황 구성을 다시 확인해 주세요.'
  if (rawMessage.includes('advisor provenance') || rawMessage.includes('manual incident context')) return 'AI 조정안의 근거 연결을 다시 확인해 주세요.'
  if (rawMessage.includes('sensor recalibration')) return '센서 다시 맞추기 요청의 장치와 설정값을 확인해 주세요.'
  if (type === 'missing') return label ? `${label} 값이 필요합니다.` : '필수 입력값을 확인해 주세요.'
  if (type.includes('literal')) return label ? `${label}에서 지원하는 항목을 선택해 주세요.` : '지원하는 항목을 선택해 주세요.'
  if (type.includes('too_long') || type.includes('max_length')) {
    const maximum = validationContextNumber(issue, 'max_length')
    if (label && maximum) {
      return type.startsWith('string_')
        ? `${label}은 ${maximum}자 이내로 입력해 주세요.`
        : `${label}은 최대 ${maximum}개까지 사용할 수 있습니다.`
    }
    return `${label ?? '입력 내용'}이 너무 깁니다.`
  }
  if (type.includes('too_short') || type.includes('min_length')) {
    if (field === 'rationale') return '조정 사유를 조금 더 구체적으로 입력해 주세요.'
    return `${label ?? '입력 내용'}을 조금 더 구체적으로 입력해 주세요.`
  }
  return label ? `${label} 입력 내용을 확인해 주세요.` : '입력 내용을 확인해 주세요.'
}

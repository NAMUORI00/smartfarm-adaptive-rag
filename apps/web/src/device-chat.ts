import type { AdvisorAgentStep, AdvisorToolDevice, ControlTarget } from './types.ts'
import { logicalControlTarget } from './operator-ui.ts'

const OPERATIONAL_SUBJECT_TERMS = /(근권\s*온도|배지\s*수분|온도|습도|ec|ph|co2|광량|일사|유량|압력|수위|장치|기기|설비|센서|냉각기|칠러|관수|펌프|환기|팬|천창|측창|차광|커튼|난방|히터)/i
const CONTROL_TERMS = /(조절|조정|변경|설정|켜|끄|가동|정지|시작|멈|열|닫|재보정|보정|맞춰|낮춰|낮추|높여|높이|줄여|줄이|올려|올리|해결|복구)/i
const LIVE_STATE_TERMS = /(현재|지금|실시간|상태|측정|센서값|값을|사용 가능|가능한|목록|어떤|활성|작동|운전|켜져|꺼져|왜|원인|이상|문제|높아|낮아|확인|점검)/i
const FARM_KNOWLEDGE_TERMS = /(고추냉이|스마트팜|재배|농장|작물|생육|근권|배지|양액|병해|병충해|수경|농업|수확|논문|근거|출처|자료|문서|연구)/i
const SELECTED_SOURCE_REFERENCE_TERMS = /(선택한|켜둔|이\s*(자료|문서|원본|내용)|해당\s*(자료|문서|원본)|위\s*(자료|문서|원본))/i
const OPERATIONAL_SCOPE_TERMS = /(전체\s*구역|[12일이]\s*구역|모든\s*구역|농장\s*전체)/i
const FOLLOW_UP_TERMS = /^(?:네[,.]?\s*|응[,.]?\s*)?(요청할게|그렇게\s*해줘|다시\s*확인해봐|진행해줘|확인해줘|승인.*요청해줘)[.!?\s]*$/i

export function isOperationalAdvisorQuestion(question: string) {
  const normalized = question.trim()
  if (!normalized) return false
  if (OPERATIONAL_SCOPE_TERMS.test(normalized) && /정상|확인|상태|알려|점검/.test(normalized)) return true
  return OPERATIONAL_SUBJECT_TERMS.test(normalized)
    && (CONTROL_TERMS.test(normalized) || LIVE_STATE_TERMS.test(normalized))
}

export function isGeneralConversationQuestion(question: string, hasSelectedSources = false) {
  const normalized = question.trim()
  if (!normalized || FOLLOW_UP_TERMS.test(normalized) || isOperationalAdvisorQuestion(normalized) || FARM_KNOWLEDGE_TERMS.test(normalized) || OPERATIONAL_SUBJECT_TERMS.test(normalized)) return false
  if (hasSelectedSources && SELECTED_SOURCE_REFERENCE_TERMS.test(normalized)) return false
  return true
}

export function advisorDeviceGroups(devices: AdvisorToolDevice[], question: string, targets: ControlTarget[] = []) {
  const relevant = new Set<ControlTarget>(targets)
  if (/습도|환기/.test(question)) ['ventilation_fan', 'roof_vent', 'side_vent'].forEach((target) => relevant.add(target as ControlTarget))
  if (/근권|냉각|칠러/.test(question)) relevant.add('root_zone_chiller')
  if (/관수|수분|유량|압력|펌프/.test(question)) relevant.add('irrigation_pump')
  if (/온도|난방|히터/.test(question) && !/근권/.test(question)) ['heater', 'ventilation_fan', 'roof_vent', 'side_vent'].forEach((target) => relevant.add(target as ControlTarget))
  if (/광량|일사|차광|커튼/.test(question)) relevant.add('shade_curtain')
  const zones: string[] = /전체|모든/.test(question) ? [] : [...question.matchAll(/([12])\s*구역/g)].map((match) => match[1] === '2' ? 'zone-b' : 'zone-a')
  const focused = devices.filter((device) => {
    const target = device.target ?? logicalControlTarget(device.key)
    return target !== null && relevant.has(target) && (!zones.length || zones.includes(device.zoneId ?? ''))
  })
  return { focused, remaining: devices.filter((device) => !focused.includes(device)) }
}

export function compactAdvisorSteps(steps: AdvisorAgentStep[], labelFor: (step: AdvisorAgentStep) => string) {
  const completedLabels = new Set<string>()
  return steps.filter((step) => {
    if (step.status !== 'completed') return true
    const label = labelFor(step)
    if (completedLabels.has(label)) return false
    completedLabels.add(label)
    return true
  })
}

export function deviceAdjustmentRange(device: AdvisorToolDevice) {
  const target = device.target ?? logicalControlTarget(device.key)
  if (!device.controllable) return '상태 확인만 가능'
  if (target === 'air_temperature_sensor_reset') return '필요할 때 한 번 다시 맞추기'
  if (device.valueType === 'percentage') {
    const minimum = device.minimum ?? 0
    const maximum = device.maximum ?? 100
    return `${minimum}–${maximum}% 범위에서 조정`
  }
  if (target === 'root_zone_chiller') return '냉각 켜기 · 끄기'
  if (target === 'irrigation_pump') return '관수 시작 · 멈춤'
  if (target === 'heater') return '난방 켜기 · 끄기'
  if (device.valueType === 'boolean') return '켜기 · 끄기'
  return '조정 범위 확인 중'
}

export function normalizeRangeValue(value: number, minimum: number, maximum: number, step: number) {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1
  const clamped = Math.max(minimum, Math.min(maximum, value))
  const snapped = minimum + Math.round((clamped - minimum) / safeStep) * safeStep
  const precision = Math.max(
    (String(minimum).split('.')[1] ?? '').length,
    (String(safeStep).split('.')[1] ?? '').length,
  )
  return Number(Math.max(minimum, Math.min(maximum, snapped)).toFixed(precision))
}

export function rangeSelectionForCurrent(value: number, minimum: number, maximum: number, step: number) {
  const normalized = normalizeRangeValue(value, minimum, maximum, step)
  return { value: normalized, needsApply: !Object.is(normalized, value) }
}

export function rangeSelectionForActuator(
  reportedValue: number,
  desiredValue: number | boolean | null | undefined,
  minimum: number,
  maximum: number,
  step: number,
) {
  if (typeof desiredValue === 'number' && Number.isFinite(desiredValue) && desiredValue >= minimum && desiredValue <= maximum) {
    const normalized = normalizeRangeValue(desiredValue, minimum, maximum, step)
    return { value: normalized, needsApply: !Object.is(normalized, desiredValue) }
  }
  return rangeSelectionForCurrent(reportedValue, minimum, maximum, step)
}

export function expectedControlImpact(target: ControlTarget, value: number | boolean) {
  const enabled = typeof value === 'boolean' ? value : value > 0
  if (target === 'root_zone_chiller') {
    return enabled
      ? '근권 온도를 낮추는 방향으로 작동하며, 변경 후 온도 추세를 확인합니다.'
      : '냉각을 멈추며, 변경 후 근권 온도 상승 여부를 확인합니다.'
  }
  if (target === 'irrigation_pump') {
    return enabled
      ? '관수 유량·압력과 배지 수분이 회복되는지 확인합니다.'
      : '관수를 멈추며, 배지 수분 변화를 계속 확인합니다.'
  }
  if (target === 'ventilation_fan') return '공기 순환이 달라져 내부 온도와 습도 균일도에 영향을 줄 수 있습니다.'
  if (target === 'roof_vent' || target === 'side_vent') return '환기량이 달라져 내부 온도·습도와 외기 유입이 변할 수 있습니다.'
  if (target === 'shade_curtain') return '일사 유입과 내부 온도 상승 속도에 영향을 줄 수 있습니다.'
  if (target === 'heater') {
    return enabled
      ? '내부 온도를 높이는 방향으로 작동하며, 변경 후 과열 여부를 확인합니다.'
      : '난방을 멈추며, 변경 후 내부 온도 하락 여부를 확인합니다.'
  }
  return '온도 센서를 다시 맞춘 뒤 주변 센서와의 편차를 확인합니다.'
}

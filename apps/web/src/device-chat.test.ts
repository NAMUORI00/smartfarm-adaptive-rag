import assert from 'node:assert/strict'
import test from 'node:test'
import { advisorDeviceGroups, compactAdvisorSteps, deviceAdjustmentRange, expectedControlImpact, isGeneralConversationQuestion, isOperationalAdvisorQuestion, normalizeRangeValue, rangeSelectionForActuator, rangeSelectionForCurrent } from './device-chat.ts'
import type { AdvisorToolDevice } from './types.ts'

function device(overrides: Partial<AdvisorToolDevice> = {}): AdvisorToolDevice {
  return {
    key: 'ventilation_fan',
    target: 'ventilation_fan',
    zoneId: 'zone-a',
    label: '순환팬',
    state: '40%',
    controllable: true,
    valueType: 'percentage',
    minimum: 0,
    maximum: 100,
    ...overrides,
  }
}

test('allows source-free submission only for explicit live status or device requests', () => {
  assert.equal(isOperationalAdvisorQuestion('현재 관수 펌프 상태와 조정 범위를 보여줘'), true)
  assert.equal(isOperationalAdvisorQuestion('어떤 기기가 활성화되어 있어?'), true)
  assert.equal(isOperationalAdvisorQuestion('환기팬을 60%로 조정해줘'), true)
  assert.equal(isOperationalAdvisorQuestion('환기팬을 60%로 설정해줘'), true)
  assert.equal(isOperationalAdvisorQuestion('지금 근권 온도 센서값을 알려줘'), true)
  assert.equal(isOperationalAdvisorQuestion('근권온도를 낮춰줘'), true)
  assert.equal(isOperationalAdvisorQuestion('근권온도가 왜 높아?'), true)
  assert.equal(isOperationalAdvisorQuestion('고추냉이 적정 온도 근거를 알려줘'), false)
  assert.equal(isOperationalAdvisorQuestion('관수 관리 기준을 설명해줘'), false)
})

test('allows everyday conversation without swallowing farm knowledge or operation requests', () => {
  assert.equal(isOperationalAdvisorQuestion('전체 구역이 정상적인지 알려줘'), true)
  assert.equal(isGeneralConversationQuestion('전체 구역이 정상적인지 알려줘'), false)
  assert.equal(isGeneralConversationQuestion('요청할게'), false)
  assert.equal(isGeneralConversationQuestion('그렇게 해줘'), false)
  assert.equal(isGeneralConversationQuestion('안녕'), true)
  assert.equal(isGeneralConversationQuestion('오늘 기분은 어때?'), true)
  assert.equal(isGeneralConversationQuestion('무엇을 할 수 있어?'), true)
  assert.equal(isGeneralConversationQuestion('고마워'), true)
  assert.equal(isGeneralConversationQuestion('짧은 농담을 해줘'), true)
  assert.equal(isGeneralConversationQuestion('프랑스의 수도는 어디야?'), true)
  assert.equal(isGeneralConversationQuestion('안녕, 현재 센서 상태 알려줘'), false)
  assert.equal(isGeneralConversationQuestion('안녕, 고추냉이 적정 온도 근거를 알려줘'), false)
  assert.equal(isGeneralConversationQuestion('환기팬을 켜줘'), false)
  assert.equal(isGeneralConversationQuestion('이 내용을 요약해줘', true), false)
})

test('focuses humidity devices by zone without discarding the complete inventory', () => {
  const devices = [device(), device({ key: 'zone-b:ventilation_fan', zoneId: 'zone-b' }), device({ key: 'root_zone_chiller', target: 'root_zone_chiller' })]
  const grouped = advisorDeviceGroups(devices, '2구역 습도를 조절해줘')
  assert.deepEqual(grouped.focused.map((entry) => entry.key), ['zone-b:ventilation_fan'])
  assert.equal(grouped.remaining.length + grouped.focused.length, devices.length)
  assert.equal(advisorDeviceGroups(devices, '전체 구역 습도').focused.length, 2)
  assert.equal(advisorDeviceGroups(devices, '상태 확인').remaining.length, 3)
  assert.equal(advisorDeviceGroups(devices, '요청할게', ['root_zone_chiller']).focused[0].target, 'root_zone_chiller')
})

test('deduplicates completed progress labels while keeping failed and pending checks visible', () => {
  const base = { kind: 'tool' as const, label: '현재 상태 확인', toolName: 'get_farm_snapshot', detail: null }
  const steps = [
    { ...base, sequence: 1, status: 'completed' as const },
    { ...base, sequence: 2, status: 'completed' as const },
    { ...base, sequence: 3, status: 'failed' as const },
    { ...base, sequence: 4, status: 'running' as const },
  ]
  assert.deepEqual(compactAdvisorSteps(steps, (step) => step.label).map((step) => step.sequence), [1, 3, 4])
})

test('describes operator-facing adjustment ranges without internal terminology', () => {
  assert.equal(deviceAdjustmentRange(device()), '0–100% 범위에서 조정')
  assert.equal(deviceAdjustmentRange(device({ key: 'zone-a:irrigation_pump', target: 'irrigation_pump', valueType: 'boolean' })), '관수 시작 · 멈춤')
  assert.equal(deviceAdjustmentRange(device({ controllable: false })), '상태 확인만 가능')
  assert.doesNotMatch(deviceAdjustmentRange(device()), /MCP|tool/i)
})

test('explains expected effects as observable operational outcomes', () => {
  assert.match(expectedControlImpact('irrigation_pump', true), /유량·압력.*배지 수분/)
  assert.match(expectedControlImpact('ventilation_fan', 60), /온도와 습도/)
  assert.match(expectedControlImpact('air_temperature_sensor_reset', true), /편차/)
})

test('snaps displayed control targets to the exact slider step', () => {
  assert.equal(normalizeRangeValue(69, 0, 100, 5), 70)
  assert.equal(normalizeRangeValue(12.4, 10, 20, 0.5), 12.5)
  assert.equal(normalizeRangeValue(105, 0, 100, 5), 100)
  assert.deepEqual(rangeSelectionForCurrent(69, 0, 100, 5), { value: 70, needsApply: true })
  assert.deepEqual(rangeSelectionForCurrent(70, 0, 100, 5), { value: 70, needsApply: false })
  assert.deepEqual(rangeSelectionForActuator(78.2, 80, 0, 100, 5), { value: 80, needsApply: false })
  assert.deepEqual(rangeSelectionForActuator(69, null, 0, 100, 5), { value: 70, needsApply: true })
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { Actuator } from './types.ts'
import { actuatorCanBeControlled, actuatorControlTarget, actuatorForControl, actuatorStateIsEnabled, controlIdentity, deviceActionLabel, deviceCategoryForKey, deviceScopeLabel, deviceStateWithMode, filterDevices, normalizedPercent, sensorStability } from './operator-ui.ts'

function actuator(key: string, zoneId: string | null = null): Actuator {
  return { key, zoneId, label: key, state: 'off', controllable: true, executionScope: 'simulator_only', capability: null }
}

test('resolves instance ids and filters actual devices by zone and logical category', () => {
  const opaqueVent = { ...actuator('actuator-42', 'zone-b'), target: 'roof_vent' as const }
  const devices = [actuator('zone-a:root_zone_chiller', 'zone-a'), actuator('zone-a:irrigation_pump', 'zone-a'), opaqueVent, actuator('zone-b:air_temperature_sensor_reset', 'zone-b')]
  assert.equal(actuatorControlTarget(devices[0]), 'root_zone_chiller')
  assert.deepEqual(filterDevices(devices, 'all', 'zone-a').map((item) => item.key), ['zone-a:root_zone_chiller', 'zone-a:irrigation_pump'])
  assert.deepEqual(filterDevices(devices, 'ventilation', 'all').map((item) => item.key), ['actuator-42'])
  assert.equal(deviceCategoryForKey('zone-a:nutrient_dosing'), 'irrigation')
  assert.equal(deviceScopeLabel(devices[1]), 'A동 1구역')
  assert.equal(deviceScopeLabel(devices[2]), 'A동 2구역')
  assert.equal(actuatorForControl(devices, 'roof_vent', 'zone-b')?.key, 'actuator-42')
  assert.equal(controlIdentity('roof_vent', 'zone-b'), 'zone-b:roof_vent')
  assert.equal(actuatorCanBeControlled(opaqueVent), true)
  assert.equal(actuatorCanBeControlled({ ...opaqueVent, zoneId: null }), false)
})

test('uses action-specific control labels', () => {
  assert.equal(deviceActionLabel('root_zone_chiller', true), '냉각 시작')
  assert.equal(deviceActionLabel('irrigation_pump', true), '펌프 켜기')
  assert.equal(deviceActionLabel('roof_vent', 40), '천창 개도율 40%로 조정')
})

test('normalizes only against an explicit range and clamps the marker', () => {
  assert.equal(normalizedPercent(20, 10, 30), 50)
  assert.equal(normalizedPercent(50, 10, 30), 100)
  assert.equal(normalizedPercent(10, 10, 10), 0)
})

test('keeps scheduling separate from the effective device state', () => {
  assert.equal(actuatorStateIsEnabled('scheduled'), false)
  assert.equal(actuatorStateIsEnabled('off'), false)
  assert.equal(actuatorStateIsEnabled('on'), true)
  assert.equal(deviceStateWithMode('scheduled', '멈춤'), '예약됨 · 현재 멈춤')
})

test('excludes invalid sensor quality and reports no data instead of zero stability', () => {
  assert.deepEqual(sensorStability([{ status: 'normal', quality: 'good' }, { status: 'normal', quality: 'stale' }, { status: 'critical', quality: 'bad' }]), { percent: 100, normal: 1, valid: 1, total: 3, needsReview: 2 })
  assert.equal(sensorStability([{ status: 'critical', quality: 'missing' }]).percent, null)
})

test('operator surfaces retain accessible visuals, source roots, and knowledge-save gating', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')
  assert.match(app, /role="img" aria-label=\{label\}/)
  assert.match(app, />전체<\/button>.*>선택됨<\/button>/s)
  assert.doesNotMatch(app, />지식 데이터베이스</)
  assert.match(app, /record\.status === 'resolved' \|\| record\.status === 'handoff'/)
  assert.match(app, /농장 지식으로 저장/)
  assert.match(app, /전체는 보기 범위이며 일괄 실행이 아닙니다/)
  assert.match(app, /현장 장치 연결 전 · 시험 운전/)
  assert.doesNotMatch(app, /상태와 센서 변화가 바로 반영/)
  assert.match(app, /greenhouse-camera-overview\.webp/)
  assert.match(app, /greenhouse-a-zone-1\.webp/)
  assert.match(app, /greenhouse-a-zone-2\.webp/)
  assert.match(app, /greenhouse-b-trial\.webp/)
  const cameraImages = [...app.matchAll(/image: '(\/assets\/greenhouse[^']+\.webp)'/g)].map((match) => match[1])
  assert.equal(cameraImages.length, 4)
  assert.equal(new Set(cameraImages).size, 4)
  assert.doesNotMatch(app, /greenhouse-camera-overview\.png/)
  assert.match(app, /화면 예시/)
  assert.match(app, /B동 시험베드[\s\S]*sensorZone: null,[\s\S]*state: 'preparing'/)
  assert.match(app, /기능 설명용 예시 · 촬영 시각 없음/)
  assert.match(app, /연결 후 사용 가능: 실시간 보기 · 구역별 비교 · 기록 확인/)
  assert.ok(app.indexOf('operator-priority-panel') < app.indexOf('<FieldCameraPanel'), 'risk and work must render before the camera panel')
  assert.match(app, /role="listitem" key=\{view\.id\}><button type="button"/)
  assert.match(styles, /@media \(max-width: 780px\)[\s\S]*\.field-camera-layout \{ grid-template-columns: 1fr; \}/)
  assert.match(api, /\/v1\/operations\/cases\/\$\{encodeURIComponent\(incidentId\)\}\/knowledge/)
  assert.match(api, /zone_id: control\.zoneId/)
  assert.match(api, /zoneId: actuator\.zone_id \?\? \(actuator\.key\.includes\(':\'\) \? actuator\.key\.split\(':\'\)\[0\] : null\)/)
  assert.match(api, /zoneId: proposal\.zone_id \?\? null/)
  assert.match(api, /target: logicalControlTarget\(actuator\.target\) \?\? logicalControlTarget\(actuator\.key\)/)
  assert.match(app, /if \(!target \|\| !actuator\.zoneId \|\| controlsLocked \|\| !canApply\) return/)
})

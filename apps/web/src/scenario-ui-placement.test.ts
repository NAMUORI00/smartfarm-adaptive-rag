import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function functionSource(name: string, nextName: string) {
  const start = app.indexOf(`function ${name}`)
  const end = app.indexOf(`function ${nextName}`, start + 1)
  assert.notEqual(start, -1, `missing ${name}`)
  assert.notEqual(end, -1, `missing ${nextName}`)
  return app.slice(start, end)
}

test('keeps scenario selection in settings and only active status on the dashboard', () => {
  const dashboard = functionSource('Dashboard(', 'ZoneManagementPanel(')
  const settings = functionSource('ModelSettingsDrawer(', 'SettingsSwitch(')

  assert.doesNotMatch(dashboard, /<ScenarioBar/)
  assert.match(dashboard, /hasActiveScenario && <section className="scenario-active-banner"/)
  assert.match(dashboard, />테스트 관리</)
  assert.match(dashboard, /정상 상태로 복귀/)
  assert.match(settings, /settings-scenario-section/)
  assert.match(settings, /<ScenarioBar/)
  assert.match(settings, /현재 로컬 검증 환경에서만 동작합니다/)
})

test('offers only the six scenarios with a verified operator-control recovery path', () => {
  for (const scenarioId of [
    'root_cooling_fault',
    'irrigation_blockage',
    'high_humidity_stagnation',
    'ec_drift',
    'temperature_sensor_drift',
    'ventilation_stuck',
  ]) assert.match(app, new RegExp(`'${scenarioId}'`))

  assert.match(app, /OPERATOR_TEST_SCENARIO_IDS\.has\(scenario\.id\) && scenario\.recoveryActions\.length > 0/)
  assert.doesNotMatch(app.slice(app.indexOf('const OPERATOR_TEST_SCENARIO_IDS'), app.indexOf('function ScenarioBar')), /tank_low|sensor_dropout|pump_flow_mismatch/)
  assert.match(app, /onApply\(primaryId, null, zoneIds\)/)
  assert.doesNotMatch(functionSource('ScenarioBar(', 'metricStatusLabel('), /함께 발생|secondaryOptions/)
})

test('keeps scenario reset separate from the AI settings reset', () => {
  assert.match(app, /onScenarioReset=\{\(\) => void handleDemoReset\(\)\}/)
  assert.match(app, /onReset=\{onScenarioReset\}/)
  assert.match(app, /resetSettings/)
})

test('keeps test controls and status actions usable on narrow screens', () => {
  assert.match(styles, /\.scenario-active-actions button \{ min-height: 44px; \}/)
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]*?\.settings-scenario-section \.scenario-select-row \{ grid-template-columns: 1fr; \}/)
  assert.match(styles, /@media \(max-width: 430px\)[\s\S]*?\.scenario-active-actions \{ display: grid; grid-template-columns: 1fr; \}/)
})

test('shows the normalized scenario validation message instead of hiding it', () => {
  assert.match(app, /catch \(error\) \{\s*setToast\(error instanceof Error \? operationalUiCopy\(error\.message\) : '상황 프로필을 적용하지 못했습니다\.'/)
})

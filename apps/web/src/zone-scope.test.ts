import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('keeps one shared zone selection across dashboard and operations navigation', () => {
  assert.equal((app.match(/const \[selectedZone, setSelectedZone\] = useState<ZoneSelection>\('all'\)/g) ?? []).length, 1)
  const dashboardInvocation = app.match(/&& <Dashboard[^\n]+/)?.[0] ?? ''
  const operationsInvocation = app.match(/&& <Operations[^\n]+/)?.[0] ?? ''
  assert.match(dashboardInvocation, /selectedZone=\{selectedZone\}.*onSelectedZoneChange=\{setSelectedZone\}/)
  assert.match(operationsInvocation, /selectedZone=\{selectedZone\}.*onSelectedZoneChange=\{setSelectedZone\}/)
})

test('does not present one zone trend as an all-zone chart', () => {
  assert.doesNotMatch(app, /const trendZone = selectedZone === 'all'/)
  assert.match(app, /selectedZone === 'all'\s*\? <section className="telemetry-overview telemetry-scope-notice compact panel"/)
  assert.match(app, /센서 추이를 자세히 보려면 구역을 선택하세요/)
  assert.match(app, /위 구역 카드에서 1구역 또는 2구역을 선택할 수 있습니다\./)
})

test('scopes dashboard equipment and operations copy to the selected zone', () => {
  assert.match(app, /snapshot\.actuators\.filter\(\(actuator\) => actuator\.zoneId === selectedZone\)\.slice\(0, 6\)/)
  assert.match(app, /선택한 구역의 센서·장애·장치를 함께 봅니다\./)
  assert.doesNotMatch(app, /선택한 구역의 센서·카메라·장치를 함께 봅니다\./)
})

test('keeps zone scope controls at a touch-friendly height', () => {
  assert.match(styles, /\.zone-switcher button \{[^}]*min-height: 44px;/)
})

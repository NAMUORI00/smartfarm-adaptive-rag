import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_TREND_SAMPLES,
  getSensorTrendDefinition,
  normalizeSvgPoints,
  recentDelta,
  selectSensorTrendSamples,
  sensorTrendGroups,
  type SensorTrendSample,
} from './sensor-trends.ts'

test('groups the six operator sensors by environment, root zone, and nutrient solution', () => {
  assert.deepEqual(sensorTrendGroups.map((group) => group.label), ['환경', '근권', '양액'])
  assert.deepEqual(sensorTrendGroups.map((group) => group.metrics.map((metric) => metric.key)), [
    ['air_temperature_c', 'relative_humidity_pct'],
    ['root_zone_temperature_c', 'substrate_moisture_pct'],
    ['supply_ec_ds_m', 'supply_ph'],
  ])
  assert.equal(getSensorTrendDefinition('supply_ec_ds_m')?.field, 'ec')
  assert.equal(getSensorTrendDefinition('unsupported'), null)
})

test('selects one metric from one zone, filters invalid readings, and orders clock samples', () => {
  const selected = selectSensorTrendSamples({
    'zone-a': [{ time: '09:30', temperature: 12 }],
    'zone-b': [
      { time: '10:30', temperature: 17.8 },
      { time: '09:30', temperature: 17.2 },
      { time: '10:00', temperature: Number.NaN },
      { time: '11:00', temperature: null },
    ],
  }, 'zone-b', 'air_temperature_c')

  assert.deepEqual(selected, [
    { time: '09:30', value: 17.2 },
    { time: '10:30', value: 17.8 },
  ])
})

test('maps substrate moisture and keeps only the latest bounded sample window', () => {
  const points = Array.from({ length: MAX_TREND_SAMPLES + 20 }, (_, index) => ({
    time: new Date(Date.UTC(2026, 6, 31, 0, index)).toISOString(),
    substrateMoisture: index,
  }))
  const selected = selectSensorTrendSamples({ 'zone-a': points }, 'zone-a', 'substrate_moisture_pct', 999)

  assert.equal(selected.length, MAX_TREND_SAMPLES)
  assert.equal(selected[0].value, 20)
  assert.equal(selected.at(-1)?.value, MAX_TREND_SAMPLES + 19)
})

test('normalizes a constant series without NaN or an artificial slope', () => {
  const points = normalizeSvgPoints([
    { time: '09:00', value: 16 },
    { time: '10:00', value: 16 },
    { time: '11:00', value: 16 },
  ], 120, 36, 3)

  assert.deepEqual(points.map((point) => point.y), [18, 18, 18])
  assert.deepEqual(points.map((point) => point.x), [3, 60, 117])
  assert.ok(points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)))
})

test('normalization rejects invalid dimensions and drops invalid values before applying its cap', () => {
  const raw = [
    { time: 'bad', value: Number.NaN },
    ...Array.from({ length: 8 }, (_, index) => ({ time: String(index), value: index })),
  ] satisfies SensorTrendSample[]

  assert.deepEqual(normalizeSvgPoints(raw, 0, 36), [])
  const points = normalizeSvgPoints(raw, 100, 20, 2, 3)
  assert.deepEqual(points.map((point) => point.value), [5, 6, 7])
  assert.deepEqual(points.map((point) => point.y), [18, 10, 2])
})

test('centers a single valid SVG point', () => {
  const [point] = normalizeSvgPoints([{ time: '10:00', value: 6.2 }], 100, 30, 4)
  assert.equal(point.x, 50)
  assert.equal(point.y, 15)
})

test('reports signed recent change from the visible window and handles insufficient data', () => {
  assert.deepEqual(recentDelta([
    { time: '09:00', value: 17.25 },
    { time: '10:00', value: 17.65 },
  ], '°C', 1), { value: 0.4, label: '+0.4 °C', direction: 'up' })
  assert.deepEqual(recentDelta([
    { time: '09:00', value: 64 },
    { time: '10:00', value: 61.5 },
  ], '%', 1), { value: -2.5, label: '-2.5 %', direction: 'down' })
  assert.deepEqual(recentDelta([
    { time: '09:00', value: 2.06 },
    { time: '10:00', value: 2.06 },
  ], 'dS/m', 2), { value: 0, label: '0.00 dS/m', direction: 'steady' })
  assert.equal(recentDelta([{ time: '10:00', value: 6.2 }], 'pH', 2), null)
})

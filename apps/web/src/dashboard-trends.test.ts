import assert from 'node:assert/strict'
import test from 'node:test'
import { synchronizeTelemetryLatest } from './dashboard-trends.ts'
import type { Metric, TelemetryPoint } from './types.ts'

const point: TelemetryPoint = {
  time: '10:00', temperature: 17.5, humidity: 63, co2: 560, ec: 2.1,
  rootZoneTemperature: 16.0, substrateMoisture: 59.2, irrigationFlow: 0, irrigationPressure: 0.15,
  ppfd: 430, supplyPh: 6.2, drainEc: 2.3,
}

function metric(key: string, value: string, zoneId: string): Metric {
  return {
    key, value, zoneId, label: key, unit: '', delta: '', trend: 'steady', tone: 'mint', icon: 'cloud', status: 'normal',
  }
}

test('updates the trend endpoint only from the explicitly selected zone metrics', () => {
  const updated = synchronizeTelemetryLatest([point], [
    metric('root_zone_temperature_c', '16.4', 'zone-b'),
    metric('substrate_moisture_pct', '61.7', 'zone-b'),
    metric('air_temperature_c', '17.9', 'zone-b'),
  ])
  assert.equal(updated[0].rootZoneTemperature, 16.4)
  assert.equal(updated[0].substrateMoisture, 61.7)
  assert.equal(updated[0].temperature, 17.9)
  assert.equal(updated[0].ec, 2.1)
  assert.equal(point.rootZoneTemperature, 16.0)
})

test('does not turn missing, stale, or bad sensor readings into a false trend endpoint', () => {
  const rawLatest = { ...point, time: '10:10', rootZoneTemperature: 15.8, temperature: 17.7 }
  const missingRoot = { ...metric('root_zone_temperature_c', '0', 'zone-a'), quality: 'missing' as const }
  const staleTemperature = { ...metric('air_temperature_c', '99', 'zone-a'), quality: 'stale' as const }
  const updated = synchronizeTelemetryLatest([point, rawLatest], [missingRoot, staleTemperature])

  assert.equal(updated.at(-1)?.rootZoneTemperature, 15.8)
  assert.equal(updated.at(-1)?.temperature, 17.7)
})

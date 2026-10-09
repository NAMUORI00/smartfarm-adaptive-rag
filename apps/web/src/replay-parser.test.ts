import assert from 'node:assert/strict'
import test from 'node:test'

import { parseOperationsReplay } from './replay-parser.ts'

test('groups CSV sensor rows by observation time without inventing values', () => {
  const observations = parseOperationsReplay([
    'observed_at,metric,value,unit,zone_id,sensor_id,quality',
    '2026-07-28T06:00:00Z,air_temperature_c,16.2,°C,zone-a,temp-a,good',
    '2026-07-28T06:00:00Z,relative_humidity_pct,68,%,zone-a,rh-a,good',
    '2026-07-28T06:01:00Z,air_temperature_c,16.4,°C,zone-a,temp-a,suspect',
  ].join('\n'), 'trace.csv')

  assert.equal(observations.length, 2)
  assert.equal(observations[0].readings.length, 2)
  assert.equal(observations[1].readings[0].quality, 'suspect')
  assert.equal(observations[1].sequence, undefined)
})

test('accepts observation-shaped NDJSON and validates sensor metadata', () => {
  const observations = parseOperationsReplay(JSON.stringify({
    observed_at: '2026-07-28T06:00:00Z',
    readings: [{ metric: 'supply_ec_ds_m', value: 2.1, unit: 'dS/m', zone_id: 'zone-b' }],
  }), 'trace.ndjson')

  assert.equal(observations[0].readings[0].zone_id, 'zone-b')
  assert.equal(observations[0].readings[0].quality, 'good')
})

test('rejects malformed records instead of silently filling the replay', () => {
  assert.throws(
    () => parseOperationsReplay('observed_at,metric,value,unit\nnot-a-date,temp,16,°C', 'trace.csv'),
    /관측 시각/,
  )
})

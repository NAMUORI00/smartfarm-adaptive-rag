import assert from 'node:assert/strict'
import test from 'node:test'
import { formatSensorUpdateTime } from './sensor-update-time.ts'

test('sensor receipt timestamps distinguish updates within the same minute', () => {
  const first = formatSensorUpdateTime('2026-09-08T03:42:10Z')
  const next = formatSensorUpdateTime('2026-09-08T03:42:12Z')
  assert.match(first, /2026.*09.*08.*12:42:10$/)
  assert.match(next, /2026.*09.*08.*12:42:12$/)
  assert.notEqual(first, next)
})

test('record dates use the farm day across UTC midnight', () => {
  assert.match(formatSensorUpdateTime('2026-09-08T16:00:00Z'), /2026.*09.*09.*01:00:00$/)
})

test('sensor receipt time stays fixed for unchanged data and never fabricates missing timestamps', () => {
  const source = '2026-09-08T03:42:10Z'
  assert.equal(formatSensorUpdateTime(source), formatSensorUpdateTime(source))
  assert.equal(formatSensorUpdateTime(undefined), '시각 미상')
  assert.equal(formatSensorUpdateTime(null), '시각 미상')
  assert.equal(formatSensorUpdateTime('invalid'), '시각 미상')
})

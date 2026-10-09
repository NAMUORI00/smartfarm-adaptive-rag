import assert from 'node:assert/strict'
import test from 'node:test'
import { controlRequestKey } from './control-request-key.ts'

test('bounds sensor recalibration keys and keeps retries deterministic', async () => {
  const id = `draft:alert-advisor-${'a'.repeat(12)}:alert-occurrence-${'b'.repeat(32)}:zone-b:air_temperature_sensor_reset:true`
  assert.equal(id.length, 123)
  const key = await controlRequestKey(id)
  assert.match(key, /^control-[a-f0-9]{64}$/)
  assert.equal(key, await controlRequestKey(id))
  assert.notEqual(key, await controlRequestKey(`${id}x`))
})

test('preserves existing valid keys and hashes incompatible characters', async () => {
  for (const id of ['12345678', 'a'.repeat(120), 'a9da3ef0-c14d-4b4e-81d2-72a03e7f9b80']) {
    assert.equal(await controlRequestKey(id), id)
  }
  for (const id of ['short', '구역 센서 조정', 'a'.repeat(121)]) {
    assert.match(await controlRequestKey(id), /^control-[a-f0-9]{64}$/)
  }
})

test('does not collapse IDs sharing a long prefix', async () => {
  const prefix = 'a'.repeat(160)
  assert.notEqual(await controlRequestKey(`${prefix}:zone-a`), await controlRequestKey(`${prefix}:zone-b`))
})

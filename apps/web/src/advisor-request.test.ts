import test from 'node:test'
import assert from 'node:assert/strict'
import { AdvisorRequests } from './advisor-request.ts'

test('switching advisor views cannot submit a second question while the farm request is pending', async () => {
  const requests = new AdvisorRequests(); let finish!: () => void; let duplicate = 0
  const first = requests.run('farm-a', () => new Promise<void>(resolve => { finish = resolve }))
  assert.equal(requests.busy('farm-a'), true)
  await assert.rejects(requests.run('farm-a', async () => { duplicate++ }))
  await requests.run('farm-b', async () => {})
  finish(); await first
  assert.equal(duplicate, 0); assert.equal(requests.busy('farm-a'), false)
})
test('failed advisor request releases the shared lock for a deliberate retry', async () => {
  const requests = new AdvisorRequests()
  await assert.rejects(requests.run('farm-a', async () => { throw new Error('offline') }))
  assert.equal(await requests.run('farm-a', async () => 'retry'), 'retry')
})

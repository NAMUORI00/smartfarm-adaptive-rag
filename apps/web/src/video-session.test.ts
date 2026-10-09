import test from 'node:test'
import assert from 'node:assert/strict'
import { VideoSession } from './video-session.ts'
import type { VideoRequest } from './video-session.ts'

test('screen subscribers share one in-flight video request and its retained result', async () => {
  const session = new VideoSession(); let calls = 0
  const first = session.run('research', async () => { calls++; return { id: 'analysis-1' } })
  const second = session.run('research', async () => { calls++; return { id: 'duplicate' } })
  assert.equal(first, second)
  await first
  await session.run('research', async () => { calls++; return { id: 'duplicate' } })
  assert.equal(calls, 1)
  assert.equal(session.read<VideoRequest<{id:string}>>('research')?.value?.id, 'analysis-1')
})
test('retired farm response cannot overwrite a newer selection even if transport ignores abort', async () => {
  const session = new VideoSession(); let resolve!: (s: string) => void
  const old = session.run('analysis', () => new Promise<string>(r => { resolve = r }))
  await Promise.resolve()
  session.cancel('analysis')
  await session.run('analysis', async () => 'new', true)
  resolve('old'); await old
  assert.equal(session.read<VideoRequest<string>>('analysis')?.value, 'new')
})
test('failure is retryable and never presented as abstention or success', async () => {
  const session = new VideoSession()
  await session.run('analysis', async () => { throw new Error('offline') })
  assert.equal(session.read<VideoRequest<string>>('analysis')?.status, 'error')
  await session.run('analysis', async () => 'recovered')
  assert.equal(session.read<VideoRequest<string>>('analysis')?.value, 'recovered')
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { videoSegment } from './video-segment.ts'

test('video segment only includes the frozen playback point and its bounded past', () => {
  assert.deepEqual(videoSegment(15, 100, 10), { start_seconds: 5, end_seconds: 15 })
  assert.deepEqual(videoSegment(3, 100, 10), { start_seconds: 0, end_seconds: 3 })
  assert.deepEqual(videoSegment(120, 100, 90), { start_seconds: 70, end_seconds: 100 })
  assert.deepEqual(videoSegment(0, 100, 10), { start_seconds: 0, end_seconds: 0 })
  assert.deepEqual(videoSegment(Number.NaN, 100, 10), { start_seconds: 0, end_seconds: 0 })
})

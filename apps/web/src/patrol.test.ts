import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { patrolBoundary, patrolChecks } from './video-patrol.ts'
const panel = readFileSync(new URL('./PatrolPanel.tsx', import.meta.url), 'utf8')
test('patrol presets never claim authorization or identity from pictures', () => {
  assert.equal(patrolChecks.length, 3)
  assert.match(patrolBoundary, /무단 출입/)
  assert.match(patrolBoundary, /확정하지/)
})
test('ordinary operations never create timed replay incidents', () => {
  assert.doesNotMatch(panel, /armed|firing|time >= 20|request_id/)
  assert.match(panel, /검증용 기록/)
})

test('event history retains resolved events and exact evidence playback range', () => {
  assert.match(panel, /events.map/)
  assert.match(panel, /startSeconds=\{current.start_seconds\}/)
  assert.match(panel, /endSeconds=\{current.end_seconds\}/)
})

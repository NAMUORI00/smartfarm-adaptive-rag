import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('history is independent of camera availability and shares requests without polling', () => {
  const source = readFileSync(new URL('./PatrolPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /useVideoSession/)
  assert.doesNotMatch(source, /setInterval|getVideoCatalog|enabled === false/)
  assert.match(source, /<PatrolProgress event=\{current\}/)
  assert.match(source, /signal.aborted/)
})

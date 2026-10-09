import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ui = readFileSync(new URL('./FieldInspection.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
test('field inspection uses a modal with keyboard dismissal and focus restoration', () => {
  assert.match(ui, /showModal\(\)/)
  assert.match(ui, /onCancel=\{onClose\}/)
  assert.match(ui, /previous\?\.focus\(\)/)
})
test('field scope filters metrics, devices and unresolved alerts', () => {
  assert.match(ui, /m\.zoneId === zone/)
  assert.match(ui, /a\.zoneId === zone/)
  assert.match(ui, /a\.status !== 'resolved'/)
})
test('example footage stays separate from farm evidence and loads only when open', () => {
  assert.match(ui, /현재 센서 상황의 근거가 아닙니다/)
  assert.match(ui, /open && children/)
  assert.match(app, /영상 관제 열기/)
  assert.match(app, /<VideoWorkspace farmId=\{farm.id\}/)
})
test('inspection reuses existing advisor and manual device navigation', () => {
  assert.match(app, /onOpenAlert\(alert, analysis\)/)
  assert.match(app, /onDevices=\{\(\) => onNavigate\('operations'\)\}/)
  assert.match(ui, /AI와 이어서 확인/)
})

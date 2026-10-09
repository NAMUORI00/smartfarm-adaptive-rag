import assert from 'node:assert/strict'
import test from 'node:test'
import { operationalUiCopy } from './operator-copy.ts'

test('keeps internal execution ids and simulator terms out of operator copy', () => {
  const rendered = operationalUiCopy('실행 기록 sim-f94f5a5f-c0a1-46be-833c-0bf0262aa847가 생성되었습니다.')
  assert.equal(rendered, '장치 변경 내역을 기록했습니다.')
  assert.doesNotMatch(rendered, /sim-|시뮬레이터|시뮬레이션/)
  assert.equal(operationalUiCopy('센서 시뮬레이터 정책을 확인합니다.'), '센서 운영 정책을 확인합니다.')
})

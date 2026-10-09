import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeApiErrorDetail } from './api-error.ts'

test('turns FastAPI validation arrays into one safe operator message', () => {
  assert.equal(normalizeApiErrorDetail([
    { type: 'literal_error', loc: ['body', 'zone_id'], msg: "Input should be 'zone-a' or 'zone-b'", input: 'internal-zone-42' },
  ], 422), '적용 구역에서 지원하는 항목을 선택해 주세요.')
  assert.doesNotMatch(normalizeApiErrorDetail([
    { type: 'literal_error', loc: ['body', 'zone_id'], msg: 'invalid', input: 'secret-internal-zone' },
  ], 422), /body|zone_id|secret-internal-zone/)
})

test('explains excessive evidence without exposing the validation path', () => {
  assert.equal(normalizeApiErrorDetail([
    { type: 'too_long', loc: ['body', 'evidence_ids'], msg: 'List should have at most 20 items', ctx: { max_length: 20 } },
  ], 422), '답변 근거는 최대 20개까지 사용할 수 있습니다.')
})

test('maps scenario combinations, missing values, and short rationale to actions', () => {
  assert.equal(normalizeApiErrorDetail([
    { type: 'value_error', loc: ['body'], msg: 'Value error, normal cannot be combined with a fault scenario' },
  ], 422), '정상 상태와 장애 테스트를 함께 선택할 수 없습니다.')
  assert.equal(normalizeApiErrorDetail([
    { type: 'missing', loc: ['body', 'target'], msg: 'Field required' },
  ], 422), '장치 값이 필요합니다.')
  assert.equal(normalizeApiErrorDetail([
    { type: 'string_too_short', loc: ['body', 'rationale'], msg: 'String should have at least 5 characters' },
  ], 422), '조정 사유를 조금 더 구체적으로 입력해 주세요.')
})

test('keeps sanitized server messages and provides a safe malformed fallback', () => {
  assert.equal(normalizeApiErrorDetail('현재 장치 상태를 다시 확인해 주세요.', 409), '현재 장치 상태를 다시 확인해 주세요.')
  assert.equal(normalizeApiErrorDetail([], 422), '입력 내용을 확인해 주세요.')
  assert.equal(normalizeApiErrorDetail(null, 503), '농장 정보를 불러오지 못했습니다. 연결을 다시 확인해 주세요.')
})

test('distinguishes internal request headers from operator input', () => {
  const message = normalizeApiErrorDetail([
    { type: 'string_too_long', loc: ['header', 'Idempotency-Key'], ctx: { max_length: 120 } },
  ], 422)
  assert.match(message, /요청 연결 정보/)
  assert.doesNotMatch(message, /입력 내용|120|Idempotency/)
})

test('uses character limits for text and item limits for lists', () => {
  for (const [field, label, limit] of [['rationale', '조정 사유', 500], ['question', '질문', 1000], ['query', '검색어', 160]] as const) {
    assert.equal(normalizeApiErrorDetail([
      { type: 'string_too_long', loc: ['body', field], ctx: { max_length: limit } },
    ], 422), `${label}은 ${limit}자 이내로 입력해 주세요.`)
  }
  assert.equal(normalizeApiErrorDetail([
    { type: 'too_long', loc: ['body', 'zone_ids'], ctx: { max_length: 2 } },
  ], 422), '적용 구역은 최대 2개까지 사용할 수 있습니다.')
})

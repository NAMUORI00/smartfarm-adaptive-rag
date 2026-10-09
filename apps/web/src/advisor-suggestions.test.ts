import test from 'node:test'
import assert from 'node:assert/strict'
import { advisorSuggestions } from './advisor-suggestions.ts'
import type { AdvisorTurn } from './types'
const turn = (content: string) => [{userMessage:{content}, controlDrafts:[], status:'complete'}] as unknown as AdvisorTurn[]
test('greeting offers read-only scoped next steps, not pump execution', () => {
  const suggestions = advisorSuggestions(turn('안녕'), 'zone-b')
  assert.match(suggestions[0], /2구역/)
  assert.ok(suggestions.every(s => !s.includes('시작해줘')))
})
test('suggestions change with conversation topic and new session scope', () => {
  assert.match(advisorSuggestions(turn('온도 확인해줘'), 'zone-a')[0], /온도와 습도/)
  assert.match(advisorSuggestions(turn('관수는 어때'), 'zone-a')[0], /관수·양액/)
  assert.match(advisorSuggestions(turn('논문을 찾아줘'), 'all')[0], /자료/)
  assert.match(advisorSuggestions([], 'all')[0], /전체 구역/)
})

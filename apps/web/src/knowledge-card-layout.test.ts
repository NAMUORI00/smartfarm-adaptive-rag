import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function sourceCardMarkup() {
  const start = app.indexOf('function KnowledgeSourceCard(')
  const end = app.indexOf('\nfunction ', start + 1)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  return app.slice(start, end)
}

test('keeps the knowledge card reading order focused on the operator task', () => {
  const card = sourceCardMarkup()
  const title = card.indexOf('<h2>')
  const topic = card.indexOf('className="knowledge-topic-line"')
  const summary = card.indexOf('className="knowledge-summary"')
  const ask = card.indexOf('className="knowledge-ask-button"')
  const sourceDetails = card.indexOf('className="knowledge-parts knowledge-source-details"')

  assert.ok(title >= 0)
  assert.ok(title < topic, 'the title must precede the topic explanation')
  assert.ok(topic < summary, 'the topic label must introduce the operational summary')
  assert.ok(summary < ask, 'the summary must precede the primary question action')
  assert.ok(ask < sourceDetails, 'technical and source details must stay after the primary action')
  assert.doesNotMatch(card, /className="knowledge-index-details"/, 'index and source details should use one disclosure')
  assert.match(card, /AI 답변에 사용/)
  assert.match(card, /aria-label="다루는 내용"><b>다루는 내용<\/b>/)
  assert.match(card, /제공기관 원본 · 정보 수정 불가/)
  assert.doesNotMatch(card, /className="tags"/, 'raw taxonomy tags must not be rendered on the card')
})

test('keeps title, summary, and primary action visually distinct', () => {
  assert.match(styles, /\.knowledge-source-card h2 \{[^}]*font-size: 18px !important;[^}]*line-height: 1\.4;/)
  assert.match(styles, /\.knowledge-source-card \.knowledge-summary \{[^}]*font-size: 14px !important;[^}]*line-height: 1\.62;/)
  assert.match(styles, /\.knowledge-topic-line \{[^}]*grid-template-columns: auto minmax\(0,1fr\);/)
  assert.match(styles, /\.knowledge-source-card \.knowledge-topic-line \.knowledge-summary \{[^}]*-webkit-line-clamp: 2;/)
  assert.match(styles, /\.knowledge-source-card \.knowledge-ask-button \{[^}]*color: #fff;[^}]*background: #2f765b;[^}]*font-size: 13px;/)
})

test('keeps knowledge cards two-column on desktop and one-column on phones', () => {
  assert.match(styles, /\.knowledge-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)

  const mobileStart = styles.indexOf('@media (max-width: 780px) {')
  assert.notEqual(mobileStart, -1)
  const mobileRules = styles.slice(mobileStart)
  assert.match(mobileRules, /\.knowledge-grid \{ grid-template-columns: 1fr; \}/)
  assert.match(mobileRules, /\.knowledge-source-link, \.knowledge-edit-trigger, \.knowledge-ask-button,[^{]*\{ min-height: 44px; \}/)
})

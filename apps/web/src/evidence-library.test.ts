import assert from 'node:assert/strict'
import test from 'node:test'
import { citedEvidenceGroups, evidenceGroupForPassage, groupAnswerEvidence } from './evidence-library.ts'
import type { Evidence } from './types.ts'

function evidence(id: string, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id,
    sourceId: id,
    sourceKind: 'public_knowledge',
    sourceGroupId: null,
    documentId: null,
    source: id,
    category: '공개',
    excerpt: `${id} 본문`,
    score: 1,
    locator: `${id} 위치`,
    path: 'Dense',
    selected: true,
    issuer: null,
    publishedYear: null,
    documentType: null,
    sourceUrl: null,
    summary: null,
    sourceLocator: null,
    crop: null,
    cultivationSystem: null,
    evidenceClass: null,
    growthStage: null,
    embeddingModel: null,
    ...overrides,
  }
}

test('groups passages by explicit source group and preserves passage details', () => {
  const groups = groupAnswerEvidence([
    evidence('chunk-1', { sourceGroupId: 'source-group:public:wasabi-guide', source: '고추냉이 재배 자료 · 28쪽', locator: '28쪽' }),
    evidence('chunk-2', { sourceGroupId: 'source-group:public:wasabi-guide', source: '고추냉이 재배 자료 · 29쪽', locator: '29쪽' }),
  ])

  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, '고추냉이 재배 자료')
  assert.deepEqual(groups[0].passages.map((item) => [item.id, item.locator]), [['chunk-1', '28쪽'], ['chunk-2', '29쪽']])
  assert.equal(evidenceGroupForPassage(groups, 'chunk-2')?.id, groups[0].id)
})

test('uses normalized source URL or document id when source group is absent', () => {
  const groups = groupAnswerEvidence([
    evidence('page-1', { sourceUrl: 'https://example.test/guide.pdf#page=1', documentId: 'page-document-1' }),
    evidence('page-2', { sourceUrl: 'https://example.test/guide.pdf#page=2', documentId: 'page-document-2' }),
    evidence('chunk-a', { documentId: 'journal-article' }),
    evidence('chunk-b', { documentId: 'journal-article' }),
  ])

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.passages.length), [2, 2])
})

test('groups legacy public sources and presents one current operating observation root', () => {
  const groups = groupAnswerEvidence([
    evidence('legacy-chunk-1', { sourceId: 'public:wasabi:legacy-guide' }),
    evidence('legacy-chunk-2', { sourceId: 'public:wasabi:legacy-guide' }),
    evidence('sensor-observation-1', { sourceId: 'farm:zone-a:telemetry:air-temperature', sourceKind: 'private_simulation', source: '1구역 공기 온도 관측' }),
    evidence('sensor-observation-2', { sourceId: 'farm:zone-b:alerts:latest', sourceKind: 'private_simulation', source: '2구역 경보 관측' }),
  ])

  assert.equal(groups.length, 2)
  assert.equal(groups[0].passages.length, 2)
  assert.equal(groups[1].passages.length, 2)
  assert.equal(groups[1].title, '현재 운영 관측')
})

test('deduplicates inline citations by source while retaining citation order', () => {
  const groups = groupAnswerEvidence([
    evidence('first-a', { documentId: 'first', source: '첫 번째 원본' }),
    evidence('first-b', { documentId: 'first', source: '첫 번째 원본' }),
    evidence('second-a', { documentId: 'second', source: '두 번째 원본' }),
  ])

  assert.deepEqual(citedEvidenceGroups(groups, ['first-a', 'first-b', 'second-a']).map((group) => group.id), [
    'document:first',
    'document:second',
  ])
})

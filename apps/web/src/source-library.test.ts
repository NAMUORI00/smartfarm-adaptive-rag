import assert from 'node:assert/strict'
import test from 'node:test'
import { groupKnowledgeSources, knowledgeSourceSummary, knowledgeSourceTopicSummary, normalizePublicSourceRootSelection, normalizeSelectionToSourceRoots, restoreSourceRootSelection, sortKnowledgeSourceGroups, toggleSourceRootSelection } from './source-library.ts'
import type { KnowledgeDocument } from './types.ts'

function document(id: string, overrides: Partial<KnowledgeDocument> = {}): KnowledgeDocument {
  return {
    id,
    sourceGroupId: overrides.sourceGroupId ?? id,
    farmId: null,
    title: id,
    scope: 'public',
    version: 'v1',
    retrievalState: 'active',
    status: 'ready',
    updatedAt: null,
    chunkCount: 1,
    vectorCount: 1,
    qdrantVectorCount: 1,
    indexBackend: 'qdrant',
    graphNodeCount: 0,
    graphEdgeCount: 0,
    sourceName: null,
    checksum: null,
    tags: [],
    summary: id,
    issuer: null,
    publishedYear: null,
    documentType: null,
    sourceUrl: null,
    summaryProvider: 'extractive',
    isResearchArchive: false,
    sourceLocator: null,
    crop: null,
    cultivationSystem: null,
    evidenceClass: null,
    growthStage: null,
    embeddingModel: null,
    ...overrides,
  }
}

test('pages from one original source are shown as one source root', () => {
  const documents = [
    document('page-28', { sourceGroupId: 'source:wasabi-guide', title: '고추냉이 재배 기술 자료 · 28쪽', sourceUrl: 'https://example.test/wasabi.pdf', sourceLocator: '28쪽' }),
    document('page-29', { sourceGroupId: 'source:wasabi-guide', title: '고추냉이 재배 기술 자료 · 29쪽', sourceUrl: 'https://example.test/wasabi.pdf', sourceLocator: '29쪽' }),
  ]
  const groups = groupKnowledgeSources(documents)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].title, '고추냉이 재배 기술 자료')
  assert.equal(groups[0].pageLabel, '28–29쪽')
  assert.deepEqual(groups[0].documentIds, ['page-28', 'page-29'])
})

test('same URL in a different visibility scope remains a separate source', () => {
  const groups = groupKnowledgeSources([
    document('public', { sourceUrl: 'https://example.test/guide' }),
    document('private', { sourceGroupId: 'private-source', sourceUrl: 'https://example.test/guide', scope: 'private' }),
  ])
  assert.equal(groups.length, 2)
})

test('a legacy page selection expands to the whole original source', () => {
  const documents = [
    document('page-1', { sourceGroupId: 'source:guide', sourceUrl: 'https://example.test/guide' }),
    document('page-2', { sourceGroupId: 'source:guide', sourceUrl: 'https://example.test/guide' }),
    document('other'),
  ]
  assert.deepEqual(normalizeSelectionToSourceRoots(documents, ['page-2']), ['source:guide'])
})

test('enabling public-only removes private source roots from the active selection', () => {
  const documents = [
    document('public-page', { sourceGroupId: 'source:public-guide' }),
    document('operating-standard', { sourceGroupId: 'source:operating-standard', scope: 'synthetic' }),
    document('private-page', { sourceGroupId: 'source:private-note', scope: 'private' }),
  ]

  assert.deepEqual(
    normalizePublicSourceRootSelection(documents, ['source:public-guide', 'source:operating-standard', 'source:private-note']),
    ['source:public-guide', 'source:operating-standard'],
  )
})

test('restoring an intentionally empty session does not select default sources', () => {
  const readyDocuments = [
    document('public-page', { sourceGroupId: 'source:public-guide' }),
    document('private-page', { sourceGroupId: 'source:private-note', scope: 'private' }),
  ]

  assert.deepEqual(
    restoreSourceRootSelection(readyDocuments, [], [readyDocuments[0]], true),
    [],
  )
  assert.deepEqual(
    restoreSourceRootSelection(readyDocuments, [], [readyDocuments[0]], false),
    ['source:public-guide'],
  )
})

test('source selection and session restoration keep paused or unreviewed roots out', () => {
  const documents = [
    document('active', { sourceGroupId: 'source:active' }),
    document('paused', { sourceGroupId: 'source:paused', retrievalState: 'paused' }),
    document('review', { sourceGroupId: 'source:review', retrievalState: 'needs_review' }),
  ]

  assert.deepEqual(
    normalizeSelectionToSourceRoots(documents, ['source:active', 'source:paused', 'source:review']),
    ['source:active'],
  )
  assert.deepEqual(
    restoreSourceRootSelection(documents, ['source:paused'], documents, true),
    [],
  )
  assert.deepEqual(
    restoreSourceRootSelection(documents, [], documents, false),
    ['source:active'],
  )
})

test('source selection has no document-count ceiling', () => {
  const documents = Array.from({ length: 25 }, (_, index) =>
    document(`page-${index}`, { sourceGroupId: 'source:large-guide', sourceUrl: 'https://example.test/large-guide' }),
  )
  const group = groupKnowledgeSources(documents)[0]
  const selected = toggleSourceRootSelection([], group)
  assert.deepEqual(selected, ['source:large-guide'])
  assert.deepEqual(toggleSourceRootSelection(selected, group), [])
})

test('puts research archives after primary sources and replaces OCR table fragments with metadata', () => {
  const primary = groupKnowledgeSources([document('primary', { title: '현장 운영 자료', issuer: '농촌진흥청', sourceUrl: 'https://example.test/primary.pdf', checksum: 'verified' })])[0]
  const archive = groupKnowledgeSources([document('archive', {
    title: '고추냉이 공개 연구 자료 · 섹션 1',
    issuer: '일본 농업·식품산업기술종합연구기구 (NARO)',
    documentType: 'PDF 문서',
    sourceUrl: 'https://example.test/archive.pdf',
    summary: '77Induced Mutations for Food and Energy Security: Cultivar Name Original Cv.',
    isResearchArchive: true,
  })])[0]
  assert.deepEqual(sortKnowledgeSourceGroups([archive, primary]).map((group) => group.id), [primary.id, archive.id])
  assert.equal(knowledgeSourceSummary(archive), '일본 농업·식품산업기술종합연구기구 (NARO) · PDF 문서 원본을 추출·색인했습니다.')
  assert.equal(knowledgeSourceTopicSummary(archive), '고추냉이 품종과 돌연변이 연구를 포함한 공개 연구 자료를 다룹니다.')
})

test('describes a curated source by its subject instead of its indexing process', () => {
  const experiment = groupKnowledgeSources([document('experiment', {
    title: '고추냉이 순환수경의 공기·양액 온도 실험',
    summary: '원문 PDF를 검증하고 공식 영문 초록을 검색 색인한 동료심사 논문입니다.',
  })])[0]
  assert.equal(knowledgeSourceTopicSummary(experiment), '순환수경에서 공기와 양액 온도가 고추냉이 생육에 미치는 영향을 다룹니다.')
})

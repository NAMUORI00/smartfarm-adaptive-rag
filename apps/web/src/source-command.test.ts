import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySourceResultSelection,
  completeSourceResultSet,
  completeSourceResultSetFromDocuments,
  isSourceCommandInstruction,
  mapKnowledgeSourceCommandPreviewResponse,
  mapKnowledgeSourceSearchResponse,
  parseSourceCommand,
  sourceSelectionSummary,
  undoSourceSelection,
} from './source-command.ts'
import type { KnowledgeDocument } from './types.ts'

function document(id: string, sourceGroupId = id): KnowledgeDocument {
  return {
    id,
    sourceGroupId,
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
  }
}

test('parses the five source command operations without a command AST', () => {
  assert.deepEqual(
    [
      '근권 고온 대응 자료를 찾아줘',
      '관수 막힘 자료를 추가해줘',
      '기존 선택을 양액 EC 자료로 바꿔줘',
      '근권 냉각 자료를 빼줘',
      '선택한 자료를 모두 해제해줘',
    ].map((instruction) => parseSourceCommand(instruction).operation),
    ['search', 'add', 'replace', 'remove', 'clear'],
  )
  assert.equal(parseSourceCommand('근권 고온 대응 자료를 찾아줘').query, '근권 고온 대응')
  assert.equal(parseSourceCommand('관수 막힘 자료를 추가해줘').query, '관수 막힘')
  assert.equal(parseSourceCommand('기존 선택을 양액 EC 자료로 바꿔줘').query, '양액 EC')
  assert.equal(parseSourceCommand('선택한 자료를 모두 해제해줘').query, null)
})

test('distinguishes a source context command from an ordinary cultivation question', () => {
  assert.equal(isSourceCommandInstruction('근권 냉각 관련 자료 찾아서 전부 선택해줘'), true)
  assert.equal(isSourceCommandInstruction('검색된 자료를 전부 선택해줘'), true)
  assert.equal(isSourceCommandInstruction('근권 온도가 높은 이유가 뭐야?'), false)
  assert.equal(isSourceCommandInstruction('선택한 자료에서 근권 온도 기준을 설명해줘'), false)
})

test('keeps visibility separate from the selection operation', () => {
  const publicSearch = parseSourceCommand('공개 자료만 근권 고온 자료를 찾아줘')
  const allSearch = parseSourceCommand('비공개 자료도 포함해서 근권 SOP를 찾아줘')
  const inheritedSearch = parseSourceCommand('근권 SOP 자료를 찾아줘')
  assert.equal(publicSearch.visibility, 'public')
  assert.equal(publicSearch.operation, 'search')
  assert.equal(allSearch.visibility, 'all')
  assert.equal(allSearch.operation, 'search')
  assert.equal(allSearch.query, '근권 SOP')
  assert.equal(inheritedSearch.visibility, null)
})

test('requires an explicit focused source for deictic commands', () => {
  const unresolved = parseSourceCommand('이 자료를 빼줘')
  assert.equal(unresolved.operation, 'remove')
  assert.equal(unresolved.requiresFocusedSource, true)
  assert.equal(unresolved.focusedSourceGroupId, null)
  assert.match(unresolved.clarification ?? '', /먼저 선택/)

  const resolved = parseSourceCommand('이 자료를 빼줘', { focusedSourceGroupId: 'source:root-zone-guide' })
  assert.equal(resolved.focusedSourceGroupId, 'source:root-zone-guide')
  assert.equal(resolved.clarification, null)
})

test('parses combined search and selection commands without leaking command words into the query', () => {
  const combined = parseSourceCommand('근권 냉각 관련 자료 찾아서 전부 선택해줘')
  assert.equal(combined.operation, 'add')
  assert.equal(combined.query, '근권 냉각')
  assert.equal(combined.usesCurrentResultSet, false)

  const currentResults = parseSourceCommand('검색된 자료를 전부 선택해줘')
  assert.equal(currentResults.operation, 'add')
  assert.equal(currentResults.query, null)
  assert.equal(currentResults.usesCurrentResultSet, true)

  const publicScope = parseSourceCommand('공개 자료만 선택해줘')
  assert.equal(publicScope.operation, 'replace')
  assert.equal(publicScope.visibility, 'public')
  assert.equal(publicScope.query, null)

  const focused = parseSourceCommand('이 문서 제외해줘')
  assert.equal(focused.operation, 'remove')
  assert.equal(focused.requiresFocusedSource, true)
  assert.match(focused.clarification ?? '', /먼저 선택/)
})

test('refuses to label one visible page as the complete search result', () => {
  assert.throws(
    () => completeSourceResultSet([['source:a', 'source:b']], 3),
    /2\/3개만 확인/,
  )
  const complete = completeSourceResultSet([
    ['source:a', 'source:b'],
    ['source:c'],
  ], 3)
  assert.deepEqual(complete.sourceGroupIds, ['source:a', 'source:b', 'source:c'])
})

test('selects, removes, replaces, clears, and undoes across every result page', () => {
  const results = completeSourceResultSet([['source:a', 'source:b'], ['source:c']], 3)
  const added = applySourceResultSelection('add', ['source:kept'], results)
  assert.deepEqual(added.sourceGroupIds, ['source:kept', 'source:a', 'source:b', 'source:c'])
  assert.deepEqual(added.addedSourceGroupIds, ['source:a', 'source:b', 'source:c'])
  assert.deepEqual(sourceSelectionSummary(added.sourceGroupIds, results), {
    state: 'all', selectedCount: 3, totalCount: 3,
  })
  assert.deepEqual(undoSourceSelection(added), ['source:kept'])

  const removed = applySourceResultSelection('remove', added.sourceGroupIds, results)
  assert.deepEqual(removed.sourceGroupIds, ['source:kept'])
  assert.equal(sourceSelectionSummary(['source:a'], results).state, 'some')
  assert.deepEqual(applySourceResultSelection('replace', ['source:kept'], results).sourceGroupIds, results.sourceGroupIds)
  assert.deepEqual(applySourceResultSelection('clear', added.sourceGroupIds, results).sourceGroupIds, [])
})

test('reuses source-root grouping when a document catalog supplies the complete result', () => {
  const result = completeSourceResultSetFromDocuments([
    document('page-1', 'source:guide'),
    document('page-2', 'source:guide'),
    document('other', 'source:other'),
  ])
  assert.deepEqual(result, { sourceGroupIds: ['source:guide', 'source:other'], totalCount: 2 })
})

test('maps source search and command preview responses defensively', () => {
  const search = mapKnowledgeSourceSearchResponse({
    query: '근권 고온',
    visibility: 'all',
    count: 2,
    source_groups: [
      { source_group_id: 'source:one', title: '근권 관리', visibility: 'private', score: 0.91, match_reasons: ['근권', '고온', '근권'], document_count: 3 },
      { title: 'ID 없는 결과' },
    ],
  })
  assert.deepEqual(search, {
    query: '근권 고온',
    visibility: 'all',
    count: 2,
    sourceGroups: [{
      sourceGroupId: 'source:one',
      title: '근권 관리',
      visibility: 'private',
      score: 0.91,
      matchReasons: ['근권', '고온'],
      documentCount: 3,
    }],
  })

  assert.deepEqual(mapKnowledgeSourceCommandPreviewResponse({
    operation: 'replace',
    query: '양액 EC',
    visibility: 'public',
    matched_source_group_ids: ['source:ec', 'source:ec'],
    source_group_ids: ['source:ec'],
    count: 1,
    result_count: 4,
    clarification: '',
    error: null,
  }), {
    operation: 'replace',
    query: '양액 EC',
    visibility: 'public',
    matchedSourceGroupIds: ['source:ec'],
    sourceGroupIds: ['source:ec'],
    count: 1,
    resultCount: 4,
    clarification: null,
    error: null,
  })
})

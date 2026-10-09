import assert from 'node:assert/strict'
import test from 'node:test'
import { isKnowledgeSourceOwnedByFarm, isPublicKnowledgeScope, knowledgeApplicability, knowledgeApplicabilityLabel, knowledgeCategory, knowledgeLoadSucceeded, knowledgeRetrievalStateLabel, knowledgeScopeLabel, knowledgeSourceGroupRestoreConfirmed, knowledgeSourceGroupUpdateConfirmed, knowledgeSourceRetrievalState, knowledgeVisibility } from './knowledge-view.ts'
import type { KnowledgeDocument } from './types.ts'

function document(scope: KnowledgeDocument['scope'], farmId: KnowledgeDocument['farmId']): KnowledgeDocument {
  return {
    id: `${scope}:${farmId ?? 'central'}`,
    sourceGroupId: `group:${scope}:${farmId ?? 'central'}`,
    farmId,
    title: '운영 자료',
    scope,
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
    summary: '운영 자료',
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

test('summarizes source-root retrieval state with conservative operator labels', () => {
  const active = document('public', null)
  const paused = { ...active, id: 'paused', retrievalState: 'paused' as const }
  const review = { ...active, id: 'review', retrievalState: 'needs_review' as const }

  assert.equal(knowledgeSourceRetrievalState([active]), 'active')
  assert.equal(knowledgeSourceRetrievalState([active, paused]), 'paused')
  assert.equal(knowledgeSourceRetrievalState([active, review]), 'needs_review')
  assert.equal(knowledgeRetrievalStateLabel('active'), '사용 중')
  assert.equal(knowledgeRetrievalStateLabel('paused'), '사용 제외')
  assert.equal(knowledgeRetrievalStateLabel('needs_review'), '확인 필요')
})

test('treats central operating standards as globally visible without exposing implementation terms', () => {
  const standard = document('synthetic', null)
  assert.equal(isPublicKnowledgeScope(standard.scope), true)
  assert.equal(knowledgeVisibility(standard), 'public')
  assert.equal(knowledgeCategory(standard), 'reference')
  assert.equal(knowledgeScopeLabel(standard.scope), '운영 기준')
})

test('presents knowledge applicability as operator-readable Korean labels', () => {
  assert.equal(knowledgeApplicabilityLabel('perlite_substrate'), '펄라이트 배지')
  assert.equal(knowledgeApplicabilityLabel('vegetative_growth'), '영양생장기')
  assert.equal(knowledgeApplicabilityLabel('unknown_stage'), 'unknown stage')
  assert.deepEqual(knowledgeApplicability({ crop: 'wasabi', cultivationSystem: 'hydroponic', growthStage: 'vegetative_growth' }), ['고추냉이', '수경재배', '영양생장기'])
})

test('only allows metadata editing when every source member belongs to the active farm', () => {
  const owned = document('private', 'farm-wasabi-a')
  const central = document('public', null)
  const otherFarm = document('private', 'farm-other' as KnowledgeDocument['farmId'])

  assert.equal(isKnowledgeSourceOwnedByFarm([owned], 'farm-wasabi-a'), true)
  assert.equal(isKnowledgeSourceOwnedByFarm([central], 'farm-wasabi-a'), false)
  assert.equal(isKnowledgeSourceOwnedByFarm([owned, central], 'farm-wasabi-a'), false)
  assert.equal(isKnowledgeSourceOwnedByFarm([otherFarm], 'farm-wasabi-a'), false)
})

test('does not report a successful refresh when either result set failed', () => {
  assert.equal(knowledgeLoadSucceeded('connected', 'connected'), true)
  assert.equal(knowledgeLoadSucceeded('connected', 'unavailable'), false)
  assert.equal(knowledgeLoadSucceeded('unavailable', 'connected'), false)
})

test('accepts a group update only when the atomic response matches every requested member', () => {
  const first = document('private', 'farm-wasabi-a')
  const second = { ...document('private', 'farm-wasabi-a'), id: 'second', sourceGroupId: first.sourceGroupId }
  assert.equal(knowledgeSourceGroupUpdateConfirmed(first.sourceGroupId, first.sourceGroupId, [first, second], 'completed'), true)
  assert.equal(knowledgeSourceGroupUpdateConfirmed(first.sourceGroupId, 'other', [first, second], 'completed'), false)
  assert.equal(knowledgeSourceGroupUpdateConfirmed(first.sourceGroupId, first.sourceGroupId, [{ ...second, sourceGroupId: 'other' }], 'completed'), false)
  assert.equal(knowledgeSourceGroupUpdateConfirmed(first.sourceGroupId, first.sourceGroupId, [first], 'failed'), false)
  assert.equal(knowledgeSourceGroupUpdateConfirmed(first.sourceGroupId, first.sourceGroupId, [], 'completed'), false)
})

test('accepts an empty restored source root while retaining response and job verification', () => {
  const restored = document('private', 'farm-wasabi-a')
  assert.equal(knowledgeSourceGroupRestoreConfirmed(restored.sourceGroupId, restored.sourceGroupId, [], 'completed'), true)
  assert.equal(knowledgeSourceGroupRestoreConfirmed(restored.sourceGroupId, restored.sourceGroupId, [restored], 'completed'), true)
  assert.equal(knowledgeSourceGroupRestoreConfirmed(restored.sourceGroupId, 'other', [], 'completed'), false)
  assert.equal(knowledgeSourceGroupRestoreConfirmed(restored.sourceGroupId, restored.sourceGroupId, [], 'failed'), false)
  assert.equal(knowledgeSourceGroupRestoreConfirmed(restored.sourceGroupId, restored.sourceGroupId, [{ ...restored, sourceGroupId: 'other' }], 'completed'), false)
})

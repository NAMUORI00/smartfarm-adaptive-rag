import type { FarmId, KnowledgeDocument, KnowledgeRetrievalState, KnowledgeScope, RuntimeState } from './types.ts'

export type KnowledgeVisibility = 'public' | 'private'
export type KnowledgeCategory = 'all' | 'agronomy' | 'research' | 'reference' | 'operations' | 'internal'
export type KnowledgeRetrievalFilter = 'all' | KnowledgeRetrievalState

export function isPublicKnowledgeScope(scope: KnowledgeScope) {
  return scope !== 'private'
}

export function knowledgeVisibility(document: KnowledgeDocument): KnowledgeVisibility {
  return isPublicKnowledgeScope(document.scope) ? 'public' : 'private'
}

export function knowledgeCategory(document: KnowledgeDocument): Exclude<KnowledgeCategory, 'all'> {
  if (knowledgeVisibility(document) === 'private') return document.evidenceClass === 'farm_sop' ? 'operations' : 'internal'
  if (document.evidenceClass === 'official_agronomy') return 'agronomy'
  if (document.evidenceClass === 'peer_reviewed') return 'research'
  return 'reference'
}

export function knowledgeCategoryLabel(category: KnowledgeCategory) {
  return ({ all: '전체', agronomy: '재배 기술', research: '연구 자료', reference: '참고 자료', operations: '농장 운영', internal: '내부 기준' } as const)[category]
}

export function knowledgeScopeLabel(scope: KnowledgeScope) {
  return scope === 'public' ? '공개' : scope === 'private' ? '비공개' : '운영 기준'
}

export function knowledgeRetrievalStateLabel(state: KnowledgeRetrievalState) {
  return ({ active: '사용 중', paused: '사용 제외', needs_review: '확인 필요' } as const)[state]
}

export function knowledgeSourceRetrievalState(documents: KnowledgeDocument[]): KnowledgeRetrievalState {
  if (documents.some((document) => document.retrievalState === 'needs_review')) return 'needs_review'
  return documents.every((document) => document.retrievalState === 'active') ? 'active' : 'paused'
}

const applicabilityLabels: Record<string, string> = {
  wasabi: '고추냉이',
  hydroponic: '수경재배',
  flowing_water: '유수재배',
  perlite_substrate: '펄라이트 배지',
  perlite_high_bed_fertigation: '펄라이트 고설베드',
  vegetative: '영양생장기',
  vegetative_growth: '영양생장기',
  leaf_production: '잎 생산',
  rhizome_production: '근경 생산',
}

export function knowledgeApplicabilityLabel(value: string | null | undefined) {
  if (!value?.trim()) return null
  const normalized = value.trim().toLowerCase()
  return applicabilityLabels[normalized] ?? value.trim().replace(/[_-]+/g, ' ')
}

export function knowledgeApplicability(document: Pick<KnowledgeDocument, 'crop' | 'cultivationSystem' | 'growthStage'>) {
  return [...new Set([document.crop, document.cultivationSystem, document.growthStage]
    .map(knowledgeApplicabilityLabel)
    .filter((value): value is string => Boolean(value)))]
}

export function isKnowledgeSourceOwnedByFarm(documents: KnowledgeDocument[], farmId: FarmId) {
  return documents.length > 0 && documents.every((document) => document.farmId === farmId)
}

export function knowledgeLoadSucceeded(resultState: RuntimeState, catalogState: RuntimeState) {
  return resultState === 'connected' && catalogState === 'connected'
}

export function knowledgeSourceGroupUpdateConfirmed(
  requestedId: string,
  responseId: string,
  documents: KnowledgeDocument[],
  jobStatus: string | undefined,
) {
  return Boolean(
    documents.length
    && responseId === requestedId
    && jobStatus === 'completed'
    && documents.every((document) => document.sourceGroupId === requestedId),
  )
}

export function knowledgeSourceGroupRestoreConfirmed(
  requestedId: string,
  responseId: string,
  documents: KnowledgeDocument[],
  jobStatus: string | undefined,
) {
  return Boolean(
    responseId === requestedId
    && jobStatus === 'completed'
    && documents.every((document) => document.sourceGroupId === requestedId),
  )
}

import type { KnowledgeDocument } from './types.ts'
import { isPublicKnowledgeScope } from './knowledge-view.ts'

export type KnowledgeSourceGroup = {
  id: string
  title: string
  documents: KnowledgeDocument[]
  documentIds: string[]
  representative: KnowledgeDocument
  sourceUrl: string | null
  pageLabel: string | null
  isResearchArchive: boolean
}

function normalizedSourceUrl(value: string) {
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.trim().replace(/\/$/, '').toLocaleLowerCase()
  }
}

function sourceRootId(document: KnowledgeDocument) {
  if (document.sourceGroupId) return document.sourceGroupId
  if (document.sourceUrl) return `${document.scope}:url:${normalizedSourceUrl(document.sourceUrl)}`
  if (document.checksum) return `${document.scope}:checksum:${document.checksum}`
  return `document:${document.id}`
}

function titleWithoutPage(title: string) {
  return title
    .replace(/\s*[·|-]\s*(?:p\.?\s*)?\d+(?:\s*[-–~]\s*\d+)?\s*(?:쪽|페이지)?\s*$/iu, '')
    .trim()
}

function groupTitle(documents: KnowledgeDocument[]) {
  const counts = new Map<string, { count: number; order: number }>()
  documents.forEach((document, order) => {
    const title = titleWithoutPage(document.title) || document.title
    const current = counts.get(title)
    counts.set(title, { count: (current?.count ?? 0) + 1, order: current?.order ?? order })
  })
  return [...counts.entries()]
    .sort((left, right) => right[1].count - left[1].count || left[1].order - right[1].order)[0]?.[0]
    ?? documents[0].title
}

function pageLabel(documents: KnowledgeDocument[]) {
  const pages = documents
    .map((document) => document.sourceLocator?.match(/(\d+)\s*쪽/u)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .sort((left, right) => left - right)
  if (!pages.length) return null
  const first = pages[0]
  const last = pages[pages.length - 1]
  return first === last ? `${first}쪽` : `${first}–${last}쪽`
}

export function groupKnowledgeSources(documents: KnowledgeDocument[]): KnowledgeSourceGroup[] {
  const grouped = new Map<string, KnowledgeDocument[]>()
  for (const document of documents) {
    const id = sourceRootId(document)
    grouped.set(id, [...(grouped.get(id) ?? []), document])
  }
  return [...grouped.entries()].map(([id, members]) => ({
    id,
    title: groupTitle(members),
    documents: members,
    documentIds: members.map((document) => document.id),
    representative: members[0],
    sourceUrl: members[0].sourceUrl,
    pageLabel: pageLabel(members),
    isResearchArchive: members.every((document) => document.isResearchArchive),
  }))
}

function sourceMetadataScore(group: KnowledgeSourceGroup) {
  const document = group.representative
  return Number(Boolean(document.sourceUrl)) * 3
    + Number(Boolean(document.issuer)) * 2
    + Number(Boolean(document.documentType))
    + Number(group.documents.some((item) => Boolean(item.checksum)))
}

export function sortKnowledgeSourceGroups(groups: KnowledgeSourceGroup[]) {
  return [...groups].sort((left, right) => (
    Number(left.isResearchArchive) - Number(right.isResearchArchive)
    || sourceMetadataScore(right) - sourceMetadataScore(left)
    || left.title.localeCompare(right.title, 'ko')
  ))
}

export function knowledgeSourceSummary(group: KnowledgeSourceGroup) {
  const summary = group.representative.summary.trim()
  const looksLikeOcrTableFragment = /^\d{1,3}[A-Za-z]/.test(summary)
    || /\b(?:Cultivar Name|Original Cv\.|Table\s+\d+)\b/i.test(summary)
  if (summary && !looksLikeOcrTableFragment) return summary
  const metadata = [group.representative.issuer, group.representative.documentType].filter(Boolean).join(' · ')
  return metadata ? `${metadata} 원본을 추출·색인했습니다.` : '원본 본문을 추출·색인했습니다.'
}

const sourceTopicSummaries: Array<[RegExp, string]> = [
  [/순환수경.*공기·양액 온도/u, '순환수경에서 공기와 양액 온도가 고추냉이 생육에 미치는 영향을 다룹니다.'],
  [/펄라이트 고설베드/u, '펄라이트 고설베드에서 잎 생산을 위한 환경·양액 운영 사례를 다룹니다.'],
  [/고수온.*연부병/u, '물와사비 포장의 고수온 노출과 연부병 발생 위험을 다룹니다.'],
  [/전통 물와사비 재배 시스템 그림/u, '흐르는 용수와 샘물, 다다미이시식 포장으로 구성된 전통 재배 구조를 다룹니다.'],
  [/재배 기술 자료/u, '고추냉이의 생육 특성, 재배 환경, 번식, 병해와 수확 관리 전반을 다룹니다.'],
  [/공개 연구 자료/u, '고추냉이 품종과 돌연변이 연구를 포함한 공개 연구 자료를 다룹니다.'],
  [/근권·관수 대응 SOP/u, '근권 고온, 관수 저하, EC 편차와 센서 이상을 구분하는 현장 대응 절차를 다룹니다.'],
  [/운영 정책/u, '경보 상황별 장치 반응과 운영 판단 기준을 다룹니다.'],
]

export function knowledgeSourceTopicSummary(group: KnowledgeSourceGroup) {
  return sourceTopicSummaries.find(([pattern]) => pattern.test(group.title))?.[1] ?? knowledgeSourceSummary(group)
}

export function normalizeSelectionToSourceRoots(documents: KnowledgeDocument[], selectedIds: string[]) {
  const selected = new Set(selectedIds)
  return groupKnowledgeSources(documents.filter((document) => document.retrievalState === 'active')).flatMap((group) =>
    selected.has(group.id) || group.documentIds.some((id) => selected.has(id)) ? [group.id] : [],
  )
}

export function restoreSourceRootSelection(
  readyDocuments: KnowledgeDocument[],
  selectedIds: string[],
  defaultDocuments: KnowledgeDocument[],
  hasPersistedContext: boolean,
) {
  const normalized = normalizeSelectionToSourceRoots(readyDocuments, selectedIds)
  return hasPersistedContext || normalized.length
    ? normalized
    : groupKnowledgeSources(defaultDocuments.filter((document) => document.retrievalState === 'active')).map((group) => group.id)
}

export function normalizePublicSourceRootSelection(documents: KnowledgeDocument[], selectedIds: string[]) {
  return normalizeSelectionToSourceRoots(
    documents.filter((document) => document.status === 'ready' && isPublicKnowledgeScope(document.scope)),
    selectedIds,
  )
}

export function toggleSourceRootSelection(currentIds: string[], group: KnowledgeSourceGroup) {
  const current = new Set(currentIds)
  const selected = current.has(group.id) || group.documentIds.some((id) => current.has(id))
  group.documentIds.forEach((id) => current.delete(id))
  if (selected) current.delete(group.id)
  else current.add(group.id)
  return [...current]
}

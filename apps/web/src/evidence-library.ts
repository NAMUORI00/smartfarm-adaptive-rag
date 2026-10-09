import type { Evidence } from './types.ts'

export type EvidenceSourceGroup = {
  id: string
  title: string
  passages: Evidence[]
  representative: Evidence
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

function evidenceSourceRoot(item: Evidence) {
  if (item.sourceGroupId) return item.sourceGroupId
  if (item.sourceUrl) return `url:${item.sourceKind}:${normalizedSourceUrl(item.sourceUrl)}`
  if (item.documentId) return `document:${item.documentId}`
  if (item.sourceKind === 'private_simulation') return 'operation:current-observations'
  if (item.sourceKind === 'public_knowledge' || item.sourceKind === 'private_knowledge') return `source:${item.sourceId}`
  return `evidence:${item.id}`
}

function titleWithoutLocation(title: string) {
  return title
    .replace(/\s*[\u00b7|-]\s*(?:p\.?\s*)?\d+(?:\s*[-–~]\s*\d+)?\s*(?:쪽|페이지)?\s*$/iu, '')
    .trim()
}

export function groupAnswerEvidence(evidence: Evidence[]): EvidenceSourceGroup[] {
  const grouped = new Map<string, Evidence[]>()
  for (const item of evidence) {
    const id = evidenceSourceRoot(item)
    grouped.set(id, [...(grouped.get(id) ?? []), item])
  }
  return [...grouped.entries()].map(([id, passages]) => ({
    id,
    title: id === 'operation:current-observations'
      ? '현재 운영 관측'
      : titleWithoutLocation(passages[0].source) || passages[0].source,
    passages,
    representative: passages[0],
  }))
}

export function evidenceGroupForPassage(groups: EvidenceSourceGroup[], passageId: string | null) {
  if (!passageId) return null
  return groups.find((group) => group.passages.some((passage) => passage.id === passageId)) ?? null
}

export function citedEvidenceGroups(groups: EvidenceSourceGroup[], passageIds: string[]) {
  const cited = new Set(passageIds)
  return groups.filter((group) => group.passages.some((passage) => cited.has(passage.id)))
}

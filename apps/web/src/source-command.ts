import { groupKnowledgeSources } from './source-library.ts'
import type {
  KnowledgeDocument,
  KnowledgeSourceCommandPreview,
  KnowledgeSourceSearchResult,
  SourceCommandOperation,
  SourceCommandVisibility,
} from './types.ts'

export type ParsedSourceCommand = {
  instruction: string
  operation: SourceCommandOperation
  visibility: SourceCommandVisibility | null
  query: string | null
  usesCurrentResultSet: boolean
  requiresFocusedSource: boolean
  focusedSourceGroupId: string | null
  clarification: string | null
}

export type CompleteSourceResultSet = {
  sourceGroupIds: string[]
  totalCount: number
}

export type SourceSelectionState = 'none' | 'some' | 'all'

export type SourceSelectionSummary = {
  state: SourceSelectionState
  selectedCount: number
  totalCount: number
}

export type SourceSelectionChange = {
  previousSourceGroupIds: string[]
  sourceGroupIds: string[]
  addedSourceGroupIds: string[]
  removedSourceGroupIds: string[]
}

const CLEAR_PATTERN = /(?:모두|전체|전부).*(?:해제|제외|빼|지워|삭제|제거|초기화)|(?:선택|자료|문서|근거).*(?:초기화)/u
const REPLACE_PATTERN = /바꿔|교체|대체|대신|(?:이|해당|현재)\s*(?:자료|문서|근거)\s*만\s*(?:남겨|사용)/u
const REMOVE_PATTERN = /빼|제외|해제|삭제|지워|제거/u
const ADD_PATTERN = /추가|포함|선택|넣/u
const FOCUSED_SOURCE_PATTERN = /(?:^|\s)(?:이|해당|현재)\s*(?:자료|문서|근거)(?:을|를|만|에서|으로)?(?:\s|$)/u
const CURRENT_RESULT_SET_PATTERN = /검색(?:된|한)\s*(?:결과|자료|문서)|현재\s*검색\s*결과/u
const SOURCE_CONTEXT_PATTERN = /자료|문서|근거|출처|소스|source|context/iu
const SOURCE_COMMAND_ACTION_PATTERN = /(?:찾아|검색|선택|추가|포함|넣|바꿔|교체|대체|빼|제외|해제|삭제|지워|제거|초기화|남겨)(?:서)?(?:\s*해)?\s*(?:줘|주세요|줘요)?[.!?]*$/iu

export function isSourceCommandInstruction(rawInstruction: string) {
  const instruction = rawInstruction.replace(/\s+/gu, ' ').trim()
  return SOURCE_CONTEXT_PATTERN.test(instruction) && SOURCE_COMMAND_ACTION_PATTERN.test(instruction)
}

function commandOperation(instruction: string): SourceCommandOperation {
  const intentInstruction = instruction.replace(/(?:비공개|내부)\s*(?:자료|문서|지식)?(?:도)?\s*(?:포함(?:해서|해)?|함께|같이)/gu, ' ')
  if (CLEAR_PATTERN.test(intentInstruction)) return 'clear'
  if (/공개\s*(?:자료|문서|지식)?\s*만\s*선택|(?:모든|전체)\s*(?:자료|문서|지식)\s*선택/u.test(intentInstruction)) return 'replace'
  if (REPLACE_PATTERN.test(intentInstruction)) return 'replace'
  if (REMOVE_PATTERN.test(intentInstruction)) return 'remove'
  if (ADD_PATTERN.test(intentInstruction)) return 'add'
  return 'search'
}

function commandVisibility(instruction: string): SourceCommandVisibility | null {
  if (/(?:비공개|내부)/u.test(instruction) || /(?:모든|전체)\s*(?:자료|문서|지식)/u.test(instruction)) return 'all'
  if (/공개/u.test(instruction)) return 'public'
  return null
}

function commandQuery(instruction: string, operation: SourceCommandOperation, usesCurrentResultSet: boolean) {
  if (operation === 'clear' || usesCurrentResultSet) return null
  const cleaned = instruction
    .replace(FOCUSED_SOURCE_PATTERN, ' ')
    .replace(/(?:비공개|내부)\s*(?:자료|문서|지식)?(?:도)?\s*(?:포함(?:해서|해)?|함께|같이)?/gu, ' ')
    .replace(/공개\s*(?:자료|문서|지식)?\s*만/gu, ' ')
    .replace(/(?:모든|전체)\s*(?:자료|문서|지식)/gu, ' ')
    .replace(/(?:기존|현재)\s*선택(?:한)?(?:을|과|에서)?/gu, ' ')
    .replace(/(?:찾아서|찾아|검색해서|검색해|검색|보여|추가|포함|선택|넣어|넣|바꿔|교체|대체|빼|제외|해제|삭제|지워|제거|초기화|남겨)(?:\s*(?:줘|주세요|줘요))?/gu, ' ')
    .replace(/(?:해\s*)?(?:줘|주세요|줘요|부탁해)\s*$/u, ' ')
    .replace(/(?:관련\s*)?(?:자료|문서|근거|지식)(?:를|을|로|으로|만|도)?/gu, ' ')
    .replace(/(?:모두|전체|전부)/gu, ' ')
    .replace(/[,.!?]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/(?:을|를|에서|으로|로)$/u, '')
    .trim()
  return cleaned || null
}

export function parseSourceCommand(
  rawInstruction: string,
  context: { focusedSourceGroupId?: string | null } = {},
): ParsedSourceCommand {
  const instruction = rawInstruction.replace(/\s+/gu, ' ').trim()
  const operation = commandOperation(instruction)
  const usesCurrentResultSet = CURRENT_RESULT_SET_PATTERN.test(instruction)
  const requiresFocusedSource = operation !== 'clear' && FOCUSED_SOURCE_PATTERN.test(`${instruction} `)
  const focusedSourceGroupId = requiresFocusedSource ? context.focusedSourceGroupId ?? null : null
  return {
    instruction,
    operation,
    visibility: commandVisibility(instruction),
    query: commandQuery(instruction, operation, usesCurrentResultSet),
    usesCurrentResultSet,
    requiresFocusedSource,
    focusedSourceGroupId,
    clarification: requiresFocusedSource && !focusedSourceGroupId
      ? '어떤 자료를 말하는지 먼저 선택해 주세요.'
      : null,
  }
}

function uniqueIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))]
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function responseVisibility(value: unknown) {
  return value === 'all' ? 'all' as const : 'public' as const
}

function responseOperation(value: unknown): SourceCommandOperation {
  return value === 'add' || value === 'replace' || value === 'remove' || value === 'clear'
    ? value
    : 'search'
}

export function mapKnowledgeSourceSearchResponse(payload: Record<string, unknown>): KnowledgeSourceSearchResult {
  const sourceGroups = (Array.isArray(payload.source_groups) ? payload.source_groups : []).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    const sourceGroupId = optionalString(entry.source_group_id)
    if (!sourceGroupId) return []
    return [{
      sourceGroupId,
      title: optionalString(entry.title) ?? '제목 없는 자료',
      visibility: entry.visibility === 'private' ? 'private' as const : 'public' as const,
      score: finiteNumber(entry.score) ?? 0,
      matchReasons: uniqueIds(Array.isArray(entry.match_reasons) ? entry.match_reasons.filter((item): item is string => typeof item === 'string') : []),
      documentCount: Math.max(0, Math.trunc(finiteNumber(entry.document_count) ?? 0)),
    }]
  })
  return {
    query: optionalString(payload.query) ?? '',
    visibility: responseVisibility(payload.visibility),
    sourceGroups,
    count: Math.max(sourceGroups.length, Math.trunc(finiteNumber(payload.count) ?? sourceGroups.length)),
  }
}

export function mapKnowledgeSourceCommandPreviewResponse(payload: Record<string, unknown>): KnowledgeSourceCommandPreview {
  const sourceGroupIds = uniqueIds(Array.isArray(payload.source_group_ids) ? payload.source_group_ids.filter((item): item is string => typeof item === 'string') : [])
  return {
    operation: responseOperation(payload.operation),
    query: optionalString(payload.query),
    visibility: responseVisibility(payload.visibility),
    matchedSourceGroupIds: uniqueIds(Array.isArray(payload.matched_source_group_ids) ? payload.matched_source_group_ids.filter((item): item is string => typeof item === 'string') : []),
    sourceGroupIds,
    count: Math.max(0, Math.trunc(finiteNumber(payload.count) ?? sourceGroupIds.length)),
    resultCount: Math.max(0, Math.trunc(finiteNumber(payload.result_count) ?? sourceGroupIds.length)),
    clarification: optionalString(payload.clarification),
    error: optionalString(payload.error),
  }
}

/**
 * Builds the only result-set shape accepted by bulk selection. The function
 * rejects a current-page subset, so a button labelled "검색 결과 전체" cannot
 * silently select only the visible page.
 */
export function completeSourceResultSet(
  pages: readonly (readonly string[])[],
  totalCount: number,
): CompleteSourceResultSet {
  const safeTotal = Number.isInteger(totalCount) && totalCount >= 0 ? totalCount : -1
  const sourceGroupIds = uniqueIds(pages.flatMap((page) => [...page]))
  if (safeTotal < 0 || sourceGroupIds.length !== safeTotal) {
    throw new Error(`전체 검색 결과 ID가 필요합니다. ${sourceGroupIds.length}/${Math.max(totalCount, 0)}개만 확인했습니다.`)
  }
  return { sourceGroupIds, totalCount: safeTotal }
}

export function completeSourceResultSetFromDocuments(
  documents: readonly KnowledgeDocument[],
  totalCount = groupKnowledgeSources([...documents]).length,
) {
  const ids = groupKnowledgeSources([...documents]).map((group) => group.id)
  return completeSourceResultSet([ids], totalCount)
}

export function sourceSelectionSummary(
  selectedSourceGroupIds: readonly string[],
  resultSet: CompleteSourceResultSet,
): SourceSelectionSummary {
  const selected = new Set(uniqueIds(selectedSourceGroupIds))
  const selectedCount = resultSet.sourceGroupIds.filter((id) => selected.has(id)).length
  return {
    state: selectedCount === 0 ? 'none' : selectedCount === resultSet.totalCount ? 'all' : 'some',
    selectedCount,
    totalCount: resultSet.totalCount,
  }
}

function selectionChange(previousIds: readonly string[], nextIds: readonly string[]): SourceSelectionChange {
  const previousSourceGroupIds = uniqueIds(previousIds)
  const sourceGroupIds = uniqueIds(nextIds)
  const previous = new Set(previousSourceGroupIds)
  const next = new Set(sourceGroupIds)
  return {
    previousSourceGroupIds,
    sourceGroupIds,
    addedSourceGroupIds: sourceGroupIds.filter((id) => !previous.has(id)),
    removedSourceGroupIds: previousSourceGroupIds.filter((id) => !next.has(id)),
  }
}

export function applySourceResultSelection(
  operation: SourceCommandOperation,
  selectedSourceGroupIds: readonly string[],
  resultSet: CompleteSourceResultSet,
): SourceSelectionChange {
  const current = uniqueIds(selectedSourceGroupIds)
  const matched = new Set(resultSet.sourceGroupIds)
  if (operation === 'search') return selectionChange(current, current)
  if (operation === 'clear') return selectionChange(current, [])
  if (operation === 'replace') return selectionChange(current, resultSet.sourceGroupIds)
  if (operation === 'remove') return selectionChange(current, current.filter((id) => !matched.has(id)))
  return selectionChange(current, [...current, ...resultSet.sourceGroupIds])
}

export function undoSourceSelection(change: SourceSelectionChange) {
  return [...change.previousSourceGroupIds]
}

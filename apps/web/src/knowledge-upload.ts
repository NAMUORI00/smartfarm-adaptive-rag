import type { KnowledgeUploadResultKind } from './api'
import type { KnowledgeRetrievalState, KnowledgeScope } from './types'

const allowedExtensions = new Set(['.txt', '.md', '.csv', '.pdf', '.png', '.jpg', '.jpeg'])
const imageExtensions = new Set(['.png', '.jpg', '.jpeg'])
const fileLimit = 12 * 1024 * 1024
const imageLimit = 10 * 1024 * 1024

type UploadCandidate = Pick<File, 'name' | 'size'>

export type KnowledgeUploadCompletion = {
  title: string
  scope: Extract<KnowledgeScope, 'public' | 'private'>
  resultKind: KnowledgeUploadResultKind
  status: 'running' | 'completed' | 'failed' | 'unknown'
  retrievalState: KnowledgeRetrievalState | null
  sourceGroupId: string | null
  summary: string | null
  chunkCount: number | null
}

function extensionOf(file: UploadCandidate) {
  return file.name.match(/\.[^.]+$/)?.[0].toLowerCase() ?? ''
}

export function knowledgeUploadTitle(file: UploadCandidate) {
  return file.name.replace(/\.(txt|md|csv|pdf|png|jpe?g)$/i, '').replace(/[_-]+/g, ' ').trim() || file.name
}

export function knowledgeUploadIssue(file: UploadCandidate, scope: Extract<KnowledgeScope, 'public' | 'private'>) {
  const extension = extensionOf(file)
  if (!allowedExtensions.has(extension)) return 'PDF, TXT, MD, CSV, JPG, PNG 파일만 등록할 수 있습니다.'
  if (file.size === 0) return '내용이 없는 파일입니다. 다른 파일을 선택해 주세요.'
  if (imageExtensions.has(extension) && file.size > imageLimit) return '이미지는 10MB 이하만 등록할 수 있습니다.'
  if (file.size > fileLimit) return '자료 파일은 12MB 이하만 등록할 수 있습니다.'
  if (imageExtensions.has(extension) && scope === 'private') return '이미지는 현재 공개 자료로만 등록할 수 있습니다. 공개로 바꾸거나 문서 파일로 변환해 주세요.'
  return null
}

export function knowledgeUploadCompletionCopy(completion: KnowledgeUploadCompletion) {
  if (completion.status === 'running') return { heading: '자료를 확인하고 있습니다', detail: `“${completion.title}” 내용을 정리한 뒤 검색에 반영합니다.` }
  if (completion.retrievalState === 'needs_review') {
    if (completion.resultKind === 'updated') return { heading: '자료 갱신을 등록했습니다', detail: `“${completion.title}”의 최신 내용을 확인한 뒤 AI 답변에 사용을 켜세요.` }
    return { heading: completion.resultKind === 'reused' ? '이미 등록된 자료입니다' : '새 자료를 등록했습니다', detail: `“${completion.title}” 내용을 확인한 뒤 AI 답변에 사용을 켜세요.` }
  }
  if (completion.resultKind === 'created') return { heading: '새 자료를 등록했습니다', detail: `“${completion.title}”을 답변 근거로 사용할 수 있습니다.` }
  if (completion.resultKind === 'reused') return { heading: '이미 등록된 자료입니다', detail: `“${completion.title}”의 기존 내용을 그대로 사용합니다.` }
  if (completion.resultKind === 'updated') return { heading: '기존 자료를 갱신했습니다', detail: `“${completion.title}”의 최신 내용이 답변 근거에 반영되었습니다.` }
  return { heading: '자료 등록을 마쳤습니다', detail: `“${completion.title}”을 지식 자료에서 확인할 수 있습니다.` }
}

export function knowledgeUploadErrorCopy(message: string) {
  if (/Knowledge uploads must be 12 MiB or smaller/i.test(message)) return '자료 파일은 12MB 이하만 등록할 수 있습니다.'
  if (/Knowledge uploads must be UTF-8 text/i.test(message)) return 'TXT, MD, CSV 파일은 UTF-8 형식으로 저장한 뒤 다시 등록해 주세요.'
  if (/No extractable text|Scanned or image-only PDFs require OCR/i.test(message)) return '이 PDF에서 선택 가능한 글자를 찾지 못했습니다. 스캔 문서는 OCR 처리 후 다시 등록해 주세요.'
  if (/PDFs with more than 250 pages/i.test(message)) return 'PDF는 250쪽 이하만 등록할 수 있습니다.'
  if (/Extracted knowledge text exceeds the 100000-character/i.test(message)) return '문서 내용이 너무 깁니다. 10만 자 이하로 나누어 등록해 주세요.'
  if (/Images must be between 1 byte and 10 MiB/i.test(message)) return '이미지는 10MB 이하만 등록할 수 있습니다.'
  return message
}

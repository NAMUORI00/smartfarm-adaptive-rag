import assert from 'node:assert/strict'
import test from 'node:test'

import { knowledgeUploadCompletionCopy, knowledgeUploadErrorCopy, knowledgeUploadIssue, knowledgeUploadTitle } from './knowledge-upload.ts'

const MiB = 1024 * 1024
const file = (name: string, size: number) => ({ name, size }) as File

test('accepts supported knowledge files at their documented boundaries', () => {
  for (const name of ['guide.pdf', 'guide.txt', 'guide.md', 'guide.csv', 'photo.png', 'photo.jpg', 'photo.jpeg']) {
    const size = /\.(png|jpe?g)$/i.test(name) ? 10 * MiB : 12 * MiB
    assert.equal(knowledgeUploadIssue(file(name, size), 'public'), null)
  }
})

test('rejects unsupported, empty, oversized, and private image uploads before submission', () => {
  assert.match(knowledgeUploadIssue(file('guide.docx', 1), 'public') ?? '', /PDF, TXT, MD, CSV, JPG, PNG/)
  assert.match(knowledgeUploadIssue(file('guide.pdf', 0), 'public') ?? '', /내용이 없는/)
  assert.match(knowledgeUploadIssue(file('guide.pdf', 12 * MiB + 1), 'public') ?? '', /12MB/)
  assert.match(knowledgeUploadIssue(file('photo.png', 10 * MiB + 1), 'public') ?? '', /10MB/)
  assert.match(knowledgeUploadIssue(file('photo.jpg', 1), 'private') ?? '', /공개 자료로만/)
})

test('derives a readable title from a selected filename', () => {
  assert.equal(knowledgeUploadTitle(file('wasabi_root-zone_guide.pdf', 1)), 'wasabi root zone guide')
})

test('maps upload result kinds to operator-facing completion copy', () => {
  const base = { title: '근권 온도 관리', scope: 'public' as const, status: 'completed' as const, retrievalState: 'active' as const, sourceGroupId: 'source-group:test', summary: '근권 온도 관리 기준입니다.', chunkCount: 2 }
  assert.equal(knowledgeUploadCompletionCopy({ ...base, resultKind: 'created' }).heading, '새 자료를 등록했습니다')
  assert.equal(knowledgeUploadCompletionCopy({ ...base, resultKind: 'reused' }).heading, '이미 등록된 자료입니다')
  assert.equal(knowledgeUploadCompletionCopy({ ...base, resultKind: 'updated' }).heading, '기존 자료를 갱신했습니다')
  assert.equal(knowledgeUploadCompletionCopy({ ...base, resultKind: 'unknown' }).heading, '자료 등록을 마쳤습니다')
  assert.equal(knowledgeUploadCompletionCopy({ ...base, resultKind: 'created', status: 'running' }).heading, '자료를 확인하고 있습니다')
})

test('tells the operator to review a newly indexed source before enabling answers', () => {
  const completion = knowledgeUploadCompletionCopy({
    title: '근권 온도 관리',
    scope: 'private',
    status: 'completed',
    retrievalState: 'needs_review',
    resultKind: 'created',
    sourceGroupId: 'source-group:test',
    summary: '근권 온도 관리 기준입니다.',
    chunkCount: 2,
  })

  assert.equal(completion.heading, '새 자료를 등록했습니다')
  assert.match(completion.detail, /확인한 뒤 AI 답변에 사용을 켜세요/)
})

test('translates known server upload failures into operator actions', () => {
  assert.match(knowledgeUploadErrorCopy('Knowledge uploads must be 12 MiB or smaller.'), /12MB 이하/)
  assert.match(knowledgeUploadErrorCopy('Knowledge uploads must be UTF-8 text.'), /UTF-8 형식/)
  assert.match(knowledgeUploadErrorCopy('No extractable text was found in this PDF. Scanned or image-only PDFs require OCR.'), /OCR 처리/)
  assert.match(knowledgeUploadErrorCopy('PDFs with more than 250 pages are not accepted.'), /250쪽 이하/)
})

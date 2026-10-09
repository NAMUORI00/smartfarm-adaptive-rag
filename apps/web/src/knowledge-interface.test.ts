import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('keeps file selection separate from the explicit knowledge registration action', () => {
  const knowledgeStart = app.indexOf('function Knowledge(')
  const cardStart = app.indexOf('function KnowledgeSourceCard(', knowledgeStart)
  const knowledge = app.slice(knowledgeStart, cardStart)

  assert.match(knowledge, /const \[selectedFile, setSelectedFile\] = useState<File \| null>\(null\)/)
  assert.match(knowledge, /onSubmit=\{\(event\) => \{ event\.preventDefault\(\); void handleUpload\(\) \}\}/)
  assert.match(knowledge, /onChange=\{\(event\) => handleKnowledgeFileChange\(event\.target\.files\?\.\[0\] \?\? null\)\}/)
  assert.doesNotMatch(knowledge, /onChange=\{[^}]*handleUpload\(/)
  assert.match(knowledge, /disabled=\{!selectedFile \|\| !title\.trim\(\) \|\| Boolean\(uploadFileIssue\) \|\| busyId !== null\}/)
  assert.match(knowledge, /선택 취소/)
  assert.match(knowledge, /공개 이미지의 내용 추출에는 외부 AI 처리 경로가 사용될 수 있습니다/)
})

test('opens registration as an accessible modal without coupling its scope to catalog filters', () => {
  const knowledgeStart = app.indexOf('function Knowledge(')
  const cardStart = app.indexOf('function KnowledgeSourceCard(', knowledgeStart)
  const knowledge = app.slice(knowledgeStart, cardStart)
  const visibilityControls = knowledge.slice(knowledge.indexOf('className="filter-tabs visibility-tabs"'), knowledge.indexOf('className="filter-tabs category-tabs"'))
  const uploadScopeStart = knowledge.indexOf('<select value={scope}')
  const uploadScopeControl = knowledge.slice(uploadScopeStart, knowledge.indexOf('</select>', uploadScopeStart))

  assert.match(knowledge, /const \[isUploadOpen, setIsUploadOpen\] = useState\(false\)/)
  assert.match(knowledge, /<dialog ref=\{uploadDialog\}[^>]*aria-modal="true"[^>]*aria-labelledby="knowledge-upload-title"/)
  assert.match(knowledge, /onCancel=\{\(event\) => \{ event\.preventDefault\(\); closeUploadPanel\(\) \}\}/)
  assert.doesNotMatch(visibilityControls, /setScope\(/)
  assert.match(knowledge, /setScope\(event\.target\.value as Extract<KnowledgeScope, 'public' \| 'private'>\)/)
  assert.doesNotMatch(uploadScopeControl, /setVisibility\(|setActiveCategory\(|setPage\(/)
})

test('passes a source root into a fresh advisor selection and focuses the composer', () => {
  const handlerStart = app.indexOf('function openKnowledgeSourceInAdvisor(')
  const handler = app.slice(handlerStart, app.indexOf('\n  }', handlerStart) + 4)

  assert.match(handler, /beginNewAdvisorSession\(\)/)
  assert.match(handler, /selectedSourceIds: \[group\.id\]/)
  assert.match(handler, /setScreen\('advisor'\)/)
  assert.match(handler, /getElementById\('advisor-composer'\)\?\.focus\(\)/)
  assert.match(app, /onAsk=\{\(\) => onAskWithSource\(group\)\}/)
})

test('keeps the knowledge registration drawer full-width with touch-sized controls on phones', () => {
  assert.match(styles, /\.knowledge-upload-dialog \{[^}]*width: min\(560px,100%\);[^}]*height: 100dvh;/)
  assert.match(styles, /@media \(max-width: 580px\) \{[\s\S]*?\.knowledge-upload-required-grid, \.knowledge-upload-optional-grid \{ grid-template-columns: minmax\(0,1fr\); \}/)
  assert.match(styles, /\.knowledge-upload-cancel, \.knowledge-upload-dialog \.knowledge-upload-submit \{ min-height: 44px;/)
})

test('offers one lifecycle filter and a source-root retrieval switch without changing visibility filters', () => {
  const knowledgeStart = app.indexOf('function Knowledge(')
  const cardStart = app.indexOf('function KnowledgeSourceCard(', knowledgeStart)
  const knowledge = app.slice(knowledgeStart, cardStart)
  const card = app.slice(cardStart, app.indexOf('\nfunction ', cardStart + 1))

  assert.match(knowledge, /const \[retrievalFilter, setRetrievalFilter\] = useState<KnowledgeRetrievalFilter>\('all'\)/)
  assert.match(knowledge, /<span>답변 상태<\/span>/)
  assert.match(knowledge, /<option value="needs_review">확인 필요<\/option>/)
  assert.match(knowledge, /<option value="active">사용 중<\/option>/)
  assert.match(knowledge, /<option value="paused">사용 제외<\/option>/)
  assert.match(card, /className="knowledge-retrieval-switch"/)
  assert.match(card, /role="switch"/)
  assert.match(card, /retrievalState === 'active' \? 'paused' : 'active'/)
  assert.match(card, /editable \? <label className="knowledge-retrieval-switch"/)
  assert.match(card, /className="knowledge-retrieval-fixed"/)
  assert.match(card, /documentDisplayTitle\(titleDocument\).*AI 답변 사용/)
  assert.match(knowledge, /const filteredDocumentCount = useMemo/)
  assert.match(knowledge, /sourceGroups\.length\}개 원본 · \$\{filteredDocumentCount\}개 구성 자료/)
  assert.match(styles, /\.knowledge-retrieval-switch input:checked \+ i/)
})

test('uses the retrieval-state API optimistically and restores the previous card state on failure', () => {
  assert.match(api, /\/v1\/knowledge\/source-groups\/retrieval-state/)
  assert.match(api, /JSON\.stringify\(\{ source_group_id: sourceGroupId, retrieval_state: retrievalState \}\)/)
  assert.match(app, /setDocuments\(\(items\) => applyState\(items, nextState\)\)/)
  assert.match(app, /setCatalogDocuments\(\(items\) => applyState\(items, nextState\)\)/)
  assert.match(app, /setDocuments\(restoreState\)/)
  assert.match(app, /setCatalogDocuments\(restoreState\)/)
  assert.match(app, /이전 상태를 유지합니다/)
})

test('lazy-loads source-root revision summaries only from an owned source detail', () => {
  const cardStart = app.indexOf('function KnowledgeSourceCard(')
  const card = app.slice(cardStart, app.indexOf('\nfunction ', cardStart + 1))
  const revisionSummary = card.indexOf('className="knowledge-revision-summary"')
  const indexSummary = card.indexOf('className="knowledge-index-summary"')

  assert.match(api, /\/v1\/knowledge\/source-groups\/\$\{encodeURIComponent\(sourceGroupId\)\}\/revision/)
  assert.match(card, /if \(!editable \|\| revisionLoading \|\| \(!force && previousRevision !== undefined\)\) return/)
  assert.match(card, /onToggle=\{\(event\) => \{[\s\S]*event\.currentTarget\.open[\s\S]*loadPreviousRevision\(true\)/)
  assert.match(card, /\{editable && <section className="knowledge-revision-summary"/)
  assert.ok(revisionSummary >= 0 && revisionSummary < indexSummary, 'version summary must precede search internals')
  assert.match(card, />현재 내용<\/span>/)
  assert.match(card, />이전 내용<\/span>/)
  assert.match(card, /아직 이전 내용이 없습니다/)
})

test('restores a previous source-root revision through inline two-step confirmation', () => {
  const cardStart = app.indexOf('function KnowledgeSourceCard(')
  const card = app.slice(cardStart, app.indexOf('\nfunction ', cardStart + 1))

  assert.match(api, /\/v1\/knowledge\/source-groups\/\$\{encodeURIComponent\(sourceGroupId\)\}\/restore-previous/)
  assert.match(api, /method: 'POST', body: JSON\.stringify\(\{\}\)/)
  assert.match(card, /setRestoreConfirming\(true\)/)
  assert.match(card, /className="knowledge-revision-confirm" role="group"/)
  assert.match(card, /원본 전체를 되돌릴까요\?/)
  assert.match(card, /disabled=\{restoreBusy\}/)
  assert.match(card, /await onRestorePrevious\(\)/)
  assert.match(card, /await loadPreviousRevision\(true\)/)
  assert.doesNotMatch(card, /window\.confirm/)
  assert.match(app, /원본 전체를 이전 내용으로 돌렸습니다/)
  assert.match(app, /현재 내용은 그대로 유지됩니다/)
})

test('keeps a server-backed recovery entry when the last ready document card is gone', () => {
  const knowledgeStart = app.indexOf('function Knowledge(')
  const cardStart = app.indexOf('function KnowledgeSourceCard(', knowledgeStart)
  const knowledge = app.slice(knowledgeStart, cardStart)
  const recoveryEntry = knowledge.indexOf('className="knowledge-recently-deleted"')
  const cardGrid = knowledge.indexOf('className="knowledge-grid"')

  assert.match(api, /\/v1\/knowledge\/source-groups\/recoverable/)
  assert.match(api, /Array\.isArray\(result\) \? result : result\.source_groups \?\? \[\]/)
  assert.match(knowledge, /getRecoverableKnowledgeSourceGroups\(farm\.id\)/)
  assert.match(knowledge, /if \(recoverableResult\.data\) \{[\s\S]*setRecoverableSources\(recoverableResult\.data\)/)
  assert.ok(recoveryEntry >= 0 && recoveryEntry < cardGrid, 'deleted-source recovery must not depend on a ready document card')
  assert.match(knowledge, />최근 삭제한 자료<\/b>/)
  assert.match(knowledge, /삭제 전 \{formatDate\(source\.previousRevision\.createdAt\)/)
  assert.match(knowledge, /구성 자료 \{source\.previousRevision\.documentCount\}개/)
  assert.match(knowledge, />되돌리기<\/button>/)
  assert.match(knowledge, /이 자료를 다시 사용할 수 있게 되돌릴까요\?/)
})

test('refreshes both ready cards and recoverable roots after every restore swap', () => {
  const handlerStart = app.indexOf('async function handleRestorePrevious(')
  const handler = app.slice(handlerStart, app.indexOf('\n  }', handlerStart) + 4)
  const restoreCall = handler.indexOf('restorePreviousKnowledgeRevision(')
  const refreshCall = handler.indexOf('await loadDocuments()')

  assert.ok(restoreCall >= 0 && restoreCall < refreshCall)
  assert.match(handler, /setDocuments\(replaceGroup\)/)
  assert.match(handler, /setCatalogDocuments\(replaceGroup\)/)
  assert.match(handler, /setRecoverableCandidateId/)
  assert.match(app, /getRecoverableKnowledgeSourceGroups\(farm\.id\)[\s\S]*setRecoverableSources/)
  assert.match(app, /복원한 이전판에는 구성 자료가 없습니다/)
  assert.match(app, /else if \(outcome\.documentCount !== 0\)/)
})

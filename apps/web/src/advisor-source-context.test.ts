import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

test('routes natural-language source commands through verified server context patches', () => {
  assert.match(app, /isSourceCommandInstruction\(cleaned\)/)
  assert.match(app, /parseSourceCommand\(cleaned, \{ focusedSourceGroupId: effectiveFocusedSourceGroupId \}\)/)
  assert.match(app, /sourceContextVisibility: currentSourceVisibility/)
  assert.match(app, /searchResultSourceGroupIds: sourceCommand\?\.usesCurrentResultSet/)
  assert.match(app, /const acceptedContextPatch = contextPatch && !contextPatch\.error \? contextPatch : null/)
  assert.match(app, /selectedSourceIds: acceptedContextPatch\.operation !== 'search' \? acceptedContextPatch\.sourceGroupIds : current\.selectedSourceIds/)
  assert.match(api, /context_patch\?: Record<string, unknown> \| null/)
  assert.match(api, /mapKnowledgeSourceCommandPreviewResponse\(result\.context_patch\)/)
})

test('preserves dormant selections and restores the latest local session context', () => {
  assert.match(app, /const selectedSourceIdsSnapshot = \[\.\.\.selectedSourceIds\]/)
  assert.match(app, /selectedSourceIds: \[\.\.\.selectedSourceIdsSnapshot\]/)
  assert.match(app, /cleaned,\s*selectedSourceIdsSnapshot,\s*includeSimulationContext/)
  assert.match(app, /advisorSessionQueryContexts\.current\.set\(activeAdvisorSessionId/)
  assert.match(app, /advisorSessionQueryContexts\.current\.get\(session\.id\) \?\? queryContextForSession\(session\.turns\)/)
})

test('keeps semantic result order, removes the client cap, and locks source scope while answering', () => {
  assert.match(app, /const orderedSourceGroups = sourceSearchResult\s*\? visibleSourceGroups/)
  assert.doesNotMatch(app, /visibility, limit: 50/)
  assert.match(app, /disabled=\{isSending \|\| sourceSearchBusy \|\| !sourceQuery\.trim\(\)\}/)
  assert.match(app, /checked=\{publicOnly\} disabled=\{isSending\}/)
  assert.match(app, /checked=\{activeSelectionIds\.has\(group\.id\)\}\s*disabled=\{isSending\}/)
})

test('lets the server resolve source-free follow-ups and explains every empty-evidence state', () => {
  assert.doesNotMatch(app, /!activeSourceIds\.length && !composerCanRunWithoutSources/)
  assert.doesNotMatch(app, /일반 재배 질문은 답변에 사용할 근거를 하나 이상 켜세요/)
  assert.match(app, /이 답변에는 문서 인용이 없습니다/)
  assert.match(app, /답변 근거를 확인하고 있습니다/)
})

test('keeps everyday conversation out of evidence and device progress UI', () => {
  assert.match(app, /const conversational = toolTrace\?\.intent === 'conversation' && controlDrafts.length === 0/)
  assert.match(app, /\{!conversational && <>/)
  assert.match(app, /\{!activeTurnIsConversation && <RouteCard/)
  assert.match(app, /일상 대화에는 자료 검색을 사용하지 않았습니다/)
  assert.match(app, /요청과 이전 대화를 확인하고 있어요/)
  assert.match(api, /'conversation', 'knowledge', 'live_status', 'control_request'/)
})

test('renders GFM pipe tables as responsive semantic tables', () => {
  const markdown = readFileSync(new URL('./AdvisorMarkdown.tsx', import.meta.url), 'utf8')
  assert.match(markdown, /isMarkdownTableDivider\(lines\[index \+ 1\], tableHeader\.length\)/)
  assert.match(readFileSync(new URL('./AdvisorMarkdown.tsx', import.meta.url), 'utf8'), /className="assistant-table-scroll"/)
  assert.match(markdown, /<table>/)
  assert.match(styles, /\.assistant-table-scroll \{[^}]*overflow-x: auto;/)
  assert.match(styles, /\.assistant-table-scroll table \{[^}]*border-collapse: collapse;/)
  assert.match(markdown, /<code key=\{index\}>\{part\.slice\(1, -1\)\}<\/code>/)
  assert.match(styles, /\.assistant-report code \{/)
})

test('keeps field and evidence scope together and sends the focused zone with every question', () => {
  assert.match(app, /className="workspace-scope-bar" aria-label="현재 작업 범위"/)
  assert.match(app, /selectedZoneIds: selectedZone === 'all' \? \[\] : \[selectedZone\]/)
  assert.match(app, /zoneScopeMode: selectedZone === 'all' \? 'all' : 'focused'/)
  assert.match(app, /답변 자료<\/span><b>\{selectedSourceGroupCount\}개 원본/)
  assert.match(styles, /\.workspace-scope-controls \.public-toggle \{[^}]*min-height: 44px;/)
})

test('makes whole-result selection explicit and reversible across pagination', () => {
  assert.match(app, /검색 결과 \{matchedSourceGroups\.length\}개 모두 선택/)
  assert.match(app, /선택된 결과 \{matchedSelectedSourceCount\}개 해제/)
  assert.match(app, /setSelectedSourceIds\(sourceSelectionNotice\.previousIds \?\? \[\]\)/)
  assert.match(app, /페이지를 이동해도 선택 상태가 유지됩니다/)
})

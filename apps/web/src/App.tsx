import { controlValueText, controlStateText, controlToggleLabels, operationalStateText } from './farmer/control-labels'
import type { FarmRuntime } from './farmer/useFarmRuntime'
import { advisorRequests } from './advisor-request'
import { useSyncExternalStore } from 'react'
import { VideoWorkspace } from './VideoWorkspace'
import { VideoSessionProvider } from './video-context'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PatrolPanel } from './PatrolPanel'
import { recheckAdvisor } from './api'
import { advisorSuggestions } from './advisor-suggestions'
import { FieldInspection } from './FieldInspection'
import {
  acknowledgeOperationCase,
  activateDemoScenario,
  askAdvisor,
  createAdvisorSession,
  createControlProposal,
  createCultivationStrategy,
  declineAdvisorRun,
  deleteAdvisorSession,
  deleteKnowledge,
  formatDate,
  getAlertAdvisory,
  getAdvisorSession,
  getAdvisorSessions,
  getApprovals,
  getAudit,
  getAiSettings,
  getDashboard,
  getDashboardSnapshot,
  getDemoScenario,
  getDemoScenarios,
  getGatewayStatus,
  getKnowledge,
  getKnowledgePreviousRevision,
  getRecoverableKnowledgeSourceGroups,
  getOperationCaseCsv,
  getOperationCases,
  getOperationMetrics,
  getCultivationStrategies,
  getReadiness,
  reindexAllKnowledge,
  reindexKnowledge,
  replayOperations,
  rollbackCultivationStrategy,
  restorePreviousKnowledgeRevision,
  renameAdvisorSession,
  resetAiSettings,
  saveAlertAdvisorTurn,
  saveOperationCaseKnowledge,
  searchKnowledgeSourceGroups,
  seedKnowledge,
  testAiSettings,
  updateAiSettings,
  updateKnowledgeRetrievalState,
  updateKnowledgeSourceGroupMetadata,
  updateOperationsClock,
  applyCultivationStrategy,
  uploadKnowledge,
} from './api'
import type { AiSettingsResponse, AiSettingsTarget, AiSettingsUpdate, ControlRequest, DemoScenario, DemoScenarioState, KnowledgeMetadataUpdate, KnowledgePreviousRevision, KnowledgeRecoverableSourceGroup, LlmServiceTier, OperationKnowledgeSaveResult } from './api'
import { farms } from './mock-data'
import { controlDraftCanBeReviewed, controlMatchesScenario, controlProgressForDraft } from './control-progress'
import { advisorDeviceGroups, compactAdvisorSteps, deviceAdjustmentRange, expectedControlImpact, isGeneralConversationQuestion, isOperationalAdvisorQuestion, normalizeRangeValue, rangeSelectionForActuator } from './device-chat'
import { synchronizeTelemetryLatest } from './dashboard-trends'
import { MAX_TREND_SAMPLES, getSensorTrendDefinition, normalizeSvgPoints, recentDelta, selectSensorTrendSamples, sensorTrendGroups } from './sensor-trends'
import { advisorSummaryTurnForView, defaultAdvisorQueryContext, diagnosticsForAdvisorTurn, filterAdvisorSessions, hasPersistedQueryContext, latestCompletedTurn, nextSessionAfterDelete, queryContextForSession, upsertAdvisorSession, upsertAdvisorTurn } from './session-state'
import { groupKnowledgeSources, knowledgeSourceTopicSummary, restoreSourceRootSelection, sortKnowledgeSourceGroups, toggleSourceRootSelection } from './source-library'
import type { KnowledgeSourceGroup } from './source-library'
import { isSourceCommandInstruction, parseSourceCommand } from './source-command'
import { isKnowledgeSourceOwnedByFarm, isPublicKnowledgeScope, knowledgeApplicability, knowledgeCategory, knowledgeCategoryLabel, knowledgeLoadSucceeded, knowledgeRetrievalStateLabel, knowledgeScopeLabel, knowledgeSourceRetrievalState, knowledgeVisibility } from './knowledge-view'
import type { KnowledgeCategory, KnowledgeRetrievalFilter, KnowledgeVisibility } from './knowledge-view'
import { citedEvidenceGroups, evidenceGroupForPassage, groupAnswerEvidence } from './evidence-library'
import { parseOperationsReplay } from './replay-parser'
import { groupOperationCaseEvidence, incidentContextForTarget, operationCaseDateGroup, operationCaseProgress, operationCaseStatusLabel, operationCaseSummary, operationCaseTimelineDetail, sortOperationCases, truthModeLabel } from './operation-cases'
import { operationalUiCopy } from './operator-copy'
import { AdvisorMarkdown } from './AdvisorMarkdown'
import { actuatorCanBeControlled, actuatorControlTarget, actuatorForControl, actuatorStateIsEnabled, controlIdentity, deviceActionLabel, deviceScopeLabel, deviceStateWithMode, filterDevices, normalizedPercent, sameControlScope, sensorStability } from './operator-ui'
import type { DeviceCategory } from './operator-ui'
import { knowledgeUploadCompletionCopy, knowledgeUploadErrorCopy, knowledgeUploadIssue, knowledgeUploadTitle } from './knowledge-upload'
import type { KnowledgeUploadCompletion } from './knowledge-upload'
import {
  ALERT_ANALYSIS_RETRY_MS,
  alertLifecycleToken,
  canStartAutomaticAlertAnalysis,
  isRetryableAlertFallback,
  loadAlertAutomationSettings,
  nextAlertAnalysisFailure,
  prioritizeAlertsForAnalysis,
  saveAlertAutomationSettings,
  shouldAcceptAutomaticAlertResult,
  shouldAutoAnalyzeAlert,
} from './alert-automation'
import type { AlertAnalysisFailure, AlertAutomationSettings } from './alert-automation'
import type {
  Actuator,
  AdvisorAgentRun,
  AdvisorDiagnostics,
  AdvisorQueryContext,
  AdvisorSessionSummary,
  AdvisorToolTrace,
  AdvisorTurn,
  Alert,
  AlertAdvisory,
  Approval,
  AuditEvent,
  ChatMessage,
  ControlDraft,
  ControlTarget,
  ControlVerification,
  CultivationStrategies,
  CultivationStrategyThreshold,
  DashboardSnapshot,
  Evidence,
  Farm,
  FarmId,
  GatewayStatus,
  KnowledgeDocument,
  KnowledgeRetrievalState,
  KnowledgeScope,
  KnowledgeSourceSearchResult,
  OperationCase,
  OperationMetrics,
  ProposalTransition,
  ReadinessService,
  RuntimeState,
} from './types'

type Screen = 'farm3d' | 'dashboard' | 'advisor' | 'operations' | 'knowledge' | 'history'
type ControlApplyOutcome = 'applied' | 'definitive_failed' | 'ambiguous'
type AlertAnalysisState =
  | { status: 'loading'; token: string; automatic: boolean }
  | { status: 'ready'; advisory: AlertAdvisory; token: string; automatic: boolean }
  | { status: 'fallback'; advisory: AlertAdvisory; retrying: boolean; token: string; automatic: boolean }
  | { status: 'error'; message: string; retrying: boolean; token: string; automatic: boolean }
type CompletedAlertAnalysis = Extract<AlertAnalysisState, { status: 'ready' | 'fallback' }>

const ADVISOR_SOURCE_PAGE_SIZE = 5
const controlTargets: Array<{ value: ControlTarget; label: string; mode: 'percentage' | 'boolean' | 'action' }> = [
  { value: 'root_zone_chiller', label: '근권 냉각기', mode: 'boolean' },
  { value: 'irrigation_pump', label: '관수 사이클', mode: 'boolean' },
  { value: 'ventilation_fan', label: '환기팬', mode: 'percentage' },
  { value: 'roof_vent', label: '천창 개도', mode: 'percentage' },
  { value: 'side_vent', label: '측창 개도', mode: 'percentage' },
  { value: 'shade_curtain', label: '차광 커튼', mode: 'percentage' },
  { value: 'heater', label: '난방기', mode: 'boolean' },
  { value: 'air_temperature_sensor_reset', label: '공기 온도 센서 재보정', mode: 'action' },
]
type IconName =
  | 'grid' | 'sparkle' | 'activity' | 'book' | 'chevron' | 'bell' | 'settings' | 'help'
  | 'thermometer' | 'droplet' | 'cloud' | 'bolt' | 'arrowUp' | 'arrowDown' | 'minus'
  | 'send' | 'paperclip' | 'search' | 'external' | 'shield' | 'check' | 'x' | 'clock'
  | 'leaf' | 'wind' | 'sun' | 'water' | 'more' | 'database' | 'sliders' | 'refresh' | 'close'
  | 'upload' | 'trash'

const emptyDiagnostics: AdvisorDiagnostics = {
  provider: 'local', privacy: 'local_only', requestedModel: null, requestedServiceTier: null, model: null, serviceTier: null, fallbackReason: null,
  path: [], gateReason: '아직 AI 재배 조언을 실행하지 않았습니다.', runId: null,
  backend: null, candidateCount: null, returnedCount: null, queryScope: null, channels: [],
}

const emptyAdvisorExecution = {
  provider: 'local' as const,
  privacy: 'local_only' as const,
  requestedModel: null,
  requestedServiceTier: null,
  model: null,
  serviceTier: null,
  fallbackReason: null,
}

const emptyAdvisorRetrieval = {
  researchDiagnosticsOnly: false,
  runId: null,
  backend: null,
  candidateCount: null,
  returnedCount: null,
  queryScope: null,
  channels: [] as string[],
}

function controlTargetLabel(target: ControlTarget) {
  return controlTargets.find((item) => item.value === target)?.label ?? target
}


function plainExcerpt(value: string, maxLength = 150) {
  const cleaned = value.replace(/[#*_>`\[\]]/g, '').replace(/\s+/g, ' ').trim()
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength).trim()}…` : cleaned
}


function advisorySummary(value: string, maxLength = 170) {
  const content = operationalUiCopy(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line) && !/^\*\*[^*]+\*\*:?$/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/\*\*/g, ''))
  return plainExcerpt(content.slice(0, 2).join(' · '), maxLength)
}

const iconPaths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  sparkle: <path d="m12 3-1.5 5.7L5 10.2l5.5 1.5L12 17l1.5-5.3 5.5-1.5-5.5-1.5L12 3Zm6.5 13.4-.6 2.1-2.1.6 2.1.6.6 2.1.6-2.1 2.1-.6-2.1-.6-.6-2.1Z" />,
  activity: <path d="M3 12h4l2.1-6 4 12 2.2-6H21" />,
  book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" /><path d="M4 19a2.5 2.5 0 0 1 2.5-2.5H20" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" /><path d="M10 21h4" /></>,
  settings: <><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.4 9a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.1-2.6 3.8" /><path d="M12 17h.01" /></>,
  thermometer: <><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z" /><path d="M12 9v7" /></>,
  droplet: <path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z" />,
  cloud: <path d="M17.5 19H7a4 4 0 1 1 1.1-7.8A5 5 0 0 1 18 12.5h.5a3.3 3.3 0 0 1 0 6.5Z" />,
  bolt: <path d="m13 2-8 12h6l-1 8 8-12h-6l1-8Z" />,
  arrowUp: <><path d="m18 15-6-6-6 6" /><path d="M12 9v12" /></>,
  arrowDown: <><path d="m6 9 6 6 6-6" /><path d="M12 15V3" /></>,
  minus: <path d="M5 12h14" />,
  send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="m22 2-11 11" /></>,
  paperclip: <path d="m20.2 10.5-8.6 8.6a4 4 0 0 1-5.7-5.7l9.2-9.2a2.7 2.7 0 0 1 3.8 3.8l-9.2 9.2a1.4 1.4 0 0 1-2-2l8.6-8.6" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4-4" /></>,
  external: <><path d="M14 4h6v6" /><path d="m20 4-9 9" /><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" /></>,
  shield: <path d="M12 3 20 6v5c0 5-3.4 8.5-8 10-4.6-1.5-8-5-8-10V6l8-3Z" />,
  check: <path d="m5 12 4 4L19 6" />,
  x: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  leaf: <><path d="M20 4C11 4 5 8.5 5 15c0 2.7 1.8 4 4 4 6.5 0 11-6 11-15Z" /><path d="M4 20c2.5-5 6-8 11-10" /></>,
  wind: <><path d="M3 8h10a2.5 2.5 0 1 0-2.4-3.2" /><path d="M3 12h14a2.5 2.5 0 1 1-2.4 3.2" /><path d="M3 16h7" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  water: <><path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z" /><path d="M3 4v4M1 6h4" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="19" cy="12" r="1" fill="currentColor" /></>,
  database: <><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" /><path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" /></>,
  sliders: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></>,
  refresh: <><path d="M20 11a8 8 0 0 0-14.9-4L3 9" /><path d="M3 4v5h5" /><path d="M4 13a8 8 0 0 0 14.9 4L21 15" /><path d="M21 20v-5h-5" /></>,
  close: <><path d="m6 6 12 12" /><path d="m18 6-12 12" /></>,
  upload: <><path d="M12 16V3" /><path d="m7 8 5-5 5 5" /><path d="M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /><path d="M10 11v5M14 11v5" /></>,
}

function Icon({ name, size = 18, stroke = 1.8 }: { name: IconName; size?: number; stroke?: number }) {
  return <svg aria-hidden="true" className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">{iconPaths[name]}</svg>
}

function getFarm(farmId: FarmId) {
  return farms.find((farm) => farm.id === farmId) ?? farms[0]
}

function isLegacyResearch(document: KnowledgeDocument) {
  return document.isResearchArchive || document.title.startsWith('[legacy:')
}

function documentDisplayTitle(document: KnowledgeDocument) {
  const cleaned = document.title.replace(/^\[legacy:[^\]]+\]\s*/, '').trim()
  const aliases: Record<string, string> = {
    'fao-traditional-wasabi-water': '전통 수와사비 재배와 수환경',
    'jstage-wasabi-root-zone-temperature': '고추냉이 근권 온도와 생육 연구',
    'nies-wasabi-soft-rot-risk': '고수온과 고추냉이 연부병 위험',
    'nongsaro-wasabi-perlite-field-case': '펄라이트 고설베드 고추냉이 현장 사례',
    'wasabi-a-operations-sop': 'A동 고추냉이 재배 운영 기준서',
    'wasabi-simulation-policy': '센서·장치 운영 기준',
  }
  const filename = cleaned.split(/[\\/]/).at(-1) ?? cleaned
  const stem = filename.replace(/\.(pdf|md|txt|csv|docx?|png|jpe?g)$/i, '')
  const title = aliases[stem.toLowerCase()] ?? (filename === cleaned ? cleaned : stem.replace(/[_-]+/g, ' '))
  return operationalUiCopy(title)
}

type CitationProfile = Pick<KnowledgeDocument, 'issuer' | 'publishedYear' | 'documentType'> & Partial<Pick<KnowledgeDocument, 'crop' | 'cultivationSystem' | 'evidenceClass' | 'growthStage'>>

function evidenceClassLabel(value: string | null | undefined) {
  return ({
    official_agronomy: '재배 기술',
    peer_reviewed: '연구 자료',
    public_reference: '참고 자료',
    farm_sop: '농장 운영기준',
    simulated: '운영 참고',
  } as Record<string, string>)[value ?? ''] ?? value ?? null
}

function citationMeta(item: CitationProfile) {
  const applicability = knowledgeApplicability({ crop: item.crop ?? null, cultivationSystem: item.cultivationSystem ?? null, growthStage: item.growthStage ?? null })
  return [item.issuer, item.publishedYear ? String(item.publishedYear) : null, item.documentType, evidenceClassLabel(item.evidenceClass), ...applicability].filter(Boolean).map((value) => operationalUiCopy(String(value))).join(' · ')
}

function citationSourceMeta(item: CitationProfile) {
  return [item.issuer, item.publishedYear ? String(item.publishedYear) : null, item.documentType, evidenceClassLabel(item.evidenceClass)].filter(Boolean).map((value) => operationalUiCopy(String(value))).join(' · ')
}

function sourceRootMeta(group: KnowledgeSourceGroup) {
  return [knowledgeScopeLabel(group.representative.scope), group.representative.issuer, group.representative.publishedYear, group.pageLabel].filter(Boolean).join(' · ')
}

function knowledgeStatusLabel(status: KnowledgeDocument['status']) {
  return ({ ready: '사용 가능', processing: '처리 중', queued: '처리 대기', failed: '확인 필요', unknown: '상태 확인' } as const)[status]
}

function formatNow() {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
}

function advisorSessionTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '시각 미상'
  const today = new Date()
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return sameDay
    ? new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric' }).format(date)
}

function alertAdvisorSessionTitle(alert: Alert) {
  return `경보 · ${alert.title}`
}

function alertAdvisorTurnId(alert: Alert, token: string) {
  const occurrenceKey = (alert.occurrenceId || token).replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 96) || 'current'
  return `alert-advisory:${alert.id}:${occurrenceKey}`
}

function pageIsHidden() {
  return document.visibilityState === 'hidden'
}

function App({ runtime, onFarm }: { runtime?: FarmRuntime; onFarm?: () => void }) {
  const [screen, changeScreen] = useState<Screen>('dashboard')
  function setScreen(next: Screen) { if (next === 'farm3d') onFarm?.(); else changeScreen(next) }
  const [showVideoReview, setShowVideoReview] = useState(false)
  const [selectedZone, setSelectedZone] = useState<ZoneSelection>('all')
  const [farmId] = useState<FarmId>('farm-wasabi-a')
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [runtimeState, setRuntimeState] = useState<RuntimeState>('unavailable')
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([])
  const [operationCases, setOperationCases] = useState<OperationCase[]>([])
  const [operationMetrics, setOperationMetrics] = useState<OperationMetrics | null>(null)
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [cultivationStrategies, setCultivationStrategies] = useState<CultivationStrategies | null>(null)
  const [strategyBusy, setStrategyBusy] = useState<'create' | 'apply' | 'rollback' | null>(null)
  const [selectedOperationCase, setSelectedOperationCase] = useState<OperationCase | null>(null)
  const [acknowledgingIncidentId, setAcknowledgingIncidentId] = useState<string | null>(null)
  const [readiness, setReadiness] = useState<ReadinessService[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showDemoGuide, setShowDemoGuide] = useState(false)
  const [demoRecordExported, setDemoRecordExported] = useState(false)
  const [advisorDiagnostics, setAdvisorDiagnostics] = useState<AdvisorDiagnostics>(emptyDiagnostics)
  const [advisorSessions, setAdvisorSessions] = useState<AdvisorSessionSummary[]>([])
  const [activeAdvisorSessionId, setActiveAdvisorSessionId] = useState<string | null>(null)
  const [advisorSessionsLoading, setAdvisorSessionsLoading] = useState(true)
  const [advisorSessionError, setAdvisorSessionError] = useState<string | null>(null)
  const [advisorTurns, setAdvisorTurns] = useState<AdvisorTurn[]>([])
  const [latestStoredAdvisor, setLatestStoredAdvisor] = useState<{ sessionId: string; turn: AdvisorTurn } | null>(null)
  const [activeAdvisorTurnId, setActiveAdvisorTurnId] = useState<string | null>(null)
  const [advisorQueryContext, setAdvisorQueryContext] = useState<AdvisorQueryContext>(defaultAdvisorQueryContext)
  const [controlDraft, setControlDraft] = useState<ControlDraft | null>(null)
  const [scenarios, setScenarios] = useState<DemoScenario[]>([])
  const [scenarioState, setScenarioState] = useState<DemoScenarioState | null>(null)
  const [scenarioBusy, setScenarioBusy] = useState(false)
  const [replayBusy, setReplayBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [alertAutomation, setAlertAutomation] = useState<AlertAutomationSettings>(loadAlertAutomationSettings)
  const [alertAnalyses, setAlertAnalyses] = useState<Record<string, AlertAnalysisState>>({})
  const [alertAnalysisCycle, setAlertAnalysisCycle] = useState(0)
  const [activeControlTarget, setActiveControlTarget] = useState<string | null>(null)
  const [proposalTransitions, setProposalTransitions] = useState<Record<string, ProposalTransition>>({})
  const loadSequence = useRef(0)
  const fullLoadInFlight = useRef(false)
  const livePollInFlight = useRef(false)
  const alertAnalysisInFlight = useRef(new Map<string, string>())
  const analyzedAlertTokens = useRef(new Map<string, string>())
  const alertAnalysisFailures = useRef(new Map<string, AlertAnalysisFailure>())
  const alertRetryTimers = useRef(new Map<string, number>())
  const alertLifecycleVersions = useRef(new Map<string, number>())
  const alertAdvisoryPersistence = useRef(new Map<string, Promise<{ sessionId: string; turn: AdvisorTurn }>>())
  const persistedAlertAdvisories = useRef(new Map<string, { sessionId: string; turn: AdvisorTurn }>())
  const alertSessionCreation = useRef(new Map<string, Promise<string>>())
  const advisorSessionCreation = useRef<Promise<string> | null>(null)
  const previousActiveAlertIds = useRef(new Set<string>())
  const activeAlertTokens = useRef(new Map<string, string>())
  const controlInFlight = useRef(false)
  const alertAutomationRef = useRef(alertAutomation)
  const componentMounted = useRef(true)
  const pageScrollRef = useRef<HTMLDivElement>(null)
  const advisorSessionsRef = useRef(advisorSessions)
  const activeAdvisorSessionIdRef = useRef(activeAdvisorSessionId)
  const advisorSessionLoadSequence = useRef(0)
  const advisorSessionQueryContexts = useRef(new Map<string, AdvisorQueryContext>())
  const farm = getFarm(farmId)
  const activeAlertOccurrenceIds = useMemo(
    () => snapshot?.alerts.filter((alert) => alert.status === 'new').map((alert) => alert.occurrenceId) ?? [],
    [snapshot],
  )
  alertAutomationRef.current = alertAutomation
  advisorSessionsRef.current = advisorSessions
  activeAdvisorSessionIdRef.current = activeAdvisorSessionId

  useEffect(() => {
    if (!activeAdvisorSessionId) return
    advisorSessionQueryContexts.current.set(activeAdvisorSessionId, {
      ...advisorQueryContext,
      selectedSourceIds: [...advisorQueryContext.selectedSourceIds],
      selectedZoneIds: [...advisorQueryContext.selectedZoneIds],
    })
  }, [activeAdvisorSessionId, advisorQueryContext])

  useEffect(() => {
    if (controlDraft && !controlDraftCanBeReviewed(controlDraft, activeAlertOccurrenceIds)) setControlDraft(null)
  }, [activeAlertOccurrenceIds, controlDraft])

  async function loadFarm(showResult = false, quiet = false) {
    if (runtime) {
      await runtime.refresh();
      const [metrics,gateway,ready,scenario]=await Promise.all([getOperationMetrics(farmId),getGatewayStatus(farmId),getReadiness(farmId),getDemoScenarios(farmId)]);
      setOperationMetrics(metrics.data);setGatewayStatus(gateway.data);setReadiness(ready.data);setScenarios(scenario.data.scenarios);setScenarioState(scenario.data.active);setIsLoading(false);return runtime.connected;
    }
    const sequence = ++loadSequence.current
    fullLoadInFlight.current = true
    if (!quiet) setIsLoading(true)
    const [dashboard, proposals, audit, cases, metrics, gateway, strategies, readinessResult, scenarioResult] = await Promise.all([
      getDashboard(farmId), getApprovals(farmId), getAudit(farmId), getOperationCases(farmId), getOperationMetrics(farmId), getGatewayStatus(farmId), getCultivationStrategies(farmId), getReadiness(farmId), getDemoScenarios(farmId),
    ])
    if (sequence !== loadSequence.current) return false
    setSnapshot(dashboard.data)
    setRuntimeState(dashboard.state)
    setRuntimeError(dashboard.error ?? null)
    setApprovals(proposals.data)
    setAuditEvents(audit.data)
    setOperationCases(cases.data)
    setOperationMetrics(metrics.data)
    setGatewayStatus(gateway.data)
    setCultivationStrategies(strategies.data)
    setReadiness(readinessResult.data)
    setScenarios(scenarioResult.data.scenarios)
    setScenarioState(scenarioResult.data.active)
    fullLoadInFlight.current = false
    if (!quiet) setIsLoading(false)
    if (showResult) {
      setToast(dashboard.data ? '실제 API 데이터를 새로 불러왔습니다.' : dashboard.error ?? '운영 데이터를 불러오지 못했습니다.')
    }
    return Boolean(
      dashboard.data
      && dashboard.state === 'connected'
      && !dashboard.data.alerts.some((alert) => alert.status !== 'resolved')
      && proposals.state === 'connected'
      && !proposals.data.some((proposal) => proposal.status === 'waiting')
      && readinessResult.state === 'connected'
      && readinessResult.data.length > 0
      && readinessResult.data.every((item) => item.state === 'ready')
      && scenarioResult.state === 'connected'
      && scenarioResult.data.active?.scenarioId === 'normal',
    )
  }

  async function loadAdvisorSession(sessionId: string, quiet = false) {
    const sequence = ++advisorSessionLoadSequence.current
    if (!quiet) setAdvisorSessionsLoading(true)
    setAdvisorSessionError(null)
    try {
      const session = await getAdvisorSession(farmId, sessionId)
      if (sequence !== advisorSessionLoadSequence.current) return false
      setAdvisorSessions((items) => upsertAdvisorSession(items, session))
      activeAdvisorSessionIdRef.current = session.id
      setActiveAdvisorSessionId(session.id)
      setAdvisorTurns(session.turns)
      setActiveAdvisorTurnId(latestCompletedTurn(session.turns)?.id ?? null)
      const restoredContext = advisorSessionQueryContexts.current.get(session.id) ?? queryContextForSession(session.turns)
      setAdvisorQueryContext(restoredContext)
      if (restoredContext.zoneScopeMode === 'focused' && (restoredContext.selectedZoneIds[0] === 'zone-a' || restoredContext.selectedZoneIds[0] === 'zone-b')) {
        setSelectedZone(restoredContext.selectedZoneIds[0])
      } else setSelectedZone('all')
      return true
    } catch (error) {
      if (sequence !== advisorSessionLoadSequence.current) return false
      setAdvisorSessionError(error instanceof Error ? error.message : '대화 기록을 불러오지 못했습니다.')
      throw error
    } finally {
      if (!quiet && sequence === advisorSessionLoadSequence.current) setAdvisorSessionsLoading(false)
    }
  }

  async function loadAdvisorHistory() {
    const sequence = ++advisorSessionLoadSequence.current
    setAdvisorSessionsLoading(true)
    setAdvisorSessionError(null)
    try {
      const sessions = await getAdvisorSessions(farmId)
      if (sequence !== advisorSessionLoadSequence.current) return
      setAdvisorSessions(sessions)
      if (sessions[0]) {
        try {
          const latestSession = await getAdvisorSession(farmId, sessions[0].id)
          if (sequence !== advisorSessionLoadSequence.current) return
          const latestTurn = latestCompletedTurn(latestSession.turns)
          setLatestStoredAdvisor(latestTurn ? { sessionId: latestSession.id, turn: latestTurn } : null)
        } catch {
          if (sequence !== advisorSessionLoadSequence.current) return
          setLatestStoredAdvisor(null)
        }
      } else setLatestStoredAdvisor(null)
      activeAdvisorSessionIdRef.current = null
      setActiveAdvisorSessionId(null)
      setAdvisorTurns([])
      setActiveAdvisorTurnId(null)
      setAdvisorQueryContext(defaultAdvisorQueryContext())
    } catch (error) {
      if (sequence !== advisorSessionLoadSequence.current) return
      setAdvisorSessionError(error instanceof Error ? error.message : '대화 기록을 불러오지 못했습니다.')
    } finally {
      if (sequence === advisorSessionLoadSequence.current) setAdvisorSessionsLoading(false)
    }
  }

  async function ensureAdvisorSession(title?: string) {
    if (activeAdvisorSessionIdRef.current) return activeAdvisorSessionIdRef.current
    if (advisorSessionCreation.current) return advisorSessionCreation.current
    const creation = createAdvisorSession(farmId, title).then((session) => {
      setAdvisorSessions((items) => upsertAdvisorSession(items, session))
      activeAdvisorSessionIdRef.current = session.id
      setActiveAdvisorSessionId(session.id)
      setAdvisorSessionError(null)
      return session.id
    }).finally(() => {
      advisorSessionCreation.current = null
    })
    advisorSessionCreation.current = creation
    return creation
  }

  function beginNewAdvisorSession() {
    activeAdvisorSessionIdRef.current = null
    setActiveAdvisorSessionId(null)
    setAdvisorTurns([])
    setActiveAdvisorTurnId(null)
    setAdvisorQueryContext({
      ...defaultAdvisorQueryContext(),
      selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
      zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
    })
    setAdvisorSessionError(null)
    setAdvisorDiagnostics(emptyDiagnostics)
  }

  function openKnowledgeSourceInAdvisor(group: KnowledgeSourceGroup) {
    beginNewAdvisorSession()
    setAdvisorQueryContext({
      selectedSourceIds: [group.id],
      includeSimulationContext: true,
      selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
      zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
      sourceVisibility: group.representative.scope === 'private' ? 'all' : 'public',
    })
    setScreen('advisor')
    setToast(`“${documentDisplayTitle({ ...group.representative, title: group.title })}”을 답변 근거로 선택했습니다.`)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => document.getElementById('advisor-composer')?.focus())
    })
  }

  async function refreshAdvisorSessionList() {
    try {
      const sessions = await getAdvisorSessions(farmId)
      setAdvisorSessions(sessions)
      setAdvisorSessionError(null)
    } catch (error) {
      setAdvisorSessionError(error instanceof Error ? error.message : '대화 목록을 갱신하지 못했습니다.')
    }
  }

  async function handleRenameAdvisorSession(sessionId: string, title: string) {
    const session = await renameAdvisorSession(farmId, sessionId, title)
    setAdvisorSessions((items) => upsertAdvisorSession(items, session))
    setAdvisorSessionError(null)
  }

  async function handleDeleteAdvisorSession(sessionId: string) {
    await deleteAdvisorSession(farmId, sessionId)
    advisorSessionQueryContexts.current.delete(sessionId)
    for (const [token, saved] of persistedAlertAdvisories.current) {
      if (saved.sessionId === sessionId) persistedAlertAdvisories.current.delete(token)
    }
    const remaining = advisorSessions.filter((session) => session.id !== sessionId)
    setAdvisorSessions(remaining)
    if (latestStoredAdvisor?.sessionId === sessionId) {
      if (remaining[0]) {
        try {
          const latestSession = await getAdvisorSession(farmId, remaining[0].id)
          const latestTurn = latestCompletedTurn(latestSession.turns)
          setLatestStoredAdvisor(latestTurn ? { sessionId: latestSession.id, turn: latestTurn } : null)
        } catch {
          setLatestStoredAdvisor(null)
        }
      } else setLatestStoredAdvisor(null)
    }
    if (activeAdvisorSessionId !== sessionId) return
    const next = nextSessionAfterDelete(advisorSessions, sessionId)
    if (next) await loadAdvisorSession(next.id)
    else beginNewAdvisorSession()
  }

  async function pollLiveState() {
    if (pageIsHidden() || fullLoadInFlight.current || livePollInFlight.current) return
    livePollInFlight.current = true
    const sequence = loadSequence.current
    try {
      const [dashboard, scenario] = await Promise.all([
        getDashboardSnapshot(farmId),
        getDemoScenario(farmId),
      ])
      if (sequence !== loadSequence.current || pageIsHidden()) return
      if (dashboard.data) {
        setSnapshot((current) => current ? { ...current, ...dashboard.data } : current)
        setRuntimeState(dashboard.state)
      }
      if (scenario.data) setScenarioState(scenario.data)
    } finally {
      livePollInFlight.current = false
    }
  }

  useEffect(() => {
    if (!runtime) return;
    setSnapshot(runtime.snapshot);setApprovals(runtime.approvals);setAuditEvents(runtime.audit);setOperationCases(runtime.cases);setCultivationStrategies(runtime.strategies);setRuntimeState(runtime.connected?'connected':'unavailable');setRuntimeError(runtime.error||null);setIsLoading(false);
  }, [runtime?.snapshot,runtime?.approvals,runtime?.audit,runtime?.cases,runtime?.strategies,runtime?.connected,runtime?.error]);

  useEffect(() => {
    void loadFarm()
    // farmId is the explicit data boundary for every request on this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId])

  useEffect(() => {
    void loadAdvisorHistory()
    // Each farm and operator has an isolated persisted conversation list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId])

  useEffect(() => {
    setAdvisorQueryContext((current) => ({
      ...current,
      selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
      zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
    }))
  }, [selectedZone])

  useEffect(() => {
    const activeTurn = advisorTurns.find((turn) => turn.id === activeAdvisorTurnId) ?? latestCompletedTurn(advisorTurns)
    setAdvisorDiagnostics(diagnosticsForAdvisorTurn(activeTurn))
  }, [activeAdvisorTurnId, advisorTurns])

  useEffect(() => {
    const latestTurn = latestCompletedTurn(advisorTurns)
    if (latestTurn && activeAdvisorSessionId && advisorSessions[0]?.id === activeAdvisorSessionId) {
      setLatestStoredAdvisor({ sessionId: activeAdvisorSessionId, turn: latestTurn })
    }
  }, [activeAdvisorSessionId, advisorSessions, advisorTurns])

  useEffect(() => {
    if (runtime || !alertAutomation.liveUpdates) return
    const refresh = window.setInterval(() => void loadFarm(false, true), 30_000)
    return () => window.clearInterval(refresh)
    // The live-update switch deliberately controls background server refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, alertAutomation.liveUpdates])

  useEffect(() => {
    if (runtime || !alertAutomation.liveUpdates || (screen !== 'history' && !showDemoGuide)) return
    let active = true
    const refreshCases = () => void Promise.all([
      getOperationCases(farmId),
      getOperationMetrics(farmId),
      getGatewayStatus(farmId),
    ]).then(([cases, metrics, gateway]) => {
      if (!active) return
      if (cases.state === 'connected') setOperationCases(cases.data)
      if (metrics.state === 'connected') setOperationMetrics(metrics.data)
      if (gateway.data) setGatewayStatus(gateway.data)
    })
    refreshCases()
    const refresh = window.setInterval(refreshCases, 5_000)
    return () => {
      active = false
      window.clearInterval(refresh)
    }
  }, [alertAutomation.liveUpdates, farmId, screen, showDemoGuide])

  useEffect(() => {
    if (!selectedOperationCase) return
    const current = operationCases.find((item) => item.id === selectedOperationCase.id)
    if (current) setSelectedOperationCase(current)
  }, [operationCases, selectedOperationCase])

  useEffect(() => {
    if (runtime || !alertAutomation.liveUpdates) return
    void pollLiveState()
    const refresh = window.setInterval(() => void pollLiveState(), 2_000)
    function refreshWhenVisible() {
      if (document.visibilityState === 'visible') void pollLiveState()
    }
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(refresh)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
    // The refs make the poll single-flight; the switch controls this live path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, alertAutomation.liveUpdates])

  useEffect(() => {
    saveAlertAutomationSettings(alertAutomation)
  }, [alertAutomation])

  useEffect(() => {
    componentMounted.current = true
    return () => {
      componentMounted.current = false
      for (const timer of alertRetryTimers.current.values()) window.clearTimeout(timer)
      alertRetryTimers.current.clear()
    }
  }, [])

  const clearAlertRetryTimer = useCallback((alertId: string) => {
    const timer = alertRetryTimers.current.get(alertId)
    if (timer !== undefined) window.clearTimeout(timer)
    alertRetryTimers.current.delete(alertId)
  }, [])

  const removeAlertAnalysis = useCallback((alertId: string, expectedToken?: string) => {
    if (!componentMounted.current) return
    setAlertAnalyses((current) => {
      if (!(alertId in current) || (expectedToken && current[alertId].token !== expectedToken)) return current
      return Object.fromEntries(Object.entries(current).filter(([id]) => id !== alertId))
    })
  }, [])

  const ensureAlertAdvisorSession = useCallback((title: string) => {
    const existing = advisorSessionsRef.current.find((session) => session.title === title)
    if (existing) return Promise.resolve(existing.id)
    const inFlight = alertSessionCreation.current.get(title)
    if (inFlight) return inFlight
    const creation = createAdvisorSession(farmId, title, true).then((session) => {
      advisorSessionsRef.current = upsertAdvisorSession(advisorSessionsRef.current, session)
      setAdvisorSessions(advisorSessionsRef.current)
      return session.id
    }).finally(() => alertSessionCreation.current.delete(title))
    alertSessionCreation.current.set(title, creation)
    return creation
  }, [farmId])

  const persistAlertAdvisory = useCallback((alert: Alert, advisory: AlertAdvisory, token: string) => {
    const persisted = persistedAlertAdvisories.current.get(token)
    if (persisted) return Promise.resolve(persisted)
    const inFlight = alertAdvisoryPersistence.current.get(token)
    if (inFlight) return inFlight
    const persistence = (async () => {
      const sessionId = await ensureAlertAdvisorSession(alertAdvisorSessionTitle(alert))
      const turn = await saveAlertAdvisorTurn(farmId, sessionId, alertAdvisorTurnId(alert, token), alert.id, advisory.snapshot)
      const result = { sessionId, turn }
      persistedAlertAdvisories.current.set(token, result)
      setLatestStoredAdvisor({ sessionId, turn })
      if (activeAdvisorSessionIdRef.current === sessionId) {
        setAdvisorTurns((items) => upsertAdvisorTurn(items, turn))
        setActiveAdvisorTurnId(turn.id)
      }
      void getAdvisorSessions(farmId).then((sessions) => {
        advisorSessionsRef.current = sessions
        setAdvisorSessions(sessions)
      }).catch(() => undefined)
      return result
    })()
    alertAdvisoryPersistence.current.set(token, persistence)
    void persistence.catch((error) => {
      if (componentMounted.current) setAdvisorSessionError(error instanceof Error ? `경보 대화 저장 실패: ${error.message}` : '경보 대화를 저장하지 못했습니다.')
    }).finally(() => alertAdvisoryPersistence.current.delete(token))
    return persistence
  }, [ensureAlertAdvisorSession, farmId])

  const requestAlertAnalysis = useCallback(async (alert: Alert, automatic = false) => {
    if (!componentMounted.current) return
    const token = activeAlertTokens.current.get(alert.id)
    if (!token) return
    const failure = alertAnalysisFailures.current.get(alert.id)
    if (automatic) {
      if (!canStartAutomaticAlertAnalysis({
        token,
        completedToken: analyzedAlertTokens.current.get(alert.id),
        failure,
        inFlight: alertAnalysisInFlight.current.get(alert.id) === token,
        inFlightCount: alertAnalysisInFlight.current.size,
        now: Date.now(),
      })) return
    } else if (alertAnalysisInFlight.current.get(alert.id) === token) return
    if (!automatic) alertAnalysisFailures.current.delete(alert.id)
    clearAlertRetryTimer(alert.id)

    alertAnalysisInFlight.current.set(alert.id, token)
    setAlertAnalyses((current) => ({ ...current, [alert.id]: { status: 'loading', token, automatic } }))
    try {
      const advisory = await getAlertAdvisory(farmId, alert.id)
      if (!componentMounted.current) return
      if (activeAlertTokens.current.get(alert.id) !== token) {
        removeAlertAnalysis(alert.id, token)
        return
      }
      const latestSettings = alertAutomationRef.current
      if (automatic && !shouldAcceptAutomaticAlertResult(alert, latestSettings, token, activeAlertTokens.current.get(alert.id))) {
        removeAlertAnalysis(alert.id, token)
        return
      }
      if (!advisory.remoteLlmUsed) {
        if (!isRetryableAlertFallback(advisory)) {
          analyzedAlertTokens.current.set(alert.id, token)
          alertAnalysisFailures.current.delete(alert.id)
          setAlertAnalyses((current) => ({ ...current, [alert.id]: { status: 'fallback', advisory, retrying: false, token, automatic } }))
          void persistAlertAdvisory(alert, advisory, token)
          if (automatic && latestSettings.showToast) setToast(`${alert.title} · 확인 가능한 근거 안내를 표시했습니다.`)
          return
        }
        const previousAttempts = failure?.token === token ? failure.attempts : 0
        const { attempts, retrying, retryAt } = nextAlertAnalysisFailure(previousAttempts, automatic, Date.now())
        alertAnalysisFailures.current.set(alert.id, { token, retryAt, attempts })
        setAlertAnalyses((current) => ({ ...current, [alert.id]: { status: 'fallback', advisory, retrying, token, automatic } }))
        if (!retrying) void persistAlertAdvisory(alert, advisory, token)
        if (retrying) {
          const timer = window.setTimeout(() => {
            alertRetryTimers.current.delete(alert.id)
            if (componentMounted.current && shouldAcceptAutomaticAlertResult(alert, alertAutomationRef.current, token, activeAlertTokens.current.get(alert.id))) {
              setAlertAnalysisCycle((cycle) => cycle + 1)
            }
          }, ALERT_ANALYSIS_RETRY_MS)
          alertRetryTimers.current.set(alert.id, timer)
        }
        if (automatic && latestSettings.showToast) setToast(`${alert.title} · 확인 가능한 근거 안내를 표시했습니다.`)
        return
      }
      analyzedAlertTokens.current.set(alert.id, token)
      alertAnalysisFailures.current.delete(alert.id)
      setAlertAnalyses((current) => ({ ...current, [alert.id]: { status: 'ready', advisory, token, automatic } }))
      void persistAlertAdvisory(alert, advisory, token)
      if (automatic && latestSettings.showToast) setToast(`${alert.title} · AI 경보 분석이 준비되었습니다.`)
    } catch (error) {
      if (!componentMounted.current) return
      if (activeAlertTokens.current.get(alert.id) !== token) {
        removeAlertAnalysis(alert.id, token)
        return
      }
      const latestSettings = alertAutomationRef.current
      if (automatic && !shouldAcceptAutomaticAlertResult(alert, latestSettings, token, activeAlertTokens.current.get(alert.id))) {
        removeAlertAnalysis(alert.id, token)
        return
      }
      const message = error instanceof Error ? error.message : '경보 해석을 불러오지 못했습니다.'
      const previousAttempts = failure?.token === token ? failure.attempts : 0
      const { attempts, retrying, retryAt } = nextAlertAnalysisFailure(previousAttempts, automatic, Date.now())
      alertAnalysisFailures.current.set(alert.id, { token, retryAt, attempts })
      setAlertAnalyses((current) => ({ ...current, [alert.id]: { status: 'error', message, retrying, token, automatic } }))
      if (retrying) {
        const timer = window.setTimeout(() => {
          alertRetryTimers.current.delete(alert.id)
          if (componentMounted.current && shouldAcceptAutomaticAlertResult(alert, alertAutomationRef.current, token, activeAlertTokens.current.get(alert.id))) {
            setAlertAnalysisCycle((cycle) => cycle + 1)
          }
        }, ALERT_ANALYSIS_RETRY_MS)
        alertRetryTimers.current.set(alert.id, timer)
      }
    } finally {
      if (alertAnalysisInFlight.current.get(alert.id) === token) alertAnalysisInFlight.current.delete(alert.id)
      if (componentMounted.current) setAlertAnalysisCycle((cycle) => cycle + 1)
    }
  }, [clearAlertRetryTimer, farmId, persistAlertAdvisory, removeAlertAnalysis])

  useEffect(() => {
    if (!snapshot) {
      activeAlertTokens.current.clear()
      previousActiveAlertIds.current.clear()
      analyzedAlertTokens.current.clear()
      alertAnalysisFailures.current.clear()
      alertAnalysisInFlight.current.clear()
      for (const id of alertRetryTimers.current.keys()) clearAlertRetryTimer(id)
      setAlertAnalyses((current) => Object.keys(current).length ? {} : current)
      return
    }
    const activeAlerts = snapshot.alerts.filter((alert) => alert.status === 'new')
    const activeIds = new Set(activeAlerts.map((alert) => alert.id))
    const activeAlertsById = new Map(activeAlerts.map((alert) => [alert.id, alert]))
    for (const alert of activeAlerts) {
      if (!previousActiveAlertIds.current.has(alert.id)) {
        alertLifecycleVersions.current.set(alert.id, (alertLifecycleVersions.current.get(alert.id) ?? 0) + 1)
      }
    }
    const nextTokens = new Map(activeAlerts.map((alert) => [
      alert.id,
      alertLifecycleToken(alertLifecycleVersions.current.get(alert.id) ?? 1, alert),
    ]))
    activeAlertTokens.current = nextTokens
    previousActiveAlertIds.current = activeIds
    for (const [id, token] of alertAnalysisInFlight.current) {
      if (nextTokens.get(id) !== token) alertAnalysisInFlight.current.delete(id)
    }
    for (const id of analyzedAlertTokens.current.keys()) {
      if (!activeIds.has(id)) analyzedAlertTokens.current.delete(id)
    }
    for (const id of alertAnalysisFailures.current.keys()) {
      const alert = activeAlertsById.get(id)
      const noLongerEligible = !alert || !alertAutomation.liveUpdates || !shouldAutoAnalyzeAlert(alert, alertAutomation)
      if (noLongerEligible || alertAnalysisFailures.current.get(id)?.token !== nextTokens.get(id)) {
        alertAnalysisFailures.current.delete(id)
        clearAlertRetryTimer(id)
      }
    }
    setAlertAnalyses((current) => {
      let changed = false
      const next: Record<string, AlertAnalysisState> = {}
      for (const [id, analysis] of Object.entries(current)) {
        const alert = activeAlertsById.get(id)
        if (!alert || analysis.token !== nextTokens.get(id)) {
          changed = true
          continue
        }
        const eligible = alertAutomation.liveUpdates && shouldAutoAnalyzeAlert(alert, alertAutomation)
        if (!eligible && analysis.automatic && analysis.status === 'loading') {
          changed = true
          continue
        }
        if (!eligible && analysis.automatic && (analysis.status === 'fallback' || analysis.status === 'error') && analysis.retrying) {
          next[id] = { ...analysis, retrying: false }
          changed = true
          continue
        }
        next[id] = analysis
      }
      return changed ? next : current
    })
    if (runtime || !alertAutomation.liveUpdates) return
    prioritizeAlertsForAnalysis(activeAlerts.filter((alert) => shouldAutoAnalyzeAlert(alert, alertAutomation)))
      .forEach((alert) => void requestAlertAnalysis(alert, true))
  }, [alertAnalysisCycle, alertAutomation, clearAlertRetryTimer, requestAlertAnalysis, snapshot])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 3_500)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    pageScrollRef.current?.scrollTo({ top: 0 })
    window.scrollTo({ top: 0 })
  }, [screen])

  const isCreatingProposal = activeControlTarget !== null
  const dataReady = Boolean(
    snapshot?.dataOrigin === 'telemetry_service'
    && snapshot.dataMode !== 'unavailable'
    && snapshot.operationalControlAllowed,
  )
  const operatingReady = dataReady
    && readiness.length > 0
    && readiness.every((item) => item.state === 'ready')
  const displayedRuntimeState: RuntimeState = dataReady
    ? 'connected'
    : runtimeState === 'connected' ? 'degraded' : runtimeState

  async function handleCreateProposal(control: ControlRequest): Promise<ControlApplyOutcome> {
    if (control.alertOccurrenceId && !activeAlertOccurrenceIds.includes(control.alertOccurrenceId)) {
      setControlDraft(null)
      setToast('경보가 종료되어 이 조정안을 실행하지 않았습니다.')
      return 'definitive_failed'
    }
    if (controlInFlight.current) return 'ambiguous'
    controlInFlight.current = true
    setActiveControlTarget(controlIdentity(control.target, control.zoneId))
    try {
      const rawBefore = controlDraft && sameControlScope(controlDraft, control) && controlDraft.beforeState != null
        ? controlDraft.beforeState
        : actuatorForControl(snapshot?.actuators ?? [], control.target, control.zoneId)?.state ?? '상태 미보고'
      const before = control.target === 'air_temperature_sensor_reset'
        ? operationalStateText(rawBefore)
        : controlStateText(rawBefore, control.target)
      const incidentContext = !control.origin && snapshot
        ? incidentContextForTarget(snapshot.incidents, control.target, control.zoneId)
        : null
      const proposal = await createControlProposal(
        farmId,
        incidentContext
          ? {
              ...control,
              contextAlertId: incidentContext.alertId,
              contextAlertOccurrenceId: incidentContext.occurrenceId,
            }
          : control,
        'demo-operator-wasabi',
      )
      setApprovals((items) => [proposal, ...items.filter((item) => item.id !== proposal.id)])
      setProposalTransitions((items) => ({
        ...items,
        [proposal.id]: { before, requested: controlValueText(control.value, control.target) },
      }))
      setControlDraft(null)
      const [audit, dashboard, scenario, cases] = await Promise.all([
        getAudit(farmId),
        getDashboardSnapshot(farmId),
        getDemoScenario(farmId),
        getOperationCases(farmId),
      ])
      setAuditEvents(audit.data)
      setOperationCases(cases.data)
      if (dashboard.data) setSnapshot((current) => current ? { ...current, ...dashboard.data } : current)
      if (scenario.data) setScenarioState(scenario.data)
      const activeSessionId = activeAdvisorSessionIdRef.current
      if (activeSessionId) await loadAdvisorSession(activeSessionId, true)
      const executionApplied = proposal.status === 'approved' && proposal.executionStatus === 'applied_to_simulator'
      const applied = executionApplied
        && proposal.verification?.status === 'verified'
        && proposal.verification.outcome !== 'unrecovered'
      setToast(applied
        ? proposal.verification?.outcome === 'resolved'
          ? '장치 반영과 환경 회복을 확인했습니다.'
          : proposal.verification?.outcome === 'recovery_pending'
          ? control.target === 'air_temperature_sensor_reset'
            ? '센서 재보정 명령이 반영되었습니다. 환경 회복을 관찰합니다.'
            : '장치 변경이 반영되었습니다. 환경 회복을 관찰합니다.'
          : '장치 변경이 반영되었습니다. 센서와 경보 변화를 관찰합니다.'
        : operationalUiCopy(
            executionApplied
              ? proposal.verification?.outcome === 'unrecovered'
                ? '장치는 변경됐지만 환경 회복이 확인되지 않아 현장 점검으로 인계했습니다.'
                : proposal.verification?.detail ?? '장치 명령은 전달됐지만 변경 결과를 다시 확인해야 합니다.'
              : proposal.failureReason ?? '장치 변경 결과를 확인하지 못했습니다.',
          ))
      return applied ? 'applied' : 'definitive_failed'
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '장치 변경을 시작하지 못했습니다.')
      return 'ambiguous'
    } finally {
      controlInFlight.current = false
      setActiveControlTarget(null)
    }
  }

  function reviewControlDraft(draft: ControlDraft) {
    if (!controlDraftCanBeReviewed(draft, activeAlertOccurrenceIds)) {
      setToast('이미 종료된 경보의 조정안입니다. 기록은 대화에서 확인할 수 있습니다.')
      return
    }
    const beforeState = draft.beforeState ?? actuatorForControl(snapshot?.actuators ?? [], draft.target, draft.zoneId)?.state ?? '상태 미보고'
    setControlDraft({ ...draft, rationale: operationalUiCopy(draft.rationale), beforeState })
  }

  async function declineControlDraft(draft: ControlDraft) {
    setControlDraft(null)
    if (!draft.advisorRunId) return
    try {
      await declineAdvisorRun(farmId, draft.advisorRunId)
      const activeSessionId = activeAdvisorSessionIdRef.current
      if (activeSessionId) await loadAdvisorSession(activeSessionId, true)
      setToast('이 조정은 실행하지 않았습니다.')
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '조정 취소를 저장하지 못했습니다.')
    }
  }

  async function handleScenario(primaryId: string, secondaryId: string | null, zoneIds: string[]) {
    const scenarioIds = [primaryId, secondaryId].filter((item): item is string => Boolean(item) && item !== 'normal')
    const normalizedScenarioIds = primaryId === 'normal' ? ['normal'] : scenarioIds
    const alreadyActive = normalizedScenarioIds.length === (scenarioState?.scenarioIds.length ?? 0)
      && normalizedScenarioIds.every((item, index) => item === scenarioState?.scenarioIds[index])
      && zoneIds.length === (scenarioState?.zoneIds.length ?? 0)
      && zoneIds.every((item, index) => item === scenarioState?.zoneIds[index])
    if (scenarioBusy || alreadyActive) return
    setScenarioBusy(true)
    try {
      const state = await activateDemoScenario(farmId, primaryId, {
        scenarioIds: normalizedScenarioIds,
        zoneIds,
        seed: scenarioState?.seed ?? 1024,
      })
      setScenarioState(state)
      await loadFarm(false, true)
      const labels = normalizedScenarioIds.map((id) => scenarios.find((item) => item.id === id)?.name ?? id)
      setToast(`${labels.join(' + ')} 운영 조건을 적용했습니다.`)
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '상황 프로필을 적용하지 못했습니다.')
    } finally {
      setScenarioBusy(false)
    }
  }

  async function handleClock(update: { speed?: 1 | 5 | 10; paused?: boolean; resetTo?: string; seed?: number }) {
    if (scenarioBusy) return
    setScenarioBusy(true)
    try {
      const clock = await updateOperationsClock(farmId, update)
      setSnapshot((current) => current ? { ...current, clock } : current)
      await pollLiveState()
      setToast(clock.paused ? '운영 흐름을 일시 정지했습니다.' : `${clock.speed}배 속도로 운영 흐름을 확인합니다.`)
    } catch {
      setToast('운영 흐름 설정을 변경하지 못했습니다.')
    } finally {
      setScenarioBusy(false)
    }
  }

  async function handleReplayFile(file: File) {
    if (replayBusy) return
    if (file.size > 5 * 1024 * 1024) {
      setToast('운영 기록은 5MB 이하의 CSV 또는 NDJSON 파일을 사용해 주세요.')
      return
    }
    setReplayBusy(true)
    try {
      const observations = parseOperationsReplay(await file.text(), file.name)
      const result = await replayOperations(farmId, observations)
      await loadFarm(false, true)
      setToast(`${result.accepted_observations}개 시점의 운영 기록을 불러왔습니다.`)
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '운영 기록을 불러오지 못했습니다.')
    } finally {
      setReplayBusy(false)
    }
  }

  async function handleDemoReset() {
    if (scenarioBusy || isCreatingProposal) return
    setScenarioBusy(true)
    try {
      setControlDraft(null)
      for (const id of alertRetryTimers.current.keys()) clearAlertRetryTimer(id)
      activeAlertTokens.current.clear()
      previousActiveAlertIds.current.clear()
      analyzedAlertTokens.current.clear()
      alertAnalysisFailures.current.clear()
      alertAnalysisInFlight.current.clear()
      setAlertAnalyses({})
      setProposalTransitions({})
      await updateOperationsClock(farmId, { speed: 1, paused: false, resetTo: new Date().toISOString(), seed: 1024 })
      const state = await activateDemoScenario(farmId, 'normal', { scenarioIds: ['normal'], zoneIds: ['zone-a'], seed: 1024 })
      setScenarioState(state)
      beginNewAdvisorSession()
      setScreen('dashboard')
      await loadFarm(false, true)
      const [preparedScenario, preparedDashboard, preparedProposals] = await Promise.all([
        getDemoScenario(farmId),
        getDashboardSnapshot(farmId),
        getApprovals(farmId),
      ])
      const prepared = preparedScenario.state === 'connected'
        && preparedScenario.data?.scenarioId === 'normal'
        && preparedDashboard.state === 'connected'
        && preparedDashboard.data !== null
        && preparedDashboard.data.dataOrigin === 'telemetry_service'
        && preparedDashboard.data.dataMode !== 'unavailable'
        && preparedDashboard.data.operationalControlAllowed
        && preparedDashboard.data.clock?.speed === 1
        && !preparedDashboard.data.clock?.paused
        && !preparedDashboard.data?.alerts.some((alert) => alert.status !== 'resolved')
        && preparedProposals.state === 'connected'
        && !preparedProposals.data.some((proposal) => proposal.status === 'waiting')
      if (!prepared) throw new Error('operating state verification failed')
      setToast('운영 상태를 정상 기준으로 되돌렸습니다. 운영 준비가 완료되었습니다.')
    } catch {
      setToast('운영 상태를 정상 기준으로 되돌리지 못했습니다.')
    } finally {
      setScenarioBusy(false)
    }
  }

  async function handleGuidedDemoStart() {
    if (scenarioBusy || isCreatingProposal) return
    setScenarioBusy(true)
    setDemoRecordExported(false)
    try {
      const clock = await updateOperationsClock(farmId, {
        speed: 10,
        paused: false,
        resetTo: new Date().toISOString(),
        seed: 1024,
      })
      const state = await activateDemoScenario(farmId, 'root_cooling_fault', {
        scenarioIds: ['root_cooling_fault'],
        zoneIds: ['zone-a'],
        seed: 1024,
      })
      setSnapshot((current) => current ? { ...current, clock } : current)
      setScenarioState(state)
      setScreen('dashboard')
      await loadFarm(false, true)
      setToast('근권 냉각 이상 상황을 시작했습니다. 경보와 센서 변화를 확인하세요.')
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '안내형 시연을 시작하지 못했습니다.')
    } finally {
      setScenarioBusy(false)
    }
  }

  async function handleOperationCaseCsv(record: OperationCase) {
    try {
      const content = await getOperationCaseCsv(farmId, record.incidentId)
      const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `operation-case-${record.incidentId}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      setDemoRecordExported(true)
      setToast('운영 판단 기록 CSV를 내려받았습니다.')
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '운영 판단 기록을 내려받지 못했습니다.')
    }
  }

  function handleOperationCasePrint(record: OperationCase) {
    setSelectedOperationCase(record)
    setDemoRecordExported(true)
    window.setTimeout(() => window.print(), 120)
  }

  async function handleAcknowledgeOperationCase(record: OperationCase) {
    if (record.acknowledgedAt || acknowledgingIncidentId) return
    setAcknowledgingIncidentId(record.incidentId)
    try {
      const acknowledged = await acknowledgeOperationCase(farmId, record.incidentId)
      setOperationCases((items) => items.map((item) => item.incidentId === acknowledged.incidentId ? acknowledged : item))
      setSelectedOperationCase((current) => current?.incidentId === acknowledged.incidentId ? acknowledged : current)
      const metrics = await getOperationMetrics(farmId)
      if (metrics.state === 'connected') setOperationMetrics(metrics.data)
      setToast('경보를 확인했습니다. 대응 과정과 확인 시간이 Log에 기록됩니다.')
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '경보 확인 상태를 반영하지 못했습니다.')
    } finally {
      setAcknowledgingIncidentId(null)
    }
  }

  async function handleSaveOperationCaseKnowledge(record: OperationCase) {
    const result = await saveOperationCaseKnowledge(farmId, record.incidentId)
    const message = result.outcome === 'reused'
      ? '이미 저장된 농장 지식을 그대로 사용합니다.'
      : result.outcome === 'needs_review'
        ? '농장 지식으로 저장했습니다. 답변에 사용하기 전에 내용을 확인하세요.'
        : '운영 결과를 농장 지식으로 저장했습니다.'
    setToast(message)
    return result
  }

  async function handleCreateStrategy(input: { growthStage: string; thresholds: CultivationStrategyThreshold[]; evidenceSourceIds: string[]; changeNote: string }) {
    if (strategyBusy) return false
    setStrategyBusy('create')
    try {
      const strategies = await createCultivationStrategy(farmId, input)
      setCultivationStrategies(strategies)
      setToast('새 운영 기준 버전을 저장했습니다. 적용 전까지 현재 기준은 유지됩니다.')
      return true
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '운영 기준 버전을 저장하지 못했습니다.')
      return false
    } finally {
      setStrategyBusy(null)
    }
  }

  async function handleApplyStrategy(versionId: string) {
    if (strategyBusy) return
    setStrategyBusy('apply')
    try {
      const strategies = await applyCultivationStrategy(farmId, versionId)
      setCultivationStrategies(strategies)
      await loadFarm(false, true)
      setToast(`${versionId} 운영 기준을 센서 판정에 적용했습니다.`)
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '운영 기준을 적용하지 못했습니다.')
    } finally {
      setStrategyBusy(null)
    }
  }

  async function handleRollbackStrategy() {
    if (strategyBusy) return
    setStrategyBusy('rollback')
    try {
      const strategies = await rollbackCultivationStrategy(farmId)
      setCultivationStrategies(strategies)
      await loadFarm(false, true)
      setToast(`${strategies.activeVersionId} 운영 기준으로 되돌렸습니다.`)
    } catch (error) {
      setToast(error instanceof Error ? operationalUiCopy(error.message) : '이전 운영 기준으로 되돌리지 못했습니다.')
    } finally {
      setStrategyBusy(null)
    }
  }

  const navItems: { id: Screen; label: string; icon: IconName }[] = [
    { id: 'farm3d', label: '우리 농장', icon: 'leaf' },
    { id: 'dashboard', label: '운영 현황', icon: 'grid' },
    { id: 'advisor', label: 'AI 재배 조언', icon: 'sparkle' },
    { id: 'operations', label: '장치 · 작업', icon: 'activity' },
    { id: 'knowledge', label: '지식 자료', icon: 'book' },
    { id: 'history', label: '전체 기록', icon: 'clock' },
  ]

  const visibleAlertAnalyses = useMemo(() => {
    if (!snapshot) return {}
    const next: Record<string, AlertAnalysisState> = {}
    for (const alert of snapshot.alerts) {
      const analysis = alertAnalyses[alert.id]
      const version = alertLifecycleVersions.current.get(alert.id) ?? 1
      if (analysis?.token === alertLifecycleToken(version, alert)) next[alert.id] = analysis
    }
    return next
  }, [alertAnalyses, snapshot])
  const advisorSummaryTurn = advisorSummaryTurnForView(
    latestStoredAdvisor?.turn ?? null,
    advisorSessions,
    activeAdvisorSessionId,
    advisorTurns,
  )

  async function openAlertAdvisory(alert: Alert, analysis: CompletedAlertAnalysis) {
    setScreen('advisor')
    try {
      const { sessionId, turn } = await persistAlertAdvisory(alert, analysis.advisory, analysis.token)
      const loaded = await loadAdvisorSession(sessionId)
      if (loaded) setActiveAdvisorTurnId(turn.id)
    } catch (error) {
      setAdvisorSessionError(error instanceof Error ? `경보 대화 저장 실패: ${error.message}` : '경보 대화를 저장하지 못했습니다.')
    }
  }

  return <VideoSessionProvider key={farmId}><div className={`app-shell ${screen === 'farm3d' || screen === 'history' ? 'farm-mode' : ''}`}>
    {screen !== 'farm3d' && screen !== 'history' && <aside className="sidebar">
      <div className="brand-block">
        <div><strong>스마트팜</strong><span>운영 콘솔</span></div>
      </div>
      <div className="farm-picker-wrap">
        <div className="farm-picker static-farm">
          <div className="farm-avatar">A</div><div className="farm-picker-copy"><span>{farm.name}</span><small>{farm.growthStage}</small></div>
        </div>
      </div>
      <nav className="main-nav" aria-label="주요 메뉴">
        {navItems.map((item) => <button key={item.id} className={screen === item.id ? 'nav-item active' : 'nav-item'} onClick={() => setScreen(item.id)}><Icon name={item.icon} size={19} /><span>{item.label}</span></button>)}
      </nav>
      <div className="sidebar-data-status"><span className={`pulse ${alertAutomation.liveUpdates ? displayedRuntimeState : 'paused'}`} /><div><b>{!alertAutomation.liveUpdates ? '화면 갱신 일시 정지' : displayedRuntimeState === 'connected' ? '운영 데이터 수신 중' : displayedRuntimeState === 'degraded' ? '제한된 데이터 경로' : '연결 확인 필요'}</b><small>{!alertAutomation.liveUpdates ? '설정에서 즉시 재개 가능' : snapshot?.dataOrigin === 'fixture_fallback' ? '복구 데이터 경로' : '현재 입력 경로'}</small></div></div>
      <div className="sidebar-footer"><button className="nav-item" onClick={() => { window.location.href = "/answer-review.html" }}><Icon name="activity" size={18} /><span>연구용 답변 비교</span></button><button className="nav-item" onClick={() => setShowDiagnostics(true)}><Icon name="activity" size={18} /><span>시스템 진단</span></button><div className="user-card"><div className="user-avatar">운</div><div><b>농가 운영자</b><small>운영자</small></div></div></div>
    </aside>}
    <main className="main-area">
      {screen !== 'farm3d' && screen !== 'history' && <header className="topbar"><div className="mobile-brand"><strong>스마트팜</strong></div><div className="breadcrumb"><span>농장 운영</span><Icon name="chevron" size={13} /><b>{screenLabel(screen)}</b></div><TruthBadge mode={snapshot?.inputMode ?? 'unavailable'} /><div className={`validation-badge ${operatingReady ? 'ready' : 'attention'}`}><span />{operatingReady ? '운영 준비됨' : dataReady ? 'AI 연결 확인 필요' : '운영 연결 확인 필요'}</div><div className="topbar-actions"><button className="icon-button" onClick={() => setShowDemoGuide(true)} aria-label="10분 시연 안내 열기"><Icon name="help" size={18} /></button><button className="icon-button refresh-button" onClick={() => void loadFarm(true)} aria-label="데이터 새로고침"><Icon name="refresh" size={17} /></button><button className="icon-button" onClick={() => setShowSettings(true)} aria-label="AI 및 운영 설정 열기"><Icon name="settings" size={18} /></button><button className="icon-button" onClick={() => setShowDiagnostics(true)} aria-label="시스템 진단 열기"><Icon name="activity" size={18} /></button><button className="icon-button notification" onClick={() => { setScreen('dashboard'); setShowSettings(true) }} aria-label="경보 및 알림 설정 열기"> <Icon name="bell" size={18} />{snapshot?.alerts.filter((alert) => alert.status === 'new').length ? <span /> : null}</button></div></header>}
      {(screen === 'farm3d' || screen === 'history') && <nav className="farm-utilities" aria-label="농장 보조 메뉴">{screen === 'history' && <button onClick={() => setScreen('farm3d')}>우리 농장으로</button>}<button onClick={() => setScreen('history')}>전체 기록</button><details><summary>관리</summary><button onClick={() => setScreen('dashboard')}>기존 운영 현황</button><button onClick={() => setScreen('knowledge')}>재배 자료 관리</button><button onClick={() => setShowSettings(true)}>운영 설정</button><button onClick={() => setShowDiagnostics(true)}>연결·연구 진단</button><button onClick={() => setShowVideoReview(true)}>영상 연결 점검</button></details></nav>}
      {screen !== 'farm3d' && screen !== 'history' && <nav className="mobile-nav" aria-label="모바일 주요 메뉴">{navItems.map((item) => <button key={item.id} className={screen === item.id ? 'active' : ''} onClick={() => setScreen(item.id)}><Icon name={item.icon} size={16} /><span>{item.label}</span></button>)}</nav>}
      <div className="page-scroll" ref={pageScrollRef}>
        {isLoading && <LoadingScreen />}
        {!isLoading && !snapshot && <UnavailableScreen error={runtimeError} onRetry={() => void loadFarm(true)} />}
        {!isLoading && snapshot && screen === 'dashboard' && <Dashboard snapshot={snapshot} farm={farm} runtimeState={runtimeState} strategies={cultivationStrategies} scenarios={scenarios} scenarioState={scenarioState} scenarioBusy={scenarioBusy} alertAutomation={alertAutomation} alertAnalyses={visibleAlertAnalyses} selectedZone={selectedZone} onSelectedZoneChange={setSelectedZone} onAnalyzeAlert={(alert) => void requestAlertAnalysis(alert)} onOpenAlert={openAlertAdvisory} onReset={() => void handleDemoReset()} onNavigate={setScreen} onOpenSettings={() => setShowSettings(true)} />}
        {!isLoading && snapshot && screen === 'advisor' && <Advisor
          farm={farm}
          runtimeState={runtimeState}
          selectedZone={selectedZone}
          sessions={advisorSessions}
          activeSessionId={activeAdvisorSessionId}
          sessionsLoading={advisorSessionsLoading}
          sessionError={advisorSessionError}
          queryContext={advisorQueryContext}
          turns={advisorTurns}
          activeTurnId={activeAdvisorTurnId}
          approvals={approvals}
          activeAlertOccurrenceIds={activeAlertOccurrenceIds}
          scenarioState={scenarioState}
          onEnsureSession={ensureAdvisorSession}
          onBeginNewSession={beginNewAdvisorSession}
          onSelectSession={loadAdvisorSession}
          onRenameSession={handleRenameAdvisorSession}
          onDeleteSession={handleDeleteAdvisorSession}
          onSessionUpdated={refreshAdvisorSessionList}
          onQueryContextChange={setAdvisorQueryContext}
          onTurnsChange={setAdvisorTurns}
          onActiveTurnChange={setActiveAdvisorTurnId}
          onDiagnostics={setAdvisorDiagnostics}
          onReviewDraft={reviewControlDraft}
          onSelectedZoneChange={setSelectedZone}
        />}
        {!isLoading && snapshot && screen === 'operations' && <Operations approvals={approvals} activeAlertOccurrenceIds={activeAlertOccurrenceIds} auditEvents={auditEvents} actuators={snapshot.actuators} metrics={snapshot.metrics} telemetryByZone={snapshot.telemetryByZone} thresholds={cultivationStrategies?.versions.find((version) => version.active)?.thresholds ?? []} runtimeState={runtimeState} scenarios={scenarios} scenarioState={scenarioState} derivedIndicators={snapshot.derivedIndicators} incidents={snapshot.incidents} clock={snapshot.clock} replayBusy={replayBusy} advisorTurn={advisorSummaryTurn} proposalTransitions={proposalTransitions} activeControlTarget={activeControlTarget} selectedZone={selectedZone} onSelectedZoneChange={setSelectedZone} onApplyControl={handleCreateProposal} onReplayFile={handleReplayFile} onOpenAdvisor={() => setScreen('advisor')} />}
        {!isLoading && snapshot && screen === 'knowledge' && <Knowledge farm={farm} onAskWithSource={openKnowledgeSourceInAdvisor} />}
        {!isLoading && snapshot && screen === 'history' && <section className="page farmer-history"><h1>전체 기록</h1><p>농장에서 확인한 일과 처리 결과입니다.</p>{sortOperationCases(operationCases).map(record => <article className="panel" key={record.id}><small>{operationCaseStatusLabel(record.status)}</small><h2>{record.title}</h2><p>{operationCaseSummary(record)}</p><button className="secondary-button" onClick={() => setSelectedOperationCase(record)}>처리 과정 보기</button></article>)}{!operationCases.length && <p>아직 기록된 조치가 없습니다.</p>}<details><summary>설비·재배 작업 기록</summary><RecentActivity events={auditEvents} /></details><details><summary>영상 확인 기록</summary><PatrolPanel key={`log-${farm.id}`} farmId={farm.id} /></details></section>}
        {!isLoading && snapshot && screen === 'history' && <details className="page"><summary>관리용 상세 기록</summary><ProductionHistory auditEvents={auditEvents} operationCases={operationCases} operationMetrics={operationMetrics} gatewayStatus={gatewayStatus} strategies={cultivationStrategies} strategyBusy={strategyBusy} acknowledgingIncidentId={acknowledgingIncidentId} inputMode={snapshot.inputMode} onCreateStrategy={handleCreateStrategy} onApplyStrategy={handleApplyStrategy} onRollbackStrategy={handleRollbackStrategy} onAcknowledgeCase={handleAcknowledgeOperationCase} onOpenCase={setSelectedOperationCase} onPrintCase={handleOperationCasePrint} /></details>}
      </div>
    </main>
    {showVideoReview && <div className="modal-backdrop"><section role="dialog" aria-modal="true" aria-label="영상 연결 점검" className="modal video-review-dialog"><button onClick={() => setShowVideoReview(false)}>닫기</button><p>공개 연구 자료와 농장 영상의 출처를 구분해 연결을 점검합니다.</p><VideoWorkspace farmId={farmId} /></section></div>}
    {controlDraft && snapshot && controlDraftCanBeReviewed(controlDraft, activeAlertOccurrenceIds) && <ControlReviewDialog draft={controlDraft} actuators={snapshot.actuators} busy={isCreatingProposal} onDraftChange={setControlDraft} onDecline={declineControlDraft} onCreateProposal={handleCreateProposal} />}
    {showSettings && <ModelSettingsDrawer farmId={farmId} alertAutomation={alertAutomation} scenarios={scenarios} scenarioState={scenarioState} clock={snapshot?.clock ?? null} scenarioBusy={scenarioBusy} onAlertAutomationChange={setAlertAutomation} onScenario={(primaryId, secondaryId, zoneIds) => void handleScenario(primaryId, secondaryId, zoneIds)} onClock={(update) => void handleClock(update)} onScenarioReset={() => void handleDemoReset()} onClose={() => setShowSettings(false)} />}
    {showDiagnostics && <DiagnosticsDrawer readiness={readiness} snapshot={snapshot} advisor={advisorDiagnostics} scenario={scenarioState} onClose={() => setShowDiagnostics(false)} />}
    {showDemoGuide && snapshot && <GuidedDemoDrawer snapshot={snapshot} scenarioState={scenarioState} cases={operationCases} exported={demoRecordExported} busy={scenarioBusy || isCreatingProposal} onStart={handleGuidedDemoStart} onNavigate={(next) => { setScreen(next); setShowDemoGuide(false) }} onOpenRecord={(record) => { setSelectedOperationCase(record); setShowDemoGuide(false) }} onClose={() => setShowDemoGuide(false)} />}
    {selectedOperationCase && <OperationCaseDrawer record={selectedOperationCase} acknowledging={acknowledgingIncidentId === selectedOperationCase.incidentId} onAcknowledge={() => void handleAcknowledgeOperationCase(selectedOperationCase)} onSaveKnowledge={() => handleSaveOperationCaseKnowledge(selectedOperationCase)} onOpenKnowledge={() => { setSelectedOperationCase(null); setScreen('knowledge') }} onExport={() => void handleOperationCaseCsv(selectedOperationCase)} onPrint={() => handleOperationCasePrint(selectedOperationCase)} onClose={() => setSelectedOperationCase(null)} />}
    <div className="sr-only" aria-live="polite">{toast ?? (isCreatingProposal ? '장치를 변경하고 있습니다.' : '')}</div>
    {toast && <div className="toast" role="status"><Icon name="check" size={16} />{toast}<button onClick={() => setToast(null)} aria-label="알림 닫기"><Icon name="close" size={14} /></button></div>}
  </div></VideoSessionProvider>
}

function screenLabel(screen: Screen) {
  return ({ farm3d: '우리 농장', dashboard: '운영 현황', advisor: 'AI 재배 조언', operations: '장치 · 작업', knowledge: '지식 자료', history: '전체 기록' })[screen]
}

function LoadingScreen() {
  return <div className="loading-page"><div className="loader-leaf"><Icon name="leaf" size={28} /></div><p>농장 운영 정보를 불러오는 중입니다</p><small>운영 데이터와 참고 자료 상태를 함께 확인하고 있어요.</small></div>
}

function UnavailableScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return <div className="loading-page unavailable-page"><div className="loader-leaf"><Icon name="cloud" size={28} /></div><p>운영 데이터를 표시할 수 없습니다</p><small>{error ?? 'Product API 연결 상태를 확인하세요.'}</small><button className="primary-outline" onClick={onRetry}><Icon name="refresh" size={15} />다시 연결</button></div>
}

function TruthBadge({ mode }: { mode: DashboardSnapshot['inputMode'] }) {
  return <div className={`truth-badge ${mode}`} title="현재 화면에 표시되는 운영 데이터의 입력 방식"><span />{truthModeLabel(mode)}</div>
}

function PrototypeBanner({ origin }: { origin: DashboardSnapshot['dataOrigin'] }) {
  const originCopy = origin === 'telemetry_service' ? '센서 데이터 수신' : origin === 'fixture_fallback' ? '복구 데이터 사용' : '데이터 출처 확인 중'
  return <div className="prototype-banner"><Icon name="shield" size={15} /><span><b>운영 화면</b> · 현재 수신된 센서와 장치 상태를 표시합니다.</span><small>{originCopy}</small></div>
}

function scenarioPhaseLabel(phase: DemoScenarioState['phase'] | undefined) {
  return ({ normal: '정상 운영', ramp: '이상 진행', hold: '이상 지속', recovery: '회복 확인 중', recovered: '정상 범위 복귀' } as const)[phase ?? 'normal']
}

const scenarioCauseById: Record<string, string> = {
  normal: '장치 이상 없음',
  root_cooling_fault: '근권 냉각기 꺼짐',
  irrigation_blockage: '관수 펌프 꺼짐',
  high_humidity_stagnation: '천창·측창·순환팬 출력 저하',
  ec_drift: '관수 중단과 양액 공급 편차',
  temperature_sensor_drift: '공기 온도 센서 보정값 이탈',
}

function scenarioCauseLabel(scenarioId: string | undefined) {
  return scenarioCauseById[scenarioId ?? 'normal'] ?? '장치·센서 운영값 이탈'
}

function formatScenarioElapsed(seconds: number | undefined) {
  const total = Math.max(0, Math.floor(seconds ?? 0))
  const minutes = Math.floor(total / 60)
  const remainder = total % 60
  return minutes ? `${minutes}분 ${remainder}초` : `${remainder}초`
}

type ZoneSelection = 'all' | 'zone-a' | 'zone-b'

type FieldCameraView = {
  id: string
  label: string
  image: string
  direction: string
  observation: string
  sensorZone: Exclude<ZoneSelection, 'all'> | null
  state: 'example' | 'preparing'
}

const fieldCameraViews: FieldCameraView[] = [{
  id: 'a-overview',
  label: 'A동 전체',
  image: '/assets/greenhouse-camera-overview.webp',
  direction: '북서 코너에서 재배동 전체 방향',
  observation: '재배동 전체 흐름',
  sensorZone: null,
  state: 'example',
}, {
  id: 'a-zone-1',
  label: 'A동 1구역',
  image: '/assets/greenhouse-a-zone-1.webp',
  direction: '전면 좌측에서 후면 방향',
  observation: '성숙 베드 · 근권 냉각 배관',
  sensorZone: 'zone-a',
  state: 'example',
}, {
  id: 'a-zone-2',
  label: 'A동 2구역',
  image: '/assets/greenhouse-a-zone-2.webp',
  direction: '후면 우측에서 출입구 방향',
  observation: '어린 베드 · 차광 · 환기 설비',
  sensorZone: 'zone-b',
  state: 'example',
}, {
  id: 'b-trial',
  label: 'B동 시험베드',
  image: '/assets/greenhouse-b-trial.webp',
  direction: '출입구 상단에서 육묘대 방향',
  observation: '육묘 · 양액 설비',
  sensorZone: null,
  state: 'preparing',
}]

function zoneLabel(zoneId: string | null | undefined) {
  if (zoneId === 'zone-b') return '2구역'
  if (zoneId === 'zone-a') return '1구역'
  return '공용'
}

function Dashboard({
  snapshot,
  farm,
  runtimeState,
  strategies,
  scenarios,
  scenarioState,
  scenarioBusy,
  alertAutomation,
  alertAnalyses,
  selectedZone,
  onSelectedZoneChange,
  onAnalyzeAlert,
  onOpenAlert,
  onReset,
  onNavigate,
  onOpenSettings,
}: {
  snapshot: DashboardSnapshot;
  farm: Farm;
  runtimeState: RuntimeState;
  strategies: CultivationStrategies | null;
  scenarios: DemoScenario[];
  scenarioState: DemoScenarioState | null;
  scenarioBusy: boolean;
  alertAutomation: AlertAutomationSettings;
  alertAnalyses: Record<string, AlertAnalysisState>;
  selectedZone: ZoneSelection;
  onSelectedZoneChange: (zone: ZoneSelection) => void;
  onAnalyzeAlert: (alert: Alert) => void;
  onOpenAlert: (alert: Alert, analysis: CompletedAlertAnalysis) => void;
  onReset: () => void;
  onNavigate: (screen: Screen) => void;
  onOpenSettings: () => void;
}) {
  const [showAllAlerts, setShowAllAlerts] = useState(false)
  const [fieldOpen, setFieldOpen] = useState(false)
  const [fieldAlertId, setFieldAlertId] = useState<string | null>(null)
  const availableZones = [...new Set([
    ...snapshot.zones,
    ...snapshot.metrics.map((metric) => metric.zoneId).filter((zoneId): zoneId is string => Boolean(zoneId)),
  ])].filter((zoneId): zoneId is 'zone-a' | 'zone-b' => zoneId === 'zone-a' || zoneId === 'zone-b')
  const metricsForView = selectedZone === 'all'
    ? snapshot.metrics
    : snapshot.metrics.filter((metric) => metric.zoneId === selectedZone)
  const indicatorsForView = selectedZone === 'all'
    ? snapshot.derivedIndicators
    : snapshot.derivedIndicators.filter((indicator) => indicator.zoneId === selectedZone)
  const stability = sensorStability(metricsForView)
  const openAlerts = snapshot.alerts.filter(
    (alert) => alert.status !== "resolved"
      && (selectedZone === 'all' || alert.zoneId === null || alert.zoneId === selectedZone),
  );
  const automaticMonitoring = alertAutomation.liveUpdates
    && alertAutomation.enabled
    && (alertAutomation.cropRisk || alertAutomation.sensorHealth || alertAutomation.equipmentFault)
  const visibleAlerts = showAllAlerts ? openAlerts : openAlerts.slice(0, 3)
  const activeStrategy = strategies?.versions.find((version) => version.active) ?? null
  const activeScenarioIds = scenarioState?.scenarioIds?.length ? scenarioState.scenarioIds : [scenarioState?.scenarioId ?? 'normal']
  const hasActiveScenario = activeScenarioIds.some((id) => id !== 'normal')
  const activeScenarioLabel = activeScenarioIds
    .filter((id) => id !== 'normal')
    .map((id) => scenarios.find((scenario) => scenario.id === id)?.name ?? id)
    .join(' + ')
  const trendMetrics = selectedZone === 'all' ? [] : snapshot.metrics.filter((metric) => metric.zoneId === selectedZone)
  const trendPoints = selectedZone === 'all'
    ? []
    : synchronizeTelemetryLatest(snapshot.telemetryByZone[selectedZone] ?? [], trendMetrics)
  const dashboardActuators = selectedZone === 'all'
    ? [
        ...snapshot.actuators.filter((actuator) => actuator.zoneId === 'zone-a').slice(0, 3),
        ...snapshot.actuators.filter((actuator) => actuator.zoneId === 'zone-b').slice(0, 3),
        ...snapshot.actuators.filter((actuator) => !actuator.zoneId).slice(0, 2),
      ]
    : snapshot.actuators.filter((actuator) => actuator.zoneId === selectedZone).slice(0, 6)
  return (
    <div className="page dashboard-page">
      <PageTitle
        eyebrow={`${farm.location} · ${farm.cultivationSystem}`}
        title="오늘의 재배 운영"
        description={`${farm.productionGoal} · ${farm.growthStage}`}
        action={
          <DataBadge
            state={runtimeState}
            updatedAt={snapshot.updatedAt}
            origin={snapshot.dataOrigin}
            paused={!alertAutomation.liveUpdates}
          />
        }
      />
      <PrototypeBanner origin={snapshot.dataOrigin} />
      {hasActiveScenario && <section className="scenario-active-banner" aria-label="운영 상황 테스트 상태"><span className="scenario-active-icon"><Icon name="sliders" size={17} /></span><div role="status" aria-live="polite"><small>운영 상황 테스트 진행 중</small><b>{activeScenarioLabel}</b><p>{scenarioPhaseLabel(scenarioState?.phase)} · 경과 {formatScenarioElapsed(scenarioState?.elapsedSeconds)} · AI 감지와 장치 조정 과정을 확인합니다.</p></div><div className="scenario-active-actions"><button className="secondary-button" onClick={onOpenSettings}>테스트 관리</button><button className="scenario-reset-button" disabled={scenarioBusy} onClick={onReset}><Icon name="refresh" size={14} />{scenarioBusy ? '정리 중' : '정상 상태로 복귀'}</button></div></section>}
      <ZoneManagementPanel
        zones={availableZones}
        metrics={snapshot.metrics}
        alerts={snapshot.alerts}
        selected={selectedZone}
        onSelect={onSelectedZoneChange}
      />
      <aside className="priority-panel operator-priority-panel panel">
        <div className="panel-head">
          <div>
            <h2>지금 확인할 위험과 작업</h2>
          </div>
          <div className="panel-head-actions">
            <button className={`automation-chip ${automaticMonitoring ? 'on' : 'off'}`} onClick={onOpenSettings} aria-label={`AI 자동 경보 분석 설정 열기 · ${automaticMonitoring ? '작동 중' : '정지'}`}>
              <span />{!alertAutomation.liveUpdates ? '감시 정지' : `AI 분석 ${automaticMonitoring ? 'ON' : 'OFF'}`}
            </button>
            <button className="text-action" onClick={() => onNavigate("operations")}>
              장치·작업 <Icon name="chevron" size={14} />
            </button>
          </div>
        </div>
        {openAlerts.length ? (
          <>
            <div className="priority-list">
              {visibleAlerts.map((alert) => (
                <div key={alert.id}><AlertRow
                  alert={alert}
                  analysis={alertAnalyses[alert.id]}
                  automatic={alertAutomation.liveUpdates && shouldAutoAnalyzeAlert(alert, alertAutomation)}
                  onAnalyze={() => onAnalyzeAlert(alert)}
                  onOpenAdvisor={(analysis) => onOpenAlert(alert, analysis)}
                /><div className="field-alert-entry"><button className="text-action" onClick={() => { if (alert.zoneId === 'zone-a' || alert.zoneId === 'zone-b') onSelectedZoneChange(alert.zoneId); setFieldAlertId(alert.id); setFieldOpen(true) }}>상황 확인</button></div></div>
              ))}
            </div>
            {openAlerts.length > 3 && (
              <button className="alert-expand-action" onClick={() => setShowAllAlerts((current) => !current)} aria-expanded={showAllAlerts}>
                {showAllAlerts ? '주요 경보만 보기' : `전체 경보 ${openAlerts.length}건 보기`}
                <Icon name="chevron" size={13} />
              </button>
            )}
          </>
        ) : (
          <div className="all-clear">
            <span><Icon name="check" size={18} /></span>
            <div>
              <b>{alertAutomation.liveUpdates ? '즉시 대응할 위험이 없습니다' : '실시간 감시가 일시 정지되었습니다'}</b>
              <p>{alertAutomation.liveUpdates ? '근권·관수·재배실 환경을 계속 감시합니다.' : '설정에서 실시간 화면 갱신을 켜면 새 경보 감지를 재개합니다.'}</p>
            </div>
          </div>
        )}
        <div className="task-list">
          <div><span>09:30</span><b>A동 배액 EC 표본 확인</b><em>점검</em></div>
          <div><span>14:00</span><b>{farm.name} 생육 기록</b><em>기록</em></div>
        </div>
      </aside>
      {selectedZone !== 'all' && <ScenarioMetricStrip metrics={metricsForView} telemetryByZone={{ [selectedZone]: trendPoints }} zoneId={selectedZone} scenarioId={scenarioState?.scenarioId} scenarioIds={scenarioState?.scenarioIds} thresholds={activeStrategy?.thresholds ?? []} />}
      <DerivedIndicatorStrip indicators={indicatorsForView} metrics={metricsForView} />
      <section className="hero-kpi-grid supporting-kpi-grid" aria-label="핵심 운영 지표">
        <HeroKpi
          label="재배환경 안정률"
          value={stability.percent == null ? '데이터 없음' : `${stability.percent}%`}
          detail={`${selectedZone === 'all' ? '전체 구역' : zoneLabel(selectedZone)} · 유효 ${stability.valid}/${stability.total}개 · 확인 필요 ${stability.needsReview}개`}
          tone={stability.percent != null && stability.percent >= 90 ? "stable" : "attention"}
          icon="activity"
          progress={stability.percent == null ? undefined : { value: stability.percent, label: `유효 센서 ${stability.valid}개 기준 재배환경 안정률 ${stability.percent}%` }}
        />
        <HeroKpi
          label="수확 일정"
          value={farm.nextHarvest}
          detail={farm.productionGoal}
          tone="neutral"
          icon="leaf"
        />
      </section>
      <section className="dashboard-summary-grid dashboard-telemetry-grid">
        {selectedZone === 'all'
          ? <section className="telemetry-overview telemetry-scope-notice compact panel"><div><h2>센서 추이를 자세히 보려면 구역을 선택하세요</h2><p>위 구역 카드에서 1구역 또는 2구역을 선택할 수 있습니다.</p></div></section>
          : <TelemetryOverview points={trendPoints} zoneId={selectedZone} />}
      </section>
      <FieldInspection open={fieldOpen} onClose={() => setFieldOpen(false)} onOpen={() => { setFieldAlertId(null); setFieldOpen(true) }} zone={selectedZone} snapshot={snapshot} alertId={fieldAlertId} onDevices={() => onNavigate('operations')} onAdvisor={() => {
        const alert = openAlerts.find(item => item.id === fieldAlertId) ?? openAlerts[0]
        const analysis = alert ? alertAnalyses[alert.id] : undefined
        if (alert && analysis && (analysis.status === 'ready' || analysis.status === 'fallback')) onOpenAlert(alert, analysis)
        else onNavigate('advisor')
      }}>
        <details><summary>영상 관제 열기</summary><VideoWorkspace farmId={farm.id} /></details>
      </FieldInspection>
      <FieldCameraPanel zones={availableZones} selected={selectedZone} onSelect={onSelectedZoneChange} />
      <section className="dashboard-lower-grid">
        <div className="daily-brief panel">
          <div className="brief-title">
            <div className="small-sparkle">
              <Icon name="sparkle" size={16} />
            </div>
            <span>운영 요약</span>
          </div>
          <p>{operationalUiCopy(snapshot.dailyBrief)}</p>
          <button className="text-action" onClick={() => onNavigate("advisor")}>
            근거와 함께 살펴보기 <Icon name="chevron" size={14} />
          </button>
          <div className="brief-provenance">
            <Icon name="shield" size={13} />
            센서·작업 상태 반영
          </div>
        </div>
        <div className="equipment-panel panel">
          <div className="panel-head">
            <div>
              <h2>주요 운영 장치</h2>
            </div>
            <div className="panel-head-actions"><span className="time-chip">{selectedZone === 'all' ? '전체 구역' : zoneLabel(selectedZone)}</span><button
                className="text-action"
                onClick={() => onNavigate("operations")}
              >
                장치 직접 조정 <Icon name="chevron" size={14} />
              </button></div>
          </div>
          <div className="equipment-grid">
            {dashboardActuators.length ? (
              dashboardActuators
                .map((actuator) => (
                  <Equipment actuator={actuator} key={actuator.key} />
                ))
            ) : (
              <EmptyCopy>{selectedZone === 'all' ? '설비 상태가 API 응답에 없습니다.' : '선택한 구역에 연결된 주요 장치가 없습니다.'}</EmptyCopy>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

const zoneOverviewMetricKeys = [
  'root_zone_temperature_c',
  'relative_humidity_pct',
  'substrate_moisture_pct',
  'supply_ec_ds_m',
]

function ZoneManagementPanel({ zones, metrics, alerts, selected, onSelect }: {
  zones: Array<'zone-a' | 'zone-b'>
  metrics: DashboardSnapshot['metrics']
  alerts: Alert[]
  selected: ZoneSelection
  onSelect: (zone: ZoneSelection) => void
}) {
  const selectableZones = zones.length ? zones : ['zone-a'] as Array<'zone-a' | 'zone-b'>
  return <section className="zone-management panel" aria-label="재배 구역 관리">
    <header className="zone-management-head">
      <div><h2>재배 구역</h2><p>전체를 비교하거나 한 구역을 선택해 집중해서 봅니다.</p></div>
      <div className="zone-switcher" role="group" aria-label="표시할 구역">
        <button className={selected === 'all' ? 'active' : ''} aria-pressed={selected === 'all'} onClick={() => onSelect('all')}>전체 구역</button>
        {selectableZones.map((zoneId) => <button key={zoneId} className={selected === zoneId ? 'active' : ''} aria-pressed={selected === zoneId} onClick={() => onSelect(zoneId)}>{zoneLabel(zoneId)}</button>)}
      </div>
    </header>
    <div className="zone-overview-grid">
      {selectableZones.map((zoneId) => {
        const zoneMetrics = metrics.filter((metric) => metric.zoneId === zoneId)
        const zoneAlerts = alerts.filter((alert) => alert.status !== 'resolved' && alert.zoneId === zoneId)
        const hasCritical = zoneMetrics.some((metric) => metric.status === 'critical') || zoneAlerts.some((alert) => alert.severity === 'critical')
        const hasWarning = zoneMetrics.some((metric) => metric.status === 'warning') || zoneAlerts.length > 0
        const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'normal'
        const statusLabel = status === 'critical' ? '즉시 확인' : status === 'warning' ? '주의' : '안정'
        const values = zoneOverviewMetricKeys.map((key) => zoneMetrics.find((metric) => metric.key === key)).filter((metric): metric is DashboardSnapshot['metrics'][number] => Boolean(metric))
        return <button type="button" className={`zone-overview-card ${status} ${selected === zoneId ? 'selected' : ''}`} key={zoneId} onClick={() => onSelect(zoneId)} aria-label={`${zoneLabel(zoneId)} 상세 보기`}>
          <span className="zone-overview-title"><span><i />{zoneLabel(zoneId)}</span><em>{zoneAlerts.length ? `경보 ${zoneAlerts.length}건` : statusLabel}</em></span>
          <span className="zone-overview-values">{values.map((metric) => <span key={metric.key}><small>{metric.label}</small><b>{metric.value}<em>{metric.unit ? ` ${metric.unit}` : ''}</em></b></span>)}</span>
        </button>
      })}
    </div>
  </section>
}

function FieldCameraPanel({ zones, selected, onSelect }: { zones: Array<'zone-a' | 'zone-b'>; selected: ZoneSelection; onSelect: (zone: ZoneSelection) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [selectedCameraId, setSelectedCameraId] = useState(fieldCameraViews[0].id)
  const camera = fieldCameraViews.find((item) => item.id === selectedCameraId) ?? fieldCameraViews[0]
  useEffect(() => {
    if (!expanded) return
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expanded])
  useEffect(() => {
    const matching = selected === 'all'
      ? fieldCameraViews.find((item) => item.sensorZone === null)
      : fieldCameraViews.find((item) => item.sensorZone === selected)
    if (matching) setSelectedCameraId(matching.id)
  }, [selected])
  function selectCamera(next: FieldCameraView) {
    setSelectedCameraId(next.id)
    if (next.sensorZone && zones.includes(next.sensorZone)) onSelect(next.sensorZone)
  }
  const picture = <img src={camera.image} alt={`${camera.label} 고설베드 재배실 카메라 화면 예시`} />
  return <>
    <section className="field-camera-panel panel" aria-labelledby="field-camera-title">
      <div className="field-camera-copy"><div><span className="panel-kicker">현장 카메라</span><h2 id="field-camera-title">재배실 화면 살펴보기</h2></div><span className={`camera-example-badge ${camera.state}`}>{camera.state === 'preparing' ? '연결 준비' : '화면 예시'}</span></div>
      <div className="field-camera-layout">
        <div><button type="button" className="field-camera-frame" onClick={() => setExpanded(true)} aria-label={`${camera.label} 현장 카메라 화면 확대보기`}>{picture}<span><Icon name="external" size={14} />확대보기</span></button><dl className="camera-view-meta"><div><dt>위치</dt><dd>{camera.label}</dd></div><div><dt>시야 방향</dt><dd>{camera.direction}</dd></div><div><dt>관찰 포인트</dt><dd>{camera.observation}</dd></div></dl></div>
        <div className="camera-filmstrip" role="list" aria-label="현장 카메라 화면 목록">{fieldCameraViews.map((view) => <div role="listitem" key={view.id}><button type="button" className={camera.id === view.id ? 'active' : ''} aria-pressed={camera.id === view.id} onClick={() => selectCamera(view)}><img src={view.image} alt="" /><span><b>{view.label}</b><small>{view.direction}</small><small>기능 설명용 예시 · 촬영 시각 없음</small><em>{view.state === 'preparing' ? '연결 준비' : view.sensorZone ? '센서 조회 연결' : '화면 예시'}</em></span></button></div>)}</div>
      </div>
      <footer><p><b>기능 설명용 예시 · 촬영 시각 없음</b><span>{camera.sensorZone ? `${zoneLabel(camera.sensorZone)} 센서 조회 범위와 함께 살펴보는 화면입니다. ` : ''}연결 후 사용 가능: 실시간 보기 · 구역별 비교 · 기록 확인</span></p></footer>
    </section>
    {expanded && <div className="camera-dialog-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpanded(false) }}><section className="camera-dialog" role="dialog" aria-modal="true" aria-labelledby="camera-dialog-title" aria-describedby="camera-dialog-note"><header><div><span className="panel-kicker">현장 카메라 · {camera.state === 'preparing' ? '연결 준비' : '화면 예시'}</span><h2 id="camera-dialog-title">{camera.label} 확대보기</h2><p id="camera-dialog-note">현재 화면은 기능 설명을 위한 예시입니다. 연결 후 사용 가능: 실시간 보기 · 구역별 비교 · 기록 확인</p></div><button type="button" className="icon-button" onClick={() => setExpanded(false)} aria-label="현장 카메라 확대보기 닫기"><Icon name="close" size={18} /></button></header><div className="camera-dialog-image">{picture}</div><dl className="camera-view-meta dialog"><div><dt>시야 방향</dt><dd>{camera.direction}</dd></div><div><dt>관찰 포인트</dt><dd>{camera.observation}</dd></div></dl><footer><span>화면 정보</span><b>기능 설명용 예시 · 촬영 시각 없음</b></footer></section></div>}
  </>
}

const OPERATOR_TEST_SCENARIO_IDS = new Set([
  'root_cooling_fault',
  'irrigation_blockage',
  'high_humidity_stagnation',
  'ec_drift',
  'temperature_sensor_drift',
  'ventilation_stuck',
])

function ScenarioBar({ scenarios, state, clock, busy, onApply, onClock, onReset }: { scenarios: DemoScenario[]; state: DemoScenarioState | null; clock: DashboardSnapshot['clock']; busy: boolean; onApply: (primaryId: string, secondaryId: string | null, zoneIds: string[]) => void; onClock: (update: { speed?: 1 | 5 | 10; paused?: boolean }) => void; onReset: () => void }) {
  const testScenarios = scenarios.filter((scenario) => OPERATOR_TEST_SCENARIO_IDS.has(scenario.id) && scenario.recoveryActions.length > 0)
  const preferredPrimaryId = state?.scenarioIds[0] ?? state?.scenarioId ?? 'normal'
  const [primaryId, setPrimaryId] = useState(testScenarios.some((scenario) => scenario.id === preferredPrimaryId) ? preferredPrimaryId : testScenarios[0]?.id ?? '')
  const [zoneSelection, setZoneSelection] = useState(state?.zoneIds.length === 2 ? 'both' : state?.zoneIds[0] ?? 'zone-a')
  const activeScenarioSignature = (state?.scenarioIds ?? []).join('|')
  const activeZoneSignature = (state?.zoneIds ?? []).join('|')
  const selectableScenarioSignature = testScenarios.map((scenario) => scenario.id).join('|')
  useEffect(() => {
    const nextPrimaryId = state?.scenarioIds[0] ?? state?.scenarioId ?? 'normal'
    setPrimaryId(testScenarios.some((scenario) => scenario.id === nextPrimaryId) ? nextPrimaryId : testScenarios[0]?.id ?? '')
    setZoneSelection(state?.zoneIds.length === 2 ? 'both' : state?.zoneIds[0] ?? 'zone-a')
  }, [state?.scenarioId, activeScenarioSignature, activeZoneSignature, selectableScenarioSignature])
  const selected = testScenarios.find((scenario) => scenario.id === primaryId)
  const phase = `${scenarioPhaseLabel(state?.phase)} · 경과 ${formatScenarioElapsed(state?.elapsedSeconds)}`
  const zoneIds = zoneSelection === 'both' ? ['zone-a', 'zone-b'] : [zoneSelection]
  return <section className="scenario-bar" aria-label="운영 상황 테스트">
    <div className="scenario-profile-picker">
      <div className="scenario-select-row">
        <label><span>테스트 상황</span><select value={primaryId} disabled={busy || !testScenarios.length} onChange={(event) => setPrimaryId(event.target.value)} aria-label="주요 운영 상황 테스트 선택">{testScenarios.length ? testScenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.name}</option>) : <option value="">실행 가능한 테스트 없음</option>}</select></label>
        <label><span>적용 구역</span><select value={zoneSelection} disabled={busy} onChange={(event) => setZoneSelection(event.target.value)} aria-label="운영 조건 적용 구역"><option value="zone-a">1구역</option><option value="zone-b">2구역</option><option value="both">전체 구역</option></select></label>
        <button className="scenario-apply-button" disabled={busy || !primaryId} onClick={() => onApply(primaryId, null, zoneIds)}>{busy ? '시작 중' : '테스트 시작'}</button>
        <button className="scenario-reset-button" disabled={busy} onClick={onReset}><Icon name="refresh" size={14} />{busy ? '정리 중' : '정상 상태로 되돌리기'}</button>
      </div>
      <div className="scenario-runtime-row">
        <dl className="scenario-profile-detail" aria-live="polite"><div><dt>예상 원인</dt><dd>{scenarioCauseLabel(primaryId)}</dd></div><div><dt>예상 상황</dt><dd>{operationalUiCopy(selected?.description ?? '실행 가능한 테스트 정보를 불러오지 못했습니다.')}</dd></div><div><dt>현재 단계</dt><dd>{clock?.paused ? `일시 정지 · ${phase}` : phase}</dd></div></dl>
        <div className="clock-control" aria-label="운영 흐름 속도"><span>진행 속도</span>{([1, 5, 10] as const).map((speed) => <button key={speed} className={!clock?.paused && (clock?.speed ?? 1) === speed ? 'active' : ''} disabled={busy} onClick={() => onClock({ speed, paused: false })}>{speed}×</button>)}<button className={clock?.paused ? 'active pause' : 'pause'} disabled={busy} onClick={() => onClock({ paused: !clock?.paused })}>{clock?.paused ? '계속' : '일시정지'}</button></div>
      </div>
    </div>
  </section>
}

const metricKeysByScenario: Record<string, string[]> = {
  normal: ['air_temperature_c', 'relative_humidity_pct', 'root_zone_temperature_c', 'substrate_moisture_pct', 'supply_ec_ds_m', 'supply_ph'],
  root_cooling_fault: ['root_zone_temperature_c', 'air_temperature_c'],
  irrigation_blockage: ['irrigation_flow_l_min', 'irrigation_pressure_bar', 'pump_current_a', 'substrate_moisture_pct'],
  high_humidity_stagnation: ['relative_humidity_pct', 'air_temperature_c'],
  ec_drift: ['supply_ec_ds_m', 'drain_ec_ds_m', 'irrigation_flow_l_min'],
  temperature_sensor_drift: ['air_temperature_c', 'root_zone_temperature_c'],
  ventilation_stuck: ['relative_humidity_pct', 'air_temperature_c'],
  high_temperature: ['air_temperature_c', 'relative_humidity_pct'],
  ec_rise: ['supply_ec_ds_m', 'drain_ec_ds_m'],
  moisture_low: ['substrate_moisture_pct', 'irrigation_flow_l_min'],
  temperature_sensor_fault: ['air_temperature_c', 'root_zone_temperature_c'],
}

function metricStatusLabel(metric: DashboardSnapshot['metrics'][number]) {
  if (metric.quality && metric.quality !== 'good') return '센서 확인'
  return ({ normal: '정상', warning: '주의', critical: '위험' } as const)[metric.status]
}

function metricRangeLabel(threshold: CultivationStrategyThreshold | undefined) {
  if (!threshold || threshold.lower === null && threshold.upper === null) return null
  if (threshold.lower !== null && threshold.upper !== null) return `운영 기준 ${threshold.lower}–${threshold.upper} ${threshold.unit}`
  if (threshold.lower !== null) return `운영 기준 ${threshold.lower} ${threshold.unit} 이상`
  return `운영 기준 ${threshold.upper} ${threshold.unit} 이하`
}

type SensorMetric = DashboardSnapshot['metrics'][number]

type SensorTrendSection = {
  id: string
  label: string
  detail: string
  metrics: Array<{
    metric: SensorMetric
    definition: ReturnType<typeof getSensorTrendDefinition>
  }>
}

const sensorTrendGroupDetails: Record<string, string> = {
  environment: '공기 · 습도',
  'root-zone': '온도 · 수분',
  nutrient: 'EC · pH',
  related: '현재 상황',
}

function SensorMiniTrend({ metric, samples, precision }: { metric: SensorMetric; samples: ReturnType<typeof selectSensorTrendSamples>; precision: number }) {
  const points = normalizeSvgPoints(samples, 120, 36, 3, MAX_TREND_SAMPLES)
  const delta = recentDelta(samples, metric.unit ?? '', precision)
  if (points.length < 2) return <div className="sensor-mini-trend empty"><span>추이 없음</span><small>현재값만 수신</small></div>
  const line = points.map((point) => `${point.x},${point.y}`).join(' ')
  const latest = points.at(-1)!
  const direction = delta?.direction ?? 'steady'
  const directionMark = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '→'
  const label = `${metric.label} 최근 추이${delta ? `, 구간 변화 ${delta.label}` : ''}`
  return <div className={`sensor-mini-trend ${direction}`}>
    <svg viewBox="0 0 120 36" preserveAspectRatio="none" role="img" aria-label={label}>
      <title>{label}</title>
      <line className="sensor-spark-baseline" x1="3" x2="117" y1="33" y2="33" />
      <polygon className="sensor-spark-area" points={`3,33 ${line} 117,33`} />
      <polyline className="sensor-spark-line" points={line} vectorEffect="non-scaling-stroke" />
      <circle className="sensor-spark-current" cx={latest.x} cy={latest.y} r="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
    <small><span>{directionMark}</span>{delta ? ` 구간 ${delta.label}` : ' 변화 계산 중'}</small>
  </div>
}

function ScenarioMetricStrip({ metrics, telemetryByZone, zoneId, scenarioId, scenarioIds, thresholds = [] }: { metrics: DashboardSnapshot['metrics']; telemetryByZone: DashboardSnapshot['telemetryByZone']; zoneId: string; scenarioId?: string; scenarioIds?: string[]; thresholds?: CultivationStrategyThreshold[] }) {
  const activeScenarioIds = scenarioIds?.length ? scenarioIds : [scenarioId ?? 'normal']
  const scenarioKeys = activeScenarioIds.flatMap((id) => metricKeysByScenario[id] ?? [])
  const keys = activeScenarioIds.every((id) => id === 'normal')
    ? metricKeysByScenario.normal
    : [...new Set([...scenarioKeys, ...metricKeysByScenario.normal])].slice(0, 6)
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]))
  const thresholdByMetric = new Map(thresholds.map((threshold) => [threshold.metric, threshold]))
  const selected = keys.map((key) => byKey.get(key)).filter((metric): metric is DashboardSnapshot['metrics'][number] => Boolean(metric))
  if (!selected.length) return null
  const selectedKeys = new Set(selected.map((metric) => metric.key))
  const standardKeys = new Set(sensorTrendGroups.flatMap((group) => group.metrics.map((metric) => metric.key)))
  const standardSections: SensorTrendSection[] = sensorTrendGroups.map((group) => ({
    id: group.id,
    label: group.label,
    detail: sensorTrendGroupDetails[group.id],
    metrics: group.metrics.flatMap((definition) => {
      const metric = selectedKeys.has(definition.key) ? byKey.get(definition.key) : undefined
      return metric ? [{ metric, definition }] : []
    }),
  })).filter((section) => section.metrics.length > 0)
  const relatedMetrics = selected.filter((metric) => !standardKeys.has(metric.key))
  const sections: SensorTrendSection[] = relatedMetrics.length
    ? [{ id: 'related', label: '관련 센서', detail: sensorTrendGroupDetails.related, metrics: relatedMetrics.map((metric) => ({ metric, definition: getSensorTrendDefinition(metric.key) })) }, ...standardSections]
    : standardSections
  const issueCount = selected.filter((metric) => metric.status !== 'normal' || metric.quality && metric.quality !== 'good').length
  return <section className="scenario-metric-strip" aria-label="현재 핵심 센서 추이">
    <header className="sensor-trend-heading">
      <div><span className="panel-kicker">현재 센서</span><h2>센서 추이</h2></div>
      <div className="sensor-trend-heading-meta"><span className={issueCount ? 'attention' : ''}>{issueCount ? `확인 필요 ${issueCount}개` : `핵심 센서 ${selected.length}개 정상`}</span><span className="time-chip">{zoneLabel(zoneId)} · 최근 10시간</span></div>
    </header>
    <div className="sensor-trend-grid">{sections.map((section) => {
      const sectionIssueCount = section.metrics.filter(({ metric }) => metric.status !== 'normal' || metric.quality && metric.quality !== 'good').length
      return <section className={`sensor-trend-group${sectionIssueCount ? ' attention' : ''}`} key={section.id}>
        <header><div><b>{section.label}</b><span>{section.detail}</span></div>{sectionIssueCount > 0 && <em>확인 필요 {sectionIssueCount}</em>}</header>
        <div className="sensor-trend-group-body">{section.metrics.map(({ metric, definition }) => {
          const threshold = thresholdByMetric.get(metric.key)
          const range = metricRangeLabel(threshold) ?? '운영 기준 미설정'
          const samples = selectSensorTrendSamples(telemetryByZone, zoneId, metric.key, MAX_TREND_SAMPLES)
          const qualityAttention = Boolean(metric.quality && metric.quality !== 'good')
          const needsAttention = metric.status !== 'normal' || qualityAttention
          return <article className={`sensor-trend-row ${metric.status}${qualityAttention ? ' quality-attention' : ''}`} key={metric.key}>
            <div className="sensor-trend-reading"><header><span>{metric.label}</span>{needsAttention && <em>{metricStatusLabel(metric)}</em>}</header><b>{metric.value}<small>{metric.unit ? ` ${metric.unit}` : ''}</small></b><small>{range}</small></div>
            <SensorMiniTrend metric={metric} samples={samples} precision={definition?.precision ?? 1} />
          </article>
        })}</div>
      </section>
    })}</div>
  </section>
}

const derivedMetricKeys = {
  vpd: ['air_temperature_c', 'relative_humidity_pct'],
  light: ['ppfd_umol_m2_s', 'solar_w_m2'],
  ec: ['supply_ec_ds_m', 'drain_ec_ds_m'],
  rootHeat: ['root_zone_temperature_c'],
}

function derivedStatus(metrics: DashboardSnapshot['metrics'], keys: string[]) {
  const ranks = { normal: 0, warning: 1, critical: 2 }
  return metrics.filter((metric) => keys.includes(metric.key)).reduce<DashboardSnapshot['metrics'][number]['status']>((status, metric) => ranks[metric.status] > ranks[status] ? metric.status : status, 'normal')
}

function DerivedIndicatorStrip({ indicators, metrics }: { indicators: DashboardSnapshot['derivedIndicators']; metrics: DashboardSnapshot['metrics'] }) {
  if (!indicators.length) return null
  return <section className="derived-indicator-strip" aria-label="재배 운영 파생지표">
    <div className="derived-strip-heading"><b>환경 균형</b><small>관련 센서를 함께 반영한 운영 지표</small></div>
    <div className="derived-zone-list">{indicators.map((indicator) => {
      const zoneMetrics = metrics.filter((metric) => metric.zoneId === indicator.zoneId)
      const values = [
        { key: 'vpd', label: 'VPD', value: `${indicator.vpdKpa.toFixed(2)} kPa`, status: derivedStatus(zoneMetrics, derivedMetricKeys.vpd), primary: true },
        { key: 'ec', label: '공급·배액 EC차', value: `${indicator.ecDeltaDsM.toFixed(2)} dS/m`, status: derivedStatus(zoneMetrics, derivedMetricKeys.ec), primary: true },
        { key: 'light', label: '오늘 광량', value: `${indicator.dliMolM2Day.toFixed(1)} mol/㎡`, status: derivedStatus(zoneMetrics, derivedMetricKeys.light), primary: false },
        { key: 'rootHeat', label: '근권 고온 노출', value: `${Math.round(indicator.rootHeatExposureDegreeMinutes)} °C·min`, status: derivedStatus(zoneMetrics, derivedMetricKeys.rootHeat), primary: false },
      ]
      return <article key={indicator.zoneId}><span>{indicator.zoneId === 'zone-b' ? '2구역' : '1구역'}</span><dl>{values.map((item) => <div className={`${item.primary ? 'primary' : 'secondary'} ${item.status}`} key={item.key}><dt><span>{item.label}</span><em>{({ normal: '정상', warning: '주의', critical: '위험' } as const)[item.status]}</em></dt><dd>{item.value}</dd></div>)}</dl></article>
    })}</div>
  </section>
}

function ProgressTrack({ label, value, minimum = 0, maximum = 100, marker = false }: { label: string; value: number; minimum?: number; maximum?: number; marker?: boolean }) {
  const percent = normalizedPercent(value, minimum, maximum)
  return <span className={`micro-progress ${marker ? 'marker' : ''}`} role="img" aria-label={label}><i style={{ width: marker ? '100%' : `${percent}%` }} />{marker && <em style={{ left: `${percent}%` }} />}</span>
}

function HeroKpi({ label, value, detail, tone, icon, progress }: { label: string; value: string; detail: string; tone: 'stable' | 'attention' | 'neutral'; icon: IconName; progress?: { value: number; label: string } }) {
  return <article className={`hero-kpi ${tone}`}><div><span>{label}</span><b>{value}</b>{progress && <ProgressTrack value={progress.value} label={progress.label} />}<small>{detail}</small></div><span className="hero-kpi-icon"><Icon name={icon} size={20} /></span></article>
}

type TrendMetric = 'rootZoneTemperature' | 'irrigationFlow' | 'temperature'

function TelemetryOverview({ points, zoneId }: { points: DashboardSnapshot['telemetry']; zoneId: string }) {
  const latest = points.at(-1)
  return <section className="telemetry-overview panel"><div className="panel-head"><div><span className="panel-kicker">최근 센서</span><h2>근권 · 관수 · 재배실 흐름</h2></div><span className="time-chip">{zoneLabel(zoneId)} · 최근 10시간</span></div><div className="trend-grid"><TrendPanel points={points} metric="rootZoneTemperature" title="근권" label="근권 온도" unit="°C" secondary={`공급 EC ${latest?.ec ?? '-'} dS/m`} /><TrendPanel points={points} metric="irrigationFlow" title="관수" label="관수 유량" unit=" L/min" secondary={`압력 ${latest?.irrigationPressure ?? '-'} bar`} /><TrendPanel points={points} metric="temperature" title="재배실" label="공기 온도" unit="°C" secondary={`습도 ${latest?.humidity ?? '-'}% · PPFD ${latest?.ppfd ?? '-'}`} /></div></section>
}

function TrendPanel({ points, metric, title, label, unit, secondary }: { points: DashboardSnapshot['telemetry']; metric: TrendMetric; title: string; label: string; unit: string; secondary: string }) {
  const values = points.map((point) => point[metric]).filter(Number.isFinite)
  if (!values.length) return <article className="trend-panel"><span>{title}</span><EmptyCopy>시계열 없음</EmptyCopy></article>
  const min = Math.min(...values)
  const max = Math.max(...values)
  const padding = Math.max((max - min) * .25, .3)
  const y = (value: number) => 82 - ((value - (min - padding)) / (max - min + padding * 2 || 1)) * 62
  const line = values.map((value, index) => `${8 + (index / Math.max(values.length - 1, 1)) * 264},${y(value)}`).join(' ')
  return <article className="trend-panel"><div className="trend-title"><span>{title}</span><small>{label}</small></div><div className="trend-value">{values.at(-1)}<small>{unit}</small></div><svg viewBox="0 0 280 92" preserveAspectRatio="none" role="img" aria-label={`${label} 추이`}><line x1="8" x2="272" y1="82" y2="82" /><polygon points={`8,86 ${line} 272,86`} /><polyline points={line} /></svg><small className="trend-secondary">{secondary}</small></article>
}

function PageTitle({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <div className="page-title"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{action}</div>
}

function DataBadge({ state, updatedAt, origin, paused = false }: { state: RuntimeState; updatedAt: string; origin?: DashboardSnapshot['dataOrigin']; paused?: boolean }) {
  const label = paused ? '화면 갱신 정지' : state === 'connected' ? '운영 데이터 수신' : state === 'degraded' ? '복구 데이터 경로' : '연결 필요'
  const detail = paused ? `마지막 수신 ${updatedAt}` : state === 'unavailable' ? 'API 미연결' : origin === 'fixture_fallback' ? '복구 데이터 사용' : `갱신 ${updatedAt}`
  return <div className={`data-badge ${paused ? 'paused' : state}`}><span className="pulse" /><div><b>{label}</b><small>{detail}</small></div></div>
}


function AlertRow({ alert, analysis, automatic, onAnalyze, onOpenAdvisor }: { alert: Alert; analysis?: AlertAnalysisState; automatic: boolean; onAnalyze: () => void; onOpenAdvisor: (analysis: CompletedAlertAnalysis) => void }) {
  const advisory = analysis?.status === 'ready' || analysis?.status === 'fallback' ? analysis.advisory : null
  const icon: IconName =
    alert.severity === "critical"
      ? "bolt"
      : alert.severity === "warning"
        ? "bell"
        : "activity";
  return (
    <div className={`alert-row ${alert.severity}`}>
      <div className="alert-symbol">
        <Icon name={icon} size={17} />
      </div>
      <div className="alert-copy">
        <b>{alert.zoneId ? `${zoneLabel(alert.zoneId)} · ` : ''}{alert.title}</b>
        <span>{operationalUiCopy(alert.detail)}</span>
        {analysis?.status === 'loading' && (
          <small className="alert-advisory-loading">
            근거를 확인해 경보 대응 순서를 생성 중입니다.
          </small>
        )}
        {advisory && analysis && analysis.status !== 'loading' && analysis.status !== 'error' && (
          <button type="button" className="alert-advisory" onClick={() => onOpenAdvisor(analysis)} aria-label={`${alert.title} AI 재배 조언 상세 보기`}>
            <span className="alert-advisory-heading">
              <Icon name="sparkle" size={13} />
              <b>AI 요약</b>
            </span>
            <span className="alert-advisory-summary">{advisorySummary(advisory.warning)}</span>
            <span className="alert-advisory-footer"><small>{advisory.controlDrafts.length ? '장치 조정안 준비됨' : `${advisory.evidence.length}개 근거 연결`}</small><b>{advisory.controlDrafts.length ? '허용 여부 확인' : '상세 보기'} <Icon name="chevron" size={12} /></b></span>
          </button>
        )}
        {analysis?.status === 'error' && (
          <div className="alert-analysis-failed">
            <small className="alert-advisory-error">{analysis.message}{analysis.retrying ? ' · 30초 후 자동 재시도합니다.' : ''}</small>
            <button className="alert-analysis-action" onClick={onAnalyze}>AI 분석 다시 시도</button>
          </div>
        )}
        {analysis?.status === 'fallback' && (
          <div className="alert-analysis-failed">
            <small className="alert-advisory-error">AI 분석 연결을 확인하는 동안 검증된 근거 안내를 표시합니다.{analysis.retrying ? ' 30초 후 연결을 다시 확인합니다.' : ''}</small>
            <button className="alert-analysis-action" onClick={onAnalyze}>{advisory?.requestedModel ? 'AI 분석 다시 시도' : '근거 다시 확인'}</button>
          </div>
        )}
        {!analysis && alert.status === 'new' && (
          automatic
            ? <small className="alert-advisory-loading">새 경보 자동 분석 대기 중입니다.</small>
            : <button className="alert-analysis-action" onClick={onAnalyze}><Icon name="sparkle" size={13} />AI 분석 실행</button>
        )}
      </div>
      <div className="alert-meta">
        <time>{alert.time}</time>
        <span className={`status-tag ${alert.status}`}>
          {alert.status === "new"
            ? "새 알림"
            : alert.status === "acknowledged"
              ? "확인됨"
              : "해결됨"}
        </span>
      </div>
    </div>
  );
}

function Equipment({ actuator }: { actuator: Actuator }) {
  const config: Record<
    string,
    { icon: IconName; tone: "mint" | "sun" | "blue" }
  > = {
    root_zone_chiller: { icon: "thermometer", tone: "mint" },
    ventilation_fan: { icon: "wind", tone: "mint" },
    side_vent: { icon: "wind", tone: "mint" },
    shade_curtain: { icon: "sun", tone: "mint" },
    irrigation_pump: { icon: "water", tone: "mint" },
    heater: { icon: "sun", tone: "mint" },
  };
  const target = actuatorControlTarget(actuator)
  const style = config[target ?? ''] ?? {
    icon: "sliders" as IconName,
    tone: "mint" as const,
  };
  return (
    <div className="equipment">
      <div className={`equipment-icon ${style.tone}`}>
        <Icon name={style.icon} size={17} />
      </div>
      <div>
        <span>{deviceScopeLabel(actuator)} · {actuator.label}</span>
        <b>{operationalStateText(actuator.state)}</b>
        <small>
          <i />
          {actuator.controllable ? "조정 준비" : "상태 확인"}
        </small>
      </div>
    </div>
  );
}

function ReadinessPanel({ readiness }: { readiness: ReadinessService[] }) {
  return (
    <section className="readiness-panel panel">
      <div className="panel-head">
        <div>
          <span className="panel-kicker">운영 연결 상태</span>
          <h2>연결된 파이프라인</h2>
        </div>
        <span className="readiness-caption">서비스 health endpoint</span>
      </div>
      {readiness.length ? (
        <div className="readiness-grid">
          {readiness.map((service) => (
            <div className={`readiness-item ${service.state}`} key={service.id}>
              <span />
              <div>
                <b>{service.label}</b>
                <small>{service.detail}</small>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyCopy>readiness endpoint가 아직 응답하지 않습니다.</EmptyCopy>
      )}
    </section>
  );
}

function Advisor({
  farm,
  runtimeState,
  selectedZone,
  sessions,
  activeSessionId,
  sessionsLoading,
  sessionError,
  queryContext,
  turns,
  activeTurnId,
  approvals,
  activeAlertOccurrenceIds,
  scenarioState,
  onEnsureSession,
  onBeginNewSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSessionUpdated,
  onQueryContextChange,
  onTurnsChange,
  onActiveTurnChange,
  onDiagnostics,
  onReviewDraft,
  onSelectedZoneChange,
}: {
  farm: Farm;
  runtimeState: RuntimeState;
  selectedZone: ZoneSelection;
  sessions: AdvisorSessionSummary[];
  activeSessionId: string | null;
  sessionsLoading: boolean;
  sessionError: string | null;
  queryContext: AdvisorQueryContext;
  turns: AdvisorTurn[];
  activeTurnId: string | null;
  approvals: Approval[];
  activeAlertOccurrenceIds: string[];
  scenarioState: DemoScenarioState | null;
  onEnsureSession: (title?: string) => Promise<string>;
  onBeginNewSession: () => void;
  onSelectSession: (sessionId: string) => Promise<boolean>;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onSessionUpdated: () => Promise<void>;
  onQueryContextChange: React.Dispatch<React.SetStateAction<AdvisorQueryContext>>;
  onTurnsChange: React.Dispatch<React.SetStateAction<AdvisorTurn[]>>;
  onActiveTurnChange: (id: string | null) => void;
  onDiagnostics: (diagnostics: AdvisorDiagnostics) => void;
  onReviewDraft: (draft: ControlDraft) => void;
  onSelectedZoneChange: (zone: ZoneSelection) => void;
}) {
  const [question, setQuestion] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [reviewMessage, setReviewMessage] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  async function reviewAnswer(responseId: string) {
    if (!activeSessionId || reviewBusy) return
    setReviewBusy(true); setReviewMessage("최신 관측 조회 → 답변 의존성 확인 중…")
    try {
      await recheckAdvisor(farm.id, activeSessionId, responseId)
      await onSelectSession(activeSessionId)
      setReviewMessage("최신 관측 확인 완료 · 관련 부분 재검토 완료 · 대화 기록 저장")
    } catch (e) { setReviewMessage(e instanceof Error ? e.message : "재검토 실패") }
    finally { setReviewBusy(false) }
  }
  const [showSessions, setShowSessions] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(
    null,
  );
  const [publicOnly, setPublicOnly] = useState(true);
  const [showSelectedSources, setShowSelectedSources] = useState(false);
  const [sourcePage, setSourcePage] = useState(1);
  const [isComposing, setIsComposing] = useState(false);
  const [mobilePane, setMobilePane] = useState<'sources' | 'chat' | 'evidence'>('chat');
  const [showOlderTurns, setShowOlderTurns] = useState(false);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null);
  const selectedSourceIds = queryContext.selectedSourceIds;
  const includeSimulationContext = queryContext.includeSimulationContext;
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSearchResult, setSourceSearchResult] = useState<KnowledgeSourceSearchResult | null>(null);
  const [sourceSearchBusy, setSourceSearchBusy] = useState(false);
  const [focusedSourceGroupId, setFocusedSourceGroupId] = useState<string | null>(null);
  const [sourceSelectionNotice, setSourceSelectionNotice] = useState<{ message: string; previousIds: string[] | null } | null>(null);
  const sessionTriggerRef = useRef<HTMLButtonElement>(null);
  const sessionDrawerRef = useRef<HTMLElement>(null);
  const sessionSearchRef = useRef<HTMLInputElement>(null);
  const latestTurn = latestCompletedTurn(turns);
  const activeTurn = turns.find((turn) => turn.id === activeTurnId) ?? latestTurn;
  const evidence = activeTurn?.evidence ?? [];
  const evidenceGroups = useMemo(() => groupAnswerEvidence(evidence), [evidence]);
  const executionState = activeTurn?.execution ?? emptyAdvisorExecution;
  const routeState = activeTurn?.retrieval ?? emptyAdvisorRetrieval;
  const selectedEvidenceGroup = evidenceGroupForPassage(evidenceGroups, selectedEvidenceId) ?? evidenceGroups[0];
  const selectedEvidence = selectedEvidenceGroup?.representative;
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const visibleSessions = filterAdvisorSessions(sessions, sessionQuery);
  const sharedRequestBusy = useSyncExternalStore(advisorRequests.subscribe, () => advisorRequests.busy(farm.id));
  const isSending = sharedRequestBusy || sessionActionBusy || turns.some((turn) => turn.status === 'loading');
  const olderTurnCount = Math.max(0, turns.length - 2);
  const displayedTurns = showOlderTurns ? turns : turns.slice(-2);

  function setSelectedSourceIds(update: React.SetStateAction<string[]>) {
    onQueryContextChange((current) => ({
      ...current,
      selectedSourceIds: typeof update === 'function' ? update(current.selectedSourceIds) : update,
    }))
  }

  function setIncludeSimulationContext(enabled: boolean) {
    onQueryContextChange((current) => ({ ...current, includeSimulationContext: enabled }))
  }

  useEffect(() => {
    setSelectedEvidenceId(activeTurn?.evidence[0]?.id ?? null)
    const frame = window.requestAnimationFrame(() => {
      if (activeTurnId) document.getElementById(`advisor-turn-${activeTurnId}`)?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeTurn?.evidence, activeTurnId])

  useEffect(() => {
    setShowOlderTurns(false)
    setMobilePane('chat')
    setSourceQuery('')
    setSourceSearchResult(null)
    setFocusedSourceGroupId(null)
    setSourceSelectionNotice(null)
  }, [activeSessionId])

  useEffect(() => {
    if (!showSessions) return
    const frame = window.requestAnimationFrame(() => sessionSearchRef.current?.focus())
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setShowSessions(false)
        setRenamingSessionId(null)
        setDeleteCandidateId(null)
        setSessionActionError(null)
        sessionTriggerRef.current?.focus()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(sessionDrawerRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])') ?? [])]
        .filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showSessions])

  useEffect(() => {
    if (!documents.length || sessionsLoading) return
    const readyDocuments = documents.filter((document) => document.status === 'ready' && document.retrievalState === 'active')
    const hasSavedContext = hasPersistedQueryContext(turns)
    const normalizedSelection = restoreSourceRootSelection(
      readyDocuments,
      queryContext.selectedSourceIds,
      readyDocuments.filter((document) => isPublicKnowledgeScope(document.scope) && !isLegacyResearch(document)),
      hasSavedContext,
    )
    onQueryContextChange((current) => ({
      ...current,
      selectedSourceIds: normalizedSelection,
    }))
    setPublicOnly(queryContext.sourceVisibility !== 'all')
    // Session changes are the restoration boundary; source toggles remain operator-controlled within a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, documents, sessionsLoading, turns])

  useEffect(() => {
    let active = true;
    void getKnowledge(farm.id).then((result) => {
      if (!active) return;
      setDocuments(result.data);
      setKnowledgeError(result.error ?? null);
    });
    return () => {
      active = false;
    };
  }, [farm.id]);

  function closeSessionDrawer() {
    setShowSessions(false)
    setRenamingSessionId(null)
    setDeleteCandidateId(null)
    setSessionActionError(null)
    window.requestAnimationFrame(() => sessionTriggerRef.current?.focus())
  }

  function startNewSession() {
    if (isSending) return
    onBeginNewSession()
    onQueryContextChange({
      selectedSourceIds: groupKnowledgeSources(documents.filter((document) => document.status === 'ready' && document.retrievalState === 'active' && isPublicKnowledgeScope(document.scope) && !isLegacyResearch(document))).map((group) => group.id),
      includeSimulationContext: true,
      selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
      zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
      sourceVisibility: 'public',
    })
    setPublicOnly(true)
    setShowSelectedSources(false)
    setSourcePage(1)
    setSourceQuery('')
    setSourceSearchResult(null)
    setFocusedSourceGroupId(null)
    setSourceSelectionNotice(null)
    setRequestError(null)
    closeSessionDrawer()
    window.requestAnimationFrame(() => document.getElementById('advisor-composer')?.focus())
  }

  async function selectSession(sessionId: string) {
    if (isSending || sessionId === activeSessionId) {
      closeSessionDrawer()
      return
    }
    setSessionActionBusy(true)
    setSessionActionError(null)
    try {
      await onSelectSession(sessionId)
      closeSessionDrawer()
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : '대화를 열지 못했습니다.')
    } finally {
      setSessionActionBusy(false)
    }
  }

  async function submitSessionRename(sessionId: string) {
    const cleaned = renameTitle.trim()
    if (!cleaned || sessionActionBusy) return
    setSessionActionBusy(true)
    setSessionActionError(null)
    try {
      await onRenameSession(sessionId, cleaned)
      setRenamingSessionId(null)
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : '대화 이름을 바꾸지 못했습니다.')
    } finally {
      setSessionActionBusy(false)
    }
  }

  async function confirmSessionDelete(sessionId: string) {
    if (sessionActionBusy || isSending) return
    setSessionActionBusy(true)
    setSessionActionError(null)
    try {
      await onDeleteSession(sessionId)
      setDeleteCandidateId(null)
      if (sessions.length <= 1) closeSessionDrawer()
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : '대화를 삭제하지 못했습니다.')
    } finally {
      setSessionActionBusy(false)
    }
  }

  const scopeEligibleDocuments = documents.filter(
    (document) =>
      document.status === "ready" &&
      document.retrievalState === 'active' &&
      (!publicOnly || isPublicKnowledgeScope(document.scope)),
  );
  const sourceGroups = groupKnowledgeSources(scopeEligibleDocuments);
  const normalizedSourceQuery = sourceQuery.trim().toLocaleLowerCase();
  const localMatchedSourceGroups = sourceGroups.filter(
    (group) =>
      !normalizedSourceQuery ||
      group.documents.some((document) =>
        [group.title, document.issuer, document.documentType, document.summary]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedSourceQuery),
      ),
  );
  const sourceGroupsById = new Map(sourceGroups.map((group) => [group.id, group]));
  const semanticMatchedSourceGroups = sourceSearchResult?.sourceGroups.flatMap((match) => {
    const group = sourceGroupsById.get(match.sourceGroupId);
    return group ? [group] : [];
  }) ?? null;
  const matchedSourceGroups = semanticMatchedSourceGroups ?? localMatchedSourceGroups;
  const activeSelectionIds = new Set(selectedSourceIds);
  const visibleSourceGroups = matchedSourceGroups.filter(
    (group) => !showSelectedSources || activeSelectionIds.has(group.id),
  );
  const orderedSourceGroups = sourceSearchResult
    ? visibleSourceGroups
    : [...visibleSourceGroups].sort(
        (left, right) => Number(left.isResearchArchive) - Number(right.isResearchArchive) || left.title.localeCompare(right.title, 'ko'),
      );
  const knownSelectionIds = new Set(sourceGroups.flatMap((group) => [group.id, ...group.documentIds]));
  const activeSourceIds = selectedSourceIds.filter((id) => knownSelectionIds.has(id));
  const selectedSourceGroupIds = sourceGroups.filter((group) => activeSelectionIds.has(group.id)).map((group) => group.id);
  const selectedSourceGroupCount = selectedSourceGroupIds.length;
  const effectiveFocusedSourceGroupId = focusedSourceGroupId && activeSelectionIds.has(focusedSourceGroupId)
    ? focusedSourceGroupId
    : selectedSourceGroupIds.length === 1 ? selectedSourceGroupIds[0] : null;
  const matchedSelectedSourceCount = matchedSourceGroups.filter((group) => activeSelectionIds.has(group.id)).length;
  const sourcePageCount = Math.max(1, Math.ceil(orderedSourceGroups.length / ADVISOR_SOURCE_PAGE_SIZE));
  const currentSourcePage = Math.min(sourcePage, sourcePageCount);
  const pagedSourceGroups = orderedSourceGroups.slice(
    (currentSourcePage - 1) * ADVISOR_SOURCE_PAGE_SIZE,
    currentSourcePage * ADVISOR_SOURCE_PAGE_SIZE,
  );
  const activeTurnIsConversation = activeTurn?.toolTrace?.intent === 'conversation' && !activeTurn.controlDrafts.length;
  const emptyEvidenceCopy = !activeTurn
    ? '질문을 보내면 답변에 사용한 원본이 여기에 표시됩니다.'
    : activeTurn.status === 'loading'
      ? isGeneralConversationQuestion(activeTurn.userMessage.content, activeSourceIds.length > 0)
        ? '답변을 준비하고 있습니다.'
        : '답변 근거를 확인하고 있습니다.'
      : activeTurn.status === 'error'
        ? '답변이 완료되지 않아 표시할 근거가 없습니다.'
        : activeTurnIsConversation
          ? '일상 대화에는 자료 검색을 사용하지 않았습니다.'
          : '이 답변에는 문서 인용이 없습니다.';

  useEffect(() => setSourcePage(1), [sourceQuery, publicOnly, showSelectedSources])

  useEffect(() => {
    if (sourcePage > sourcePageCount) setSourcePage(sourcePageCount)
  }, [sourcePage, sourcePageCount])

  async function runSourceSearch(rawQuery = sourceQuery, visibility: 'public' | 'all' = publicOnly ? 'public' : 'all') {
    const cleaned = rawQuery.trim();
    if (isSending) return null;
    if ([...cleaned].length > 160) {
      setRequestError('검색어는 160자 이내로 입력해 주세요.');
      return null;
    }
    if (!cleaned) {
      setSourceSearchResult(null);
      setRequestError(null);
      return null;
    }
    setSourceSearchBusy(true);
    setRequestError(null);
    try {
      const result = await searchKnowledgeSourceGroups(farm.id, { query: cleaned, visibility });
      setSourceQuery(result.query);
      setSourceSearchResult(result);
      setSourcePage(1);
      return result;
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : '관련 자료를 찾지 못했습니다.');
      return null;
    } finally {
      setSourceSearchBusy(false);
    }
  }

  function setPublicOnlySources(enabled: boolean) {
    if (isSending) return;
    setPublicOnly(enabled);
    onQueryContextChange((current) => ({ ...current, sourceVisibility: enabled ? 'public' : 'all' }));
    setSourceSearchResult(null);
    setSourcePage(1);
  }

  function toggleSource(group: KnowledgeSourceGroup) {
    if (isSending) return;
    const wasSelected = activeSelectionIds.has(group.id) || group.documentIds.some((id) => activeSelectionIds.has(id));
    setFocusedSourceGroupId(wasSelected ? null : group.id);
    setSourceSelectionNotice(null);
    setSelectedSourceIds((current) => {
      setRequestError(null);
      return toggleSourceRootSelection(current, group);
    });
  }

  function selectVisibleSources() {
    if (isSending) return;
    if (!matchedSourceGroups.length) {
      setRequestError("검색 결과가 없어 현재 선택한 근거를 유지했습니다.");
      return;
    }
    const matchedIds = matchedSourceGroups.map((group) => group.id)
    setSelectedSourceIds((current) => {
      const next = [...new Set([...current, ...matchedIds])];
      setSourceSelectionNotice({ message: `검색 결과 ${matchedIds.length}개 원본을 모두 선택했습니다.`, previousIds: [...current] });
      return next;
    });
    setRequestError(null);
  }

  function clearVisibleSources() {
    if (isSending) return;
    const visibleIds = new Set(matchedSourceGroups.flatMap((group) => [group.id, ...group.documentIds]));
    setSelectedSourceIds((current) => {
      const next = current.filter((id) => !visibleIds.has(id));
      setSourceSelectionNotice({ message: `검색 결과 ${matchedSourceGroups.length}개 원본을 선택에서 제외했습니다.`, previousIds: [...current] });
      return next;
    });
  }

  async function submitQuestion(text = question) {
    const cleaned = text.trim();
    if (!cleaned || isSending) return;
    if ([...cleaned].length > 1000) {
      setRequestError('질문은 1,000자 이내로 입력해 주세요. 입력 내용은 그대로 유지됩니다.');
      return;
    }
    const sourceCommand = isSourceCommandInstruction(cleaned)
      ? parseSourceCommand(cleaned, { focusedSourceGroupId: effectiveFocusedSourceGroupId })
      : null
    let sessionId = activeSessionId;
    if (!sessionId) {
      setSessionActionBusy(true)
      try {
        sessionId = await onEnsureSession()
      } catch (error) {
        setRequestError(error instanceof Error ? error.message : '새 대화를 시작하지 못했습니다.')
        setSessionActionBusy(false)
        return
      }
      setSessionActionBusy(false)
    }
    setQuestion("");
    setRequestError(null);
    const selectedSourceIdsSnapshot = [...selectedSourceIds];
    const currentSourceVisibility = publicOnly ? 'public' : 'all';
    const turnId = crypto.randomUUID();
    const pendingTurn: AdvisorTurn = {
      id: turnId,
      userMessage: { id: `${turnId}:user`, role: 'user', content: cleaned, createdAt: formatNow() },
      assistantMessage: null,
      evidence: [],
      execution: emptyAdvisorExecution,
      retrieval: emptyAdvisorRetrieval,
      responseId: null,
      controlDrafts: [],
      toolTrace: null,
      agentRun: null,
      queryContext: {
        selectedSourceIds: [...selectedSourceIdsSnapshot],
        includeSimulationContext,
        selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
        zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
        sourceVisibility: currentSourceVisibility,
      },
      status: 'loading',
      error: null,
    };
    onTurnsChange((items) => upsertAdvisorTurn(items, pendingTurn));
    onActiveTurnChange(turnId);
    setSelectedEvidenceId(null);
    try {
      const result = await askAdvisor(
        farm.id,
        cleaned,
        selectedSourceIdsSnapshot,
        includeSimulationContext,
        sessionId,
        turnId,
        {
          sourceSelectionMode: 'explicit',
          sourceContextVisibility: currentSourceVisibility,
          searchResultSourceGroupIds: sourceCommand?.usesCurrentResultSet && sourceSearchResult
            ? matchedSourceGroups.map((group) => group.id)
            : [],
          focusedSourceGroupId: sourceCommand?.focusedSourceGroupId ?? effectiveFocusedSourceGroupId,
          selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
          zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
        },
      );
      const contextPatch = result.contextPatch
      const acceptedContextPatch = contextPatch && !contextPatch.error ? contextPatch : null
      const resolvedSourceIds = acceptedContextPatch && acceptedContextPatch.operation !== 'search'
        ? acceptedContextPatch.sourceGroupIds
        : selectedSourceIdsSnapshot
      const resolvedSourceVisibility = acceptedContextPatch?.visibility ?? currentSourceVisibility
      if (acceptedContextPatch) {
        const previousIds = [...selectedSourceIdsSnapshot]
        setPublicOnly(acceptedContextPatch.visibility === 'public')
        onQueryContextChange((current) => ({
          ...current,
          selectedSourceIds: acceptedContextPatch.operation !== 'search' ? acceptedContextPatch.sourceGroupIds : current.selectedSourceIds,
          sourceVisibility: acceptedContextPatch.visibility,
        }))
        if (acceptedContextPatch.query) void runSourceSearch(acceptedContextPatch.query, acceptedContextPatch.visibility)
        if (acceptedContextPatch.matchedSourceGroupIds.length === 1) setFocusedSourceGroupId(acceptedContextPatch.matchedSourceGroupIds[0])
        setSourceSelectionNotice({
          message: acceptedContextPatch.clarification ?? (acceptedContextPatch.operation === 'search'
            ? `관련 원본 ${acceptedContextPatch.count}개를 찾았습니다.`
            : `답변 자료 ${acceptedContextPatch.sourceGroupIds.length}개로 범위를 변경했습니다.`),
          previousIds: acceptedContextPatch.operation !== 'search' ? previousIds : null,
        })
      } else if (contextPatch) {
        setSourceSelectionNotice({ message: contextPatch.clarification ?? contextPatch.error ?? '자료 범위를 바꾸지 못했습니다.', previousIds: null })
      }
      const execution = {
        provider: result.execution.provider,
        privacy: result.execution.privacy,
        requestedModel: result.execution.requestedModel ?? null,
        requestedServiceTier: result.execution.requestedServiceTier ?? null,
        model: result.execution.model ?? null,
        serviceTier: result.execution.serviceTier ?? null,
        fallbackReason: result.execution.fallbackReason ?? null,
      };
      const controlDrafts = result.controlDrafts.map((draft) => ({ ...draft, advisorMessageId: result.message.id }));
      onTurnsChange((items) => upsertAdvisorTurn(items, {
        ...pendingTurn,
        assistantMessage: result.message,
        evidence: result.evidence,
        execution,
        retrieval: result.retrieval,
        responseId: result.responseId,
        controlDrafts,
        toolTrace: result.toolTrace,
        agentRun: result.agentRun,
        queryContext: {
          selectedSourceIds: [...resolvedSourceIds],
          includeSimulationContext,
          selectedZoneIds: selectedZone === 'all' ? [] : [selectedZone],
          zoneScopeMode: selectedZone === 'all' ? 'all' : 'focused',
          sourceVisibility: resolvedSourceVisibility,
        },
        status: 'complete',
      }));
      void onSessionUpdated()
      setSelectedEvidenceId(result.evidence[0]?.id ?? null);
      onDiagnostics({
        provider: result.execution.provider,
        privacy: result.execution.privacy,
        requestedModel: result.execution.requestedModel ?? null,
        requestedServiceTier: result.execution.requestedServiceTier ?? null,
        model: result.execution.model ?? null,
        serviceTier: result.execution.serviceTier ?? null,
        fallbackReason: result.execution.fallbackReason ?? null,
        path: result.message.searchPath ?? [],
        gateReason:
          result.message.gateReason ?? "그래프 경로를 사용하지 않았습니다.",
        runId: result.retrieval.runId,
        backend: result.retrieval.backend,
        candidateCount: result.retrieval.candidateCount,
        returnedCount: result.retrieval.returnedCount,
        queryScope: result.retrieval.queryScope,
        channels: result.retrieval.channels,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Advisor 요청을 완료하지 못했습니다.";
      onTurnsChange((items) => upsertAdvisorTurn(items, { ...pendingTurn, status: 'error', error: message }));
    }
  }

  return (
    <div className="advisor-workspace">
      <div className="advisor-head page-title">
        <div>
          <span className="eyebrow">현장 AI 조언</span>
          <h1>근거를 선택하고 재배 상황을 질문하세요</h1>
          <p>
            현재 센서와 선택한 원본을 함께 검토해 확인 순서와 조치를 제안합니다.
          </p>
        </div>
        <div className="advisor-actions">
          <DataBadge state={runtimeState} updatedAt="현재" />
        </div>
      </div>
      <section className="workspace-scope-bar" aria-label="현재 작업 범위">
        <div className="workspace-scope-heading">
          <span className="panel-kicker">현재 작업 범위</span>
          <b>{selectedZone === 'all' ? 'A동 전체 구역 비교' : `A동 ${zoneLabel(selectedZone)} 집중 보기`}</b>
          <small>이 범위는 센서 조회와 다음 AI 질문에 함께 적용됩니다.</small>
        </div>
        <div className="workspace-scope-controls">
          <div className="zone-switcher workspace-zone-switcher" role="group" aria-label="AI 조언 현장 범위">
            <button type="button" className={selectedZone === 'all' ? 'active' : ''} aria-pressed={selectedZone === 'all'} disabled={isSending} onClick={() => onSelectedZoneChange('all')}>전체</button>
            <button type="button" className={selectedZone === 'zone-a' ? 'active' : ''} aria-pressed={selectedZone === 'zone-a'} disabled={isSending} onClick={() => onSelectedZoneChange('zone-a')}>1구역</button>
            <button type="button" className={selectedZone === 'zone-b' ? 'active' : ''} aria-pressed={selectedZone === 'zone-b'} disabled={isSending} onClick={() => onSelectedZoneChange('zone-b')}>2구역</button>
          </div>
          <label className="public-toggle">
            <input type="checkbox" checked={includeSimulationContext} disabled={isSending} onChange={(event) => setIncludeSimulationContext(event.target.checked)} />
            <span className="toggle-track"><i /></span>
            <span><b>센서 포함</b><small>현재 관측값</small></span>
          </label>
          <label className="public-toggle">
            <input type="checkbox" checked={publicOnly} disabled={isSending} onChange={(event) => setPublicOnlySources(event.target.checked)} />
            <span className="toggle-track"><i /></span>
            <span><b>{publicOnly ? '공개 자료만' : '농장 내부 포함'}</b><small>답변 근거 범위</small></span>
          </label>
          <div className="workspace-source-count"><span>답변 자료</span><b>{selectedSourceGroupCount}개 원본</b></div>
        </div>
      </section>
      <nav className="advisor-mobile-tabs" aria-label="AI 재배 조언 화면">
        <button type="button" className={mobilePane === 'sources' ? 'active' : ''} onClick={() => setMobilePane('sources')}><Icon name="book" size={15} />자료 <span>{selectedSourceGroupCount}</span></button>
        <button type="button" className={mobilePane === 'chat' ? 'active' : ''} onClick={() => setMobilePane('chat')}><Icon name="sparkle" size={15} />질문 <span>{turns.length}</span></button>
        <button type="button" className={mobilePane === 'evidence' ? 'active' : ''} onClick={() => setMobilePane('evidence')}><Icon name="check" size={15} />근거 <span>{evidenceGroups.length}</span></button>
      </nav>
      <div className="advisor-layout">
        <section className={`source-rail ${mobilePane === 'sources' ? 'mobile-active' : ''}`}>
          <div className="rail-title">
            <span>답변에 사용할 자료</span>
            <span className="panel-kicker">원본 묶음</span>
          </div>
          <div className="source-search" role="search">
            <Icon name="search" size={16} />
            <input
              value={sourceQuery}
              title="검색어는 160자 이내로 입력해 주세요"
              disabled={isSending}
              onChange={(event) => { setSourceQuery(event.target.value); setSourceSearchResult(null) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void runSourceSearch() }
              }}
              placeholder="예: 근권 고온 대응 자료"
              aria-label="답변 근거 검색"
            />
            <button type="button" disabled={isSending || sourceSearchBusy || !sourceQuery.trim()} onClick={() => void runSourceSearch()} aria-label={sourceSearchBusy ? '관련 자료 검색 중' : '관련 자료 검색'}>
              {sourceSearchBusy ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="chevron" size={13} />}
            </button>
          </div>
          <div className="source-search-status">
            {knowledgeError ??
              `선택 ${selectedSourceGroupCount}개 · ${sourceSearchResult ? '관련 자료' : '검색 결과'} ${matchedSourceGroups.length}개`}
          </div>
          {sourceSelectionNotice && <div className="source-selection-notice" role="status"><span>{sourceSelectionNotice.message}</span>{sourceSelectionNotice.previousIds && <button type="button" disabled={isSending} onClick={() => { setSelectedSourceIds(sourceSelectionNotice.previousIds ?? []); setSourceSelectionNotice(null) }}>실행 취소</button>}</div>}
          <div className="source-selection-actions">
            <button
              type="button"
              disabled={isSending || !matchedSourceGroups.length}
              onClick={selectVisibleSources}
            >
              검색 결과 {matchedSourceGroups.length}개 모두 선택
            </button>
            <button
              type="button"
              disabled={isSending || !matchedSourceGroups.length}
              onClick={clearVisibleSources}
            >
              선택된 결과 {matchedSelectedSourceCount}개 해제
            </button>
          </div>
          <div className="source-view-tabs" role="group" aria-label="자료 보기">
            <button type="button" className={!showSelectedSources ? 'active' : ''} aria-pressed={!showSelectedSources} disabled={isSending} onClick={() => setShowSelectedSources(false)}>전체</button>
            <button type="button" className={showSelectedSources ? 'active' : ''} aria-pressed={showSelectedSources} disabled={isSending} onClick={() => setShowSelectedSources(true)}>선택됨</button>
          </div>
          <SourceGroup
            title="원본 자료"
            count={`선택 ${selectedSourceGroupCount}`}
          >
            {pagedSourceGroups.length ? (
              <div className="source-document-list">
                {pagedSourceGroups.map((group) => (
                  <SourceItem
                    key={group.id}
                    icon={group.representative.scope === "private" ? "database" : "book"}
                    iconTone={
                      group.representative.scope === "private"
                        ? "sun"
                        : group.isResearchArchive
                          ? "stone"
                          : "mint"
                    }
                    title={documentDisplayTitle({ ...group.representative, title: group.title })}
                    meta={sourceRootMeta(group)}
                    checked={activeSelectionIds.has(group.id)}
                    disabled={isSending}
                    onToggle={() => toggleSource(group)}
                  />
                ))}
              </div>
            ) : (
              <EmptyCopy>
                {showSelectedSources
                  ? "선택한 자료가 없습니다. 전체에서 답변에 사용할 자료를 고르세요."
                  : sourceQuery
                  ? "검색 조건과 일치하는 자료가 없습니다."
                  : "사용할 수 있는 자료가 없습니다."}
              </EmptyCopy>
            )}
          </SourceGroup>
          {orderedSourceGroups.length > ADVISOR_SOURCE_PAGE_SIZE && (
            <nav className="source-pagination" aria-label="답변 근거 페이지">
              <button type="button" disabled={isSending || currentSourcePage <= 1} onClick={() => setSourcePage((current) => Math.max(1, current - 1))} aria-label="이전 자료 페이지"><Icon name="chevron" size={13} /></button>
              <span>{currentSourcePage} / {sourcePageCount}</span>
              <button type="button" disabled={isSending || currentSourcePage >= sourcePageCount} onClick={() => setSourcePage((current) => Math.min(sourcePageCount, current + 1))} aria-label="다음 자료 페이지"><Icon name="chevron" size={13} /></button>
            </nav>
          )}
          <div className="privacy-note">
            <Icon name="shield" size={15} />
            <p>
              선택한 원문 안에서 질문과 관련된 구간을 찾아 답변합니다. 페이지를 이동해도 선택 상태가 유지됩니다.
            </p>
          </div>
        </section>
        <section className={`conversation-panel ${mobilePane === 'chat' ? 'mobile-active' : ''}`}>
          <div className="conversation-context session-context">
            <button
              ref={sessionTriggerRef}
              type="button"
              className="session-trigger"
              aria-expanded={showSessions}
              aria-controls="advisor-session-drawer"
              onClick={() => showSessions ? closeSessionDrawer() : setShowSessions(true)}
            >
              <span className="session-trigger-icon"><Icon name="clock" size={16} /></span>
              <span className="session-trigger-copy">
                <b>{activeSession?.title ?? '새 대화'}</b>
                <small>{activeSession ? `${turns.length}개 조언 · 기록 저장됨` : '첫 질문을 보내면 기록됩니다'}</small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
            <div className="conversation-farm-context">
              <b>{farm.name}</b>
              <span>{selectedSourceGroupCount}개 자료 · {publicOnly ? '공개 지식' : '선택한 운영 근거'}</span>
            </div>
            <ProviderStatus publicOnly={publicOnly} execution={executionState} />
            <button type="button" className="new-session-button" disabled={isSending} onClick={startNewSession}>
              <span aria-hidden="true">+</span> 새 대화
            </button>
          </div>
          {showSessions && <>
            <button type="button" className="session-scrim" aria-label="대화 기록 닫기" onClick={closeSessionDrawer} />
            <aside ref={sessionDrawerRef} id="advisor-session-drawer" className="session-drawer" role="dialog" aria-modal="true" aria-labelledby="advisor-session-title">
              <header>
                <div><span className="panel-kicker">AI 재배 조언</span><h2 id="advisor-session-title">대화 기록</h2></div>
                <button type="button" className="icon-button" aria-label="대화 기록 닫기" onClick={closeSessionDrawer}><Icon name="close" size={17} /></button>
              </header>
              <button type="button" className="session-new-wide" disabled={isSending} onClick={startNewSession}><span aria-hidden="true">+</span><b>새 대화</b><small>별도의 운영 질문 시작</small></button>
              <label className="session-search">
                <span className="sr-only">대화 기록 검색</span>
                <Icon name="search" size={15} />
                <input ref={sessionSearchRef} value={sessionQuery} onChange={(event) => setSessionQuery(event.target.value)} placeholder="제목과 최근 내용 검색" />
              </label>
              {(sessionActionError || sessionError) && <div className="session-inline-error" role="alert">{sessionActionError || sessionError}</div>}
              <nav className="session-list" aria-label="AI 조언 기록">
                {sessionsLoading ? <div className="session-list-empty">대화 기록을 불러오는 중입니다.</div> : visibleSessions.length ? visibleSessions.map((session) => (
                  <div className={session.id === activeSessionId ? 'session-row active' : 'session-row'} key={session.id}>
                    {renamingSessionId === session.id ? (
                      <form className="session-rename" onSubmit={(event) => { event.preventDefault(); void submitSessionRename(session.id) }}>
                        <label><span className="sr-only">대화 이름</span><input value={renameTitle} maxLength={80} autoFocus onChange={(event) => setRenameTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenamingSessionId(null) } }} /></label>
                        <button type="submit" aria-label="이름 저장" disabled={!renameTitle.trim() || sessionActionBusy}><Icon name="check" size={14} /></button>
                        <button type="button" aria-label="이름 변경 취소" onClick={() => setRenamingSessionId(null)}><Icon name="close" size={14} /></button>
                      </form>
                    ) : deleteCandidateId === session.id ? (
                      <div className="session-delete-confirm"><span>이 대화를 삭제할까요?</span><button type="button" onClick={() => setDeleteCandidateId(null)}>취소</button><button type="button" className="danger" onClick={() => void confirmSessionDelete(session.id)}>삭제</button></div>
                    ) : <>
                      <button type="button" className="session-row-main" aria-current={session.id === activeSessionId ? 'page' : undefined} disabled={isSending} onClick={() => void selectSession(session.id)}>
                        <span><b>{session.title}</b><small>{operationalUiCopy(session.preview) || '아직 질문이 없습니다.'}</small></span>
                        <time dateTime={session.updatedAt}>{advisorSessionTime(session.updatedAt)}</time>
                      </button>
                      <div className="session-row-actions">
                        <button type="button" aria-label={`${session.title} 이름 바꾸기`} disabled={isSending} onClick={() => { setRenamingSessionId(session.id); setRenameTitle(session.title); setDeleteCandidateId(null) }}><Icon name="more" size={15} /></button>
                        <button type="button" aria-label={`${session.title} 삭제`} disabled={isSending} onClick={() => { setDeleteCandidateId(session.id); setRenamingSessionId(null) }}><Icon name="trash" size={14} /></button>
                      </div>
                    </>}
                  </div>
                )) : <div className="session-list-empty">{sessionQuery ? '검색 결과가 없습니다.' : '저장된 대화가 없습니다. 새 질문으로 시작하세요.'}</div>}
              </nav>
              <footer>{sessions.length}개 대화 · 질문과 근거가 이 기기에 연결된 운영 저장소에 보관됩니다.</footer>
            </aside>
          </>}
          {reviewMessage && <p className="source-selection-notice" role="status">{reviewMessage}</p>}
          <div className="message-list" aria-live="polite" aria-busy={isSending || reviewBusy}>
            {routeState.researchDiagnosticsOnly && <p role="status" className="source-selection-notice">검색 품질을 검토 중인 자문입니다. 제시된 원문 근거를 함께 확인하세요.</p>}
            {olderTurnCount > 0 && <button type="button" className="older-turns-toggle" aria-expanded={showOlderTurns} onClick={() => setShowOlderTurns((current) => !current)}>{showOlderTurns ? '이전 조언 접기' : `이전 조언 ${olderTurnCount}개 보기`} <Icon name="chevron" size={14} /></button>}
            {turns.length ? (
              displayedTurns.map((turn) => (
                <div className="advisor-turn" id={`advisor-turn-${turn.id}`} key={turn.id}>
                  <ChatBubble message={turn.userMessage} evidence={[]} approvals={approvals} activeAlertOccurrenceIds={activeAlertOccurrenceIds} scenarioPhase={scenarioState?.phase} scenarioId={scenarioState?.scenarioId} onCitation={() => undefined} controlDrafts={[]} toolTrace={null} agentRun={null} onReviewDraft={onReviewDraft} />
                  {turn.assistantMessage && (
                    <ChatBubble
                      message={turn.assistantMessage}
                      evidence={turn.evidence}
                      controlDrafts={turn.controlDrafts}
                      toolTrace={turn.toolTrace}
                      agentRun={turn.agentRun}
                      approvals={approvals}
                      activeAlertOccurrenceIds={activeAlertOccurrenceIds}
                      scenarioPhase={scenarioState?.phase}
                      scenarioId={scenarioState?.scenarioId}
                      onReviewDraft={onReviewDraft}
                      onCitation={(id) => {
                        onActiveTurnChange(turn.id);
                        setSelectedEvidenceId(id);
                        setMobilePane('evidence');
                      }}
                    />
                  )}
                  {turn.assistantMessage && turn.responseId && <button type="button" className="new-session-button" disabled={isSending || reviewBusy} onClick={() => void reviewAnswer(turn.responseId!)}>최신 관측으로 이 답변 재검토</button>}
                  {turn.status === 'loading' && (
                    <div className="thinking"><span /><span /><span /> 요청과 이전 대화를 확인하고 있어요</div>
                  )}
                  {turn.status === 'error' && (
                    <div className="advisor-error"><Icon name="x" size={15} /><div><b>답변을 만들지 못했습니다</b><span>{turn.error}</span></div></div>
                  )}
                </div>
              ))
            ) : (
              <AdvisorEmpty />
            )}
            {requestError && (
              <div className="advisor-error">
                <Icon name="x" size={15} />
                <div>
                  <b>답변을 만들지 못했습니다</b>
                  <span>{requestError}</span>
                </div>
              </div>
            )}
          </div>
          <div className="question-suggestions" aria-label="대화에 맞는 다음 질문">
            {advisorSuggestions(turns, selectedZone).map(suggestion => <button key={suggestion} disabled={isSending} onClick={() => void submitQuestion(suggestion)}>{suggestion}</button>)}
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submitQuestion();
            }}
          >
            <span className="composer-attach">
              <Icon name="search" size={19} />
            </span>
            <textarea
              id="advisor-composer"
              aria-description="질문은 1,000자까지 입력할 수 있습니다."
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submitQuestion();
                }
              }}
              placeholder="농장 상황이나 운영 판단을 물어보세요"
              rows={1}
            />
            <button
              type="submit"
              className="send-button"
              disabled={
                !question.trim() || isSending
              }
              aria-label="질문 보내기"
            >
              <Icon name="send" size={17} />
            </button>
            <span className="composer-hint">
              {isGeneralConversationQuestion(question, activeSourceIds.length > 0) ? '편하게 대화해 보세요 · Enter 전송' : isOperationalAdvisorQuestion(question) ? '현장 상태 확인 · Enter 전송' : '선택한 근거만 검색 · Enter 전송'}
            </span>
          </form>
        </section>
        <aside className={`evidence-rail ${mobilePane === 'evidence' ? 'mobile-active' : ''}`}>
          <div className="evidence-head">
            <div>
              <span>답변 근거</span>
              <b>{evidenceGroups.length}개 원본</b>
            </div>
          </div>
          {!activeTurnIsConversation && <RouteCard
            path={activeTurn?.assistantMessage?.searchPath ?? []}
            gateReason={activeTurn?.assistantMessage?.gateReason ?? '질문을 보내면 검색 상태가 표시됩니다.'}
            trace={routeState}
          />}
          <div className="evidence-list">
            {evidenceGroups.length ? (
              evidenceGroups.map((group, index) => (
                <button
                  key={group.id}
                  onClick={() => setSelectedEvidenceId(group.representative.id)}
                  className={
                    selectedEvidenceGroup?.id === group.id
                      ? "evidence-item selected"
                      : "evidence-item"
                  }
                >
                  <span className={`evidence-index ${group.representative.path.toLowerCase()}`}>
                    {index + 1}
                  </span>
                  <div>
                    <em>{group.representative.category}</em>
                    <b>{operationalUiCopy(group.title)}</b>
                    <p>{operationalUiCopy(group.representative.excerpt)}</p>
                    <small>
                      {group.passages.length === 1 ? group.representative.locator : `인용 구간 ${group.passages.length}개`} · 원본 #{index + 1}
                    </small>
                  </div>
                </button>
              ))
            ) : (
              <EmptyCopy>{emptyEvidenceCopy}</EmptyCopy>
            )}
          </div>
          {selectedEvidence && (
            <div className="evidence-preview">
              <div className="preview-kicker">
                <span>선택한 근거</span>
                {selectedEvidence.sourceUrl ? (
                  <a
                    href={selectedEvidence.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="원문 열기"
                  >
                    <Icon name="external" size={14} />
                  </a>
                ) : (
                  <Icon name="external" size={14} />
                )}
              </div>
              <b>{operationalUiCopy(selectedEvidenceGroup.title)}</b>
              {citationMeta(selectedEvidence) && (
                <small className="evidence-profile-meta">
                  {citationMeta(selectedEvidence)}
                </small>
              )}
              <div className="evidence-passages">
                {selectedEvidenceGroup.passages.map((passage, index) => (
                  <details key={passage.id} open={index === 0}>
                    <summary><span>인용 구간 {index + 1}</span><small>{passage.locator}</small></summary>
                    <p>“{operationalUiCopy(passage.excerpt)}”</p>
                  </details>
                ))}
              </div>
              {selectedEvidence.sourceUrl && (
                <a
                  className="evidence-source-link"
                  href={selectedEvidence.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  원문 보기 <Icon name="external" size={13} />
                </a>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function AdvisorEmpty() {
  return <div className="advisor-empty"><div className="assistant-avatar"><Icon name="sparkle" size={15} /></div><div><b>편하게 대화하거나 농장 운영을 물어보세요.</b><p>일상 대화는 바로 답하고, 재배 질문은 선택한 자료와 센서 상태를 확인해 답변합니다.</p></div></div>
}

function RouteCard(_props: { path: string[]; gateReason: string; trace: { runId: string | null; backend: string | null; candidateCount: number | null; returnedCount: number | null; queryScope: string | null; channels: string[] } }) {
  return <details className="route-card product-route"><summary><span><Icon name="shield" size={14} />답변 근거 확인</span><Icon name="chevron" size={13} /></summary><small>검색 경로와 실행 정보는 시스템 진단에서 확인할 수 있습니다.</small></details>
}

function SourceGroup({ title, count, children }: { title: string; count: string; children: React.ReactNode }) { return <section className="source-group"><div className="source-group-title"><span>{title}</span><em>{count}</em></div>{children}</section> }

function SourceItem({ icon, iconTone, title, meta, checked, disabled, onToggle }: { icon: IconName; iconTone: 'mint' | 'sun' | 'blue' | 'stone'; title: string; meta: string; checked: boolean; disabled: boolean; onToggle: () => void }) { return <button type="button" className={checked ? 'source-item active' : 'source-item'} aria-pressed={checked} disabled={disabled} onClick={onToggle}><span className={`source-icon ${iconTone}`}><Icon name={icon} size={15} /></span><div><b>{title}</b><small>{meta}</small></div><span className="source-check">{checked && <Icon name="check" size={12} />}</span></button> }

function ProviderStatus({ publicOnly, execution }: { publicOnly: boolean; execution: { provider: 'local' | 'llmgateway'; privacy: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'; model?: string | null; fallbackReason?: string | null } }) {
  const remote = execution.provider === 'llmgateway'
  const copy = remote ? 'AI 조언 연결됨' : execution.fallbackReason ? '근거 요약 모드' : publicOnly ? '공개 지식 모드' : '선택 근거 모드'
  const title = '상세 실행 정보는 시스템 진단에서 확인할 수 있습니다.'
  return <span className={remote ? 'provider-status remote' : 'provider-status'} title={title}><Icon name={remote ? 'sparkle' : 'shield'} size={13} />{copy}</span>
}

function agentRunStatusLabel(status: AdvisorAgentRun['status']) {
  return ({
    running: '상황을 확인하고 있습니다',
    awaiting_approval: '조정안 검토가 필요합니다',
    executing: '허용한 변경을 반영하고 있습니다',
    verifying: '변경 결과를 확인하고 있습니다',
    completed: '요청 확인을 마쳤습니다',
    failed: '진행을 완료하지 못했습니다',
  } as const)[status]
}

function agentStepLabel(step: AdvisorAgentRun['steps'][number]) {
  if (step.kind === 'planning') return '요청 확인'
  if (step.toolName === 'approve_control_proposal') return '변경 허용됨 · 장치 조정'
  if (step.kind === 'approval') return '조정안 준비'
  if (step.kind === 'verification') return '변경 결과 확인'
  if (step.toolName === 'search_knowledge_source_groups') return '관련 자료 검색'
  if (step.toolName === 'update_source_context') return '답변 자료 선택'
  if (step.toolName === 'get_sensor_timeseries' || /추세/.test(step.label)) return '추세 확인'
  if (step.toolName === 'list_alerts' || /경보|알림/.test(step.label)) return '경보 확인'
  if (step.toolName === 'get_farm_snapshot' || /상태|장치/.test(step.label)) return '현재 상태 확인'
  return step.kind === 'observation' ? '확인 결과 정리' : '현장 정보 확인'
}

function AgentRunProgress({ run, approval }: { run: AdvisorAgentRun | null; approval: Approval | null }) {
  if (!run) return null
  const steps = compactAdvisorSteps(run.steps, agentStepLabel)
  const verificationOutcome = approval?.verification?.outcome
  const effectiveStatus: AdvisorAgentRun['status'] = verificationOutcome === 'recovery_pending'
    ? 'verifying'
    : verificationOutcome === 'unrecovered'
    ? 'failed'
    : verificationOutcome === 'device_applied' || verificationOutcome === 'resolved'
    ? 'completed'
    : approval?.status === 'rejected'
      ? 'completed'
      : approval?.verification || approval?.status === 'failed'
      ? 'failed'
      : approval?.status === 'approved'
        ? 'verifying'
        : run.status
  const statusLabel = approval?.status === 'rejected'
    ? '조정하지 않았습니다'
    : verificationOutcome === 'recovery_pending'
      ? '환경 회복을 확인하고 있습니다'
      : verificationOutcome === 'unrecovered'
        ? '환경 회복이 확인되지 않아 현장 점검이 필요합니다'
      : verificationOutcome === 'resolved'
        ? '센서 정상 범위 복귀 · 문제 해결'
        : verificationOutcome === 'device_applied'
      ? '장치 반영을 확인했습니다'
      : approval?.verification?.status === 'mismatch'
        ? '현재 상태를 다시 확인해야 합니다'
        : approval?.verification?.status === 'unavailable'
          ? '변경 결과를 확인하지 못했습니다'
          : agentRunStatusLabel(effectiveStatus)
  return <section className={`agent-run-progress ${effectiveStatus}`} aria-label="AI 작업 진행 상태">
    <header>
      <div><small>작업 진행</small><b>{statusLabel}</b></div>
      {run.currentTarget && <span>{controlTargetLabel(run.currentTarget)}</span>}
    </header>
    {steps.length > 0 && <details className="agent-step-details" open={effectiveStatus !== 'completed'}><summary>확인 과정 · {steps.length}단계</summary><ol>{steps.map((step) => <li className={step.status} key={`${run.runId}:${step.sequence}`}>
      <span><Icon name={step.status === 'completed' ? 'check' : step.status === 'failed' ? 'x' : 'clock'} size={13} /></span>
      <div><b>{agentStepLabel(step)}</b><small>{step.status === 'completed' ? '완료' : step.status === 'failed' ? '확인 필요' : '진행 중'}</small></div>
    </li>)}</ol></details>}
  </section>
}

function ChatBubble({ message, evidence, controlDrafts, toolTrace, agentRun, approvals, activeAlertOccurrenceIds, scenarioPhase, scenarioId, onCitation, onReviewDraft }: { message: ChatMessage; evidence: Evidence[]; controlDrafts: ControlDraft[]; toolTrace: AdvisorToolTrace | null; agentRun: AdvisorAgentRun | null; approvals: Approval[]; activeAlertOccurrenceIds: string[]; scenarioPhase?: DemoScenarioState['phase']; scenarioId?: string; onCitation: (id: string) => void; onReviewDraft: (draft: ControlDraft) => void }) {
  if (message.role === 'user') return <div className="chat-user"><div>{message.content}</div><time>{message.createdAt}</time></div>
  const evidenceGroups = groupAnswerEvidence(evidence)
  const citedGroups = citedEvidenceGroups(evidenceGroups, message.evidenceIds ?? [])
  const conversational = toolTrace?.intent === 'conversation' && controlDrafts.length === 0
  const operationalTrace = toolTrace && toolTrace.intent !== 'knowledge' && !conversational
  const sourceContextRun = agentRun?.steps.some((step) => (
    step.toolName === 'search_knowledge_source_groups' || step.toolName === 'update_source_context'
  )) ?? false
  const evidenceFallback = operationalTrace
    ? toolTrace.status === 'unavailable'
      ? '현장 상태 확인이 완료되지 않아 장치 변경안을 만들지 않았습니다.'
      : '현재 상태는 연결된 센서와 장치에서 확인했습니다.'
    : '연결된 인용이 없습니다. 수치 조치는 적용 전에 원문을 확인하세요.'
  const agentApproval = agentRun ? approvals.find((proposal) => proposal.advisorRunId === agentRun.runId) ?? null : null
  return <article className="chat-assistant"><div className="assistant-avatar"><Icon name="sparkle" size={15} /></div><div className="assistant-body"><div className="assistant-label">{conversational ? 'AI' : 'AI 재배 조언'} <time>{message.createdAt}</time></div><AdvisorMarkdown content={operationalUiCopy(message.content)} />{!conversational && <><AgentRunProgress run={agentRun} approval={agentApproval} /><DeviceAvailabilityCard question={agentRun?.goal ?? ''} targets={controlDrafts.map((draft) => draft.target)} trace={toolTrace} observedBeforeChange={agentApproval?.status === 'approved'} />{citedGroups.length ? <div className="inline-citations">{citedGroups.map((group, index) => <button key={group.id} onClick={() => onCitation(group.representative.id)}><span>{index + 1}</span>{operationalUiCopy(group.title)}{group.passages.length > 1 && <small>{group.passages.length}개 구간</small>}</button>)}</div> : !sourceContextRun && <div className="citation-missing"><Icon name="shield" size={13} />{evidenceFallback}</div>}{controlDrafts.map((draft) => <AdvisorControlDraftCard key={draft.id} draft={draft} trace={toolTrace} approvals={approvals} activeAlertOccurrenceIds={activeAlertOccurrenceIds} scenarioPhase={scenarioPhase} scenarioId={scenarioId} onReview={() => onReviewDraft(draft)} />)}</>}</div></article>
}

function deviceStateForAdvisor(key: string, state: string | number | boolean) {
  const target = controlTargets.some((item) => item.value === key) ? key as ControlTarget : null
  if (!target || target === 'air_temperature_sensor_reset') return operationalStateText(state)
  return controlStateText(state, target)
}

function DeviceAvailabilityCard({ trace, question, targets, observedBeforeChange = false }: { trace: AdvisorToolTrace | null; question: string; targets: ControlTarget[]; observedBeforeChange?: boolean }) {
  if (!trace || trace.intent === 'conversation' || trace.intent === 'knowledge' || trace.status === 'not_required') return null
  const controllableCount = trace.devices.filter((device) => device.controllable).length
  const { focused, remaining } = advisorDeviceGroups(trace.devices, question, targets)
  const renderDevices = (devices: AdvisorToolTrace['devices']) => <div className="device-availability-grid">{devices.map((device) => <div className="device-availability-item" key={device.key}><div><b>{device.zoneId === 'zone-b' ? 'A동 2구역' : device.zoneId === 'zone-a' ? 'A동 1구역' : '구역 미확인'} · {device.label}</b><span>{observedBeforeChange ? '변경 전' : '조회 시점'} {deviceStateForAdvisor(device.target ?? device.key, device.state)}</span></div><small>{deviceAdjustmentRange(device)}</small></div>)}</div>
  const statusCopy = trace.status === 'completed'
    ? observedBeforeChange
      ? '장치를 바꾸기 전에 확인한 상태와 조정 범위입니다.'
      : '최신 장치 상태와 조정 범위를 확인했습니다.'
    : trace.status === 'fallback'
      ? '연결이 지연되어 확인 가능한 최신 상태를 표시합니다.'
      : '현재 장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.'
  return <section className={`device-availability ${trace.status}`} aria-label="사용 가능 장치 확인">
    <header className="device-availability-head"><span><Icon name={trace.status === 'unavailable' ? 'x' : 'check'} size={15} /></span><div><small>사용 가능 장치 확인</small><b>{trace.status === 'unavailable' ? '현장 연결 확인 필요' : `조정 가능 ${controllableCount}개 · 상태 확인 ${trace.devices.length}개`}</b></div></header>
    <p>{statusCopy}</p>
    {focused.length > 0 && renderDevices(focused)}
    {remaining.length > 0 && <details className="device-list-details"><summary>{focused.length ? '다른 장치' : '조회한 장치'} {remaining.length}개 보기</summary>{renderDevices(remaining)}</details>}
  </section>
}

function verificationValueText(value: string | number | boolean, target: ControlTarget) {
  return typeof value === 'string' ? operationalUiCopy(value) : controlValueText(value, target)
}

function ControlVerificationSummary({ verification, target }: { verification: ControlVerification | null; target: ControlTarget }) {
  if (!verification) return null
  const title = verification.outcome === 'device_pending'
    ? '장치 반영 확인 중'
    : verification.outcome === 'recovery_pending'
    ? '환경 회복 확인 중'
    : verification.outcome === 'unrecovered'
      ? '환경 회복 미확인 · 현장 점검 필요'
    : verification.outcome === 'resolved'
      ? '센서 정상 범위 복귀 · 문제 해결'
      : verification.outcome === 'device_applied'
        ? '장치 반영 확인 완료'
    : verification.status === 'mismatch'
      ? '당시 요청값과 확인값이 달랐습니다'
      : '변경 결과 확인이 필요합니다'
  const icon = verification.outcome === 'recovery_pending' ? 'clock' : verification.outcome === 'unrecovered' ? 'x' : verification.status === 'verified' ? 'check' : verification.status === 'mismatch' ? 'x' : 'clock'
  return <div className={`control-verification ${verification.status} ${verification.outcome}`}>
    <header><span><Icon name={icon} size={13} /></span><div><b>{title}</b><small>{formatDate(verification.checkedAt) ?? '확인 시각 미보고'}</small></div></header>
    <div className="control-verification-values"><span>요청 <b>{verificationValueText(verification.requestedValue, target)}</b></span><span>확인 <b>{verification.targetState ? operationalUiCopy(verification.targetState) : '상태 미보고'}</b></span></div>
    <p>{operationalUiCopy(verification.detail)}</p>
  </div>
}

function AdvisorControlDraftCard({ draft, trace, approvals, activeAlertOccurrenceIds, scenarioPhase, scenarioId, onReview }: { draft: ControlDraft; trace: AdvisorToolTrace | null; approvals: Approval[]; activeAlertOccurrenceIds: string[]; scenarioPhase?: DemoScenarioState['phase']; scenarioId?: string; onReview: () => void }) {
  const progress = controlProgressForDraft(draft, approvals, scenarioPhase, scenarioId, activeAlertOccurrenceIds)
  const device = trace?.devices.find((item) => item.target === draft.target && item.zoneId === draft.zoneId)
  const currentState = draft.beforeState ?? device?.state ?? '상태 미보고'
  const scope = draft.zoneId === 'zone-a' ? 'A동 1구역' : draft.zoneId === 'zone-b' ? 'A동 2구역' : '구역 미확인'
  const alertContext = draft.alertId
    ? controlDraftCanBeReviewed(draft, activeAlertOccurrenceIds) ? '현재 경보와 연결됨' : '종료된 경보의 기록'
    : '운영자 요청에서 준비됨'
  return <section className={`advisor-control-draft ${progress.stage}`}><div><div className="control-draft-heading"><span className="panel-kicker">AI 장치 조정안 · {scope}</span><span className={`control-progress ${progress.stage}`}>{progress.label}</span></div><b>{controlTargetLabel(draft.target)}</b><div className="control-draft-summary"><div><span>현재 상태</span><strong>{deviceStateForAdvisor(draft.target, currentState)}</strong></div><div><span>변경 내용</span><strong>{controlValueText(draft.value, draft.target)}</strong></div></div><div className="control-draft-impact"><span>예상 영향</span><p>{expectedControlImpact(draft.target, draft.value)}</p></div><p className="control-draft-reason">{operationalUiCopy(draft.rationale)}</p><small>{operationalUiCopy(progress.detail)} · {alertContext}</small><ControlVerificationSummary verification={progress.proposal?.verification ?? null} target={draft.target} /></div>{progress.stage === 'review' && <button onClick={onReview}>변경 검토 및 승인 <Icon name="chevron" size={14} /></button>}</section>
}

function Operations({
  approvals,
  activeAlertOccurrenceIds,
  auditEvents,
  actuators,
  metrics,
  telemetryByZone,
  thresholds,
  runtimeState,
  scenarios,
  scenarioState,
  derivedIndicators,
  incidents,
  clock,
  replayBusy,
  advisorTurn,
  proposalTransitions,
  activeControlTarget,
  selectedZone,
  onSelectedZoneChange,
  onApplyControl,
  onReplayFile,
  onOpenAdvisor,
}: {
  approvals: Approval[];
  activeAlertOccurrenceIds: string[];
  auditEvents: AuditEvent[];
  actuators: Actuator[];
  metrics: DashboardSnapshot['metrics'];
  telemetryByZone: DashboardSnapshot['telemetryByZone'];
  thresholds: CultivationStrategyThreshold[];
  runtimeState: RuntimeState;
  scenarios: DemoScenario[];
  scenarioState: DemoScenarioState | null;
  derivedIndicators: DashboardSnapshot['derivedIndicators'];
  incidents: DashboardSnapshot['incidents'];
  clock: DashboardSnapshot['clock'];
  replayBusy: boolean;
  advisorTurn: AdvisorTurn | null;
  proposalTransitions: Record<string, ProposalTransition>;
  activeControlTarget: string | null;
  selectedZone: ZoneSelection;
  onSelectedZoneChange: (zone: ZoneSelection) => void;
  onApplyControl: (control: ControlRequest) => Promise<ControlApplyOutcome>;
  onReplayFile: (file: File) => Promise<void>;
  onOpenAdvisor: () => void;
}) {
  const completed = approvals.filter((proposal) => proposal.status !== "waiting");
  const scenario = scenarios.find((item) => item.id === scenarioState?.scenarioId);
  const availableZones = [...new Set([...metrics.map((metric) => metric.zoneId), ...actuators.map((actuator) => actuator.zoneId)])].filter((zoneId): zoneId is 'zone-a' | 'zone-b' => zoneId === 'zone-a' || zoneId === 'zone-b')
  const metricsForView = selectedZone === 'all' ? metrics : metrics.filter((metric) => metric.zoneId === selectedZone)
  const trendPointsForView = selectedZone === 'all'
    ? []
    : synchronizeTelemetryLatest(telemetryByZone[selectedZone] ?? [], metricsForView)
  const indicatorsForView = selectedZone === 'all' ? derivedIndicators : derivedIndicators.filter((indicator) => indicator.zoneId === selectedZone)
  const incidentsForView = selectedZone === 'all' ? incidents : incidents.filter((incident) => incident.zoneId === null || incident.zoneId === selectedZone)
  const activeIncidentCount = incidentsForView.filter((incident) => incident.status !== 'resolved').length;
  return (
    <div className="page operations-page">
      <PageTitle
        eyebrow="현장 장치 운영"
        title="장치 · 작업"
        description="설정값과 현재 상태를 비교한 뒤 필요한 작업을 선택하세요."
        action={<DataBadge state={runtimeState} updatedAt="현재" />}
      />
      <div className="prototype-banner operations-truth-notice"><Icon name="shield" size={15} /><span><b>현장 장치 연결 전 · 시험 운전</b> · 변경 내용은 운영 기록에서 결과를 확인합니다.</span></div>
      <div className="operations-scenario-strip" role="status">
        <span className="scenario-dot" />
        <div><b>{scenario?.name ?? scenarioState?.scenarioId ?? '상황 미확인'}</b><small>원인: {scenarioCauseLabel(scenarioState?.scenarioId)} · {operationalUiCopy(scenario?.description ?? '장치와 센서 상태를 확인합니다.')}</small></div>
        <em title={scenarioState?.phaseStartedAt ? `단계 시작 ${formatTime(scenarioState.phaseStartedAt)}` : undefined}>{scenarioPhaseLabel(scenarioState?.phase)} · 경과 {formatScenarioElapsed(scenarioState?.elapsedSeconds)}</em>
      </div>
      <div className="operations-zone-context">
        <div><b>보기 범위</b><small>선택한 구역의 센서·장애·장치를 함께 봅니다. 전체는 보기 범위이며 일괄 실행이 아닙니다.</small></div>
        <div className="zone-switcher" role="group" aria-label="농장 운영 보기 범위">
          <button className={selectedZone === 'all' ? 'active' : ''} aria-pressed={selectedZone === 'all'} onClick={() => onSelectedZoneChange('all')}>전체 구역</button>
          {availableZones.map((zoneId) => <button key={zoneId} className={selectedZone === zoneId ? 'active' : ''} aria-pressed={selectedZone === zoneId} onClick={() => onSelectedZoneChange(zoneId)}>{zoneLabel(zoneId)}</button>)}
        </div>
      </div>
      <DeviceCardGrid actuators={actuators} approvals={approvals} selectedZone={selectedZone} activeControlTarget={activeControlTarget} onApplyControl={onApplyControl} />
      <details className="operations-detail-block">
        <summary><span className="operations-detail-icon"><Icon name="activity" size={17} /></span><span><small>운영 문맥</small><b>센서·장애·AI 기록</b><em>{activeIncidentCount ? `진행 중인 상황 ${activeIncidentCount}건` : '진행 중인 상황 없음'} · 필요할 때 펼쳐 확인</em></span><span className="operations-detail-toggle"><span className="show-open">펼쳐 보기</span><span className="show-close">접기</span><Icon name="chevron" size={14} /></span></summary>
        <div className="operations-context-body">{selectedZone !== 'all' && <ScenarioMetricStrip metrics={metricsForView} telemetryByZone={{ [selectedZone]: trendPointsForView }} zoneId={selectedZone} scenarioId={scenarioState?.scenarioId} scenarioIds={scenarioState?.scenarioIds} thresholds={thresholds} />}<DerivedIndicatorStrip indicators={indicatorsForView} metrics={metricsForView} /><OperationsRuntimePanel incidents={incidentsForView} clock={clock} replayBusy={replayBusy} onReplayFile={onReplayFile} /><AssistantDock turn={advisorTurn} activeAlertOccurrenceIds={activeAlertOccurrenceIds} onOpenAdvisor={onOpenAdvisor} /></div>
      </details>
      <details className="operations-detail-block">
        <summary><span className="operations-detail-icon"><Icon name="clock" size={17} /></span><span><small>처리 이력</small><b>최근 장치 변경과 운영 활동</b><em>최근 처리 {completed.length}건 · 전체 기록은 Log에서 확인</em></span><span className="operations-detail-toggle"><span className="show-open">펼쳐 보기</span><span className="show-close">접기</span><Icon name="chevron" size={14} /></span></summary>
        <div className="operations-tail">
          <section className="panel completed-section">
            <div className="panel-head"><div><span className="panel-kicker">실행 확인</span><h2>최근 처리 결과</h2></div><span className="history-chip">최근 4건</span></div>
            {completed.length ? completed.slice(0, 4).map((proposal) => <CompletedProposal proposal={proposal} key={proposal.id} transition={proposalTransitions[proposal.id]} currentState={actuatorForControl(actuators, proposal.target, proposal.zoneId)?.state ?? '상태 미보고'} scenarioPhase={scenarioState?.phase} scenarioId={scenarioState?.scenarioId} activeAlertOccurrenceIds={activeAlertOccurrenceIds} />) : <EmptyCopy>완료된 장치 변경이 없습니다.</EmptyCopy>}
          </section>
          <RecentActivity events={auditEvents} />
        </div>
      </details>
    </div>
  );
}

function OperationsRuntimePanel({ incidents, clock, replayBusy, onReplayFile }: { incidents: DashboardSnapshot['incidents']; clock: DashboardSnapshot['clock']; replayBusy: boolean; onReplayFile: (file: File) => Promise<void> }) {
  const active = incidents.filter((incident) => incident.status !== 'resolved')
  const statusLabel = (status: DashboardSnapshot['incidents'][number]['status']) => ({ open: '확인 필요', acknowledged: '확인됨', recovering: '회복 확인 중', resolved: '해결됨' } as const)[status]
  return <section className="operations-runtime-panel panel">
    <div className="panel-head"><div><span className="panel-kicker">운영 상태 검증</span><h2>장애 · 회복 기록</h2></div><span className="history-chip">{clock?.paused ? '일시 정지' : `${clock?.speed ?? 1}× 진행`}</span></div>
    <div className="runtime-panel-body">
      <div className="incident-compact-list">{active.length ? active.slice(0, 4).map((incident) => <article className={incident.status} key={incident.id}><span className={`incident-severity ${incident.severity}`} /><div><b>{incident.message}</b><small>{incident.zoneId === 'zone-b' ? '2구역' : '1구역'} · {formatDate(incident.lastObservedAt) ?? '시각 미보고'}</small></div><em>{statusLabel(incident.status)}</em></article>) : <div className="all-clear compact"><span><Icon name="check" size={16} /></span><div><b>진행 중인 장애가 없습니다</b><p>새 경보와 장치 회복 상태를 계속 확인합니다.</p></div></div>}</div>
      <div className="record-replay-card"><span className="record-replay-icon"><Icon name="upload" size={17} /></span><div><b>운영 기록 불러오기</b><small>CSV 또는 NDJSON 센서 기록을 같은 데이터 경로에서 재생합니다.</small></div><label className={replayBusy ? 'disabled' : ''}>{replayBusy ? '불러오는 중' : '파일 선택'}<input type="file" accept=".csv,.ndjson,application/x-ndjson,text/csv" disabled={replayBusy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void onReplayFile(file); event.currentTarget.value = '' }} /></label></div>
    </div>
  </section>
}

function isPercentageTarget(target: ControlTarget, actuators: Actuator[] = [], zoneId?: string | null) {
  const capability = actuatorForControl(actuators, target, zoneId)?.capability
  return capability ? capability.valueType === 'percentage' : controlTargets.find((item) => item.value === target)?.mode === 'percentage'
}

function actuatorControlValue(target: ControlTarget, actuators: Actuator[], zoneId?: string | null) {
  const actuator = actuatorForControl(actuators, target, zoneId)
  const state = actuator?.effectiveValue ?? actuator?.reportedValue ?? actuator?.state ?? ''
  if (isPercentageTarget(target, actuators, zoneId)) {
    const minimum = actuator?.capability?.minimum ?? 0
    const maximum = actuator?.capability?.maximum ?? 100
    const numeric = typeof state === 'number' ? state : Number.parseFloat(String(state));
    return Number.isFinite(numeric)
      ? Math.max(minimum, Math.min(maximum, numeric))
      : minimum;
  }
  return actuatorStateIsEnabled(state);
}

function ControlReviewDialog({ draft, actuators, busy, onDraftChange, onDecline, onCreateProposal }: { draft: ControlDraft; actuators: Actuator[]; busy: boolean; onDraftChange: (draft: ControlDraft | null) => void; onDecline: (draft: ControlDraft) => Promise<void>; onCreateProposal: (control: ControlRequest) => Promise<ControlApplyOutcome> }) {
  const actuator = actuatorForControl(actuators, draft.target, draft.zoneId)
  const percentage = isPercentageTarget(draft.target, actuators, draft.zoneId)
  const oneShot = draft.target === 'air_temperature_sensor_reset'
  const minimum = actuator?.capability?.minimum ?? 0
  const maximum = actuator?.capability?.maximum ?? 100
  const step = actuator?.capability?.step ?? 5
  const reviewValue = percentage ? normalizeRangeValue(Number(draft.value), minimum, maximum, step) : draft.value
  const currentState = draft.beforeState ?? actuator?.state ?? '상태 미보고'
  const [enableLabel, disableLabel] = controlToggleLabels(draft.target)
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onDraftChange(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onDraftChange])

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft.zoneId) return
    const rationaleLength = [...draft.rationale.trim()].length
    if (rationaleLength > 0 && (rationaleLength < 5 || rationaleLength > 500)) {
      setValidationError('조정 사유는 5~500자로 입력해 주세요.');
      return;
    }
    const provenance = draft.origin === 'verified_telemetry_rule' || (draft.origin === 'manual' && draft.advisorRunId) ? {
      origin: draft.origin,
      ...(draft.advisorRunId ? { advisorRunId: draft.advisorRunId } : {}),
      evidenceIds: draft.evidenceIds,
      ...(draft.origin === 'verified_telemetry_rule' ? {
        alertId: draft.alertId,
        alertOccurrenceId: draft.alertOccurrenceId,
      } : {}),
    } : {}
    void onCreateProposal({ requestId: draft.id, action: draft.action, target: draft.target, zoneId: draft.zoneId, value: reviewValue, rationale: draft.rationale.trim() || `${controlTargetLabel(draft.target)} ${controlValueText(reviewValue, draft.target)} 제안`, ...provenance });
  }
  function updateDraft(changes: Partial<Pick<ControlDraft, 'value' | 'rationale'>>) {
    setValidationError(null)
    onDraftChange({ ...draft, ...changes, id: crypto.randomUUID() })
  }
  return <div className="control-review-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onDraftChange(null) }}><section className="control-review-dialog" role="dialog" aria-modal="true" aria-labelledby="control-review-title" aria-busy={busy}>
    <header><div><span className="panel-kicker">{draft.origin === 'manual' ? '직접 조절' : 'AI 장치 조정안'} · {deviceScopeLabel(actuator ?? { zoneId: draft.zoneId })}</span><h2 id="control-review-title">{draft.origin === 'manual' ? '선택한' : 'AI가 제안한'} {controlTargetLabel(draft.target)} 조정을 허용하시겠습니까?</h2><p>허용하기 전 현재 상태와 바뀔 값을 확인하세요.</p></div><button className="icon-button" disabled={busy} onClick={() => onDraftChange(null)} aria-label="장치 조정 확인 닫기"><Icon name="close" size={18} /></button></header>
    <div className="control-permission"><Icon name="shield" size={17} /><div><b>조정안 확인 → 장치 반영 → 환경 변화 관찰</b><small>허용한 경우에만 선택한 장치가 변경됩니다.</small></div></div>
    <div className="state-journey" aria-label="장치 변경 순서"><div><span>현재</span><b>{draft.target === 'air_temperature_sensor_reset' ? operationalStateText(currentState) : controlStateText(currentState, draft.target)}</b></div><Icon name="chevron" size={16} /><div><span>바꿀 값</span><b>{controlValueText(reviewValue, draft.target)}</b></div><Icon name="chevron" size={16} /><div><span>결과</span><b>장치 반영 확인</b></div></div>
    <form className="draft-review-form" onSubmit={submit}>
      {validationError && <p role="alert">{validationError}</p>}
      {percentage ? <label><span>설정값 <b>{controlValueText(reviewValue, draft.target)}</b></span><input type="range" min={minimum} max={maximum} step={step} value={Number(reviewValue)} disabled={busy} onChange={(event) => updateDraft({ value: Number(event.target.value) })} /></label> : oneShot ? <div className="one-shot-action"><Icon name="refresh" size={17} /><div><b>센서 다시 맞추기</b><small>허용하면 온도 센서를 한 번 다시 맞춥니다.</small></div></div> : <fieldset className="control-toggle"><legend>설정값</legend><button type="button" className={draft.value === true ? 'active' : ''} disabled={busy} onClick={() => updateDraft({ value: true })}>{enableLabel}</button><button type="button" className={draft.value === false ? 'active' : ''} disabled={busy} onClick={() => updateDraft({ value: false })}>{disableLabel}</button></fieldset>}
      <label className="control-rationale"><span>조정 사유</span><input value={draft.rationale} maxLength={500} disabled={busy} onChange={(event) => updateDraft({ rationale: event.target.value })} /></label>
      {draft.evidenceIds.length > 0 && <div className="draft-provenance"><Icon name="book" size={14} />현재 관측과 답변 근거를 함께 확인했습니다.</div>}
      {!draft.zoneId && <div className="draft-provenance"><Icon name="shield" size={14} />조정할 구역을 확인할 수 없어 실행할 수 없습니다.</div>}
      <div className="draft-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void onDecline(draft)}>조정하지 않음</button><button type="submit" className="approve-button" disabled={busy || !draft.zoneId}>{busy ? '장치 변경 중' : deviceActionLabel(draft.target, reviewValue)}</button></div>
    </form>
  </section></div>
}

function AssistantDock({ turn, activeAlertOccurrenceIds, onOpenAdvisor }: { turn: AdvisorTurn | null; activeAlertOccurrenceIds: string[]; onOpenAdvisor: () => void }) {
  const alertDrafts = turn?.controlDrafts.filter((draft) => draft.alertId) ?? []
  const currentAlertLinked = alertDrafts.some((draft) => controlDraftCanBeReviewed(draft, activeAlertOccurrenceIds))
  const endedAlertRecord = alertDrafts.length > 0 && !currentAlertLinked
  const kicker = currentAlertLinked ? '현재 경보 AI 조언' : endedAlertRecord ? '지난 경보 AI 조언 기록' : '최근 AI 조언'
  const evidenceCount = groupAnswerEvidence(turn?.evidence ?? []).length
  const detail = currentAlertLinked
    ? `답변 근거 ${evidenceCount}개 · 현재 경보와 연결된 대화입니다.`
    : endedAlertRecord
      ? `답변 근거 ${evidenceCount}개 · 종료된 경보의 기록으로만 보관됩니다.`
      : `답변 근거 ${evidenceCount}개 · 대화와 근거가 그대로 유지됩니다.`
  return <section className={`assistant-dock panel${endedAlertRecord ? ' archived' : ''}`}><div className="assistant-avatar"><Icon name="sparkle" size={15} /></div><div><span className="panel-kicker">{kicker}</span>{turn?.assistantMessage ? <><b>{plainExcerpt(operationalUiCopy(turn.userMessage.content), 64)}</b><p>{plainExcerpt(operationalUiCopy(turn.assistantMessage.content))}</p><small>{detail}</small></> : <><b>아직 실행한 AI 조언이 없습니다.</b><p>재배 상황을 질문하면 이곳에 마지막 답변이 요약됩니다.</p></>}</div><button onClick={onOpenAdvisor}>{turn ? endedAlertRecord ? '지난 대화 열기' : '전체 대화 열기' : 'AI 재배 조언 열기'} <Icon name="chevron" size={14} /></button></section>
}

function twinValueText(value: number | boolean | null | undefined, target: ControlTarget | null, unit?: string | null) {
  if (value === null || value === undefined) return '미보고'
  if (target) return controlValueText(value, target)
  return `${String(value)}${unit ? ` ${unit}` : ''}`
}

function DeviceControlCard({ actuator, completed, activeControlTarget, onApplyControl }: { actuator: Actuator; completed?: Approval; activeControlTarget: string | null; onApplyControl: (control: ControlRequest) => Promise<ControlApplyOutcome> }) {
  const target = actuatorControlTarget(actuator)
  const percentage = target ? isPercentageTarget(target, [actuator], actuator.zoneId) : false
  const oneShot = target === 'air_temperature_sensor_reset'
  const minimum = actuator.capability?.minimum ?? 0
  const maximum = actuator.capability?.maximum ?? 100
  const step = actuator.capability?.step ?? 5
  const currentValue = target ? actuatorControlValue(target, [actuator], actuator.zoneId) : false
  const rangeSelection = percentage ? rangeSelectionForActuator(Number(currentValue), actuator.desiredValue, minimum, maximum, step) : null
  const selectableCurrentValue = rangeSelection?.value ?? currentValue
  const unchangedValue = rangeSelection?.needsApply ? currentValue : selectableCurrentValue
  const [value, setValue] = useState<number | boolean>(selectableCurrentValue)
  const [dirty, setDirty] = useState(rangeSelection?.needsApply ?? false)
  const requestId = useRef(crypto.randomUUID())
  const attemptedValue = useRef<number | boolean | null>(null)
  const deviceName = target ? controlTargetLabel(target) : actuator.label
  const rawCurrentDisplay = target && !oneShot
    ? percentage ? controlValueText(currentValue, target) : controlStateText(currentValue, target)
    : operationalStateText(actuator.state)
  const currentDisplay = deviceStateWithMode(actuator.mode, rawCurrentDisplay)
  const capability = actuator.capability?.action === 'recalibrate_air_temperature_sensor' ? '한 번 다시 맞추기' : actuator.capability?.valueType === 'percentage' ? `${minimum}–${maximum}% · ${step}% 단위` : actuator.capability?.valueType === 'boolean' ? '켜기 · 끄기' : '상태만 확인'
  const confirmation = completed?.status === 'approved' ? '변경 완료' : completed?.status === 'failed' ? '변경 실패' : completed?.status === 'rejected' ? '변경 없음' : '—'
  const lastChangeDisplay = completed ? operationalUiCopy(completed.requestedValue) : null
  const [enableLabel, disableLabel] = target ? controlToggleLabels(target) : ['켜기', '끄기']
  const icon: IconName = target?.includes('fan') || target?.includes('vent') ? 'wind' : target?.includes('irrigation') ? 'water' : target?.includes('chiller') ? 'thermometer' : target?.includes('curtain') ? 'sun' : 'sliders'
  const controllable = actuatorCanBeControlled(actuator)
  const busy = target !== null && activeControlTarget === controlIdentity(target, actuator.zoneId)
  const controlsLocked = activeControlTarget !== null
  const canRestartIrrigation = target === 'irrigation_pump' && currentValue === true && value === true
  const canApply = dirty || oneShot || canRestartIrrigation
  const hasTwinFeedback = actuator.desiredValue !== null && actuator.desiredValue !== undefined
    || actuator.reportedValue !== null && actuator.reportedValue !== undefined
    || actuator.effectiveValue !== null && actuator.effectiveValue !== undefined
  const healthLabel = ({ normal: '정상', degraded: '출력 저하', fault: '점검 필요', offline: '연결 끊김' } as const)[actuator.health ?? 'normal']
  const actionLabel = target ? deviceActionLabel(target, oneShot ? true : value) : '변경 내용 확인'

  useEffect(() => {
    if (dirty) {
      if (Object.is(value, unchangedValue)) {
        setDirty(false)
        if (attemptedValue.current !== null) {
          requestId.current = crypto.randomUUID()
          attemptedValue.current = null
        }
      }
      return
    }
    if (!Object.is(value, selectableCurrentValue)) setValue(selectableCurrentValue)
    if (rangeSelection?.needsApply) setDirty(true)
  }, [dirty, rangeSelection?.needsApply, selectableCurrentValue, unchangedValue, value])

  function selectValue(nextValue: number | boolean) {
    if (attemptedValue.current !== null && !Object.is(attemptedValue.current, nextValue)) {
      requestId.current = crypto.randomUUID()
      attemptedValue.current = null
    }
    setValue(nextValue)
    setDirty(!Object.is(nextValue, unchangedValue))
  }

  async function applyControl() {
    if (!target || !actuator.zoneId || controlsLocked || !canApply) return
    const action = target === 'air_temperature_sensor_reset' ? 'recalibrate_air_temperature_sensor' : actuator.capability?.action ?? 'set_actuator_state'
    const submittedValue = oneShot ? true : value
    attemptedValue.current = submittedValue
    const outcome = await onApplyControl({
      requestId: requestId.current,
      action,
      target,
      zoneId: actuator.zoneId,
      value: submittedValue,
      rationale: `${deviceName} 상태를 현장 운영자가 직접 조정했습니다.`,
    })
    if (outcome === 'ambiguous') return
    requestId.current = crypto.randomUUID()
    attemptedValue.current = null
    if (outcome === 'applied') setDirty(false)
  }

  return <article className="device-control-card panel">
    <header><span className="device-control-icon"><Icon name={icon} size={19} /></span><div><b>{deviceName}</b><small>{deviceScopeLabel(actuator)} · {capability}</small></div><div className="device-current-state"><i className={actuator.health && actuator.health !== 'normal' ? `health-${actuator.health}` : controllable ? 'ready' : ''}>{actuator.health && actuator.health !== 'normal' ? healthLabel : controllable ? '조정 가능' : '상태 확인'}</i><span>현재 <b>{currentDisplay}</b></span></div></header>
    {controllable ? <div className="device-direct-control"><span className="device-step-label">설정값</span>{percentage
      ? <label><span>설정할 값 <b>{controlValueText(Number(value), target ?? undefined)}</b></span><input aria-label={`${deviceName} 설정값`} type="range" min={minimum} max={maximum} step={step} value={Number(value)} disabled={controlsLocked} onChange={(event) => selectValue(Number(event.target.value))} /></label>
      : oneShot
        ? <div className="device-one-shot"><Icon name="refresh" size={16} /><span>온도 센서를 한 번 다시 맞춥니다.</span></div>
        : <fieldset className="device-toggle"><legend>설정할 상태</legend><button type="button" className={value === true ? 'active' : ''} disabled={controlsLocked} onClick={() => selectValue(true)}>{enableLabel}</button><button type="button" className={value === false ? 'active' : ''} disabled={controlsLocked} onClick={() => selectValue(false)}>{disableLabel}</button></fieldset>}</div>
      : <div className="device-readonly">{actuator.controllable && target && !actuator.zoneId ? '구역을 확인할 수 없어 조정할 수 없습니다.' : '상태 확인만 지원하는 장치입니다.'}</div>}
    {controllable && <><button aria-label={`${deviceName} 변경 내용 확인: ${actionLabel}`} disabled={controlsLocked || !canApply} onClick={() => void applyControl()}>{busy ? '변경 중' : canRestartIrrigation && !dirty ? '펌프 다시 켜기' : actionLabel}</button>{target === 'irrigation_pump' && <small className="device-adjust-note">펌프를 켜면 유량·압력·배지 수분의 회복을 확인할 수 있습니다.</small>}</>}
    <div className="device-result" aria-label={`${deviceName} 변경 결과`}>{completed ? <div className="device-last-change"><span>최근 결과</span><b>{lastChangeDisplay}</b><em>{confirmation}</em></div> : <span>변경 결과가 여기에 표시됩니다.</span>}</div>
    {hasTwinFeedback && <details className={`device-feedback-details ${actuator.health ?? 'normal'}`}><summary>변경 내용 확인 <span>{actuator.health && actuator.health !== 'normal' ? healthLabel : '정상'}</span></summary><div className="device-twin-feedback"><span>설정값 <b>{twinValueText(actuator.desiredValue, target, actuator.unit)}</b></span><span>현재 상태 <b>{twinValueText(actuator.reportedValue, target, actuator.unit)}</b></span><span>실제 출력 <b>{twinValueText(actuator.effectiveValue, target, actuator.unit)}</b></span></div></details>}
  </article>
}

function DeviceCardGrid({ actuators, approvals, selectedZone, activeControlTarget, onApplyControl }: { actuators: Actuator[]; approvals: Approval[]; selectedZone: ZoneSelection; activeControlTarget: string | null; onApplyControl: (control: ControlRequest) => Promise<ControlApplyOutcome> }) {
  const [category, setCategory] = useState<DeviceCategory>('all')
  const aBuildingActuators = actuators.filter((actuator) => !actuator.zoneId || actuator.zoneId === 'zone-a' || actuator.zoneId === 'zone-b')
  const visibleActuators = filterDevices(aBuildingActuators, category, selectedZone)
  const categories: Array<{ id: DeviceCategory; label: string }> = [{ id: 'all', label: '전체' }, { id: 'environment', label: '환경' }, { id: 'irrigation', label: '관수·양액' }, { id: 'ventilation', label: '환기' }, { id: 'sensor', label: '센서' }]
  const groupZones = selectedZone === 'all' ? ['zone-a', 'zone-b', null] as const : [selectedZone] as const
  const groups = groupZones.map((zoneId) => ({ zoneId, actuators: visibleActuators.filter((actuator) => (actuator.zoneId ?? null) === zoneId) })).filter((group) => group.actuators.length)
  const scope = selectedZone === 'all' ? '전체 구역' : zoneLabel(selectedZone)
  const categoryLabel = categories.find((item) => item.id === category)?.label
  return <section className="device-section"><div className="section-heading"><div><span className="panel-kicker">전체 농장 / 고설베드 A동 / {scope} / {categoryLabel}</span><h2>현재 상태와 설정값</h2></div><span>현재 상태 → 설정값 → 작업 → 결과</span></div><div className="device-category-filter" role="group" aria-label="장치 카테고리">{categories.map((item) => <button type="button" className={category === item.id ? 'active' : ''} aria-pressed={category === item.id} onClick={() => setCategory(item.id)} key={item.id}>{item.label}</button>)}</div><p className="device-filter-summary">{scope} · {categoryLabel} · 장치 {visibleActuators.length}개 · 전체 보기는 일괄 조정이 아닙니다.</p>{groups.length ? <div className="device-zone-groups">{groups.map((group) => <section className="device-zone-group" key={group.zoneId ?? 'unscoped'}><header><h3>{group.zoneId ? `A동 ${zoneLabel(group.zoneId)}` : '구역 미확인'}</h3><span>{group.actuators.length}개 · 개별 조정</span></header><div className="device-card-grid">{group.actuators.map((actuator) => { const target = actuatorControlTarget(actuator); const completed = target ? approvals.find((item) => item.status !== 'waiting' && sameControlScope(item, { target, zoneId: actuator.zoneId })) : undefined; return <DeviceControlCard actuator={actuator} completed={completed} activeControlTarget={activeControlTarget} onApplyControl={onApplyControl} key={actuator.key} /> })}</div></section>)}</div> : <EmptyCopy>선택한 구역과 카테고리에 연결된 장치가 없습니다.</EmptyCopy>}</section>
}

function CompletedProposal({ proposal, transition, currentState, scenarioPhase, scenarioId, activeAlertOccurrenceIds }: { proposal: Approval; transition?: ProposalTransition; currentState: string; scenarioPhase?: DemoScenarioState['phase']; scenarioId?: string; activeAlertOccurrenceIds: string[] }) {
  const sensorReset = proposal.target === 'air_temperature_sensor_reset'
  const matchingScenario = controlMatchesScenario(proposal.target, scenarioId, proposal.alertId)
  const alertStillActive = Boolean(
    proposal.alertOccurrenceId && activeAlertOccurrenceIds.includes(proposal.alertOccurrenceId),
  )
  const resolution = proposal.verification?.outcome === 'recovery_pending'
    ? '환경 회복 중'
    : proposal.verification?.outcome === 'unrecovered'
      ? '현장 점검 필요'
    : proposal.verification?.outcome === 'resolved'
      ? '문제 해결'
      : matchingScenario && scenarioPhase === 'recovery' ? '환경 회복 중' : matchingScenario && scenarioPhase === 'recovered' && !alertStillActive ? '문제 해결' : matchingScenario && scenarioPhase === 'recovered' ? '경보 지속' : null
  const verificationNeedsReview = proposal.verification?.outcome === 'unrecovered' || proposal.verification?.status === 'mismatch' || proposal.verification?.status === 'unavailable'
  const after = proposal.status === 'approved' ? resolution ?? (sensorReset ? '센서 다시 맞춤' : operationalStateText(currentState)) : proposal.status === 'rejected' ? '변경 없음' : '확인 필요';
  return <div className="completed-proposal-result"><div className="completed-summary"><span className={proposal.status === 'approved' && !verificationNeedsReview ? 'completed-icon approved' : 'completed-icon rejected'}><Icon name={proposal.status === 'approved' && !verificationNeedsReview ? 'check' : 'x'} size={14} /></span><div><b>{proposal.action}</b><small>{proposal.status === 'approved' ? verificationNeedsReview ? '변경 결과 확인 필요' : resolution ?? '장치 변경 완료' : proposal.status === 'failed' ? '변경 결과 확인 필요' : '취소되어 장치 변경 없음'}</small></div><time>{proposal.createdAt}</time></div><div className="state-journey compact"><div><span>변경 전</span><b>{transition?.before ?? '이전값 미기록'}</b></div><Icon name="chevron" size={14} /><div><span>요청</span><b>{transition?.requested ?? proposal.requestedValue}</b></div><Icon name="chevron" size={14} /><div><span>{resolution ? '환경 상태' : '변경 후'}</span><b>{after}</b></div></div><ControlVerificationSummary verification={proposal.verification} target={proposal.target} /></div>;
}

function RecentActivity({ events }: { events: AuditEvent[] }) {
  return <section className="panel recent-activity"><div className="panel-head"><div><span className="panel-kicker">최근 작업</span><h2>운영 활동</h2></div></div>{events.length ? events.slice(0, 5).map((event) => {
    const icon: IconName = event.eventType.includes('approved') ? 'check' : event.eventType.includes('rejected') ? 'x' : event.eventType.includes('advisor') ? 'sparkle' : 'activity';
    const summary = event.eventType.startsWith('cultivation_') ? '선택한 재배 회차에 저장되었습니다.' : event.eventType.includes('advisor') ? '근거 기반 조언을 확인했습니다.' : event.eventType.includes('scenario') ? '운영 조건이 변경되었습니다.' : '장치 변경 흐름에 기록되었습니다.';
    return <div className="human-activity" key={event.id}><span><Icon name={icon} size={15} /></span><div><b>{friendlyEventName(event.eventType)}</b><small>{summary}</small></div><time>{formatTime(event.createdAt)}</time></div>
  }) : <EmptyCopy>최근 작업 기록이 없습니다.</EmptyCopy>}</section>
}

type KnowledgeLoadOutcome = 'success' | 'failed' | 'superseded'
type KnowledgeRestoreOutcome = { error: string | null; documentCount: number | null }

function Knowledge({ farm, onAskWithSource }: { farm: Farm; onAskWithSource: (group: KnowledgeSourceGroup) => void }) {
  const pageSize = 6;
  const [visibility, setVisibility] = useState<KnowledgeVisibility>('public');
  const [activeCategory, setActiveCategory] = useState<KnowledgeCategory>('all');
  const [retrievalFilter, setRetrievalFilter] = useState<KnowledgeRetrievalFilter>('all');
  const [page, setPage] = useState(1);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [catalogDocuments, setCatalogDocuments] = useState<KnowledgeDocument[]>([]);
  const [recoverableSources, setRecoverableSources] = useState<KnowledgeRecoverableSourceGroup[]>([]);
  const [recoverableError, setRecoverableError] = useState<string | null>(null);
  const [recoverableCandidateId, setRecoverableCandidateId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [state, setState] = useState<RuntimeState>("unavailable");
  const [catalogState, setCatalogState] = useState<RuntimeState>("unavailable");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadCompletion, setUploadCompletion] = useState<KnowledgeUploadCompletion | null>(null);
  const [scope, setScope] = useState<Extract<KnowledgeScope, 'public' | 'private'>>("public");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [issuer, setIssuer] = useState("");
  const [publishedYear, setPublishedYear] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadDialog = useRef<HTMLDialogElement>(null);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
  const loadSequence = useRef(0);
  const appliedQueryRef = useRef("");

  useEffect(() => {
    if (!isUploadOpen) return;
    const dialog = uploadDialog.current;
    if (dialog && !dialog.open) dialog.showModal();
    window.setTimeout(() => fileInput.current?.focus(), 0);
    return () => {
      if (dialog?.open) dialog.close();
    }
  }, [isUploadOpen]);

  async function loadDocuments(nextQuery?: string): Promise<KnowledgeLoadOutcome> {
    const sequence = ++loadSequence.current;
    const normalizedQuery = (nextQuery ?? appliedQueryRef.current).trim();
    setIsSearching(true);
    const [result, catalogResult, recoverableResult] = await Promise.all([
      getKnowledge(farm.id, normalizedQuery),
      normalizedQuery ? getKnowledge(farm.id) : Promise.resolve(null),
      getRecoverableKnowledgeSourceGroups(farm.id)
        .then((data) => ({ data, error: null as string | null }))
        .catch((reason) => ({ data: null, error: reason instanceof Error ? operationalUiCopy(reason.message) : '최근 삭제한 자료를 확인하지 못했습니다.' })),
    ]);
    if (sequence !== loadSequence.current) return 'superseded';
    const fullCatalog = catalogResult?.data ?? result.data;
    const nextCatalogState = catalogResult?.state ?? result.state;
    setDocuments(result.data);
    setCatalogDocuments(fullCatalog);
    setState(result.state);
    setCatalogState(nextCatalogState);
    setError(result.error ?? catalogResult?.error ?? null);
    if (recoverableResult.data) {
      setRecoverableSources(recoverableResult.data);
      setRecoverableCandidateId((current) => current && recoverableResult.data?.some((source) => source.sourceGroupId === current) ? current : null);
    }
    setRecoverableError(recoverableResult.error);
    setIsSearching(false);
    return knowledgeLoadSucceeded(result.state, nextCatalogState) ? 'success' : 'failed';
  }

  useEffect(() => {
    setRecoverableSources([]);
    setRecoverableCandidateId(null);
    void loadDocuments(""); /* Initial list has no client-side fallback. */
    return () => { loadSequence.current += 1 }
  }, [farm.id]);

  const filtered = useMemo(
    () =>
      documents.filter((document) => knowledgeVisibility(document) === visibility && (activeCategory === 'all' || knowledgeCategory(document) === activeCategory)),
    [activeCategory, documents, visibility],
  );
  const groupedSources = useMemo(() => sortKnowledgeSourceGroups(groupKnowledgeSources(filtered)), [filtered]);
  const sourceGroups = useMemo(
    () => groupedSources.filter((group) => retrievalFilter === 'all' || knowledgeSourceRetrievalState(group.documents) === retrievalFilter),
    [groupedSources, retrievalFilter],
  );
  const filteredDocumentCount = useMemo(
    () => sourceGroups.reduce((total, group) => total + group.documents.length, 0),
    [sourceGroups],
  );
  const pageCount = Math.max(1, Math.ceil(sourceGroups.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleSourceGroups = sourceGroups.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const catalogForVisibility = useMemo(
    () => catalogDocuments.filter((document) => knowledgeVisibility(document) === visibility),
    [catalogDocuments, visibility],
  );
  const catalogSourceCount = useMemo(
    () => groupKnowledgeSources(catalogForVisibility).length,
    [catalogForVisibility],
  );
  const activeSourceCount = useMemo(
    () => groupKnowledgeSources(catalogDocuments.filter((document) => document.status === 'ready'))
      .filter((group) => knowledgeSourceRetrievalState(group.documents) === 'active').length,
    [catalogDocuments],
  );
  useEffect(() => {
    setPage((current) => Math.min(current, pageCount));
  }, [pageCount]);
  const categoryOptions: KnowledgeCategory[] = visibility === 'public'
    ? ['all', 'agronomy', 'research', 'reference']
    : ['all', 'operations', 'internal']
  const uploadFileIssue = selectedFile ? knowledgeUploadIssue(selectedFile, scope) : null;

  function closeUploadPanel() {
    if (busyId === 'upload') return;
    setIsUploadOpen(false);
    window.setTimeout(() => uploadTrigger.current?.focus(), 0);
  }

  function handleKnowledgeFileChange(file: File | null) {
    setSelectedFile(file);
    setTitle(file ? knowledgeUploadTitle(file) : "");
    setUploadError(null);
    setSuccess(null);
    setUploadCompletion(null);
  }
  async function handleSearch() {
    const normalizedQuery = query.trim();
    if ([...normalizedQuery].length > 160) {
      setError('검색어는 160자 이내로 입력해 주세요.');
      return;
    }
    appliedQueryRef.current = normalizedQuery;
    setPage(1);
    setAppliedQuery(normalizedQuery);
    setSuccess(null);
    await loadDocuments(normalizedQuery);
  }
  async function clearSearch() {
    setQuery("");
    appliedQueryRef.current = "";
    setAppliedQuery("");
    setPage(1);
    setSuccess(null);
    await loadDocuments("");
  }
  async function handleSeed() {
    setBusyId("seed");
    setSuccess(null);
    try {
      await seedKnowledge(farm.id);
      const outcome = await loadDocuments();
      if (outcome === 'failed') setError((current) => `기본 자료 등록은 완료됐지만 목록을 갱신하지 못했습니다. 중복 등록 전에 새로고침하세요.${current ? ` ${current}` : ''}`);
      else setSuccess("기본 자료 등록을 마쳤습니다.");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "시드 지식을 불러오지 못했습니다.",
      );
    } finally {
      setBusyId(null);
    }
  }
  async function handleUpload() {
    if (!selectedFile || busyId !== null) return;
    if (uploadFileIssue) {
      setUploadError(uploadFileIssue);
      return;
    }
    if (!title.trim()) {
      setUploadError('자료 제목을 확인해 주세요.');
      return;
    }
    setBusyId("upload");
    setSuccess(null);
    setUploadError(null);
    try {
      const result = await uploadKnowledge(farm.id, selectedFile, scope, {
        title,
        issuer,
        publishedYear,
        sourceUrl,
      });
      if (result.job?.status === 'failed') throw new Error('자료 내용을 확인하지 못했습니다. 파일 조건을 확인한 뒤 다시 시도해 주세요.');
      const registeredTitle = result.document ? documentDisplayTitle(result.document) : title.trim();
      const completion: KnowledgeUploadCompletion = {
        title: registeredTitle,
        scope,
        resultKind: result.job?.resultKind ?? 'unknown',
        status: result.job?.status ?? 'unknown',
        retrievalState: result.document?.retrievalState ?? null,
        sourceGroupId: result.document?.sourceGroupId ?? null,
        summary: result.document?.summary ?? null,
        chunkCount: result.document?.chunkCount ?? null,
      };
      setTitle("");
      setIssuer("");
      setPublishedYear("");
      setSourceUrl("");
      setSelectedFile(null);
      if (fileInput.current) fileInput.current.value = "";
      const outcome = await loadDocuments();
      if (outcome === 'failed') setError((current) => `“${registeredTitle}” 등록은 완료됐지만 목록을 갱신하지 못했습니다. 다시 등록하지 말고 먼저 새로고침하세요.${current ? ` ${current}` : ''}`);
      setUploadCompletion(completion);
      setIsUploadOpen(false);
      window.setTimeout(() => uploadTrigger.current?.focus(), 0);
    } catch (reason) {
      const detail = reason instanceof Error ? knowledgeUploadErrorCopy(operationalUiCopy(reason.message)) : "자료를 등록하지 못했습니다.";
      setUploadError(`자료를 등록하지 못했습니다. 선택한 파일과 입력 내용은 유지했습니다. ${detail}`);
    } finally {
      setBusyId(null);
    }
  }
  async function handleReindex(document: KnowledgeDocument) {
    setBusyId(document.id);
    setSuccess(null);
    try {
      await reindexKnowledge(farm.id, document.id);
      const outcome = await loadDocuments();
      if (outcome === 'failed') setError((current) => `재색인은 완료됐지만 목록을 갱신하지 못했습니다. 먼저 새로고침하세요.${current ? ` ${current}` : ''}`);
      else setSuccess(`“${documentDisplayTitle(document)}” 재색인을 시작했습니다.`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "재색인을 시작하지 못했습니다.",
      );
    } finally {
      setBusyId(null);
    }
  }
  async function handleDelete(document: KnowledgeDocument) {
    if (
      !window.confirm(
        `“${documentDisplayTitle(document)}”을(를) 지식 인덱스에서 제거할까요?`,
      )
    )
      return;
    setBusyId(document.id);
    setSuccess(null);
    try {
      await deleteKnowledge(farm.id, document.id);
      const outcome = await loadDocuments();
      if (outcome === 'failed') setError((current) => `자료 제거는 완료됐지만 목록을 갱신하지 못했습니다. 같은 작업을 반복하지 말고 먼저 새로고침하세요.${current ? ` ${current}` : ''}`);
      else setSuccess(`“${documentDisplayTitle(document)}”을 지식 자료에서 제거했습니다.`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "문서를 삭제하지 못했습니다.",
      );
    } finally {
      setBusyId(null);
    }
  }
  async function handleUpdateGroup(group: KnowledgeSourceGroup, changes: KnowledgeMetadataUpdate) {
    const busyKey = `metadata:${group.id}`;
    setBusyId(busyKey);
    setSuccess(null);
    setError(null);
    try {
      const updatedDocuments = await updateKnowledgeSourceGroupMetadata(farm.id, group.id, changes);
      if (!updatedDocuments.length) throw new Error("수정된 구성 자료를 확인하지 못했습니다.");
      const outcome = await loadDocuments();
      if (outcome === 'failed') setError((current) => `원본 정보는 저장됐지만 목록을 갱신하지 못했습니다. 다시 저장하지 말고 먼저 새로고침하세요.${current ? ` ${current}` : ''}`);
      else setSuccess(`“${changes.title.trim()}” 정보가 구성 자료 ${updatedDocuments.length}개에 함께 반영됐습니다.`);
      return true;
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : "자료 정보를 저장하지 못했습니다.";
      setError(`원본 정보를 수정하지 못했습니다. 변경 사항은 적용되지 않았습니다. ${detail}`);
      return false;
    } finally {
      setBusyId(null);
    }
  }
  async function handleRetrievalState(group: KnowledgeSourceGroup, nextState: Exclude<KnowledgeRetrievalState, 'needs_review'>) {
    const busyKey = `retrieval:${group.id}`;
    const displayTitle = documentDisplayTitle({ ...group.representative, title: group.title });
    const previousStates = new Map(group.documents.map((document) => [document.id, document.retrievalState]));
    const applyState = (items: KnowledgeDocument[], state: KnowledgeRetrievalState) => items.map((document) =>
      document.sourceGroupId === group.id ? { ...document, retrievalState: state } : document,
    );
    const restoreState = (items: KnowledgeDocument[]) => items.map((document) => {
      const previousState = previousStates.get(document.id);
      return previousState ? { ...document, retrievalState: previousState } : document;
    });
    setBusyId(busyKey);
    setSuccess(null);
    setError(null);
    setDocuments((items) => applyState(items, nextState));
    setCatalogDocuments((items) => applyState(items, nextState));
    try {
      const updatedDocuments = await updateKnowledgeRetrievalState(farm.id, group.id, nextState);
      if (updatedDocuments.length) {
        const updatedById = new Map(updatedDocuments.map((document) => [document.id, document]));
        const mergeUpdated = (items: KnowledgeDocument[]) => items.map((document) => updatedById.get(document.id) ?? document);
        setDocuments(mergeUpdated);
        setCatalogDocuments(mergeUpdated);
      }
      setSuccess(`“${displayTitle}”을 ${nextState === 'active' ? 'AI 답변에 사용합니다.' : 'AI 답변에서 제외했습니다.'}`);
    } catch (reason) {
      setDocuments(restoreState);
      setCatalogDocuments(restoreState);
      const detail = reason instanceof Error ? operationalUiCopy(reason.message) : '사용 상태를 바꾸지 못했습니다.';
      setError(`“${displayTitle}” 사용 상태를 바꾸지 못했습니다. 이전 상태를 유지합니다. ${detail}`);
    } finally {
      setBusyId(null);
    }
  }
  async function handleRestorePrevious(sourceGroupId: string, displayTitle: string): Promise<KnowledgeRestoreOutcome> {
    const busyKey = `restore:${sourceGroupId}`;
    setBusyId(busyKey);
    setSuccess(null);
    setError(null);
    try {
      const restoredDocuments = await restorePreviousKnowledgeRevision(farm.id, sourceGroupId);
      const replaceGroup = (items: KnowledgeDocument[]) => items.some((document) => document.sourceGroupId === sourceGroupId)
        ? [...items.filter((document) => document.sourceGroupId !== sourceGroupId), ...restoredDocuments]
        : items;
      setDocuments(replaceGroup);
      setCatalogDocuments(replaceGroup);
      const outcome = await loadDocuments();
      if (outcome === 'failed') setError((current) => `이전 내용은 복원했지만 목록을 다시 확인하지 못했습니다. 같은 작업을 반복하지 말고 먼저 새로고침하세요.${current ? ` ${current}` : ''}`);
      setRecoverableCandidateId((current) => current === sourceGroupId ? null : current);
      setSuccess(`“${displayTitle}” 원본 전체를 이전 내용으로 돌렸습니다. ${restoredDocuments.length ? `구성 자료 ${restoredDocuments.length}개가 함께 복원됐습니다.` : '복원한 이전판에는 구성 자료가 없습니다.'}`);
      return { error: null, documentCount: restoredDocuments.length };
    } catch (reason) {
      const detail = reason instanceof Error ? operationalUiCopy(reason.message) : '이전 내용으로 돌리지 못했습니다.';
      return { error: `이전 내용으로 돌리지 못했습니다. 현재 내용은 그대로 유지됩니다. ${detail}`, documentCount: null };
    } finally {
      setBusyId(null);
    }
  }
  async function handleRecoverableRestore(source: KnowledgeRecoverableSourceGroup) {
    if (busyId !== null) return;
    setRecoverableError(null);
    const outcome = await handleRestorePrevious(source.sourceGroupId, operationalUiCopy(source.title));
    if (outcome.error) setRecoverableError(`“${operationalUiCopy(source.title)}”을 되돌리지 못했습니다. ${outcome.error}`);
  }
  const selectedFileUsesExternalImageExtraction = Boolean(
    selectedFile
    && scope === 'public'
    && (selectedFile.type.startsWith('image/') || /\.(png|jpe?g)$/i.test(selectedFile.name)),
  );
  const uploadCompletionCopy = uploadCompletion ? knowledgeUploadCompletionCopy(uploadCompletion) : null;
  const uploadCompletionGroup = uploadCompletion?.sourceGroupId
    ? groupKnowledgeSources(catalogDocuments).find((group) => group.id === uploadCompletion.sourceGroupId) ?? null
    : null;

  return (
    <div className="page knowledge-page">
      <PageTitle
        eyebrow="운영 근거 라이브러리"
        title="지식 자료"
        description="재배에 참고할 PDF·문서·이미지를 추가하면 AI가 내용을 정리해 답변 근거로 사용합니다."
        action={<div className="knowledge-title-actions">
          {catalogState === 'connected' && catalogDocuments.length === 0 && <button className="primary-outline" onClick={handleSeed} disabled={busyId !== null}>
            <Icon name="database" size={16} />
            {busyId === "seed" ? "기본 자료를 불러오는 중" : "기본 자료 불러오기"}
          </button>}
          <button ref={uploadTrigger} className="knowledge-add-button" onClick={() => { setUploadError(null); setIsUploadOpen(true) }} disabled={busyId !== null}>
            <Icon name="upload" size={16} />
            자료 추가
          </button>
        </div>}
      />
      <div className="knowledge-toolbar">
        <div className="knowledge-filter-stack">
          <div className="knowledge-filter-primary">
            <div className="filter-tabs visibility-tabs" aria-label="지식 공개 범위">
              {(['public', 'private'] as const).map((item) => (
                <button
                  type="button"
                  className={visibility === item ? 'active' : ''}
                  aria-pressed={visibility === item}
                  key={item}
                  onClick={() => { setVisibility(item); setActiveCategory('all'); setPage(1) }}
                >
                  {item === 'public' ? '공개' : '비공개'}
                </button>
              ))}
            </div>
            <label className="knowledge-retrieval-filter">
              <span>답변 상태</span>
              <select value={retrievalFilter} onChange={(event) => { setRetrievalFilter(event.target.value as KnowledgeRetrievalFilter); setPage(1) }}>
                <option value="all">전체</option>
                <option value="needs_review">확인 필요</option>
                <option value="active">사용 중</option>
                <option value="paused">사용 제외</option>
              </select>
            </label>
          </div>
          <div className="filter-tabs category-tabs" aria-label={`${visibility === 'public' ? '공개' : '비공개'} 지식 하위 분류`}>
            {categoryOptions.map((category) => (
              <button type="button" className={activeCategory === category ? 'active' : ''} aria-pressed={activeCategory === category} key={category} onClick={() => { setActiveCategory(category); setPage(1) }}>
                {knowledgeCategoryLabel(category)}
              </button>
            ))}
          </div>
        </div>
        <div className="knowledge-search" role="search" aria-busy={isSearching}>
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); void handleSearch() }
            }}
            placeholder="제목·발행기관·문서 유형·요약 검색"
            aria-label="지식 자료 검색어"
            title="검색어는 160자 이내로 입력해 주세요"
          />
          {appliedQuery && <button type="button" className="knowledge-search-clear" disabled={isSearching} onClick={() => void clearSearch()} aria-label="검색 초기화"><Icon name="close" size={14} /></button>}
          <button type="button" disabled={isSearching} onClick={() => void handleSearch()} aria-label={isSearching ? "검색 중" : "검색"}>
            {isSearching ? <span className="button-spinner" aria-hidden="true" /> : <Icon name="search" size={14} />}
          </button>
        </div>
      </div>
      {uploadCompletion && uploadCompletionCopy && <section className={`knowledge-upload-completion ${uploadCompletion.resultKind}`} role="status">
        <span className="knowledge-upload-completion-icon"><Icon name={uploadCompletion.status === 'running' ? 'clock' : 'check'} size={17} /></span>
        <div><b>{uploadCompletionCopy.heading}</b><p>{uploadCompletionCopy.detail}</p>{uploadCompletion.summary && <small>{uploadCompletion.summary}{uploadCompletion.chunkCount ? ` · 본문 ${uploadCompletion.chunkCount}개 구간` : ''}</small>}</div>
        <div className="knowledge-upload-completion-actions">
          {uploadCompletionGroup && knowledgeSourceRetrievalState(uploadCompletionGroup.documents) === 'active' && <button type="button" className="knowledge-upload-ask" onClick={() => onAskWithSource(uploadCompletionGroup)}><Icon name="sparkle" size={13} />이 자료로 질문하기</button>}
          <button type="button" onClick={() => { setVisibility(uploadCompletion.scope); setActiveCategory('all'); setPage(1); setUploadCompletion(null); void clearSearch() }}>등록한 자료 보기</button>
          <button type="button" className="icon-button" onClick={() => setUploadCompletion(null)} aria-label="등록 결과 닫기"><Icon name="close" size={14} /></button>
        </div>
      </section>}
      {isUploadOpen && <dialog ref={uploadDialog} className="knowledge-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="knowledge-upload-title" aria-describedby="knowledge-upload-description" onCancel={(event) => { event.preventDefault(); closeUploadPanel() }}>
        <div className="knowledge-upload-drawer">
          <header>
            <div>
              <span className="panel-kicker">지식 자료</span>
              <h2 id="knowledge-upload-title">자료 추가</h2>
              <p id="knowledge-upload-description">재배에 참고할 파일을 등록하면 내용을 정리해 AI 답변 근거로 사용합니다.</p>
            </div>
            <button type="button" className="icon-button" disabled={busyId === 'upload'} onClick={closeUploadPanel} aria-label="자료 추가 닫기"><Icon name="close" size={18} /></button>
          </header>
          <form className="knowledge-upload" aria-busy={busyId === 'upload'} onSubmit={(event) => { event.preventDefault(); void handleUpload() }}>
            <section className="knowledge-upload-step">
              <div className="knowledge-upload-step-heading"><em>1</em><div><b>자료 파일 선택</b><small>먼저 등록할 파일을 선택해 주세요.</small></div></div>
              <label className="knowledge-upload-file">
                <input id="knowledge-upload" ref={fileInput} type="file" disabled={busyId !== null} accept=".txt,.md,.csv,.pdf,.png,.jpg,.jpeg" onChange={(event) => handleKnowledgeFileChange(event.target.files?.[0] ?? null)} />
                <span className="file-picker"><Icon name="upload" size={18} /><span><b>{selectedFile ? '다른 파일 선택' : '기기에서 파일 선택'}</b><small>PDF, TXT, MD, CSV, JPG, PNG</small></span></span>
              </label>
              <p className="knowledge-upload-conditions">문서는 12MB, 이미지는 10MB 이하를 지원합니다. PDF는 글자를 선택할 수 있는 텍스트 PDF, TXT·MD·CSV는 UTF-8 형식이어야 합니다. 파일 내용만 검색 자료로 저장하므로 원본 파일은 별도로 보관해 주세요.</p>
              {selectedFile && <div className={`knowledge-selected-file ${uploadFileIssue ? 'invalid' : ''}`} aria-live="polite">
                <Icon name={uploadFileIssue ? 'x' : 'check'} size={16} />
                <div><b>{selectedFile.name}</b><small>{selectedFile.size >= 1_048_576 ? `${(selectedFile.size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(selectedFile.size / 1024))} KB`}</small></div>
                <button type="button" disabled={busyId === 'upload'} onClick={() => { handleKnowledgeFileChange(null); if (fileInput.current) fileInput.current.value = "" }} aria-label={`${selectedFile.name} 선택 취소`}>선택 취소</button>
              </div>}
            </section>

            {selectedFile && <>
              <section className="knowledge-upload-step">
                <div className="knowledge-upload-step-heading"><em>2</em><div><b>표시 정보 확인</b><small>작업자가 찾을 제목과 사용할 범위를 확인합니다.</small></div></div>
                <div className="knowledge-upload-required-grid">
                  <label className="knowledge-upload-field">
                    <span className="knowledge-upload-label">표시 제목 <i>필수</i></span>
                    <input type="text" required value={title} disabled={busyId !== null} onChange={(event) => { setTitle(event.target.value); setUploadError(null) }} placeholder="자료 목록에 표시할 제목" />
                  </label>
                  <label className="knowledge-upload-field">
                    <span className="knowledge-upload-label">사용 범위 <i>필수</i></span>
                    <select value={scope} disabled={busyId !== null} onChange={(event) => { setScope(event.target.value as Extract<KnowledgeScope, 'public' | 'private'>); setUploadError(null) }} aria-label="등록할 지식 자료 공개 범위">
                      <option value="public">공개</option>
                      <option value="private">비공개</option>
                    </select>
                  </label>
                </div>
                <p className="knowledge-upload-scope-note"><Icon name={scope === 'private' ? 'shield' : 'book'} size={14} />{scope === 'public' ? '공개 자료는 모든 답변에서 근거로 사용할 수 있습니다.' : '비공개 자료는 이 농장의 내부 답변에만 사용합니다.'}</p>
                {uploadFileIssue && <p className="knowledge-upload-inline-error" role="alert"><Icon name="x" size={14} />{uploadFileIssue}</p>}
              </section>

              <details className="knowledge-upload-optional">
                <summary><span><b>출처 정보</b><small>발행기관·연도·원문 주소는 선택 사항입니다.</small></span><Icon name="chevron" size={15} /></summary>
                <div className="knowledge-upload-optional-grid">
                  <label className="knowledge-upload-field">
                    <span className="knowledge-upload-label">발행기관</span>
                    <input type="text" value={issuer} disabled={busyId !== null} onChange={(event) => { setIssuer(event.target.value); setUploadError(null) }} placeholder="예: 농촌진흥청" />
                  </label>
                  <label className="knowledge-upload-field">
                    <span className="knowledge-upload-label">발행연도</span>
                    <input type="number" min="1900" max="2100" value={publishedYear} disabled={busyId !== null} onChange={(event) => { setPublishedYear(event.target.value); setUploadError(null) }} placeholder="예: 2025" />
                  </label>
                  <label className="knowledge-upload-field knowledge-source-url">
                    <span className="knowledge-upload-label">원문 주소</span>
                    <input type="url" value={sourceUrl} disabled={busyId !== null} onChange={(event) => { setSourceUrl(event.target.value); setUploadError(null) }} placeholder="https://..." />
                  </label>
                </div>
              </details>

              <section className="knowledge-upload-review" aria-live="polite">
                <Icon name="check" size={17} />
                <div><b>등록 전 확인</b><small>{title.trim() || '제목 확인 필요'} · {knowledgeScopeLabel(scope)} · {selectedFile.name}</small>{selectedFileUsesExternalImageExtraction && <small className="knowledge-upload-ai-note">공개 이미지의 내용 추출에는 외부 AI 처리 경로가 사용될 수 있습니다.</small>}</div>
              </section>
            </>}

            {uploadError && <div className="knowledge-upload-error" role="alert"><Icon name="x" size={15} /><div><b>자료를 등록하지 못했습니다</b><p>{uploadError}</p></div></div>}
            <footer>
              <button type="button" className="knowledge-upload-cancel" disabled={busyId === 'upload'} onClick={closeUploadPanel}>취소</button>
              <button className="knowledge-upload-submit" type="submit" disabled={!selectedFile || !title.trim() || Boolean(uploadFileIssue) || busyId !== null}>{busyId === 'upload' ? '자료 내용을 확인하는 중' : '자료 등록'}</button>
            </footer>
          </form>
        </div>
      </dialog>}
      {error && (
        <div className="advisor-error knowledge-error" role="alert">
          <Icon name="x" size={15} />
          <div>
          <b>자료를 불러오지 못했습니다</b>
            <span>{error}</span>
          </div>
        </div>
      )}
      {success && <div className="knowledge-success" role="status"><Icon name="check" size={15} /><span>{success}</span><button type="button" onClick={() => setSuccess(null)} aria-label="등록 상태 알림 닫기"><Icon name="close" size={13} /></button></div>}
      {(recoverableSources.length > 0 || recoverableError) && <section className="knowledge-recently-deleted" aria-labelledby="knowledge-recently-deleted-title">
        <header><div><span className="knowledge-recently-deleted-icon"><Icon name="trash" size={15} /></span><div><b id="knowledge-recently-deleted-title">최근 삭제한 자료</b><small>농장에서 삭제한 원본을 다시 사용할 수 있습니다.</small></div></div>{recoverableSources.length > 0 && <span>{recoverableSources.length}개</span>}</header>
        {recoverableError && <div className="knowledge-recently-deleted-error" role="alert"><span>{recoverableError}</span><button type="button" disabled={isSearching || busyId !== null} onClick={() => void loadDocuments()}>다시 확인</button></div>}
        {recoverableSources.length > 0 && <div className="knowledge-recently-deleted-list">{recoverableSources.map((source) => {
          const restoring = busyId === `restore:${source.sourceGroupId}`
          const confirming = recoverableCandidateId === source.sourceGroupId
          return <article key={source.sourceGroupId}><div><b>{operationalUiCopy(source.title)}</b><small>삭제 전 {formatDate(source.previousRevision.createdAt) ?? '시간 미보고'} · 구성 자료 {source.previousRevision.documentCount}개</small></div>{confirming ? <div className="knowledge-recently-deleted-confirm"><span>이 자료를 다시 사용할 수 있게 되돌릴까요?</span><button type="button" disabled={restoring} onClick={() => setRecoverableCandidateId(null)}>취소</button><button type="button" className="restore" disabled={restoring} onClick={() => void handleRecoverableRestore(source)}>{restoring ? '되돌리는 중' : '되돌리기'}</button></div> : <button type="button" disabled={busyId !== null} onClick={() => { setRecoverableError(null); setRecoverableCandidateId(source.sourceGroupId) }}>되돌리기</button>}</article>
        })}</div>}
      </section>}
      <div className="knowledge-origin" role="status" aria-live="polite" aria-busy={isSearching}>
        <span className={`pulse ${state}`} />
        {isSearching
          ? "지식 자료를 찾는 중입니다."
          : state === "connected"
          ? `${appliedQuery ? `“${appliedQuery}” 검색 결과 ` : '현재 분류 '}${sourceGroups.length}개 원본 · ${filteredDocumentCount}개 구성 자료${catalogState === 'connected' ? ` · ${visibility === 'public' ? '공개' : '비공개'} 전체 ${catalogSourceCount}개 원본 · ${catalogForVisibility.length}개 구성 자료` : ' · 전체 수 확인 필요'}`
          : "문서 목록을 보장할 수 없습니다. fallback 문서는 표시하지 않습니다."}
      </div>
      <section className="knowledge-grid">
        {sourceGroups.length ? (
          visibleSourceGroups.map((group) => (
            <KnowledgeSourceCard
              group={group}
              farmId={farm.id}
              busyId={busyId}
              onReindex={(document) => void handleReindex(document)}
              onDelete={(document) => void handleDelete(document)}
              onUpdate={(changes) => handleUpdateGroup(group, changes)}
              onRetrievalStateChange={(state) => void handleRetrievalState(group, state)}
              onRestorePrevious={() => handleRestorePrevious(group.id, documentDisplayTitle({ ...group.representative, title: group.title }))}
              onAsk={() => onAskWithSource(group)}
              key={group.id}
            />
          ))
        ) : (
          <EmptyCopy>현재 필터에서 API가 반환한 문서가 없습니다.</EmptyCopy>
        )}
      </section>
      {pageCount > 1 && <nav className="knowledge-pagination" aria-label="지식 원본 페이지"><button disabled={currentPage === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}><Icon name="chevron" size={14} />이전</button><span>{currentPage} / {pageCount}</span><button disabled={currentPage === pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>다음<Icon name="chevron" size={14} /></button></nav>}
      <section className="ingestion-panel">
        <div className="ingest-icon">
          <Icon name="database" size={21} />
        </div>
        <div>
          <b>지식 처리 흐름</b>
          <p>
            자료 추가 → 내용 확인 → 검색 준비 → 답변 근거 연결. 공개 이미지는 내용
            확인 과정에서 외부 AI를 사용할 수 있습니다.
          </p>
        </div>
        <div className="ingest-status">
          <span>
            <i />
            전체 {activeSourceCount}개 자료 답변에 사용 중
          </span>
        </div>
      </section>
    </div>
  );
}

function KnowledgeSourceCard({ group, farmId, busyId, onReindex, onDelete, onUpdate, onRetrievalStateChange, onRestorePrevious, onAsk }: { group: KnowledgeSourceGroup; farmId: FarmId; busyId: string | null; onReindex: (document: KnowledgeDocument) => void; onDelete: (document: KnowledgeDocument) => void; onUpdate: (changes: KnowledgeMetadataUpdate) => Promise<boolean>; onRetrievalStateChange: (state: Exclude<KnowledgeRetrievalState, 'needs_review'>) => void; onRestorePrevious: () => Promise<KnowledgeRestoreOutcome>; onAsk: () => void }) {
  const documents = group.documents
  const representative = group.representative
  const [editingMetadata, setEditingMetadata] = useState(false)
  const [editTitle, setEditTitle] = useState(group.title)
  const [editIssuer, setEditIssuer] = useState(representative.issuer ?? '')
  const [editPublishedYear, setEditPublishedYear] = useState(representative.publishedYear ? String(representative.publishedYear) : '')
  const [editSourceUrl, setEditSourceUrl] = useState(representative.sourceUrl ?? '')
  const [editScope, setEditScope] = useState<'public' | 'private'>(representative.scope === 'public' ? 'public' : 'private')
  const [editError, setEditError] = useState<string | null>(null)
  const [previousRevision, setPreviousRevision] = useState<KnowledgePreviousRevision | null | undefined>(undefined)
  const [revisionLoading, setRevisionLoading] = useState(false)
  const [revisionError, setRevisionError] = useState<string | null>(null)
  const [restoreConfirming, setRestoreConfirming] = useState(false)
  const [restoreStarting, setRestoreStarting] = useState(false)
  const style = knowledgeVisibility(representative) === 'private' ? { icon: 'database' as IconName, tone: 'sun' } : { icon: 'book' as IconName, tone: 'mint' }
  const statusPriority: KnowledgeDocument['status'][] = ['failed', 'processing', 'queued', 'unknown', 'ready']
  const status = statusPriority.find((candidate) => documents.some((document) => document.status === candidate)) ?? 'unknown'
  const chunkCount = documents.reduce((total, document) => total + (document.chunkCount ?? 0), 0)
  const vectorCount = documents.reduce((total, document) => total + (document.vectorCount ?? 0), 0)
  const qdrantVectorCount = documents.reduce((total, document) => total + (document.qdrantVectorCount ?? 0), 0)
  const activeVectorCount = documents.some((document) => document.indexBackend === 'qdrant') ? qdrantVectorCount : vectorCount
  const indexStore = documents.some((document) => document.indexBackend === 'qdrant') ? 'Qdrant' : documents.some((document) => document.indexBackend === 'sqlite_fallback') ? '로컬 검색' : '저장소 확인 중'
  const counts = chunkCount || activeVectorCount ? [`본문 ${chunkCount}개 구간`, `활성 검색 인덱스 ${activeVectorCount}개`, `검색 저장소 ${indexStore}`].join(' · ') : '색인 통계를 준비 중입니다.'
  const profile = citationSourceMeta({ ...representative, evidenceClass: null })
  const applicability = knowledgeApplicability(representative)
  const summaryLabels = [...new Set(documents.map((document) => ({ extractive: '자동 추출', provided: '제공된 요약', llmgateway: 'AI 요약' })[document.summaryProvider]))]
  const embeddingModels = [...new Set(documents.map((document) => document.embeddingModel).filter(Boolean))]
  const updatedAt = documents.map((document) => document.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null
  const currentVersions = [...new Set(documents.map((document) => document.version).filter((value): value is string => Boolean(value)))]
  const sourceUrl = documents.find((document) => document.sourceUrl)?.sourceUrl
  const retrievalState = knowledgeSourceRetrievalState(documents)
  const retrievalBusy = busyId === `retrieval:${group.id}`
  const canAsk = retrievalState === 'active' && documents.some((document) => document.status === 'ready')
  const hasChecksum = documents.some((document) => Boolean(document.checksum))
  const metadataBusy = busyId === `metadata:${group.id}`
  const restoreBusy = restoreStarting || busyId === `restore:${group.id}`
  const synthetic = representative.scope === 'synthetic'
  const editable = isKnowledgeSourceOwnedByFarm(documents, farmId)
  const titleDocument = { ...representative, title: group.title }
  async function loadPreviousRevision(force = false) {
    if (!editable || revisionLoading || (!force && previousRevision !== undefined)) return
    setRevisionLoading(true)
    setRevisionError(null)
    try {
      setPreviousRevision(await getKnowledgePreviousRevision(farmId, group.id))
    } catch (reason) {
      const detail = reason instanceof Error ? operationalUiCopy(reason.message) : '이전 내용을 불러오지 못했습니다.'
      setRevisionError(`이전 내용을 불러오지 못했습니다. ${detail}`)
    } finally {
      setRevisionLoading(false)
    }
  }
  async function confirmRestorePrevious() {
    if (restoreBusy || !previousRevision) return
    setRestoreStarting(true)
    setRevisionError(null)
    const outcome = await onRestorePrevious()
    if (outcome.error) {
      setRevisionError(outcome.error)
      setRestoreStarting(false)
    } else if (outcome.documentCount !== 0) {
      setRestoreConfirming(false)
      setPreviousRevision(undefined)
      await loadPreviousRevision(true)
      setRestoreStarting(false)
    }
  }
  function openMetadataEditor() {
    setEditTitle(group.title)
    setEditIssuer(representative.issuer ?? '')
    setEditPublishedYear(representative.publishedYear ? String(representative.publishedYear) : '')
    setEditSourceUrl(representative.sourceUrl ?? '')
    setEditScope(representative.scope === 'public' ? 'public' : 'private')
    setEditError(null)
    setEditingMetadata(true)
  }
  async function submitMetadata(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const cleanedTitle = editTitle.trim()
    const year = editPublishedYear.trim() ? Number(editPublishedYear) : undefined
    if (cleanedTitle.length < 2) {
      setEditError('자료 제목은 두 글자 이상 입력하세요.')
      return
    }
    if (year !== undefined && (!Number.isInteger(year) || year < 1900 || year > 2100)) {
      setEditError('발행연도는 1900년부터 2100년 사이로 입력하세요.')
      return
    }
    setEditError(null)
    const saved = await onUpdate({
      title: cleanedTitle,
      ...(editIssuer.trim() ? { issuer: editIssuer.trim() } : {}),
      ...(year ? { publishedYear: year } : {}),
      ...(editSourceUrl.trim() ? { sourceUrl: editSourceUrl.trim() } : {}),
      ...(!synthetic ? { scope: editScope } : {}),
    })
    if (saved) setEditingMetadata(false)
    else setEditError('일부 구성 자료에 반영되지 않았습니다. 위 오류 내용을 확인하세요.')
  }
  return <article className="knowledge-card knowledge-source-card">
    <div className="knowledge-card-head"><span className={`knowledge-icon ${style.tone}`}><Icon name={style.icon} size={19} /></span><div className="knowledge-card-state"><span className={`knowledge-status ${status === 'ready' ? `retrieval-${retrievalState}` : status}`}>{status === 'ready' ? knowledgeRetrievalStateLabel(retrievalState) : knowledgeStatusLabel(status)}</span>{editable ? <label className="knowledge-retrieval-switch"><span>AI 답변에 사용</span><input type="checkbox" role="switch" checked={retrievalState === 'active'} disabled={busyId !== null || status !== 'ready'} aria-label={`${documentDisplayTitle(titleDocument)} AI 답변 사용`} onChange={() => onRetrievalStateChange(retrievalState === 'active' ? 'paused' : 'active')} /><i aria-hidden="true" />{retrievalBusy && <span className="sr-only" role="status">사용 상태 변경 중</span>}</label> : <span className="knowledge-retrieval-fixed"><Icon name="shield" size={12} />기본 자료</span>}</div></div>
    <em className="knowledge-classification">{knowledgeScopeLabel(representative.scope)} · {knowledgeCategoryLabel(knowledgeCategory(representative))}</em>
    <h2>{documentDisplayTitle(titleDocument)}</h2>
    {profile && <small className="knowledge-citation-meta">{profile}</small>}
    <div className="knowledge-topic-line" aria-label="다루는 내용"><b>다루는 내용</b><p className="knowledge-summary">{operationalUiCopy(knowledgeSourceTopicSummary(group))}</p></div>
    <div className="knowledge-card-foot"><div><button type="button" className="knowledge-ask-button" disabled={!canAsk || busyId !== null} onClick={onAsk}><Icon name="sparkle" size={13} />이 자료로 질문하기</button>{sourceUrl && <a className="knowledge-source-link" href={sourceUrl} target="_blank" rel="noreferrer">원문 보기 <Icon name="external" size={13} /></a>}{editable && <button type="button" className="knowledge-edit-trigger" disabled={busyId !== null} aria-expanded={editingMetadata} aria-controls={`metadata-editor-${group.id}`} onClick={() => editingMetadata ? setEditingMetadata(false) : openMetadataEditor()}>{editingMetadata ? '수정 닫기' : '정보 수정'}</button>}</div></div>
    {editable && editingMetadata && <form id={`metadata-editor-${group.id}`} className="knowledge-metadata-form" aria-busy={metadataBusy} onSubmit={(event) => void submitMetadata(event)}><div className="knowledge-metadata-heading"><b>원본 정보 수정</b><small>이 원본에 속한 구성 자료 {documents.length}개에 함께 반영합니다.</small></div><label><span>자료 제목</span><input required minLength={2} maxLength={200} value={editTitle} disabled={busyId !== null} onChange={(event) => setEditTitle(event.target.value)} /></label><label><span>발행기관</span><input maxLength={160} value={editIssuer} disabled={busyId !== null} onChange={(event) => setEditIssuer(event.target.value)} placeholder="비워두면 기존 값 유지" /></label><label><span>발행연도</span><input type="number" min="1900" max="2100" value={editPublishedYear} disabled={busyId !== null} onChange={(event) => setEditPublishedYear(event.target.value)} placeholder="비워두면 기존 값 유지" /></label><label className="knowledge-metadata-url"><span>원문 URL</span><input type="url" maxLength={2048} value={editSourceUrl} disabled={busyId !== null} onChange={(event) => setEditSourceUrl(event.target.value)} placeholder="비워두면 기존 값 유지" /></label>{synthetic ? <div className="knowledge-metadata-scope"><span>공개 범위</span><b>운영 기준 자료의 공개 범위는 변경할 수 없습니다.</b></div> : <label><span>공개 범위</span><select value={editScope} disabled={busyId !== null} onChange={(event) => setEditScope(event.target.value as 'public' | 'private')}><option value="public">공개</option><option value="private">비공개</option></select></label>}{editError && <p className="knowledge-metadata-error" role="alert">{editError}</p>}<div className="knowledge-metadata-actions"><button type="button" disabled={busyId !== null} onClick={() => setEditingMetadata(false)}>취소</button><button type="submit" disabled={busyId !== null || editTitle.trim().length < 2}>{metadataBusy ? '원본 정보 저장 중' : '원본 정보 저장'}</button></div></form>}
    <details className="knowledge-parts knowledge-source-details" onToggle={(event) => {
      if (event.currentTarget.open) void loadPreviousRevision(true)
      else setRestoreConfirming(false)
    }}><summary><span>{editable ? '자료 및 검색 정보 관리' : '자료 및 검색 정보'}</span><b>{documents.length}개</b><Icon name="chevron" size={14} /></summary><div className="knowledge-source-details-body">
      <section className="knowledge-source-overview" aria-label="자료 구성과 적용 범위">
        <b>자료 구성</b>
        <div className="knowledge-source-counts"><span>구성 자료 <b>{documents.length}개</b></span>{group.pageLabel && <span>{group.pageLabel}</span>}{!editable && <span className="knowledge-readonly-note"><Icon name="shield" size={13} />제공기관 원본 · 정보 수정 불가</span>}</div>
        {applicability.length > 0 && <div className="knowledge-applicability" aria-label="적용 범위"><b>적용 범위</b><div>{applicability.map((label) => <span key={label}>{label}</span>)}</div></div>}
      </section>
      {editable && <section className="knowledge-revision-summary" aria-label="내용 버전">
        <b>내용 버전</b>
        <div><span>현재 내용</span><p>{currentVersions.join(', ') || '버전 미보고'} · {formatDate(updatedAt) ?? '시간 미보고'} · 구성 자료 {documents.length}개</p></div>
        <div><span>이전 내용</span><p>{revisionLoading ? '이전 내용을 확인하는 중입니다.' : previousRevision ? `${previousRevision.versions.join(', ') || '버전 미보고'} · ${formatDate(previousRevision.createdAt) ?? '시간 미보고'} · 구성 자료 ${previousRevision.documentCount}개${previousRevision.changeSummary ? ` · ${operationalUiCopy(previousRevision.changeSummary)}` : ''}` : '아직 이전 내용이 없습니다'}</p></div>
        {revisionError && <div className="knowledge-revision-error" role="alert"><span>{revisionError}</span>{previousRevision === undefined && <button type="button" disabled={revisionLoading || restoreBusy} onClick={() => void loadPreviousRevision(true)}>다시 확인</button>}</div>}
        {previousRevision && !restoreConfirming && <button type="button" className="knowledge-revision-restore" disabled={busyId !== null || revisionLoading} onClick={() => { setRevisionError(null); setRestoreConfirming(true) }}>이전 내용으로 되돌리기</button>}
        {previousRevision && restoreConfirming && <div className="knowledge-revision-confirm" role="group" aria-label="이전 내용 복원 확인"><p><b>원본 전체를 되돌릴까요?</b><span>현재 구성 자료 {documents.length}개가 이전 내용으로 교체됩니다.</span></p><div><button type="button" disabled={restoreBusy} onClick={() => setRestoreConfirming(false)}>취소</button><button type="button" className="danger" disabled={restoreBusy} onClick={() => void confirmRestorePrevious()}>{restoreBusy ? '되돌리는 중' : '이전 내용으로 되돌리기'}</button></div></div>}
      </section>}
      <section className="knowledge-index-summary" aria-label="검색 준비 정보"><b>검색 준비 정보</b><span>최근 업데이트 · {formatDate(updatedAt) ?? '시간 미보고'}</span><span>{counts}</span><span>요약 방식 · {summaryLabels.join(', ')}</span><span>임베딩 모델 · {embeddingModels.join(', ') || '미보고'}</span><span>파일 지문 · {hasChecksum ? '기록됨' : '미보고'}</span></section><div className="knowledge-part-list">{documents.map((document) => {
      const busy = busyId === document.id
      return <article className="knowledge-part-row" key={document.id}><div><b>{documentDisplayTitle(document)}</b><small>{[document.sourceLocator, knowledgeStatusLabel(document.status)].filter(Boolean).join(' · ')}</small></div>{editable && <div><button type="button" disabled={busyId !== null} onClick={() => onReindex(document)} aria-label={`${documentDisplayTitle(document)} 재색인`}>재색인</button><button type="button" disabled={busyId !== null} onClick={() => onDelete(document)} aria-label={`${documentDisplayTitle(document)} 삭제`}><Icon name="trash" size={13} /></button>{busy && <span className="sr-only" role="status">처리 중</span>}</div>}</article>
    })}</div></div></details>
  </article>
}

const strategyMetricLabels: Record<string, string> = {
  air_temperature_c: '재배실 온도',
  relative_humidity_pct: '상대 습도',
  root_zone_temperature_c: '근권 온도',
  supply_ec_ds_m: '공급 EC',
  supply_ph: '공급 pH',
  substrate_moisture_pct: '배지 수분',
  irrigation_flow_l_min: '관수 유량',
}

function strategyMetricLabel(metric: string) {
  return strategyMetricLabels[metric] ?? operationalUiCopy(metric.replace(/_/g, ' '))
}

function gatewayStateLabel(state: GatewayStatus['state']) {
  return ({ not_connected: '현장 센서 연결 대기', ready: '현장 센서 수신 정상', degraded: '현장 센서 확인 필요', stale: '현장 센서 수신 지연', unavailable: '현장 센서 상태 미확인' } as const)[state]
}

function GatewayStatusPanel({ status }: { status: GatewayStatus | null }) {
  const attention = !status || !['ready', 'not_connected'].includes(status.state)
  const connected = Boolean(status && !['not_connected', 'unavailable'].includes(status.state))
  const received = status ? `${connected ? status.metricCount : '—'}/${status.expectedMetricCount || '—'}` : '—'
  const rejected = status?.rejectedMessageCount ?? 0
  return <section className={`panel gateway-operations-card ${attention ? 'attention' : ''}`}>
    <div className="panel-head"><div><span className="panel-kicker">현장 입력</span><h2>센서 연결 품질</h2></div><span className={`connection-state ${status?.state ?? 'unavailable'}`}><i />{gatewayStateLabel(status?.state ?? 'unavailable')}</span></div>
    <div className="gateway-quality-score"><div><strong>{connected && status ? `${status.completenessPercent.toFixed(1)}%` : '—'}</strong><span>필수 관측 완성도</span></div><div><strong>{received}</strong><span>최근 수락 항목</span></div></div>
    <div className="gateway-check-list">
      <div className={connected && status?.missingMetrics.length ? 'attention' : 'ok'}><span>누락</span><b>{connected && status ? `${status.missingMetrics.length}건` : '확인 전'}</b></div>
      <div className={status?.duplicateSensorMetrics ? 'attention' : 'ok'}><span>중복 거부</span><b>{status ? `${status.duplicateSensorMetrics}건` : '확인 전'}</b></div>
      <div className={status?.unitErrors ? 'attention' : 'ok'}><span>단위 거부</span><b>{status ? `${status.unitErrors}건` : '확인 전'}</b></div>
    </div>
    {rejected > 0 ? <p className="gateway-issue-copy"><b>최근 거부 {rejected}건</b> · {operationalUiCopy(status?.lastRejectionReason ?? '입력 형식을 확인하세요.')}{status?.lastRejectionAt ? ` · ${formatDate(status.lastRejectionAt)}` : ''}</p> : !connected ? <p className="gateway-issue-copy">현장 입력이 연결되면 필수 {status?.expectedMetricCount ?? 7}개 관측 항목의 누락·중복·표준 단위를 검사합니다.</p> : status?.missingMetrics.length ? <p className="gateway-issue-copy">최근 메시지에서 {status.missingMetrics.slice(0, 2).map((item) => strategyMetricLabel(item.split(':').at(-1) ?? item)).join(', ')}{status.missingMetrics.length > 2 ? ` 외 ${status.missingMetrics.length - 2}개` : ''}가 누락됐습니다.</p> : <p className="gateway-issue-copy">수락된 메시지는 중복 센서와 표준 단위 오류가 없습니다.</p>}
    <footer><span>{status?.source ? `입력 ${operationalUiCopy(status.source)}` : '현장 입력을 연결하면 품질을 판정합니다.'}</span><small>{status?.observedAt ? `${formatDate(status.observedAt)} 수신` : '최근 수신 없음'} · 상태 확인 전용</small></footer>
  </section>
}

function OperationKpiPanel({ metrics }: { metrics: OperationMetrics | null }) {
  const timings = [
    { label: '경보 확인', value: metrics?.acknowledgeMedianMinutes ?? null },
    { label: '변경 허용', value: metrics?.approvalMedianMinutes ?? null },
    { label: '환경 회복', value: metrics?.recoveryMedianMinutes ?? null },
  ]
  const max = Math.max(...timings.map((item) => item.value ?? 0), 1)
  const incidentCount = metrics?.incidentCount ?? 0
  const completedCount = (metrics?.resolvedCount ?? 0) + (metrics?.handoffCount ?? 0)
  const recoveryRate = metrics?.recoveryRatePercent ?? null
  return <section className="panel operations-kpi-panel">
    <div className="panel-head"><div><span className="panel-kicker">운영 성과</span><h2>감지에서 회복까지</h2></div><span className="history-chip">최근 {metrics?.windowHours ?? 168}시간</span></div>
    <div className="operations-kpi-grid">
      <div><span>기록된 상황</span><b>{incidentCount}</b>{incidentCount > 0 && <ProgressTrack label={`기록된 상황 ${incidentCount}건 중 처리 결과 ${completedCount}건`} value={completedCount} maximum={incidentCount} />}<small>사건 단위</small></div>
      <div><span>해결률</span><b>{recoveryRate == null ? '—' : `${recoveryRate.toFixed(1)}%`}</b>{recoveryRate != null && <ProgressTrack label={`운영 상황 해결률 ${recoveryRate.toFixed(1)}%`} value={recoveryRate} />}<small>해결 / 해결+현장 인계</small></div>
      <div className={metrics?.handoffCount ? 'attention' : ''}><span>현장 점검</span><b>{metrics?.handoffCount ?? 0}</b>{incidentCount > 0 && <ProgressTrack label={`기록된 상황 ${incidentCount}건 중 현장 점검 ${metrics?.handoffCount ?? 0}건`} value={metrics?.handoffCount ?? 0} maximum={incidentCount} />}<small>회복 미확인</small></div>
    </div>
    <div className="operations-duration-chart">{timings.map((item) => <div key={item.label}><span>{item.label}</span><i><em style={{ width: `${item.value == null ? 0 : Math.max(8, item.value / max * 100)}%` }} /></i><b>{item.value == null ? '기록 대기' : `${item.value.toFixed(1)}분`}</b></div>)}</div>
    <footer><span>{metrics ? `${metrics.lotId} · ${metrics.growthStage}` : '생산 구간 연결 대기'}</span><small>{metrics?.sourceGrain ?? '사건·조정안 기록에서 계산합니다.'}</small></footer>
  </section>
}

type StrategyWorkspaceProps = {
  strategies: CultivationStrategies | null
  busy: 'create' | 'apply' | 'rollback' | null
  onCreate: (input: { growthStage: string; thresholds: CultivationStrategyThreshold[]; evidenceSourceIds: string[]; changeNote: string }) => Promise<boolean>
  onApply: (versionId: string) => Promise<void>
  onRollback: () => Promise<void>
}

function StrategyWorkspace({ strategies, busy, onCreate, onApply, onRollback }: StrategyWorkspaceProps) {
  const active = strategies?.versions.find((item) => item.active) ?? null
  const candidates = strategies?.versions.filter((item) => !item.active) ?? []
  const [editing, setEditing] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [thresholds, setThresholds] = useState<CultivationStrategyThreshold[]>(active?.thresholds ?? [])
  useEffect(() => {
    if (!editing && active) setThresholds(active.thresholds.map((item) => ({ ...item })))
  }, [active, editing])
  const previousAvailable = Boolean(strategies?.history.slice(1).some((item) => item.versionId !== strategies.activeVersionId))
  const selected = candidates.find((item) => item.versionId === selectedVersionId) ?? null
  const changes = selected && active ? selected.thresholds.flatMap((next) => {
    const current = active.thresholds.find((item) => item.metric === next.metric)
    if (!current || current.lower !== next.lower || current.upper !== next.upper) return [{ metric: next.metric, before: current, after: next }]
    return []
  }) : []
  useEffect(() => {
    if (selectedVersionId && !candidates.some((item) => item.versionId === selectedVersionId)) setSelectedVersionId(null)
  }, [candidates, selectedVersionId])
  function updateThreshold(metric: string, bound: 'lower' | 'upper', raw: string) {
    setThresholds((items) => items.map((item) => item.metric === metric ? { ...item, [bound]: raw === '' ? null : Number(raw) } : item))
  }
  async function saveVersion() {
    if (!active || note.trim().length < 2) return
    const saved = await onCreate({
      growthStage: active.growthStage,
      thresholds,
      evidenceSourceIds: active.evidenceSourceIds,
      changeNote: note.trim(),
    })
    if (saved) {
      setEditing(false)
      setNote('')
    }
  }
  return <section className="panel strategy-workspace">
    <div className="panel-head"><div><span className="panel-kicker">운영 기준</span><h2>재배 전략 버전</h2></div>{active && <span className={`active-strategy-chip ${strategies?.sync.state ?? 'pending'}`}>{strategies?.sync.state === 'synced' ? '판정 서비스와 일치' : strategies?.sync.state === 'pending' ? '반영 확인 중' : strategies?.sync.state === 'failed' ? '반영 실패' : '기준 불일치'} · {active.versionId}</span>}</div>
    {active ? <>
      <div className="strategy-summary"><div><span>생육 단계</span><b>{active.growthStage}</b></div><div><span>판정 항목</span><b>{active.thresholds.length}개</b></div><div><span>연결 근거</span><b>{active.evidenceSourceIds.length}개</b></div></div>
      {!editing ? <>
        <div className="strategy-threshold-list">{active.thresholds.map((item) => <div key={item.metric}><span>{strategyMetricLabel(item.metric)}</span><b>{item.lower ?? '—'}–{item.upper ?? '—'} {item.unit}</b></div>)}</div>
        <div className="strategy-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => setEditing(true)}>기준 사본 만들기</button><button className="text-action" disabled={Boolean(busy) || !previousAvailable} onClick={() => void onRollback()}>{busy === 'rollback' ? '되돌리는 중' : '이전 기준으로 되돌리기'}</button></div>
      </> : <div className="strategy-editor">
        <p>현재 기준을 복제해 새 버전으로 저장합니다. 저장만으로 센서 판정은 바뀌지 않습니다.</p>
        <div className="strategy-edit-grid">{thresholds.map((item) => <div key={item.metric}><b>{strategyMetricLabel(item.metric)}</b><label><span>하한</span><input type="number" step="0.1" value={item.lower ?? ''} onChange={(event) => updateThreshold(item.metric, 'lower', event.target.value)} /></label><label><span>상한</span><input type="number" step="0.1" value={item.upper ?? ''} onChange={(event) => updateThreshold(item.metric, 'upper', event.target.value)} /></label><em>{item.unit}</em></div>)}</div>
        <label className="strategy-note"><span>변경 이유</span><input value={note} maxLength={500} placeholder="예: 현장 검토를 위한 온도 상한 조정" onChange={(event) => setNote(event.target.value)} /></label>
        <div className="strategy-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => setEditing(false)}>취소</button><button className="approve-button" disabled={Boolean(busy) || note.trim().length < 2} onClick={() => void saveVersion()}>{busy === 'create' ? '저장 중' : '새 버전 저장'}</button></div>
      </div>}
      {strategies?.sync.lastError && <p className="strategy-sync-error">{operationalUiCopy(strategies.sync.lastError)}</p>}
      <div className="strategy-version-list">{candidates.map((item) => <div className={selectedVersionId === item.versionId ? 'selected' : ''} key={item.versionId}><button className="strategy-version-select" onClick={() => setSelectedVersionId((value) => value === item.versionId ? null : item.versionId)}><b>{item.versionId}</b><small>{item.changeNote} · {formatDate(item.createdAt)}</small></button><button disabled={Boolean(busy)} onClick={() => setSelectedVersionId(item.versionId)}>비교</button></div>)}</div>
      {selected && <div className="strategy-diff"><header><div><span>변경 전후 확인</span><b>{selected.versionId}</b></div><button className="icon-button" aria-label="운영 기준 비교 닫기" onClick={() => setSelectedVersionId(null)}><Icon name="close" size={15} /></button></header><p>{selected.changeNote}</p>{changes.length ? <div>{changes.map((change) => <div key={change.metric}><span>{strategyMetricLabel(change.metric)}</span><del>{change.before ? `${change.before.lower ?? '—'}–${change.before.upper ?? '—'} ${change.before.unit}` : '현재 항목 없음'}</del><Icon name="chevron" size={12} /><b>{change.after.lower ?? '—'}–{change.after.upper ?? '—'} {change.after.unit}</b></div>)}</div> : <EmptyCopy>판정 범위 변경은 없고 설명 또는 근거만 달라집니다.</EmptyCopy>}<footer><span>연결 근거 {selected.evidenceSourceIds.length}개 · 적용 후 즉시 판정 기준으로 사용</span><button className="approve-button" disabled={Boolean(busy)} onClick={() => void onApply(selected.versionId)}>{busy === 'apply' ? '반영 확인 중' : '이 기준 적용'}</button></footer></div>}
    </> : <EmptyCopy>운영 기준을 불러오지 못했습니다. 연결 상태를 확인하세요.</EmptyCopy>}
  </section>
}

type ProductionHistoryProps = {
  auditEvents: AuditEvent[]
  operationCases: OperationCase[]
  operationMetrics: OperationMetrics | null
  gatewayStatus: GatewayStatus | null
  strategies: CultivationStrategies | null
  strategyBusy: 'create' | 'apply' | 'rollback' | null
  acknowledgingIncidentId: string | null
  inputMode: DashboardSnapshot['inputMode']
  onCreateStrategy: StrategyWorkspaceProps['onCreate']
  onApplyStrategy: StrategyWorkspaceProps['onApply']
  onRollbackStrategy: StrategyWorkspaceProps['onRollback']
  onAcknowledgeCase: (record: OperationCase) => Promise<void>
  onOpenCase: (record: OperationCase) => void
  onPrintCase: (record: OperationCase) => void
}

function ProductionHistory({ auditEvents, operationCases, operationMetrics, gatewayStatus, strategies, strategyBusy, acknowledgingIncidentId, inputMode, onCreateStrategy, onApplyStrategy, onRollbackStrategy, onAcknowledgeCase, onOpenCase, onPrintCase }: ProductionHistoryProps) {
  const records = sortOperationCases(operationCases)
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'resolved' | 'handoff'>('all')
  const [page, setPage] = useState(1)
  const handoffCount = records.filter((record) => record.status === 'handoff').length
  const activeCount = records.filter((record) => !['resolved', 'handoff'].includes(record.status)).length
  const resolvedCount = records.filter((record) => record.status === 'resolved').length
  const filteredRecords = records.filter((record) => {
    if (statusFilter === 'all') return true
    if (statusFilter === 'active') return !['resolved', 'handoff'].includes(record.status)
    return record.status === statusFilter
  })
  const pageSize = 6
  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / pageSize))
  const visibleRecords = filteredRecords.slice((page - 1) * pageSize, page * pageSize)
  const groupedRecords = visibleRecords.reduce<Array<{ label: string; records: OperationCase[] }>>((groups, record) => {
    const label = operationCaseDateGroup(record.openedAt)
    const current = groups.at(-1)
    if (current?.label === label) current.records.push(record)
    else groups.push({ label, records: [record] })
    return groups
  }, [])
  useEffect(() => setPage(1), [statusFilter])
  useEffect(() => { if (page > pageCount) setPage(pageCount) }, [page, pageCount])
  const latestEvents = auditEvents.filter((event) => /control|advisor|scenario/.test(event.eventType)).slice(0, 8)
  const activeStrategy = strategies?.versions.find((item) => item.active) ?? null
  return <div className="page history-page">
    <PageTitle eyebrow="운영 일지" title="Log" description="오늘 발생한 상황과 처리 결과를 사건 단위로 확인합니다." action={<TruthBadge mode={inputMode} />} />
    <div className="case-summary-grid">
      <div className={handoffCount ? 'attention' : ''}><span>현장 점검 필요</span><b>{handoffCount}</b><small>회복 미확인 또는 장치 상태 불일치</small></div>
      <div><span>진행 중</span><b>{activeCount}</b><small>확인·허용·회복 관찰 단계</small></div>
      <div><span>해결됨</span><b>{resolvedCount}</b><small>센서 정상 범위 복귀 확인</small></div>
    </div>
    <section className="panel case-list-panel">
      <div className="panel-head"><div><span className="panel-kicker">사건 단위 기록</span><h2>상황과 처리 결과</h2></div>{records[0] && <button className="text-action" onClick={() => onPrintCase(records[0])}>최근 기록 출력 <Icon name="external" size={13} /></button>}</div>
      <div className="case-list-toolbar" role="group" aria-label="운영 기록 상태 필터">{([{ id: 'all', label: '전체', count: records.length }, { id: 'active', label: '진행 중', count: activeCount }, { id: 'resolved', label: '해결됨', count: resolvedCount }, { id: 'handoff', label: '현장 점검', count: handoffCount }] as const).map((item) => <button className={statusFilter === item.id ? 'active' : ''} onClick={() => setStatusFilter(item.id)} key={item.id}>{item.label}<span>{item.count}</span></button>)}</div>
      {groupedRecords.length ? <div className="operation-case-groups">{groupedRecords.map((group, groupIndex) => <section className="operation-case-group" key={`${group.label}-${groupIndex}`}>
        <div className="case-date-divider"><span>{group.label}</span><small>{group.records.length}건</small></div>
        <div className="operation-case-list">{group.records.map((record) => <article className={`operation-case-card ${record.status}`} key={record.id}>
          <header><div className="case-card-status"><em>{operationCaseStatusLabel(record.status)}</em><time>{formatTime(record.openedAt)}</time></div><h3>{operationalUiCopy(record.title)}</h3><p>{record.zoneId === 'zone-b' ? '2구역' : '1구역'} · {formatDate(record.openedAt) ?? '발생 시각 미보고'}</p></header>
          <p className="case-result-summary">{operationalUiCopy(operationCaseSummary(record))}</p>
          {record.status === 'resolved'
            ? <details className="case-progress-details"><summary>완료 과정 보기 <Icon name="chevron" size={13} /></summary><ol className="case-progress" aria-label={`${operationalUiCopy(record.title)} 처리 단계`}>{operationCaseProgress(record).map((step) => <li className={step.state} key={step.id}><span /><b>{step.label}</b></li>)}</ol></details>
            : <ol className="case-progress" aria-label={`${operationalUiCopy(record.title)} 처리 단계`}>{operationCaseProgress(record).map((step) => <li className={step.state} key={step.id}><span /><b>{step.label}</b></li>)}</ol>}
          <footer><span>근거 {groupOperationCaseEvidence(record.evidence).length}개 · 장치 조정 {record.actions.length}건</span><div>{!record.acknowledgedAt && record.status !== 'resolved' && <button disabled={Boolean(acknowledgingIncidentId)} onClick={() => void onAcknowledgeCase(record)}>{acknowledgingIncidentId === record.incidentId ? '반영 중' : '경보 확인'}</button>}<button className="case-detail-button" onClick={() => onOpenCase(record)}>처리 과정 보기 <Icon name="chevron" size={13} /></button></div></footer>
        </article>)}</div>
      </section>)}</div> : <EmptyCopy>{records.length ? '선택한 상태의 운영 기록이 없습니다.' : '경보가 발생하면 근거와 장치 변경 결과가 사건 단위로 여기에 기록됩니다.'}</EmptyCopy>}
      {filteredRecords.length > pageSize && <div className="case-pagination"><button disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>이전</button><span>{page} / {pageCount}</span><button disabled={page === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>다음</button></div>}
    </section>
    <OperationKpiPanel metrics={operationMetrics} />
    <details className="log-context-details">
      <summary><span className="log-context-icon"><Icon name="settings" size={17} /></span><span><small>운영 상태</small><b>센서 연결과 재배 기준</b><em>{gatewayStateLabel(gatewayStatus?.state ?? 'unavailable')} · {activeStrategy ? '재배 기준 적용 중' : '재배 기준 확인 필요'}</em></span><span className="log-context-open"><span className="show-open">펼쳐 보기</span><span className="show-close">접기</span><Icon name="chevron" size={14} /></span></summary>
      <div className="log-operations-grid"><GatewayStatusPanel status={gatewayStatus} /><StrategyWorkspace strategies={strategies} busy={strategyBusy} onCreate={onCreateStrategy} onApply={onApplyStrategy} onRollback={onRollbackStrategy} /></div>
    </details>
    <section className="panel activity-history log-list-panel">
      <div className="panel-head"><div><span className="panel-kicker">보조 감사 기록</span><h2>최근 운영 활동</h2></div><span className="history-chip">{latestEvents.length}건</span></div>
      {latestEvents.length ? latestEvents.map((event) => <div className="history-event" key={event.id}><span><Icon name={event.eventType.includes('handoff') ? 'x' : event.eventType.includes('approved') || event.eventType.includes('resolved') ? 'check' : event.eventType.includes('advisor') ? 'sparkle' : 'clock'} size={15} /></span><div><b>{friendlyEventName(event.eventType)}</b><p>{event.actorId.startsWith('demo-') ? '농가 운영자' : event.actorId} · {formatDate(event.createdAt)}</p></div></div>) : <EmptyCopy>운영 조건 변경이나 장치 적용을 시작하면 여기에 표시됩니다.</EmptyCopy>}
    </section>
  </div>
}

function OperationCaseDrawer({ record, acknowledging, onAcknowledge, onSaveKnowledge, onOpenKnowledge, onExport, onPrint, onClose }: { record: OperationCase; acknowledging: boolean; onAcknowledge: () => void; onSaveKnowledge: () => Promise<OperationKnowledgeSaveResult>; onOpenKnowledge: () => void; onExport: () => void; onPrint: () => void; onClose: () => void }) {
  const evidenceGroups = groupOperationCaseEvidence(record.evidence)
  const canSaveKnowledge = record.status === 'resolved' || record.status === 'handoff'
  const [knowledgeSaving, setKnowledgeSaving] = useState(false)
  const [knowledgeResult, setKnowledgeResult] = useState<OperationKnowledgeSaveResult | null>(null)
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null)
  async function saveKnowledge() {
    if (!canSaveKnowledge || knowledgeSaving) return
    setKnowledgeSaving(true)
    setKnowledgeError(null)
    try {
      setKnowledgeResult(await onSaveKnowledge())
    } catch (error) {
      setKnowledgeError(error instanceof Error ? operationalUiCopy(error.message) : '농장 지식을 저장하지 못했습니다.')
    } finally {
      setKnowledgeSaving(false)
    }
  }
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="case-detail-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="case-detail-drawer case-print-sheet" role="dialog" aria-modal="true" aria-labelledby="case-detail-title">
    <header><div><span className="panel-kicker">운영 판단 기록</span><h2 id="case-detail-title">{operationalUiCopy(record.title)}</h2><p>{record.zoneId === 'zone-b' ? '2구역' : '1구역'} · {formatDate(record.openedAt) ?? '발생 시각 미보고'}</p></div><button className="icon-button no-print" onClick={onClose} aria-label="운영 판단 기록 닫기"><Icon name="close" size={18} /></button></header>
    <div className="case-detail-status"><TruthBadge mode={record.inputMode} /><span className={`case-status ${record.status}`}>{operationCaseStatusLabel(record.status)}</span></div>
    <section className="case-outcome-grid detail"><div><span>예상 결과</span><p>{operationalUiCopy(record.expectedOutcome)}</p></div><div><span>관측 결과</span><p>{operationalUiCopy(record.observedOutcome)}</p></div></section>
    <section className={`case-next-action ${record.status === 'handoff' ? 'attention' : ''}`}><span><Icon name={record.status === 'handoff' ? 'x' : record.status === 'resolved' ? 'check' : 'clock'} size={16} /></span><div><b>{record.status === 'handoff' ? '현장 점검 인계' : '다음 조치'}</b><p>{operationalUiCopy(record.nextAction)}</p></div></section>
    <section className="case-detail-section"><div className="case-section-title"><span>진행 과정</span><b>{record.timeline.length}단계</b></div><div className="decision-timeline">{record.timeline.map((item) => <article className={item.state} key={item.id}><span><Icon name={item.state === 'attention' ? 'x' : item.state === 'current' ? 'clock' : 'check'} size={13} /></span><div><b>{item.title}</b><p>{operationalUiCopy(operationCaseTimelineDetail(item, evidenceGroups.length))}</p><small>{formatDate(item.occurredAt) ?? '시각 미보고'}</small></div></article>)}</div></section>
    <section className="case-detail-section"><div className="case-section-title"><span>답변 근거</span><b>{evidenceGroups.length}개</b></div>{evidenceGroups.length ? <div className="case-evidence-list">{evidenceGroups.map((group) => { const item = group.representative; return <div key={group.id}><span><Icon name={item.kind === 'document' ? 'book' : 'activity'} size={14} /></span><div><b>{operationalUiCopy(item.title)}</b><small>{[item.issuer, item.sourceLocator].filter(Boolean).join(' · ') || (group.items.length > 1 ? `현재 운영 관측 · ${group.items.length}개 항목` : '현재 운영 관측')}</small></div>{item.sourceUrl && <a className="no-print" href={item.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${item.title} 원문 열기`}><Icon name="external" size={13} /></a>}</div> })}</div> : <EmptyCopy>연결된 문서 근거가 없습니다.</EmptyCopy>}</section>
    {record.actions.length > 0 && <section className="case-detail-section"><div className="case-section-title"><span>장치 변경</span><b>{record.actions.length}건</b></div><div className="case-action-list">{record.actions.map((action) => { const target = controlTargets.find((item) => item.value === action.target)?.label ?? operationalUiCopy(action.target); const scope = action.zoneId === 'zone-b' ? 'A동 2구역' : action.zoneId === 'zone-a' ? 'A동 1구역' : '구역 미확인'; return <div key={action.proposalId}><span>{scope} · {target}</span><b>{action.status === 'approved' ? '허용됨' : action.status === 'rejected' ? '실행 안 함' : action.status === 'failed' ? '실패' : '허용 대기'}</b><small>{action.verification ? operationalUiCopy(action.verification.detail) : operationalUiCopy(action.rationale)}</small></div> })}</div></section>}
    {canSaveKnowledge && <section className={`case-knowledge-save ${knowledgeResult?.outcome ?? ''}`} aria-live="polite"><div><Icon name={knowledgeResult ? 'check' : 'book'} size={16} /><div><b>{knowledgeResult?.outcome === 'reused' ? '이미 저장된 농장 지식입니다' : knowledgeResult?.outcome === 'needs_review' ? '내용 확인이 필요합니다' : knowledgeResult?.outcome === 'saved' ? '농장 지식으로 저장했습니다' : '이번 처리 결과를 다음 판단에 활용하세요'}</b><p>{knowledgeError ?? (knowledgeResult?.outcome === 'reused' ? `기존 자료를 중복 생성하지 않고 그대로 사용합니다.${knowledgeResult.needsReview ? ' 내용을 확인한 뒤 AI 답변 사용 여부를 정하세요.' : ''}` : knowledgeResult?.outcome === 'needs_review' ? '지식 자료에서 내용을 확인한 뒤 AI 답변 사용 여부를 정하세요.' : knowledgeResult?.outcome === 'saved' ? '상황·근거·조치·결과를 하나의 농장 기록으로 남겼습니다.' : '해결 또는 현장 인계가 끝난 기록만 저장할 수 있습니다.')}</p></div></div>{knowledgeResult ? <button type="button" onClick={onOpenKnowledge}>지식 자료에서 보기 <Icon name="chevron" size={13} /></button> : <button type="button" disabled={knowledgeSaving} onClick={() => void saveKnowledge()}>{knowledgeSaving ? '저장 중' : '농장 지식으로 저장'}</button>}</section>}
    <footer className="case-detail-actions no-print">{!record.acknowledgedAt && record.status !== 'resolved' && <button className="approve-button" disabled={acknowledging} onClick={onAcknowledge}>{acknowledging ? '반영 중' : '경보 확인'}</button>}<button className="secondary-button" onClick={onExport}>CSV 내려받기</button><button className="approve-button" onClick={onPrint}>1페이지 출력</button></footer>
  </aside></div>
}

function GuidedDemoDrawer({ snapshot, scenarioState, cases, exported, busy, onStart, onNavigate, onOpenRecord, onClose }: { snapshot: DashboardSnapshot; scenarioState: DemoScenarioState | null; cases: OperationCase[]; exported: boolean; busy: boolean; onStart: () => Promise<void>; onNavigate: (screen: Screen) => void; onOpenRecord: (record: OperationCase) => void; onClose: () => void }) {
  const currentCase = sortOperationCases(cases).find((record) => /root_zone|근권|냉각/.test(`${record.alertId} ${record.title}`)) ?? sortOperationCases(cases)[0] ?? null
  const faultStarted = Boolean(scenarioState && scenarioState.scenarioId !== 'normal')
  const evidenceReady = Boolean(currentCase?.evidence.length)
  const actionApproved = Boolean(currentCase?.actions.some((action) => action.status === 'approved'))
  const outcomeReady = Boolean(currentCase && ['resolved', 'handoff'].includes(currentCase.status))
  const steps = [
    { label: '입력 방식 확인', detail: `${truthModeLabel(snapshot.inputMode)}로 진행합니다.`, complete: snapshot.inputMode !== 'unavailable' },
    { label: '이상 상황과 경보 확인', detail: '근권 냉각 이상이 센서와 경보에 반영됩니다.', complete: faultStarted && Boolean(currentCase) },
    { label: 'AI 근거 확인', detail: '원본 자료와 현재 관측을 함께 확인합니다.', complete: evidenceReady },
    { label: '운영자 허용과 장치 반영', detail: '허용하기 전에는 장치가 바뀌지 않습니다.', complete: actionApproved },
    { label: '회복 또는 현장 인계', detail: '해결 여부를 관측 결과로 판정합니다.', complete: outcomeReady },
    { label: '기록 내보내기', detail: 'CSV 또는 1페이지 기록으로 남깁니다.', complete: exported },
  ]
  const completed = steps.filter((step) => step.complete).length
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="guide-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="guide-drawer" role="dialog" aria-modal="true" aria-labelledby="guide-title"><header><div><span className="panel-kicker">기업 시연 안내</span><h2 id="guide-title">근거에서 회복까지 10분</h2><p>장치를 자동으로 바꾸지 않고 운영자가 직접 판단·허용하는 흐름입니다.</p></div><button className="icon-button" onClick={onClose} aria-label="시연 안내 닫기"><Icon name="close" size={18} /></button></header>
    <div className="guide-progress"><span><i style={{ width: `${Math.round(completed / steps.length * 100)}%` }} /></span><b>{completed}/{steps.length} 완료</b></div>
    <ol className="guide-steps">{steps.map((step, index) => <li className={step.complete ? 'completed' : index === completed ? 'current' : ''} key={step.label}><span>{step.complete ? <Icon name="check" size={13} /> : index + 1}</span><div><b>{step.label}</b><small>{step.detail}</small></div></li>)}</ol>
    {!evidenceReady && faultStarted && <div className="guide-prompt"><span>권장 질문</span><p>근권 온도 이상을 근거와 함께 분석하고 해결 가능한 장치를 제안해줘</p></div>}
    <div className="guide-actions">{!faultStarted || !currentCase ? <button className="approve-button" disabled={busy} onClick={() => void onStart()}>{busy ? '상황 준비 중' : '근권 냉각 이상 시작'}</button> : !evidenceReady ? <button className="approve-button" onClick={() => onNavigate('advisor')}>AI 재배 조언 열기</button> : !actionApproved ? <button className="approve-button" onClick={() => onNavigate('operations')}>장치 조정 확인</button> : !outcomeReady ? <button className="approve-button" onClick={() => onNavigate('operations')}>회복 상태 보기</button> : !exported && currentCase ? <button className="approve-button" onClick={() => onOpenRecord(currentCase)}>운영 판단 기록 열기</button> : <button className="secondary-button" onClick={onClose}>시연 완료</button>}</div>
  </aside></div>
}

function friendlyEventName(eventType: string) {
  if (eventType === 'cultivation_harvest_recorded') return '수확 기록 저장'
  if (eventType === 'cultivation_observed') return '자람 정도 기록'
  if (eventType.startsWith('cultivation_')) return '재배 회차 기록'
  if (eventType.includes('handoff')) return '현장 점검 인계'
  if (eventType.includes('recovery_resolved')) return '환경 회복 확인'
  if (eventType.includes('scenario')) return '운영 조건 변경'
  if (eventType.includes('approved')) return '장치 변경 허용'
  if (eventType.includes('rejected')) return '장치 조정 취소'
  if (eventType.includes('proposal')) return '장치 변경 준비 기록'
  if (eventType.includes('advisor')) return 'AI 재배 조언 실행'
  return '운영 활동 기록'
}

type AiProviderDraft = { endpoint: string; model: string; serviceTier: LlmServiceTier; apiKey: string }
type AiSettingsDraft = { advisor: AiProviderDraft; indexingLlm: AiProviderDraft; embeddingModel: string; sharedCredential: boolean }

function aiSettingsDraft(settings: AiSettingsResponse, sharedCredential = true): AiSettingsDraft {
  return {
    advisor: { endpoint: settings.advisor.endpoint ?? '', model: settings.advisor.model ?? '', serviceTier: settings.advisor.serviceTier, apiKey: '' },
    indexingLlm: { endpoint: settings.indexingLlm.endpoint ?? '', model: settings.indexingLlm.model ?? '', serviceTier: settings.indexingLlm.serviceTier, apiKey: '' },
    embeddingModel: settings.embedding.model,
    sharedCredential,
  }
}

function settingSourceLabel(source: string) {
  return ({ runtime: '런타임 적용', environment: '환경 변수', not_configured: '미구성', default: '기본값' } as Record<string, string>)[source] ?? source
}

function serviceTierLabel(tier: LlmServiceTier) {
  return ({ default: 'Standard', flex: 'Flex', priority: 'Priority' } as const)[tier]
}

function privacyRouteLabel(route: AdvisorDiagnostics['privacy']) {
  return ({ local_only: '내부 처리', public_only_remote: '공개 근거', simulation_and_public_remote: '센서 문맥 + 공개 근거' } as const)[route]
}

function diagnosticScopeLabel(scope: string | null) {
  if (!scope) return '미보고'
  return operationalUiCopy(scope.replace(/public_plus_/g, '공개 근거 + ').replace(/public_only/g, '공개 근거'))
}

function ModelSettingsDrawer({ farmId, alertAutomation, scenarios, scenarioState, clock, scenarioBusy, onAlertAutomationChange, onScenario, onClock, onScenarioReset, onClose }: { farmId: FarmId; alertAutomation: AlertAutomationSettings; scenarios: DemoScenario[]; scenarioState: DemoScenarioState | null; clock: DashboardSnapshot['clock']; scenarioBusy: boolean; onAlertAutomationChange: (settings: AlertAutomationSettings) => void; onScenario: (primaryId: string, secondaryId: string | null, zoneIds: string[]) => void; onClock: (update: { speed?: 1 | 5 | 10; paused?: boolean }) => void; onScenarioReset: () => void; onClose: () => void }) {
  const [serverSettings, setServerSettings] = useState<AiSettingsResponse | null>(null)
  const [draft, setDraft] = useState<AiSettingsDraft | null>(null)
  const [busy, setBusy] = useState<'load' | 'apply' | 'reset' | 'reindex' | AiSettingsTarget | null>('load')
  const [statusMessage, setStatusMessage] = useState('서버의 실제 적용 설정을 불러오고 있습니다.')
  const [testResults, setTestResults] = useState<Partial<Record<AiSettingsTarget, string>>>({})

  useEffect(() => {
    let active = true
    void getAiSettings(farmId).then((settings) => {
      if (!active) return
      setServerSettings(settings)
      setDraft(aiSettingsDraft(settings))
      setStatusMessage('서버 적용값을 불러왔습니다. API key 원문은 반환되거나 표시되지 않습니다.')
    }).catch((error) => {
      if (active) setStatusMessage(error instanceof Error ? error.message : 'AI 설정을 불러오지 못했습니다.')
    }).finally(() => {
      if (active) setBusy(null)
    })
    return () => { active = false }
  }, [farmId])

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  function updateProvider(target: AiSettingsTarget, patch: Partial<AiProviderDraft>) {
    setDraft((current) => {
      if (!current) return current
      const key = target === 'advisor' ? 'advisor' : 'indexingLlm'
      const otherKey = target === 'advisor' ? 'indexingLlm' : 'advisor'
      const next = { ...current, [key]: { ...current[key], ...patch } }
      if (current.sharedCredential && patch.apiKey !== undefined) next[otherKey] = { ...current[otherKey], apiKey: patch.apiKey }
      return next
    })
  }

  function setSharedCredential(checked: boolean) {
    setDraft((current) => {
      if (!current) return current
      const sharedKey = current.advisor.apiKey || current.indexingLlm.apiKey
      return {
        ...current,
        sharedCredential: checked,
        ...(checked && sharedKey ? { advisor: { ...current.advisor, apiKey: sharedKey }, indexingLlm: { ...current.indexingLlm, apiKey: sharedKey } } : {}),
      }
    })
  }

  async function applySettings() {
    if (!draft || busy) return
    if (!draft.advisor.endpoint.trim() || !draft.advisor.model.trim() || !draft.indexingLlm.endpoint.trim() || !draft.indexingLlm.model.trim() || !draft.embeddingModel.trim()) {
      setStatusMessage('두 LLM의 endpoint·model과 임베딩 model을 모두 입력해 주세요.')
      return
    }
    setBusy('apply')
    try {
      const providerPayload = (provider: AiProviderDraft) => ({
        provider: 'llmgateway' as const,
        base_url: provider.endpoint.trim(),
        model: provider.model.trim(),
        service_tier: provider.serviceTier,
        ...(provider.apiKey.trim() ? { api_key: provider.apiKey.trim() } : {}),
      })
      const payload: AiSettingsUpdate = {
        advisor: providerPayload(draft.advisor),
        indexing_llm: providerPayload(draft.indexingLlm),
        embedding: { provider: 'fastembed', model: draft.embeddingModel.trim() },
      }
      const settings = await updateAiSettings(farmId, payload)
      setServerSettings(settings)
      setDraft(aiSettingsDraft(settings, draft.sharedCredential))
      setTestResults({})
      setStatusMessage(`서버 런타임에 적용했습니다. 질문 응답은 다음 요청부터, 공개 이미지 설명 LLM은 다음 이미지 수집부터 사용됩니다.${settings.embedding.reindexRequired ? ' 임베딩 변경은 전체 재색인이 필요합니다.' : ''}`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '설정을 적용하지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  async function resetSettings() {
    if (busy) return
    setBusy('reset')
    try {
      const settings = await resetAiSettings(farmId)
      setServerSettings(settings)
      setDraft(aiSettingsDraft(settings, draft?.sharedCredential ?? true))
      setTestResults({})
      setStatusMessage('런타임 덮어쓰기를 제거하고 서버 환경 변수·기본값으로 복원했습니다.')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '설정을 복원하지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  async function testTarget(target: AiSettingsTarget) {
    if (busy) return
    setBusy(target)
    try {
      const result = await testAiSettings(farmId, target)
      const requested = `${result.requestedModel ?? '모델 미구성'} / ${result.requestedServiceTier ? serviceTierLabel(result.requestedServiceTier) : '등급 미구성'}`
      const served = `${result.model ?? '모델 미보고'} / ${result.serviceTier ? serviceTierLabel(result.serviceTier) : '등급 미보고'}`
      const message = `${result.reachable ? '연결 성공' : result.configured ? '연결 실패' : '설정 미완료'} · 요청 ${requested} → 제공 ${served} · ${result.detail}`
      setTestResults((current) => ({ ...current, [target]: message }))
      setStatusMessage(`${target === 'advisor' ? '질문 응답' : '공개 이미지 설명'} 적용값 테스트: ${message}`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '연결 테스트를 완료하지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  async function reindexAll() {
    if (busy) return
    setBusy('reindex')
    setStatusMessage('활성 임베딩 전환과 전체 문서 재색인을 실행하고 있습니다.')
    try {
      const result = await reindexAllKnowledge(farmId)
      const settings = await getAiSettings(farmId)
      setServerSettings(settings)
      setDraft(aiSettingsDraft(settings, draft?.sharedCredential ?? true))
      setStatusMessage(`전체 재색인 완료 · 문서 ${result.processedDocuments}개 · 청크 ${result.processedChunks}개 · 벡터 ${result.qdrantVectors}개 · ${result.activeProvider ?? settings.embedding.activeProvider} / ${result.activeModel ?? settings.embedding.activeModel}`)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '전체 재색인을 완료하지 못했습니다.')
    } finally {
      setBusy(null)
    }
  }

  function updateAlertAutomation<K extends keyof AlertAutomationSettings>(key: K, value: AlertAutomationSettings[K]) {
    onAlertAutomationChange({ ...alertAutomation, [key]: value })
  }

  return <div className="settings-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="settings-drawer" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><div><span className="panel-kicker">AI · 운영 설정</span><h2 id="settings-title">경보 · 테스트 · 모델</h2><p>운영 화면 설정과 AI 검증용 상황을 관리합니다. 모델 설정은 서버에 적용됩니다.</p></div><button className="icon-button" onClick={onClose} aria-label="설정 닫기"><Icon name="close" size={18} /></button></header>
    <section className="settings-form-section settings-scenario-section" aria-labelledby="scenario-test-title">
      <div className="settings-section-title"><div><span className="panel-kicker">검증 도구 · 즉시 실행</span><h3 id="scenario-test-title">운영 상황 테스트</h3></div><span>{scenarioState?.scenarioId === 'normal' ? '대기 중' : scenarioPhaseLabel(scenarioState?.phase)}</span></div>
      <p className="settings-section-description">센서 스트레스를 만들고 AI 경보 분석, 장치 조정안, 운영자 허용, 환경 회복까지 한 흐름으로 확인합니다. 현재 로컬 검증 환경에서만 동작합니다.</p>
      <ScenarioBar scenarios={scenarios} state={scenarioState} clock={clock} busy={scenarioBusy} onApply={onScenario} onClock={onClock} onReset={onScenarioReset} />
    </section>
    <section className="settings-form-section automation-settings-section" aria-labelledby="alert-automation-title">
      <div className="settings-section-title"><div><span className="panel-kicker">즉시 적용 · 이 브라우저</span><h3 id="alert-automation-title">경보 자동화</h3></div><span>{!alertAutomation.liveUpdates ? '감시 정지' : alertAutomation.enabled ? '작동 중' : '일시 정지'}</span></div>
      <SettingsSwitch label="새 경보 AI 자동 분석" description="화면 위치와 관계없이 콘솔 세션의 활성 경보를 근거와 함께 한 번 분석" checked={alertAutomation.enabled} onChange={(checked) => updateAlertAutomation('enabled', checked)} />
      <div className="automation-subgroup" aria-label="자동 분석 경보 유형">
        <SettingsSwitch label="재배 위험" description="근권·온습도·양액 등 작물 환경 경보" checked={alertAutomation.cropRisk} onChange={(checked) => updateAlertAutomation('cropRisk', checked)} />
        <SettingsSwitch label="센서 이상" description="드리프트·고정값·결측 등 센서 건전성 경보" checked={alertAutomation.sensorHealth} onChange={(checked) => updateAlertAutomation('sensorHealth', checked)} />
        <SettingsSwitch label="장치 장애" description="냉각·관수·환기 등 설비 상태 경보" checked={alertAutomation.equipmentFault} onChange={(checked) => updateAlertAutomation('equipmentFault', checked)} />
      </div>
      <div className="automation-policy"><Icon name="shield" size={15} /><div><b>장치 자동 변경</b><span>항상 확인 후 변경 · 자동 변경 안 함</span></div></div>
    </section>
    <section className="settings-form-section automation-settings-section" aria-labelledby="screen-settings-title">
      <div className="settings-section-title"><div><span className="panel-kicker">운영 화면</span><h3 id="screen-settings-title">갱신 · 알림</h3></div><span>즉시 저장</span></div>
      <SettingsSwitch label="실시간 화면 갱신" description="2초 센서 갱신과 30초 전체 상태 동기화" checked={alertAutomation.liveUpdates} onChange={(checked) => updateAlertAutomation('liveUpdates', checked)} />
      <SettingsSwitch label="AI 분석 완료 알림" description="새 경보 분석이 끝나면 화면 하단에 알림 표시" checked={alertAutomation.showToast} onChange={(checked) => updateAlertAutomation('showToast', checked)} />
    </section>
    {serverSettings && draft ? <>
      <section className="settings-truth-grid"><div><span>질문 응답</span><b>{settingSourceLabel(serverSettings.advisor.source)}</b><small>{serverSettings.advisor.model ?? '모델 미구성'} · {serviceTierLabel(serverSettings.advisor.serviceTier)}</small></div><div><span>공개 이미지 설명</span><b>{settingSourceLabel(serverSettings.indexingLlm.source)}</b><small>{serverSettings.indexingLlm.model ?? '모델 미구성'} · {serviceTierLabel(serverSettings.indexingLlm.serviceTier)}</small></div><div><span>활성 임베딩</span><b>{serverSettings.embedding.activeProvider}</b><small>{serverSettings.embedding.activeModel}</small></div></section>
      <AiProviderSettingsSection title="질문 응답 LLM" kicker="다음 질문부터 적용" target="advisor" view={serverSettings.advisor} draft={draft.advisor} busy={busy} testResult={testResults.advisor} onChange={(patch) => updateProvider('advisor', patch)} onTest={() => void testTarget('advisor')} />
      <AiProviderSettingsSection title="공개 이미지 설명 LLM" kicker="다음 이미지 수집부터 적용" target="indexing_llm" view={serverSettings.indexingLlm} draft={draft.indexingLlm} busy={busy} testResult={testResults.indexing_llm} onChange={(patch) => updateProvider('indexing_llm', patch)} onTest={() => void testTarget('indexing_llm')} />
      <section className="settings-form-section"><div className="settings-section-title"><div><span className="panel-kicker">벡터 색인</span><h3>임베딩 모델</h3></div>{serverSettings.embedding.reindexRequired && <span className="reindex-required">재색인 필요</span>}</div><div className="settings-fields"><label><span>Provider</span><input value="fastembed" disabled /></label><label><span>Model</span><input value={draft.embeddingModel} disabled={Boolean(busy)} onChange={(event) => setDraft({ ...draft, embeddingModel: event.target.value })} /></label></div><small className="runtime-note">설정 {serverSettings.embedding.provider} / {serverSettings.embedding.model} · 현재 활성 {serverSettings.embedding.activeProvider} / {serverSettings.embedding.activeModel} · {settingSourceLabel(serverSettings.embedding.source)}</small></section>
      <section className="settings-form-section compact-credential"><label className="settings-check"><input type="checkbox" checked={draft.sharedCredential} disabled={Boolean(busy)} onChange={(event) => setSharedCredential(event.target.checked)} />두 LLM에 같은 API key를 한 번에 입력</label><small>입력 편의 기능일 뿐이며 서버에는 목적별 설정으로 전송됩니다. 입력값은 적용 직후 비워집니다.</small></section>
    </> : <div className="settings-loading">서버 적용 설정 확인 중</div>}
    <div className="settings-status" role="status" aria-live="polite"><Icon name="shield" size={15} /><span>{statusMessage}</span></div>
    {serverSettings?.embedding.reindexRequired && <button className="reindex-link" disabled={Boolean(busy)} onClick={() => void reindexAll()}>{busy === 'reindex' ? '전체 재색인 실행 중' : '새 임베딩으로 전체 재색인 실행'} <Icon name="chevron" size={14} /></button>}
    <footer><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void resetSettings()}>{busy === 'reset' ? '복원 중' : '서버 기본값 복원'}</button><button className="approve-button" disabled={Boolean(busy) || !draft} onClick={() => void applySettings()}>{busy === 'apply' ? '적용 중' : '서버에 적용'}</button></footer>
  </aside></div>
}

function SettingsSwitch({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="settings-switch-row"><span><b>{label}</b><small>{description}</small></span><span className="settings-switch-control"><input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true"><em /></i></span></label>
}

function AiProviderSettingsSection({ title, kicker, target, view, draft, busy, testResult, onChange, onTest }: { title: string; kicker: string; target: AiSettingsTarget; view: AiSettingsResponse['advisor']; draft: AiProviderDraft; busy: string | null; testResult?: string; onChange: (patch: Partial<AiProviderDraft>) => void; onTest: () => void }) {
  return <section className="settings-form-section"><div className="settings-section-title"><div><span className="panel-kicker">{kicker}</span><h3>{title}</h3></div><span>{settingSourceLabel(view.source)}</span></div><div className="settings-provider-fields"><label><span>Provider</span><input value="llmgateway" disabled /></label><label><span>요청 등급</span><select value={draft.serviceTier} disabled={Boolean(busy)} onChange={(event) => onChange({ serviceTier: event.target.value as LlmServiceTier })}><option value="default">Standard</option><option value="flex">Flex</option><option value="priority">Priority</option></select></label><label className="settings-field-wide"><span>Endpoint</span><input type="url" value={draft.endpoint} disabled={Boolean(busy)} placeholder="https://gateway.example/v1" onChange={(event) => onChange({ endpoint: event.target.value })} /></label><label><span>Model</span><input value={draft.model} disabled={Boolean(busy)} onChange={(event) => onChange({ model: event.target.value })} /></label><label><span>API key · 원문 미표시</span><input type="password" autoComplete="new-password" value={draft.apiKey} disabled={Boolean(busy)} placeholder={view.apiKeyConfigured ? '서버에 키 구성됨 · 변경할 때만 입력' : 'API key 입력'} onChange={(event) => onChange({ apiKey: event.target.value })} /></label></div><div className="provider-runtime-line"><span>현재 요청 설정 · {view.endpoint ?? 'endpoint 미구성'} · {view.model ?? 'model 미구성'} · {serviceTierLabel(view.serviceTier)} · key {view.apiKeyConfigured ? '구성됨' : '미구성'}</span><button className="secondary-button" disabled={Boolean(busy)} onClick={onTest}>{busy === target ? '테스트 중' : '현재 적용값 테스트'}</button></div>{testResult && <small className="runtime-note">{testResult}</small>}</section>
}

function DiagnosticsDrawer({ readiness, snapshot, advisor, scenario, onClose }: { readiness: ReadinessService[]; snapshot: DashboardSnapshot | null; advisor: AdvisorDiagnostics; scenario: DemoScenarioState | null; onClose: () => void }) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="diagnostics-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><aside className="diagnostics-drawer" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title"><header><div><span className="panel-kicker">기술 확인창</span><h2 id="diagnostics-title">시스템 진단</h2><p>운영 화면에서 숨긴 연결·검색·실행 상세입니다.</p></div><button className="icon-button" onClick={onClose} aria-label="시스템 진단 닫기"><Icon name="close" size={18} /></button></header><section className="diagnostic-section"><div className="diagnostic-title"><Icon name="activity" size={16} /><b>데이터·장치 연동</b></div><dl className="diagnostic-list"><div><dt>데이터 출처</dt><dd>{snapshot?.dataOrigin ?? '미보고'}</dd></div><div><dt>마지막 생성</dt><dd>{snapshot ? formatDate(snapshot.generatedAt) : '미보고'}</dd></div><div><dt>센서 수</dt><dd>{snapshot?.metrics.length ?? 0}</dd></div><div><dt>활성 운영 조건</dt><dd>{scenario?.scenarioId ?? '미보고'}</dd></div><div><dt>Scenario trace</dt><dd>{scenario?.correlationId ?? '없음'}</dd></div></dl></section><section className="diagnostic-section"><div className="diagnostic-title"><Icon name="sparkle" size={16} /><b>AI·RAG 마지막 실행</b></div><dl className="diagnostic-list"><div><dt>Provider</dt><dd>{advisor.provider}</dd></div><div><dt>Requested</dt><dd>{advisor.requestedModel ? `${advisor.requestedModel} / ${advisor.requestedServiceTier ? serviceTierLabel(advisor.requestedServiceTier) : '등급 미보고'}` : '미보고'}</dd></div><div><dt>Served</dt><dd>{advisor.model ? `${advisor.model} / ${advisor.serviceTier ? serviceTierLabel(advisor.serviceTier) : '등급 미보고'}` : '미보고'}</dd></div><div><dt>Privacy route</dt><dd>{privacyRouteLabel(advisor.privacy)}</dd></div><div><dt>Retrieval</dt><dd>{advisor.path.join(' + ') || '실행 전'}</dd></div><div><dt>Backend</dt><dd>{advisor.backend ?? '미보고'}</dd></div><div><dt>Run ID</dt><dd>{advisor.runId ?? '없음'}</dd></div><div><dt>Hits</dt><dd>{advisor.returnedCount ?? 0} / {advisor.candidateCount ?? 0}</dd></div><div><dt>Scope</dt><dd>{diagnosticScopeLabel(advisor.queryScope)}</dd></div><div><dt>Channels</dt><dd>{advisor.channels.join(', ') || '미보고'}</dd></div></dl><p className="diagnostic-note">{operationalUiCopy(advisor.fallbackReason ?? advisor.gateReason)}</p></section><ReadinessPanel readiness={readiness} /></aside></div>
}

function EmptyCopy({ children }: { children: React.ReactNode }) { return <p className="empty-copy">{children}</p> }

function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date) }

export default App

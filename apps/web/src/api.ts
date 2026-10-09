import { advisorRequests } from './advisor-request'
import type {
  Actuator,
  AdvisorAgentRun,
  AdvisorRetrieval,
  AdvisorSession,
  AdvisorSessionSummary,
  AdvisorToolTrace,
  AdvisorTurn,
  AlertAdvisory,
  Approval,
  AuditEvent,
  ChatMessage,
  ControlDraft,
  ControlVerification,
  ControlTarget,
  CultivationStrategies,
  CultivationStrategyThreshold,
  DashboardSnapshot,
  Evidence,
  FarmId,
  GatewayStatus,
  KnowledgeDocument,
  KnowledgeRetrievalState,
  KnowledgeScope,
  KnowledgeSourceCommandPreview,
  KnowledgeSourceCommandPreviewRequest,
  KnowledgeSourceSearchRequest,
  KnowledgeSourceSearchResult,
  OperationCase,
  OperationMetrics,
  OperationsClock,
  ReadinessService,
  RuntimeState,
} from './types'
import { knowledgeSourceGroupRestoreConfirmed, knowledgeSourceGroupUpdateConfirmed } from './knowledge-view'
import { logicalControlTarget } from './operator-ui'
import { formatSensorUpdateTime } from './sensor-update-time'
import { normalizeApiErrorDetail } from './api-error'
import { controlRequestKey } from './control-request-key'
import { mapKnowledgeSourceCommandPreviewResponse, mapKnowledgeSourceSearchResponse } from './source-command'

const baseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')
const demoToken = import.meta.env.VITE_DEMO_TOKEN ?? 'demo-admin'

type Resource<T> = {
  data: T
  state: RuntimeState
  error?: string
}

type ApiMetric = {
  stale_after_seconds?: number
  key: string
  label: string
  value: number
  unit: string
  status: 'normal' | 'warning' | 'critical'
  trend: 'up' | 'down' | 'steady'
  observed_at: string
  zone_id?: string | null
  sensor_id?: string | null
  quality?: 'good' | 'suspect' | 'bad' | 'stale' | 'missing'
  source?: string | null
}

type ApiDashboard = {
  generated_at: string
  metrics: ApiMetric[]
  actuator_states?: Array<{
    key: string
    target?: string | null
    label: string
    state: string
    controllable?: boolean
    execution_scope?: 'simulator_only'
    capability?: {
      action?: 'set_actuator_state' | 'recalibrate_air_temperature_sensor'
      value_type: 'boolean' | 'percentage'
      minimum?: number | null
      maximum?: number | null
      step?: number | null
      mcp_action: string
    } | null
    zone_id?: string | null
    desired_value?: number | boolean | null
    reported_value?: number | boolean | null
    effective_value?: number | boolean | null
    unit?: string | null
    mode?: 'scheduled' | 'manual' | 'assisted' | 'off'
    health?: 'normal' | 'degraded' | 'fault' | 'offline'
    command_id?: string | null
    feedback_at?: string | null
  }>
  active_alerts: Array<{ id: string; occurrence_id: string; severity: 'info' | 'warning' | 'critical'; title: string; message: string; status: 'active' | 'acknowledged' | 'resolved'; created_at: string; alert_kind?: 'crop_risk' | 'sensor_health' | 'equipment_fault'; zone_id?: string | null }>
  shift_note: string
  data_mode?: 'simulated' | 'real' | 'mixed' | 'unavailable'
  input_mode?: 'demo' | 'replay' | 'live' | 'mixed' | 'unavailable'
  data_origin?: 'telemetry_service' | 'fixture_fallback'
  operational_control_allowed?: boolean
  active_scenario_ids?: string[]
  zones?: string[]
  derived_indicators?: Array<{
    zone_id: string
    vpd_kpa: number
    dli_mol_m2_day: number
    ec_delta_ds_m: number
    root_heat_exposure_degree_minutes: number
    source?: string
  }>
  incidents?: Array<{
    incident_id: string
    alert_id: string
    occurrence_id: string
    zone_id?: string | null
    severity: 'info' | 'warning' | 'critical'
    status: 'open' | 'acknowledged' | 'recovering' | 'resolved'
    message_ko: string
    opened_at: string
    last_observed_at: string
    resolved_at?: string | null
  }>
  clock?: {
    speed: 1 | 5 | 10
    paused: boolean
    seed: number
    revision: number
  } | null
}

type ApiTelemetry = {
  data_origin?: 'telemetry_service' | 'fixture_fallback'
  data_mode?: 'simulated' | 'real' | 'mixed' | 'unavailable'
  series: Array<{ sensor: string; zone_id?: string | null; points: Array<{ timestamp: string; value: number }> }>
}

type ApiEvidence = {
  source_id: string
  source_group_id?: string | null
  document_id?: string | null
  title: string
  excerpt: string
  source_kind: 'private_simulation' | 'private_knowledge' | 'public_knowledge' | 'synthetic_demo'
  observed_at?: string
  relevance?: 'high' | 'medium'
  score?: number
  chunk_id?: string
  locator?: string
  location?: string
  page?: number
  issuer?: string | null
  published_year?: number | null
  document_type?: string | null
  source_url?: string | null
  summary?: string | null
  source_locator?: string | null
  crop?: string | null
  cultivation_system?: string | null
  evidence_class?: string | null
  growth_stage?: string | null
  embedding_model?: string | null
}

type ApiProposal = {
  id: string
  action: string
  target: ControlTarget
  zone_id?: string | null
  value: string | number | boolean
  rationale: string
  status: 'pending_approval' | 'approved' | 'rejected' | 'failed'
  created_at: string
  created_by: string
  correlation_id?: string | null
  failure_reason?: string | null
  origin?: 'verified_telemetry_rule' | 'manual' | null
  advisor_run_id?: string | null
  evidence_ids?: string[]
  alert_id?: string | null
  alert_occurrence_id?: string | null
  verification?: {
    status?: 'verified' | 'mismatch' | 'unavailable'
    outcome?: 'device_applied' | 'device_pending' | 'recovery_pending' | 'resolved' | 'unrecovered' | 'mismatch' | 'unavailable'
    checked_at?: string
    target_state?: string | null
    requested_value?: string | number | boolean
    detail?: string
  } | null
  execution: {
    status: 'not_executed' | 'applied_to_simulator' | 'failed'
    scope?: 'simulator_only'
    executed_at?: string | null
    execution_id?: string | null
    correlation_id?: string | null
    failure_reason?: string | null
  }
}

type ApiControlDraft = {
  origin?: string
  action?: string
  target?: string
  zone_id?: string | null
  value?: number | boolean
  rationale?: string
  evidence_ids?: string[]
  before_state?: string | number | boolean | null
  advisor_run_id?: string
  alert_id?: string
  alert_occurrence_id?: string
}

type ApiAdvisorToolTrace = {
  intent?: 'conversation' | 'knowledge' | 'live_status' | 'control_request'
  available_tools?: string[]
  invoked_tools?: string[]
  status?: 'not_required' | 'completed' | 'fallback' | 'unavailable'
  state_source?: 'farm_mcp' | 'telemetry_service' | 'fixture_fallback' | null
  devices?: Array<{
    key?: string
    target?: string | null
    zone_id?: string | null
    label?: string
    state?: string
    controllable?: boolean
    value_type?: 'boolean' | 'percentage' | null
    minimum?: number | null
    maximum?: number | null
  }>
}

type ApiAdvisorAgentRun = {
  run_id?: string
  status?: 'running' | 'awaiting_approval' | 'executing' | 'verifying' | 'completed' | 'failed'
  goal?: string
  current_target?: string | null
  steps?: Array<{
    sequence?: number
    kind?: 'planning' | 'tool' | 'observation' | 'approval' | 'verification'
    status?: 'running' | 'completed' | 'failed'
    label?: string
    tool_name?: string | null
    detail?: string | null
  }>
}

type ApiAdvisorResponse = {
  state_review?: import('./types').AdvisorStateReview | null
  response_id?: string
  answer?: string
  content?: string
  citations?: ApiEvidence[]
  evidence?: ApiEvidence[]
  ignored_source_ids?: string[]
  routing?: { mode?: string; route_reason?: string; channel_weights?: Record<string, number>; retrieval_path?: string[]; graph_gate?: { reason?: string }; qact_profile_id?: string | null; qact_profile_state?: string }
  retrieval?: { run_id?: string; backend?: string; candidate_count?: number; returned_count?: number; query_scope?: string; channels?: string[] | Record<string, number>; research_policy?: { diagnostics_only?: boolean; quality_acceptance?: boolean | null } }
  search_path?: string[]
  graph_gate_reason?: string
  execution?: { provider?: 'local-deterministic' | 'llmgateway'; requested_model?: string | null; requested_service_tier?: LlmServiceTier | null; model?: string | null; service_tier?: LlmServiceTier | null; privacy_route?: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'; fallback_reason?: string | null }
  control_draft?: ApiControlDraft | null
  tool_trace?: ApiAdvisorToolTrace | null
  agent_run?: ApiAdvisorAgentRun | null
  context_patch?: Record<string, unknown> | null
}

type ApiAdvisorSessionSummary = {
  id: string
  farm_id: FarmId
  title: string
  preview?: string | null
  turn_count?: number
  created_at: string
  updated_at: string
}

type ApiAdvisorSessionTurn = {
  id: string
  question: string
  created_at: string
  response: ApiAdvisorResponse
  query_context?: {
    bed_id?: string | null
    tier?: number | null
    cycle_id?: string | null
    video_analysis_id?: string | null
    selected_source_ids?: string[]
    include_simulation_context?: boolean
    selected_zone_ids?: string[]
    zone_scope_mode?: 'all' | 'focused'
    source_visibility?: 'public' | 'all'
  } | null
}

type ApiAdvisorSession = ApiAdvisorSessionSummary & {
  turns: ApiAdvisorSessionTurn[]
}

export type ControlRequest = {
  requestId: string
  action: 'set_actuator_state' | 'recalibrate_air_temperature_sensor'
  target: ControlTarget
  zoneId: string
  value: number | boolean
  rationale: string
  origin?: 'verified_telemetry_rule' | 'manual'
  advisorRunId?: string
  evidenceIds?: string[]
  alertId?: string | null
  alertOccurrenceId?: string | null
  contextAlertId?: string | null
  contextAlertOccurrenceId?: string | null
}

export type DemoScenario = {
  id: string
  name: string
  description: string
  category: string
  supportedZones: string[]
  recoveryActions: string[]
  provenanceRefs: string[]
}

export type DemoScenarioState = {
  scenarioId: string
  appliedAt: string | null
  correlationId: string | null
  phase: 'normal' | 'ramp' | 'hold' | 'recovery' | 'recovered'
  elapsedSeconds: number
  phaseStartedAt: string | null
  scenarioIds: string[]
  zoneIds: string[]
  seed: number
}

export type LiveDashboardSnapshot = Pick<DashboardSnapshot, 'updatedAt' | 'generatedAt' | 'dataOrigin' | 'dataMode' | 'inputMode' | 'operationalControlAllowed' | 'metrics' | 'alerts' | 'actuators' | 'activeScenarioIds' | 'zones' | 'derivedIndicators' | 'incidents' | 'clock'>

type ApiAuditEvent = {
  id: string
  event_type: string
  actor_id: string
  created_at: string
  details?: Record<string, unknown>
}

type ApiOperationCase = {
  id: string
  incident_id: string
  alert_id: string
  occurrence_id: string
  title: string
  zone_id?: string | null
  severity: OperationCase['severity']
  status: OperationCase['status']
  recovery_verdict: OperationCase['recoveryVerdict']
  data_mode: OperationCase['dataMode']
  input_mode: OperationCase['inputMode']
  opened_at: string
  last_observed_at: string
  acknowledged_at?: string | null
  resolved_at?: string | null
  expected_outcome: string
  observed_outcome: string
  next_action: string
  evidence?: Array<{
    source_id: string
    title: string
    kind: 'document' | 'operation'
    issuer?: string | null
    source_url?: string | null
    source_locator?: string | null
  }>
  actions?: Array<{
    proposal_id: string
    status: OperationCase['actions'][number]['status']
    target: string
    zone_id?: string | null
    requested_value: string | number | boolean
    rationale: string
    created_at: string
    approved_at?: string | null
    approved_by?: string | null
    execution_id?: string | null
    executed_at?: string | null
    expected_effects?: string[]
    verification?: ApiProposal['verification'] | null
    ai_judgment_summary?: string | null
  }>
  timeline?: Array<{
    id: string
    stage: OperationCase['timeline'][number]['stage']
    state: OperationCase['timeline'][number]['state']
    occurred_at?: string | null
    title: string
    detail: string
  }>
}

class ApiError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message
  if (error instanceof DOMException && error.name === 'AbortError') return 'API 응답 시간이 초과되었습니다.'
  return 'API에 연결할 수 없습니다.'
}

const pendingReads = new Map<string, Promise<unknown>>()
function request<T>(path: string, farmId: FarmId, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  if (init?.method && init.method !== 'GET') return executeRequest<T>(path, farmId, init, timeoutMs)
  const key = JSON.stringify([farmId, path, init?.headers ?? null])
  const existing = pendingReads.get(key)
  if (existing) return existing as Promise<T>
  const work = executeRequest<T>(path, farmId, init, timeoutMs).finally(() => pendingReads.delete(key))
  pendingReads.set(key, work)
  return work
}
async function executeRequest<T>(path: string, farmId: FarmId, init?: RequestInit, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  const bodyIsForm = init?.body instanceof FormData

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'X-Demo-Token': demoToken,
        'X-Farm-Context': farmId,
        ...(bodyIsForm ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { detail?: unknown } | null
      const message = normalizeApiErrorDetail(payload?.detail, response.status)
      throw new ApiError(message, response.status)
    }
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  } finally {
    window.clearTimeout(timeout)
  }
}

async function requestText(path: string, farmId: FarmId, timeoutMs = 8_000): Promise<string> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'text/csv', 'X-Demo-Token': demoToken, 'X-Farm-Context': farmId },
      signal: controller.signal,
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { detail?: string } | null
      throw new ApiError(payload?.detail ?? '농장 정보를 불러오지 못했습니다. 연결을 다시 확인해 주세요.', response.status)
    }
    return response.text()
  } finally {
    window.clearTimeout(timeout)
  }
}

function formatTime(value: string | null | undefined) {
  if (!value) return '시각 미상'
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function mapApiEvidence(item: ApiEvidence, index: number): Evidence {
  return {
    id: item.chunk_id ?? `${item.source_id}:${item.location ?? item.observed_at ?? index}`,
    sourceId: item.source_id,
    sourceKind: item.source_kind,
    sourceGroupId: item.source_group_id ?? null,
    documentId: item.document_id ?? null,
    source: item.title,
    category: item.source_kind === 'private_simulation' || item.source_kind === 'private_knowledge' ? '비공개' : '공개',
    excerpt: item.excerpt,
    score: item.score ?? (item.relevance === 'high' ? 0.91 : 0.76),
    locator: item.location ?? item.locator ?? (item.page ? `p. ${item.page}` : item.observed_at ? formatTime(item.observed_at) : '위치 정보 없음'),
    path: 'Dense',
    selected: true,
    issuer: item.issuer ?? null,
    publishedYear: item.published_year ?? null,
    documentType: item.document_type ?? null,
    sourceUrl: item.source_url ?? null,
    summary: item.summary ?? null,
    sourceLocator: item.source_locator ?? item.locator ?? item.location ?? null,
    crop: item.crop ?? null,
    cultivationSystem: item.cultivation_system ?? null,
    evidenceClass: item.evidence_class ?? null,
    growthStage: item.growth_stage ?? null,
    embeddingModel: item.embedding_model ?? null,
  }
}

function mapApiControlDraft(draft: ApiControlDraft | null | undefined): ControlDraft | null {
  if (!draft) return null
  const targets = new Set<ControlTarget>(['root_zone_chiller', 'irrigation_pump', 'ventilation_fan', 'roof_vent', 'side_vent', 'shade_curtain', 'heater', 'air_temperature_sensor_reset'])
  const action = draft.action ?? (draft.target === 'air_temperature_sensor_reset' ? 'recalibrate_air_temperature_sensor' : 'set_actuator_state')
  const origin = draft.origin
  if ((origin !== 'verified_telemetry_rule' && origin !== 'manual') || !draft.target || !targets.has(draft.target as ControlTarget) || (action !== 'set_actuator_state' && action !== 'recalibrate_air_temperature_sensor') || typeof draft.rationale !== 'string' || typeof draft.advisor_run_id !== 'string' || !draft.evidence_ids?.length) return null
  if (origin === 'verified_telemetry_rule' && (typeof draft.alert_id !== 'string' || typeof draft.alert_occurrence_id !== 'string')) return null
  if ((draft.target === 'air_temperature_sensor_reset') !== (action === 'recalibrate_air_temperature_sensor')) return null
  if (typeof draft.value !== 'boolean' && typeof draft.value !== 'number') return null
  return {
    id: `draft:${draft.advisor_run_id}:${draft.alert_occurrence_id ?? 'manual'}:${draft.zone_id ?? 'unscoped'}:${draft.target}:${String(draft.value)}`,
    origin,
    action,
    target: draft.target as ControlTarget,
    zoneId: draft.zone_id ?? null,
    value: draft.value,
    rationale: draft.rationale,
    evidenceIds: draft.evidence_ids,
    advisorMessageId: null,
    advisorRunId: draft.advisor_run_id,
    alertId: draft.alert_id ?? null,
    alertOccurrenceId: draft.alert_occurrence_id ?? null,
    beforeState: draft.before_state ?? null,
  }
}

function mapApiToolTrace(trace: ApiAdvisorToolTrace | null | undefined): AdvisorToolTrace | null {
  if (!trace?.intent || !['conversation', 'knowledge', 'live_status', 'control_request'].includes(trace.intent)) return null
  const status = trace.status && ['not_required', 'completed', 'fallback', 'unavailable'].includes(trace.status)
    ? trace.status
    : trace.intent === 'knowledge' || trace.intent === 'conversation' ? 'not_required' : 'fallback'
  const devices = (trace.devices ?? []).flatMap((device) => {
    if (typeof device.key !== 'string' || typeof device.label !== 'string' || typeof device.state !== 'string') return []
    return [{
      key: device.key,
      target: logicalControlTarget(device.target) ?? logicalControlTarget(device.key),
      zoneId: device.zone_id ?? (device.key.includes(':') ? device.key.split(':')[0] : null),
      label: device.label,
      state: device.state,
      controllable: device.controllable === true,
      valueType: device.value_type === 'boolean' || device.value_type === 'percentage' ? device.value_type : null,
      minimum: typeof device.minimum === 'number' ? device.minimum : null,
      maximum: typeof device.maximum === 'number' ? device.maximum : null,
    }]
  })
  return {
    intent: trace.intent,
    status,
    stateSource: trace.state_source ?? null,
    availableTools: trace.available_tools?.filter((item): item is string => typeof item === 'string') ?? [],
    invokedTools: trace.invoked_tools?.filter((item): item is string => typeof item === 'string') ?? [],
    devices,
  }
}

function mapApiAgentRun(run: ApiAdvisorAgentRun | null | undefined): AdvisorAgentRun | null {
  const statuses = new Set<AdvisorAgentRun['status']>(['running', 'awaiting_approval', 'executing', 'verifying', 'completed', 'failed'])
  const kinds = new Set<AdvisorAgentRun['steps'][number]['kind']>(['planning', 'tool', 'observation', 'approval', 'verification'])
  const stepStatuses = new Set<AdvisorAgentRun['steps'][number]['status']>(['running', 'completed', 'failed'])
  const targets = new Set<ControlTarget>(['root_zone_chiller', 'irrigation_pump', 'ventilation_fan', 'roof_vent', 'side_vent', 'shade_curtain', 'heater', 'air_temperature_sensor_reset'])
  if (typeof run?.run_id !== 'string' || !run.status || !statuses.has(run.status) || typeof run.goal !== 'string') return null
  const steps = (run.steps ?? []).flatMap((step) => {
    if (typeof step.sequence !== 'number' || !step.kind || !kinds.has(step.kind) || !step.status || !stepStatuses.has(step.status) || typeof step.label !== 'string') return []
    return [{
      sequence: step.sequence,
      kind: step.kind,
      status: step.status,
      label: step.label,
      toolName: typeof step.tool_name === 'string' ? step.tool_name : null,
      detail: typeof step.detail === 'string' ? step.detail : null,
    }]
  })
  return {
    runId: run.run_id,
    status: run.status,
    goal: run.goal,
    currentTarget: run.current_target && targets.has(run.current_target as ControlTarget) ? run.current_target as ControlTarget : null,
    steps: steps.sort((left, right) => left.sequence - right.sequence),
  }
}

function mapTelemetry(telemetry: ApiTelemetry, zoneId: string) {
  const scopedSeries = telemetry.series.filter((series) => series.zone_id === zoneId || (zoneId === 'zone-a' && !series.zone_id))
  const keyedSeries = new Map(scopedSeries.map((series) => [series.sensor, series.points]))
  const temp = keyedSeries.get('air_temperature_c') ?? []
  const humidity = keyedSeries.get('relative_humidity_pct') ?? []
  const co2 = keyedSeries.get('co2_ppm') ?? []
  const ec = keyedSeries.get('ec_ms_cm') ?? []
  const rootZoneTemperature = keyedSeries.get('root_zone_temperature_c') ?? []
  const substrateMoisture = keyedSeries.get('substrate_moisture_pct') ?? []
  const irrigationFlow = keyedSeries.get('irrigation_flow_l_min') ?? []
  const irrigationPressure = keyedSeries.get('irrigation_pressure_bar') ?? []
  const ppfd = keyedSeries.get('ppfd_umol_m2_s') ?? []
  const supplyEc = keyedSeries.get('supply_ec_ds_m') ?? []
  const drainEc = keyedSeries.get('drain_ec_ds_m') ?? []
  const supplyPh = keyedSeries.get('supply_ph') ?? []
  const allSeries = [...keyedSeries.values()]
  const rowCount = Math.max(0, ...allSeries.map((points) => points.length))
  const displayValue = (points: ApiTelemetry['series'][number]['points'], index: number) => points[index]?.value ?? Number.NaN
  return Array.from({ length: rowCount }, (_, index) => ({
    time: temp[index]?.timestamp ?? rootZoneTemperature[index]?.timestamp ?? irrigationFlow[index]?.timestamp ?? allSeries[0]?.[index]?.timestamp ?? '',
    temperature: displayValue(temp, index),
    humidity: displayValue(humidity, index),
    co2: displayValue(co2, index),
    ec: displayValue(supplyEc.length ? supplyEc : ec, index),
    rootZoneTemperature: displayValue(rootZoneTemperature, index),
    substrateMoisture: displayValue(substrateMoisture, index),
    irrigationFlow: displayValue(irrigationFlow, index),
    irrigationPressure: displayValue(irrigationPressure, index),
    ppfd: displayValue(ppfd, index),
    supplyPh: displayValue(supplyPh, index),
    drainEc: displayValue(drainEc, index),
  }))
}

function mapDashboard(dashboard: ApiDashboard, telemetryByZone: Record<string, ApiTelemetry>): DashboardSnapshot {
  const metricTones: Record<string, 'mint' | 'sun' | 'blue' | 'rose'> = {
    air_temperature_c: 'mint', relative_humidity_pct: 'mint', root_zone_temperature_c: 'mint',
    supply_ec_ds_m: 'mint', drain_ec_ds_m: 'mint', irrigation_flow_l_min: 'mint',
    irrigation_pressure_bar: 'mint', ppfd_umol_m2_s: 'mint', co2_ppm: 'mint',
  }
  const metricIcons: Record<string, 'thermometer' | 'droplet' | 'cloud' | 'bolt'> = {
    air_temperature_c: 'thermometer', relative_humidity_pct: 'droplet', root_zone_temperature_c: 'thermometer',
    supply_ec_ds_m: 'bolt', drain_ec_ds_m: 'bolt', irrigation_flow_l_min: 'droplet',
    irrigation_pressure_bar: 'droplet', ppfd_umol_m2_s: 'cloud', co2_ppm: 'cloud',
  }
  const mappedTelemetryByZone = Object.fromEntries(
    Object.entries(telemetryByZone).map(([zoneId, telemetry]) => [zoneId, mapTelemetry(telemetry, zoneId)]),
  )
  const primaryZone = dashboard.zones?.[0] ?? 'zone-a'
  const primaryTelemetry = telemetryByZone[primaryZone]

  return {
    updatedAt: formatSensorUpdateTime(dashboard.generated_at),
    generatedAt: dashboard.generated_at,
    dataOrigin: dashboard.data_origin ?? primaryTelemetry?.data_origin ?? 'unknown',
    dataMode: dashboard.data_mode ?? primaryTelemetry?.data_mode ?? 'unavailable',
    inputMode: dashboard.input_mode ?? 'unavailable',
    operationalControlAllowed: dashboard.operational_control_allowed ?? false,
    metrics: dashboard.metrics.map((metric) => {
      const isBoolean = metric.unit === 'boolean'
      return {
        key: metric.key,
        label: metric.label,
        value: isBoolean ? (metric.value ? '감지' : '미감지') : String(metric.value),
        unit: isBoolean ? '' : metric.unit,
        delta: metric.status === 'critical' ? '즉시 확인 필요' : metric.status === 'warning' ? '주의 구간' : metric.trend === 'steady' ? '안정적' : metric.trend === 'up' ? '상승 추세' : '하강 추세',
        trend: metric.trend,
        tone: metricTones[metric.key] ?? 'mint',
        icon: metricIcons[metric.key] ?? 'cloud',
        status: metric.status,
        observedAt: metric.observed_at ?? null,
        zoneId: metric.zone_id ?? null,
        sensorId: metric.sensor_id ?? null,
        staleAfterSeconds: metric.stale_after_seconds ?? 300,
        quality: metric.quality ?? 'good',
        source: metric.source ?? null,
      }
    }),
    telemetry: mappedTelemetryByZone[primaryZone] ?? [],
    telemetryByZone: mappedTelemetryByZone,
    alerts: dashboard.active_alerts.map((alert) => ({
      id: alert.id,
      occurrenceId: alert.occurrence_id,
      severity: alert.severity,
      title: alert.title,
      detail: alert.message,
      time: formatTime(alert.created_at),
      occurredAt: alert.created_at,
      status: alert.status === 'active' ? 'new' : alert.status,
      kind: alert.alert_kind ?? 'crop_risk',
      zoneId: alert.zone_id ?? null,
    })),
    actuators: (dashboard.actuator_states ?? []).map((actuator): Actuator => ({
      key: actuator.key,
      target: logicalControlTarget(actuator.target) ?? logicalControlTarget(actuator.key),
      label: actuator.label,
      state: actuator.state,
      controllable: actuator.controllable ?? true,
      executionScope: actuator.execution_scope ?? 'unknown',
      capability: actuator.capability ? {
        action: actuator.capability.action ?? 'set_actuator_state',
        valueType: actuator.capability.value_type,
        minimum: actuator.capability.minimum ?? null,
        maximum: actuator.capability.maximum ?? null,
        step: actuator.capability.step ?? null,
        mcpAction: actuator.capability.mcp_action,
      } : null,
      zoneId: actuator.zone_id ?? (actuator.key.includes(':') ? actuator.key.split(':')[0] : null),
      desiredValue: actuator.desired_value ?? null,
      reportedValue: actuator.reported_value ?? null,
      effectiveValue: actuator.effective_value ?? null,
      unit: actuator.unit ?? null,
      mode: actuator.mode ?? 'scheduled',
      health: actuator.health ?? 'normal',
      commandId: actuator.command_id ?? null,
      feedbackAt: actuator.feedback_at ?? null,
    })),
    dailyBrief: dashboard.shift_note.includes('센서 데이터와 장치 제어는 시뮬레이션입니다.')
      ? '재배 기준과 현재 센서·장치 상태를 함께 반영합니다.'
      : dashboard.shift_note,
    activeScenarioIds: dashboard.active_scenario_ids ?? [],
    zones: dashboard.zones ?? [],
    derivedIndicators: (dashboard.derived_indicators ?? []).map((item) => ({
      zoneId: item.zone_id,
      vpdKpa: item.vpd_kpa,
      dliMolM2Day: item.dli_mol_m2_day,
      ecDeltaDsM: item.ec_delta_ds_m,
      rootHeatExposureDegreeMinutes: item.root_heat_exposure_degree_minutes,
      source: item.source ?? 'telemetry-derived',
    })),
    incidents: (dashboard.incidents ?? []).map((item) => ({
      id: item.incident_id,
      alertId: item.alert_id,
      occurrenceId: item.occurrence_id,
      zoneId: item.zone_id ?? null,
      severity: item.severity,
      status: item.status,
      message: item.message_ko,
      openedAt: item.opened_at,
      lastObservedAt: item.last_observed_at,
      resolvedAt: item.resolved_at ?? null,
    })),
    clock: dashboard.clock ?? null,
  }
}

export async function getDashboard(farmId: FarmId): Promise<Resource<DashboardSnapshot | null>> {
  try {
    const dashboard = await request<ApiDashboard>('/v1/dashboard/snapshot', farmId)
    const zones = dashboard.zones?.length ? dashboard.zones : ['zone-a']
    const telemetryEntries = await Promise.all(zones.map(async (zoneId) => [
      zoneId,
      await request<ApiTelemetry>(`/v1/telemetry/series?hours=10&zone_id=${encodeURIComponent(zoneId)}`, farmId),
    ] as const))
    const telemetryByZone = Object.fromEntries(telemetryEntries)
    const telemetryUnavailable = telemetryEntries.some(([, telemetry]) => telemetry.data_mode === 'unavailable')
    const telemetryConnected = telemetryEntries.every(([, telemetry]) => telemetry.data_origin === 'telemetry_service')
    const state: RuntimeState = dashboard.data_mode === 'unavailable' || telemetryUnavailable
      ? 'unavailable'
      : dashboard.data_origin === 'telemetry_service' && telemetryConnected
        ? 'connected'
        : 'degraded'
    return { data: mapDashboard(dashboard, telemetryByZone), state }
  } catch (error) {
    return { data: null, state: 'unavailable', error: errorMessage(error) }
  }
}

export async function getDashboardSnapshot(farmId: FarmId): Promise<Resource<LiveDashboardSnapshot | null>> {
  try {
    const dashboard = await request<ApiDashboard>('/v1/dashboard/snapshot', farmId)
    const mapped = mapDashboard(dashboard, {})
    return {
      data: {
        updatedAt: mapped.updatedAt,
        generatedAt: mapped.generatedAt,
        dataOrigin: mapped.dataOrigin,
        dataMode: mapped.dataMode,
        inputMode: mapped.inputMode,
        operationalControlAllowed: mapped.operationalControlAllowed,
        metrics: mapped.metrics,
        alerts: mapped.alerts,
        actuators: mapped.actuators,
        activeScenarioIds: mapped.activeScenarioIds,
        zones: mapped.zones,
        derivedIndicators: mapped.derivedIndicators,
        incidents: mapped.incidents,
        clock: mapped.clock,
      },
      state: dashboard.data_mode === 'unavailable'
        ? 'unavailable'
        : dashboard.data_origin === 'telemetry_service' ? 'connected' : 'degraded',
    }
  } catch (error) {
    return { data: null, state: 'unavailable', error: errorMessage(error) }
  }
}

function mapDemoScenarioState(state: Record<string, unknown>, fallbackScenarioId = 'normal'): DemoScenarioState {
  const candidate = String(state.phase ?? 'normal')
  const phase = ['normal', 'ramp', 'hold', 'recovery', 'recovered'].includes(candidate)
    ? candidate as DemoScenarioState['phase']
    : 'normal'
  return {
    scenarioId: String(state.scenario_id ?? fallbackScenarioId),
    appliedAt: typeof state.applied_at === 'string' ? state.applied_at : null,
    correlationId: typeof state.correlation_id === 'string' ? state.correlation_id : null,
    phase,
    elapsedSeconds: typeof state.elapsed_seconds === 'number' && Number.isFinite(state.elapsed_seconds) ? Math.max(0, state.elapsed_seconds) : 0,
    phaseStartedAt: typeof state.phase_started_at === 'string' ? state.phase_started_at : null,
    scenarioIds: Array.isArray(state.scenario_ids) ? state.scenario_ids.filter((item): item is string => typeof item === 'string') : [String(state.scenario_id ?? fallbackScenarioId)],
    zoneIds: Array.isArray(state.zone_ids) ? state.zone_ids.filter((item): item is string => typeof item === 'string') : ['zone-a'],
    seed: typeof state.seed === 'number' && Number.isInteger(state.seed) ? state.seed : 1024,
  }
}

export async function getDemoScenarios(farmId: FarmId): Promise<Resource<{ scenarios: DemoScenario[]; active: DemoScenarioState | null }>> {
  try {
    const [catalog, state] = await Promise.all([
      request<{ scenarios?: Array<Record<string, unknown>> }>('/v1/demo/scenarios', farmId),
      request<Record<string, unknown>>('/v1/demo/scenario', farmId),
    ])
    const scenarios = (catalog.scenarios ?? []).map((item) => ({
      id: String(item.scenario_id ?? item.id ?? ''),
      name: String(item.name_ko ?? item.name ?? item.scenario_id ?? '시나리오'),
      description: String(item.description_ko ?? item.description ?? '센서·장치 운영 조건'),
      category: String(item.category ?? 'environment'),
      supportedZones: Array.isArray(item.supported_zones) ? item.supported_zones.filter((value): value is string => typeof value === 'string') : ['zone-a'],
      recoveryActions: Array.isArray(item.recovery_actions) ? item.recovery_actions.filter((value): value is string => typeof value === 'string') : [],
      provenanceRefs: Array.isArray(item.provenance_refs) ? item.provenance_refs.filter((value): value is string => typeof value === 'string') : [],
    })).filter((item) => item.id)
    return {
      data: {
        scenarios,
        active: mapDemoScenarioState(state),
      },
      state: 'connected',
    }
  } catch (error) {
    return { data: { scenarios: [], active: null }, state: 'unavailable', error: errorMessage(error) }
  }
}

export async function getDemoScenario(farmId: FarmId): Promise<Resource<DemoScenarioState | null>> {
  try {
    const state = await request<Record<string, unknown>>('/v1/demo/scenario', farmId)
    return { data: mapDemoScenarioState(state), state: 'connected' }
  } catch (error) {
    return { data: null, state: 'unavailable', error: errorMessage(error) }
  }
}

export async function activateDemoScenario(
  farmId: FarmId,
  scenarioId: string,
  options?: { scenarioIds?: string[]; zoneIds?: string[]; seed?: number },
): Promise<DemoScenarioState> {
  const result = await request<Record<string, unknown>>('/v1/demo/scenario', farmId, {
    method: 'POST',
    body: JSON.stringify({
      scenario_id: scenarioId,
      scenario_ids: options?.scenarioIds ?? [scenarioId],
      zone_ids: options?.zoneIds ?? ['zone-a'],
      seed: options?.seed ?? 1024,
    }),
  })
  return mapDemoScenarioState(result, scenarioId)
}

export async function updateOperationsClock(
  farmId: FarmId,
  update: { speed?: 1 | 5 | 10; paused?: boolean; resetTo?: string; seed?: number },
): Promise<OperationsClock> {
  return request<OperationsClock>('/v1/operations/clock', farmId, {
    method: 'PATCH',
    body: JSON.stringify({
      speed: update.speed,
      paused: update.paused,
      reset_to: update.resetTo,
      seed: update.seed,
    }),
  })
}

export type OperationsReplayObservation = {
  observed_at: string
  readings: Array<{
    metric: string
    value: number
    unit: string
    zone_id?: 'zone-a' | 'zone-b'
    sensor_id?: string
    quality?: 'good' | 'suspect' | 'bad' | 'stale' | 'missing'
  }>
  message_id?: string
  sequence?: number
}

export async function replayOperations(
  farmId: FarmId,
  observations: OperationsReplayObservation[],
): Promise<{ accepted_observations: number; first_observed_at: string; last_observed_at: string }> {
  return request('/v1/operations/replay', farmId, {
    method: 'POST',
    body: JSON.stringify({ observations, reset_clock_to_first_observation: true }),
  }, 30_000)
}

export async function getAlertAdvisory(farmId: FarmId, alertId: string, options: { lang?: 'ko' | 'en'; refresh?: boolean } = {}): Promise<AlertAdvisory> {
  const query = [options.lang === 'en' ? 'lang=en' : '', options.refresh ? 'refresh=true' : ''].filter(Boolean).join('&')
  try {
    const result = await request<{
      alert_id: string
      warning: string
      citation_source_ids?: string[]
      evidence?: ApiEvidence[]
      generated_at?: string
      cached?: boolean
      control_draft?: ApiControlDraft | null
      execution?: {
        provider?: 'local-deterministic' | 'llmgateway'
        requested_model?: string | null
        requested_service_tier?: LlmServiceTier | null
        model?: string | null
        service_tier?: LlmServiceTier | null
        remote_llm_used?: boolean
        privacy_route?: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'
        fallback_reason?: string | null
      }
    }>(`/v1/alerts/${encodeURIComponent(alertId)}/advisory${query ? `?${query}` : ''}`, farmId, undefined, 90_000)
    return {
      alertId: result.alert_id,
      warning: result.warning,
      citations: result.citation_source_ids ?? [],
      evidence: (result.evidence ?? []).map(mapApiEvidence),
      provider: result.execution?.provider === 'llmgateway' ? 'llmgateway' : 'local',
      privacy: result.execution?.privacy_route ?? 'local_only',
      requestedModel: result.execution?.requested_model ?? null,
      requestedServiceTier: result.execution?.requested_service_tier ?? null,
      model: result.execution?.model ?? null,
      serviceTier: result.execution?.service_tier ?? null,
      remoteLlmUsed: result.execution?.remote_llm_used ?? false,
      fallbackReason: result.execution?.fallback_reason ?? null,
      generatedAt: result.generated_at ?? null,
      cached: result.cached ?? false,
      controlDrafts: [mapApiControlDraft(result.control_draft)].filter((draft): draft is ControlDraft => draft !== null),
      snapshot: result,
    }
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || /signal is aborted|aborted without reason/i.test(error.message))) {
      throw new ApiError('AI 경고 조언 응답이 지연되었습니다. 잠시 후 다시 확인해 주세요.')
    }
    throw error
  }
}

function controlValueLabel(target: ControlTarget, value: string | number | boolean) {
  if (target === 'air_temperature_sensor_reset') return '재보정 실행'
  if (target === 'ventilation_fan' || target === 'roof_vent' || target === 'side_vent' || target === 'shade_curtain') {
    const numeric = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(numeric) ? `${Math.round(numeric)}%` : String(value)
  }
  const enabled = value === true || String(value).toLowerCase() === 'on' || String(value).toLowerCase() === 'true'
  if (target === 'root_zone_chiller') return enabled ? '냉각 켜기' : '냉각 끄기'
  if (target === 'irrigation_pump') return enabled ? '관수 시작' : '관수 멈춤'
  if (target === 'heater') return enabled ? '난방 켜기' : '난방 끄기'
  return enabled ? '켜기' : '끄기'
}

function mapControlVerification(proposal: ApiProposal): ControlVerification | null {
  const verification = proposal.verification
  if (!verification?.status || !['verified', 'mismatch', 'unavailable'].includes(verification.status) || typeof verification.checked_at !== 'string') return null
  return {
    status: verification.status,
    outcome: verification.outcome
      ?? (verification.status === 'verified' ? 'device_applied' : verification.status),
    checkedAt: verification.checked_at,
    targetState: typeof verification.target_state === 'string' ? verification.target_state : null,
    requestedValue: verification.requested_value ?? proposal.value,
    detail: typeof verification.detail === 'string' ? verification.detail : '변경 결과를 확인했습니다.',
  }
}

function mapProposal(proposal: ApiProposal): Approval {
  const labels: Record<string, string> = {
    root_zone_chiller: '근권 냉각기', irrigation_pump: '관수 사이클',
    ventilation_fan: '순환팬', roof_vent: '천창 개도', side_vent: '측창 개도', shade_curtain: '차광 커튼', heater: '난방기',
    air_temperature_sensor_reset: '공기 온도 센서 재보정',
  }
  const execution = proposal.execution
  const verification = mapControlVerification(proposal)
  const scope = proposal.zone_id === 'zone-b' ? 'A동 2구역' : proposal.zone_id === 'zone-a' ? 'A동 1구역' : '구역 미확인'
  return {
    id: proposal.id,
    target: proposal.target,
    zoneId: proposal.zone_id ?? null,
    requestedValue: controlValueLabel(proposal.target, proposal.value),
    action: `${scope} · ${labels[proposal.target] ?? proposal.target} ${controlValueLabel(proposal.target, proposal.value)}`,
    device: `${scope} · ${labels[proposal.target] ?? proposal.target}`,
    proposedBy: proposal.created_by,
    reason: proposal.rationale,
    impact: verification?.outcome === 'recovery_pending'
      ? '장치 반영 · 환경 회복 확인 중'
      : verification?.outcome === 'unrecovered'
        ? '환경 회복 미확인 · 현장 점검 필요'
      : verification?.outcome === 'resolved'
        ? '환경 회복 확인 완료'
        : execution.status === 'applied_to_simulator'
          ? '장치 반영 완료'
      : execution.status === 'failed'
        ? execution.failure_reason ?? proposal.failure_reason ?? '장치 변경 결과를 확인하지 못했습니다.'
        : proposal.status === 'rejected'
          ? '취소됨 · 장치 변경 없음'
          : '장치 변경 상태 확인 중',
    status: proposal.status === 'approved' ? 'approved' : proposal.status === 'rejected' ? 'rejected' : proposal.status === 'failed' ? 'failed' : 'waiting',
    createdAt: formatTime(proposal.created_at),
    createdAtIso: proposal.created_at,
    executionStatus: execution.status,
    executionId: execution.execution_id ?? null,
    correlationId: execution.correlation_id ?? proposal.correlation_id ?? null,
    executedAt: execution.executed_at ?? null,
    failureReason: execution.failure_reason ?? proposal.failure_reason ?? null,
    origin: proposal.origin ?? null,
    advisorRunId: proposal.advisor_run_id ?? null,
    evidenceIds: proposal.evidence_ids ?? [],
    alertId: proposal.alert_id ?? null,
    alertOccurrenceId: proposal.alert_occurrence_id ?? null,
    verification,
  }
}

export async function getApprovals(farmId: FarmId): Promise<Resource<Approval[]>> {
  try {
    const result = await request<{ proposals?: ApiProposal[] }>('/v1/control-proposals', farmId)
    return { data: (result.proposals ?? []).map(mapProposal), state: 'connected' }
  } catch (error) {
    return { data: [], state: 'unavailable', error: errorMessage(error) }
  }
}

export async function createControlProposal(farmId: FarmId, control: ControlRequest, actorToken = demoToken): Promise<Approval> {
  const result = await request<ApiProposal>('/v1/control-proposals', farmId, {
    method: 'POST',
    headers: { 'X-Demo-Token': actorToken, 'Idempotency-Key': await controlRequestKey(control.requestId) },
    body: JSON.stringify({
      action: control.action,
      target: control.target,
      zone_id: control.zoneId,
      value: control.value,
      rationale: control.rationale,
      ...(control.origin ? { origin: control.origin } : {}),
      ...(control.advisorRunId ? { advisor_run_id: control.advisorRunId } : {}),
      ...(control.evidenceIds?.length ? { evidence_ids: control.evidenceIds } : {}),
      ...(control.alertId ? { alert_id: control.alertId } : {}),
      ...(control.alertOccurrenceId ? { alert_occurrence_id: control.alertOccurrenceId } : {}),
      ...(control.contextAlertId ? { context_alert_id: control.contextAlertId } : {}),
      ...(control.contextAlertOccurrenceId ? { context_alert_occurrence_id: control.contextAlertOccurrenceId } : {}),
    }),
  })
  if (result.status === 'pending_approval' || result.execution.status === 'not_executed') {
    throw new Error('장치 변경 결과를 확인하지 못했습니다.')
  }
  return mapProposal(result)
}

export async function getAudit(farmId: FarmId): Promise<Resource<AuditEvent[]>> {
  try {
    const result = await request<{ events?: ApiAuditEvent[] }>('/v1/audit/events?limit=25', farmId)
    return {
      data: (result.events ?? []).map((event) => ({
        id: event.id,
        eventType: event.event_type,
        actorId: event.actor_id,
        createdAt: event.created_at,
        details: event.details ?? {},
      })),
      state: 'connected',
    }
  } catch (error) {
    return { data: [], state: 'unavailable', error: errorMessage(error) }
  }
}

function mapOperationCaseVerification(
  verification: NonNullable<ApiOperationCase['actions']>[number]['verification'],
  requestedValue: string | number | boolean,
): ControlVerification | null {
  if (!verification?.status || !verification.checked_at) return null
  return {
    status: verification.status,
    outcome: verification.outcome ?? (verification.status === 'verified' ? 'device_applied' : verification.status),
    checkedAt: verification.checked_at,
    targetState: verification.target_state ?? null,
    requestedValue: verification.requested_value ?? requestedValue,
    detail: verification.detail ?? '변경 결과를 확인했습니다.',
  }
}

function mapOperationCase(record: ApiOperationCase): OperationCase {
  return {
    id: record.id,
    incidentId: record.incident_id,
    alertId: record.alert_id,
    occurrenceId: record.occurrence_id,
    title: record.title,
    zoneId: record.zone_id ?? null,
    severity: record.severity,
    status: record.status,
    recoveryVerdict: record.recovery_verdict,
    dataMode: record.data_mode,
    inputMode: record.input_mode,
    openedAt: record.opened_at,
    lastObservedAt: record.last_observed_at,
    acknowledgedAt: record.acknowledged_at ?? null,
    resolvedAt: record.resolved_at ?? null,
    expectedOutcome: record.expected_outcome,
    observedOutcome: record.observed_outcome,
    nextAction: record.next_action,
    evidence: (record.evidence ?? []).map((item) => ({
      sourceId: item.source_id,
      title: item.title,
      kind: item.kind,
      issuer: item.issuer ?? null,
      sourceUrl: item.source_url ?? null,
      sourceLocator: item.source_locator ?? null,
    })),
    actions: (record.actions ?? []).map((item) => ({
      proposalId: item.proposal_id,
      status: item.status,
      target: item.target,
      zoneId: item.zone_id ?? record.zone_id ?? null,
      requestedValue: item.requested_value,
      rationale: item.rationale,
      createdAt: item.created_at,
      approvedAt: item.approved_at ?? null,
      approvedBy: item.approved_by ?? null,
      executionId: item.execution_id ?? null,
      executedAt: item.executed_at ?? null,
      expectedEffects: item.expected_effects ?? [],
      verification: mapOperationCaseVerification(item.verification, item.requested_value),
      aiJudgmentSummary: item.ai_judgment_summary ?? null,
    })),
    timeline: (record.timeline ?? []).map((item) => ({
      id: item.id,
      stage: item.stage,
      state: item.state,
      occurredAt: item.occurred_at ?? null,
      title: item.title,
      detail: item.detail,
    })),
  }
}

export async function getOperationCases(farmId: FarmId): Promise<Resource<OperationCase[]>> {
  try {
    const result = await request<{ records?: ApiOperationCase[] }>('/v1/operations/cases?limit=50', farmId, undefined, 15_000)
    return { data: (result.records ?? []).map(mapOperationCase), state: 'connected' }
  } catch (error) {
    return { data: [], state: 'unavailable', error: errorMessage(error) }
  }
}

export async function acknowledgeOperationCase(farmId: FarmId, incidentId: string): Promise<OperationCase> {
  const result = await request<ApiOperationCase>(
    `/v1/operations/cases/${encodeURIComponent(incidentId)}/acknowledge`,
    farmId,
    { method: 'POST', headers: { 'X-Demo-Token': 'demo-operator-wasabi' } },
    15_000,
  )
  return mapOperationCase(result)
}

export type OperationKnowledgeSaveResult = {
  outcome: 'saved' | 'reused' | 'needs_review'
  document: KnowledgeDocument | null
  needsReview: boolean
}

export async function saveOperationCaseKnowledge(farmId: FarmId, incidentId: string): Promise<OperationKnowledgeSaveResult> {
  const result = await request<{
    document?: Record<string, unknown>
    job?: { status?: string; error?: string | null; details?: { result_kind?: string } }
  }>(
    `/v1/operations/cases/${encodeURIComponent(incidentId)}/knowledge`,
    farmId,
    { method: 'POST', headers: { 'X-Demo-Token': 'demo-operator-wasabi' }, body: JSON.stringify({}) },
    30_000,
  )
  if (result.job?.status === 'failed') throw new Error(result.job.error || '농장 지식을 저장하지 못했습니다.')
  const document = result.document ? mapKnowledgeDocument(result.document) : null
  const resultKind = String(result.job?.details?.result_kind ?? '').toLowerCase()
  const needsReview = document?.retrievalState === 'needs_review'
  const outcome = resultKind === 'reused' ? 'reused' : needsReview ? 'needs_review' : 'saved'
  return { outcome, document, needsReview }
}

type ApiGatewayStatus = {
  state: GatewayStatus['state']
  read_only?: boolean
  source?: string | null
  observed_at?: string | null
  age_seconds?: number | null
  message_id?: string | null
  sequence?: number | null
  metric_count?: number
  expected_metric_count?: number
  completeness_percent?: number
  missing_metrics?: string[]
  quality_counts?: Record<string, number>
  duplicate_sensor_metrics?: number
  unit_errors?: number
  rejected_message_count?: number
  rejection_counts?: Record<string, number>
  last_rejection_at?: string | null
  last_rejection_reason?: string | null
  input_mode?: GatewayStatus['inputMode']
}

type ApiCultivationStrategyThreshold = {
  metric: string
  lower?: number | null
  upper?: number | null
  unit: string
  source_id?: string | null
}

type ApiCultivationStrategies = {
  active_version_id: string
  versions?: Array<{
    version_id: string
    growth_stage: string
    thresholds?: ApiCultivationStrategyThreshold[]
    evidence_source_ids?: string[]
    change_note: string
    created_by: string
    created_at: string
    active?: boolean
  }>
  history?: Array<{
    version_id: string
    event_type: 'baseline' | 'apply' | 'rollback'
    actor_id: string
    applied_at: string
    from_version_id?: string | null
  }>
  sync: {
    desired_version_id: string
    applied_version_id: string
    runtime_version_id?: string | null
    state: CultivationStrategies['sync']['state']
    updated_at: string
    last_error?: string | null
  }
}

function mapCultivationStrategies(result: ApiCultivationStrategies): CultivationStrategies {
  return {
    activeVersionId: result.active_version_id,
    versions: (result.versions ?? []).map((item) => ({
      versionId: item.version_id,
      growthStage: item.growth_stage,
      thresholds: (item.thresholds ?? []).map((threshold) => ({
        metric: threshold.metric,
        lower: threshold.lower ?? null,
        upper: threshold.upper ?? null,
        unit: threshold.unit,
        sourceId: threshold.source_id ?? null,
      })),
      evidenceSourceIds: item.evidence_source_ids ?? [],
      changeNote: item.change_note,
      createdBy: item.created_by,
      createdAt: item.created_at,
      active: item.active ?? item.version_id === result.active_version_id,
    })),
    history: (result.history ?? []).map((item) => ({
      versionId: item.version_id,
      eventType: item.event_type,
      actorId: item.actor_id,
      appliedAt: item.applied_at,
      fromVersionId: item.from_version_id ?? null,
    })),
    sync: {
      desiredVersionId: result.sync.desired_version_id,
      appliedVersionId: result.sync.applied_version_id,
      runtimeVersionId: result.sync.runtime_version_id ?? null,
      state: result.sync.state,
      updatedAt: result.sync.updated_at,
      lastError: result.sync.last_error ?? null,
    },
  }
}

export async function getGatewayStatus(farmId: FarmId): Promise<Resource<GatewayStatus | null>> {
  try {
    const result = await request<ApiGatewayStatus>('/v1/telemetry/gateway-status', farmId)
    return {
      data: {
        state: result.state,
        readOnly: result.read_only ?? true,
        source: result.source ?? null,
        observedAt: result.observed_at ?? null,
        ageSeconds: result.age_seconds ?? null,
        messageId: result.message_id ?? null,
        sequence: result.sequence ?? null,
        metricCount: result.metric_count ?? 0,
        expectedMetricCount: result.expected_metric_count ?? 0,
        completenessPercent: result.completeness_percent ?? 0,
        missingMetrics: result.missing_metrics ?? [],
        qualityCounts: result.quality_counts ?? {},
        duplicateSensorMetrics: result.duplicate_sensor_metrics ?? 0,
        unitErrors: result.unit_errors ?? 0,
        rejectedMessageCount: result.rejected_message_count ?? 0,
        rejectionCounts: result.rejection_counts ?? {},
        lastRejectionAt: result.last_rejection_at ?? null,
        lastRejectionReason: result.last_rejection_reason ?? null,
        inputMode: result.input_mode ?? 'unavailable',
      },
      state: result.state === 'unavailable' ? 'unavailable' : result.state === 'degraded' || result.state === 'stale' ? 'degraded' : 'connected',
    }
  } catch (error) {
    return { data: null, state: 'unavailable', error: errorMessage(error) }
  }
}

export async function getCultivationStrategies(farmId: FarmId): Promise<Resource<CultivationStrategies | null>> {
  try {
    const result = await request<ApiCultivationStrategies>('/v1/cultivation-strategies', farmId)
    return { data: mapCultivationStrategies(result), state: 'connected' }
  } catch (error) {
    return { data: null, state: 'unavailable', error: errorMessage(error) }
  }
}

export async function createCultivationStrategy(
  farmId: FarmId,
  input: { growthStage: string; thresholds: CultivationStrategyThreshold[]; evidenceSourceIds: string[]; changeNote: string },
): Promise<CultivationStrategies> {
  const result = await request<ApiCultivationStrategies>('/v1/cultivation-strategies', farmId, {
    method: 'POST',
    headers: { 'X-Demo-Token': 'demo-operator-wasabi' },
    body: JSON.stringify({
      growth_stage: input.growthStage,
      thresholds: input.thresholds.map((item) => ({ metric: item.metric, lower: item.lower, upper: item.upper, unit: item.unit, source_id: item.sourceId })),
      evidence_source_ids: input.evidenceSourceIds,
      change_note: input.changeNote,
    }),
  })
  return mapCultivationStrategies(result)
}

export async function applyCultivationStrategy(farmId: FarmId, versionId: string): Promise<CultivationStrategies> {
  const result = await request<ApiCultivationStrategies>(`/v1/cultivation-strategies/${encodeURIComponent(versionId)}/apply`, farmId, {
    method: 'POST',
    headers: { 'X-Demo-Token': 'demo-operator-wasabi' },
  })
  return mapCultivationStrategies(result)
}

export async function rollbackCultivationStrategy(farmId: FarmId): Promise<CultivationStrategies> {
  const result = await request<ApiCultivationStrategies>('/v1/cultivation-strategies/rollback', farmId, {
    method: 'POST',
    headers: { 'X-Demo-Token': 'demo-operator-wasabi' },
  })
  return mapCultivationStrategies(result)
}

export async function getOperationMetrics(farmId: FarmId, windowHours = 168): Promise<Resource<OperationMetrics | null>> {
  try {
    const result = await request<{
      lot_id: string
      growth_stage: string
      window_hours: number
      generated_at: string
      incident_count: number
      active_count: number
      resolved_count: number
      handoff_count: number
      acknowledge_median_minutes?: number | null
      approval_median_minutes?: number | null
      recovery_median_minutes?: number | null
      recovery_rate_percent?: number | null
      gateway_missing_rate_percent?: number | null
      source_grain: string
    }>(`/v1/operations/metrics?window_hours=${windowHours}`, farmId, undefined, 15_000)
    return {
      data: {
        lotId: result.lot_id,
        growthStage: result.growth_stage,
        windowHours: result.window_hours,
        generatedAt: result.generated_at,
        incidentCount: result.incident_count,
        activeCount: result.active_count,
        resolvedCount: result.resolved_count,
        handoffCount: result.handoff_count,
        acknowledgeMedianMinutes: result.acknowledge_median_minutes ?? null,
        approvalMedianMinutes: result.approval_median_minutes ?? null,
        recoveryMedianMinutes: result.recovery_median_minutes ?? null,
        recoveryRatePercent: result.recovery_rate_percent ?? null,
        gatewayMissingRatePercent: result.gateway_missing_rate_percent ?? null,
        sourceGrain: result.source_grain,
      },
      state: 'connected',
    }
  } catch (error) {
    return { data: null, state: 'unavailable', error: errorMessage(error) }
  }
}

export async function getOperationCaseCsv(farmId: FarmId, incidentId: string): Promise<string> {
  return requestText(`/v1/operations/cases/${encodeURIComponent(incidentId)}/export.csv`, farmId, 15_000)
}

export type AdvisorResult = {
  message: ChatMessage
  evidence: Evidence[]
  execution: { provider: 'local' | 'llmgateway'; privacy: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'; requestedModel?: string | null; requestedServiceTier?: LlmServiceTier | null; model?: string | null; serviceTier?: LlmServiceTier | null; fallbackReason?: string | null }
  responseId: string | null
  ignoredSourceIds: string[]
  controlDrafts: ControlDraft[]
  toolTrace: AdvisorToolTrace | null
  agentRun: AdvisorAgentRun | null
  contextPatch: KnowledgeSourceCommandPreview | null
  retrieval: AdvisorRetrieval
}

function mapAdvisorResponse(result: ApiAdvisorResponse, assistantMessageId: string = crypto.randomUUID()): AdvisorResult {
  const evidence = (result.citations ?? result.evidence ?? []).map(mapApiEvidence)
  const searchPath = result.routing?.retrieval_path?.map((path) => path[0].toUpperCase() + path.slice(1))
    ?? result.search_path
    ?? ['Dense']
  const gateReason = result.routing?.graph_gate?.reason ?? result.graph_gate_reason
  const profile = result.routing?.qact_profile_state
  const responseId = result.response_id ?? null
  const mappedControlDraft = mapApiControlDraft(result.control_draft)
  const controlDrafts = mappedControlDraft ? [mappedControlDraft] : []
  return {
    message: {
      id: assistantMessageId,
      role: 'assistant',
      content: result.answer ?? result.content ?? '응답 내용을 확인할 수 없습니다.',
      createdAt: formatTime(new Date().toISOString()),
      evidenceIds: evidence.map((item) => item.id),
      searchPath,
      gateReason: [gateReason, profile ? `QACT profile: ${profile}` : null].filter(Boolean).join(' · ') || undefined,
    },
    evidence,
    responseId,
    ignoredSourceIds: result.ignored_source_ids ?? [],
    controlDrafts,
    toolTrace: mapApiToolTrace(result.tool_trace),
    agentRun: mapApiAgentRun(result.agent_run),
    contextPatch: result.context_patch ? mapKnowledgeSourceCommandPreviewResponse(result.context_patch) : null,
    retrieval: {
      ...(result.retrieval?.research_policy ? { researchDiagnosticsOnly: result.retrieval.research_policy.diagnostics_only === true, researchQualityAccepted: result.retrieval.research_policy.quality_acceptance ?? null } : {}),
      runId: result.retrieval?.run_id ?? null,
      backend: result.retrieval?.backend ?? null,
      candidateCount: result.retrieval?.candidate_count ?? null,
      returnedCount: result.retrieval?.returned_count ?? null,
      queryScope: result.retrieval?.query_scope ?? null,
      channels: Array.isArray(result.retrieval?.channels)
        ? result.retrieval.channels
        : Object.entries(result.retrieval?.channels ?? {}).map(([channel, count]) => `${channel}: ${count}`),
      ...(result.routing ? {
        route: {
          mode: result.routing.mode ?? null,
          path: result.routing.retrieval_path ?? [],
          weights: result.routing.channel_weights ?? {},
          reason: result.routing.route_reason ?? null,
          profileState: result.routing.qact_profile_state ?? null,
          graphReason: result.routing.graph_gate?.reason ?? null,
        },
      } : {}),
    },
    execution: {
      provider: result.execution?.provider === 'llmgateway' ? 'llmgateway' : 'local',
      privacy: result.execution?.privacy_route ?? 'local_only',
      requestedModel: result.execution?.requested_model,
      requestedServiceTier: result.execution?.requested_service_tier,
      model: result.execution?.model,
      serviceTier: result.execution?.service_tier,
      fallbackReason: result.execution?.fallback_reason,
    },
  }
}

async function requestAdvisor(
  farmId: FarmId,
  question: string,
  selectedSourceIds: string[],
  includeSimulationContext = true,
  sessionId?: string,
  clientTurnId?: string,
  context: {
    sourceSelectionMode?: 'automatic' | 'explicit'
    sourceContextVisibility?: 'public' | 'all'
    searchResultSourceGroupIds?: string[]
    focusedSourceGroupId?: string | null
    selectedZoneIds?: string[]
    zoneScopeMode?: 'all' | 'focused'
    bedId?: string
    tier?: number
    cycleId?: string
    videoAnalysisId?: string
    /** The screen language; the AI writes its answer in English only when asked. */
    answerLanguage?: 'ko' | 'en'
  } = {},
): Promise<AdvisorResult> {
  const result = await request<ApiAdvisorResponse>('/v1/advisor/questions', farmId, {
    method: 'POST',
    body: JSON.stringify({
      question,
      bed_id: context.bedId ?? null,
      tier: context.tier ?? null,
      cycle_id: context.cycleId ?? null,
      video_analysis_id: context.videoAnalysisId ?? null,
      ...(context.answerLanguage === 'en' ? { answer_language: 'en' } : {}),
      selected_source_ids: selectedSourceIds,
      source_selection_mode: context.sourceSelectionMode ?? 'explicit',
      source_context_visibility: context.sourceContextVisibility ?? 'public',
      search_result_source_group_ids: context.searchResultSourceGroupIds ?? [],
      focused_source_group_id: context.focusedSourceGroupId ?? null,
      selected_zone_ids: context.selectedZoneIds ?? [],
      zone_scope_mode: context.zoneScopeMode ?? 'all',
      include_simulation_context: includeSimulationContext,
      ...(sessionId && clientTurnId ? { session_id: sessionId, client_turn_id: clientTurnId } : {}),
    }),
  }, 90_000)
  return mapAdvisorResponse(result, clientTurnId ? `${clientTurnId}:assistant` : undefined)
}

function mapAdvisorSessionSummary(session: ApiAdvisorSessionSummary): AdvisorSessionSummary {
  const detail = session as ApiAdvisorSession
  const latestTurn = detail.turns?.[detail.turns.length - 1]
  const latestAnswer = latestTurn?.response.answer ?? latestTurn?.response.content ?? ''
  const detailPreview = latestAnswer.replace(/[#*_>`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return {
    id: session.id,
    farmId: session.farm_id,
    title: session.title,
    preview: session.preview?.trim() || detailPreview || latestTurn?.question || '',
    turnCount: session.turn_count ?? detail.turns?.length ?? 0,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  }
}

function mapStoredAdvisorTurn(turn: ApiAdvisorSessionTurn): AdvisorTurn {
  const result = mapAdvisorResponse(turn.response, `${turn.id}:assistant`)
  const createdAt = formatTime(turn.created_at)
  const controlDrafts = result.controlDrafts.map((draft) => ({ ...draft, advisorMessageId: result.message.id }))
  return {
    id: turn.id,
    recordedAt: turn.created_at,
    stateReview: turn.response.state_review ?? null,
    userMessage: { id: `${turn.id}:user`, role: 'user', content: turn.question, createdAt },
    assistantMessage: { ...result.message, createdAt },
    evidence: result.evidence,
    execution: {
      provider: result.execution.provider,
      privacy: result.execution.privacy,
      requestedModel: result.execution.requestedModel ?? null,
      requestedServiceTier: result.execution.requestedServiceTier ?? null,
      model: result.execution.model ?? null,
      serviceTier: result.execution.serviceTier ?? null,
      fallbackReason: result.execution.fallbackReason ?? null,
    },
    retrieval: result.retrieval,
    responseId: result.responseId,
    controlDrafts,
    toolTrace: result.toolTrace,
    agentRun: result.agentRun,
    queryContext: turn.query_context ? {
      bedId: turn.query_context.bed_id ?? null,
      tier: turn.query_context.tier ?? null,
      cycleId: turn.query_context.cycle_id ?? null,
      videoAnalysisId: turn.query_context.video_analysis_id ?? null,
      selectedSourceIds: turn.query_context.selected_source_ids ?? [],
      includeSimulationContext: turn.query_context.include_simulation_context ?? true,
      selectedZoneIds: turn.query_context.selected_zone_ids ?? [],
      zoneScopeMode: turn.query_context.zone_scope_mode === 'focused' ? 'focused' : 'all',
      sourceVisibility: turn.query_context.source_visibility === 'all' ? 'all' : 'public',
    } : null,
    status: 'complete',
    error: null,
  }
}

export async function getAdvisorSessions(farmId: FarmId): Promise<AdvisorSessionSummary[]> {
  const result = await request<{ sessions: ApiAdvisorSessionSummary[] }>('/v1/advisor/sessions', farmId)
  return result.sessions.map(mapAdvisorSessionSummary)
}

export async function createAdvisorSession(farmId: FarmId, title?: string, reuseTitle = false): Promise<AdvisorSessionSummary> {
  const result = await request<ApiAdvisorSessionSummary>('/v1/advisor/sessions', farmId, {
    method: 'POST',
    body: JSON.stringify({ ...(title ? { title } : {}), ...(reuseTitle ? { reuse_title: true } : {}) }),
  })
  return mapAdvisorSessionSummary(result)
}

export async function getAdvisorSession(farmId: FarmId, sessionId: string): Promise<AdvisorSession> {
  const result = await request<ApiAdvisorSession>(`/v1/advisor/sessions/${encodeURIComponent(sessionId)}`, farmId)
  return { ...mapAdvisorSessionSummary(result), turns: result.turns.map(mapStoredAdvisorTurn) }
}

export async function renameAdvisorSession(farmId: FarmId, sessionId: string, title: string): Promise<AdvisorSessionSummary> {
  const result = await request<ApiAdvisorSessionSummary>(`/v1/advisor/sessions/${encodeURIComponent(sessionId)}`, farmId, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
  return mapAdvisorSessionSummary(result)
}

export async function deleteAdvisorSession(farmId: FarmId, sessionId: string): Promise<void> {
  await request<void>(`/v1/advisor/sessions/${encodeURIComponent(sessionId)}`, farmId, { method: 'DELETE' })
}

export async function declineAdvisorRun(farmId: FarmId, runId: string): Promise<void> {
  await request<void>(`/v1/advisor/runs/${encodeURIComponent(runId)}/decline`, farmId, { method: 'POST' })
}

export async function saveAlertAdvisorTurn(farmId: FarmId, sessionId: string, turnId: string, alertId: string, advisorySnapshot: unknown): Promise<AdvisorTurn> {
  const result = await request<ApiAdvisorSessionTurn>(
    `/v1/advisor/sessions/${encodeURIComponent(sessionId)}/alert-turns/${encodeURIComponent(turnId)}`,
    farmId,
    { method: 'PUT', body: JSON.stringify({ alert_id: alertId, snapshot: advisorySnapshot }) },
    90_000,
  )
  return mapStoredAdvisorTurn(result)
}

function normalizeScope(value: unknown): KnowledgeScope {
  const candidate = String(value ?? '').toLowerCase()
  if (candidate.includes('private') || candidate.includes('farm')) return 'private'
  if (candidate.includes('synthetic') || candidate.includes('demo')) return 'synthetic'
  return 'public'
}

function normalizeStatus(value: unknown): KnowledgeDocument['status'] {
  const candidate = String(value ?? '').toLowerCase()
  if (candidate.includes('queue') || candidate.includes('pending')) return 'queued'
  if (candidate.includes('process') || candidate.includes('index')) return 'processing'
  if (candidate.includes('ready') || candidate.includes('complete')) return 'ready'
  if (candidate.includes('fail') || candidate.includes('error')) return 'failed'
  return 'unknown'
}

function normalizeRetrievalState(value: unknown): KnowledgeRetrievalState {
  return value === 'paused' || value === 'needs_review' ? value : 'active'
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mapKnowledgeDocument(entry: Record<string, unknown>): KnowledgeDocument {
  const rawTags = entry.tags
  return {
    id: String(entry.id ?? entry.document_id ?? ''),
    sourceGroupId: String(entry.source_group_id ?? entry.id ?? entry.document_id ?? ''),
    farmId: typeof entry.farm_id === 'string' && entry.farm_id ? entry.farm_id as FarmId : null,
    title: String(entry.title ?? entry.name ?? '제목 없는 문서'),
    scope: normalizeScope(entry.scope ?? entry.visibility ?? entry.source_scope),
    version: typeof entry.version === 'string' && entry.version.trim() ? entry.version : null,
    retrievalState: normalizeRetrievalState(entry.retrieval_state),
    status: normalizeStatus(entry.status ?? entry.index_status),
    updatedAt: (entry.updated_at ?? entry.created_at ?? null) as string | null,
    chunkCount: numberOrNull(entry.chunk_count ?? entry.chunks),
    vectorCount: numberOrNull(entry.vector_count ?? entry.vectors),
    qdrantVectorCount: numberOrNull(entry.qdrant_vector_count),
    indexBackend: entry.index_backend === 'qdrant' || entry.index_backend === 'sqlite_fallback' ? entry.index_backend : null,
    graphNodeCount: numberOrNull(entry.graph_node_count ?? entry.graph_nodes),
    graphEdgeCount: numberOrNull(entry.graph_edge_count ?? entry.graph_edges),
    sourceName: typeof entry.source_name === 'string' ? entry.source_name : null,
    checksum: typeof entry.checksum === 'string' ? entry.checksum : typeof entry.sha256 === 'string' ? entry.sha256 : null,
    tags: Array.isArray(rawTags) ? rawTags.filter((tag): tag is string => typeof tag === 'string') : [],
    summary: typeof entry.summary === 'string' ? entry.summary : '색인 요약을 준비 중입니다.',
    issuer: typeof entry.issuer === 'string' ? entry.issuer : null,
    publishedYear: numberOrNull(entry.published_year),
    documentType: typeof entry.document_type === 'string' ? entry.document_type : null,
    sourceUrl: typeof entry.source_url === 'string' ? entry.source_url : null,
    summaryProvider: entry.summary_provider === 'provided' || entry.summary_provider === 'llmgateway' ? entry.summary_provider : 'extractive',
    isResearchArchive: entry.is_research_archive === true,
    sourceLocator: typeof entry.source_locator === 'string' ? entry.source_locator : null,
    crop: typeof entry.crop === 'string' ? entry.crop : null,
    cultivationSystem: typeof entry.cultivation_system === 'string' ? entry.cultivation_system : null,
    evidenceClass: typeof entry.evidence_class === 'string' ? entry.evidence_class : null,
    growthStage: typeof entry.growth_stage === 'string' ? entry.growth_stage : null,
    embeddingModel: typeof entry.embedding_model === 'string' ? entry.embedding_model : null,
  }
}

export async function getKnowledge(farmId: FarmId, query = ''): Promise<Resource<KnowledgeDocument[]>> {
  try {
    const suffix = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : ''
    const result = await request<{ documents?: Record<string, unknown>[] } | Record<string, unknown>[]>(`/v1/knowledge/documents${suffix}`, farmId)
    const documents = Array.isArray(result) ? result : result.documents ?? []
    return { data: documents.map(mapKnowledgeDocument), state: 'connected' }
  } catch (error) {
    return { data: [], state: 'unavailable', error: errorMessage(error) }
  }
}

export async function searchKnowledgeSourceGroups(
  farmId: FarmId,
  input: KnowledgeSourceSearchRequest,
): Promise<KnowledgeSourceSearchResult> {
  const result = await request<Record<string, unknown>>('/v1/knowledge/source-groups/search', farmId, {
    method: 'POST',
    body: JSON.stringify({
      query: input.query.trim(),
      visibility: input.visibility ?? 'public',
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  }, 20_000)
  return mapKnowledgeSourceSearchResponse(result)
}

export async function previewKnowledgeSourceCommand(
  farmId: FarmId,
  input: KnowledgeSourceCommandPreviewRequest,
): Promise<KnowledgeSourceCommandPreview> {
  const result = await request<Record<string, unknown>>('/v1/knowledge/source-commands/preview', farmId, {
    method: 'POST',
    body: JSON.stringify({
      instruction: input.instruction.trim(),
      visibility: input.visibility ?? 'public',
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      ...(input.currentSourceGroupIds === undefined ? {} : { current_source_group_ids: input.currentSourceGroupIds }),
      ...(input.searchResultSourceGroupIds === undefined ? {} : { search_result_source_group_ids: input.searchResultSourceGroupIds }),
      ...(input.focusedSourceGroupId === undefined ? {} : { focused_source_group_id: input.focusedSourceGroupId }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  }, 20_000)
  return mapKnowledgeSourceCommandPreviewResponse(result)
}

export type KnowledgeUploadResultKind = 'created' | 'reused' | 'updated' | 'unknown'

export type KnowledgeUploadResult = {
  document: KnowledgeDocument | null
  job: {
    id: string | null
    status: 'running' | 'completed' | 'failed' | 'unknown'
    resultKind: KnowledgeUploadResultKind
  } | null
}

export async function uploadKnowledge(
  farmId: FarmId,
  file: File,
  scope: KnowledgeScope,
  metadata: { title?: string; issuer?: string; publishedYear?: string; sourceUrl?: string } = {},
): Promise<KnowledgeUploadResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('scope', scope)
  if (metadata.title?.trim()) form.append('title', metadata.title.trim())
  if (metadata.issuer?.trim()) form.append('issuer', metadata.issuer.trim())
  if (metadata.publishedYear?.trim()) form.append('published_year', metadata.publishedYear.trim())
  if (metadata.sourceUrl?.trim()) form.append('source_url', metadata.sourceUrl.trim())
  const result = await request<{
    document?: Record<string, unknown>
    job?: { id?: string; status?: string; details?: { result_kind?: string } }
  }>('/v1/knowledge/documents/upload', farmId, { method: 'POST', body: form }, 30_000)
  const rawStatus = String(result.job?.status ?? '').toLowerCase()
  const status = rawStatus === 'running' || rawStatus === 'completed' || rawStatus === 'failed' ? rawStatus : 'unknown'
  const rawResultKind = String(result.job?.details?.result_kind ?? '').toLowerCase()
  const resultKind = rawResultKind === 'created' || rawResultKind === 'reused' || rawResultKind === 'updated' ? rawResultKind : 'unknown'
  return {
    document: result.document ? mapKnowledgeDocument(result.document) : null,
    job: result.job ? { id: result.job.id ?? null, status, resultKind } : null,
  }
}

export type KnowledgeMetadataUpdate = {
  title: string
  issuer?: string
  publishedYear?: number
  sourceUrl?: string
  scope?: 'public' | 'private'
}

export async function updateKnowledgeSourceGroupMetadata(
  farmId: FarmId,
  sourceGroupId: string,
  changes: KnowledgeMetadataUpdate,
): Promise<KnowledgeDocument[]> {
  const result = await request<{ source_group_id: string; documents?: Record<string, unknown>[]; job?: { status?: string } }>(
    '/v1/knowledge/source-groups',
    farmId,
    {
      method: 'PATCH',
      body: JSON.stringify({
        source_group_id: sourceGroupId,
        title: changes.title.trim(),
        ...(changes.issuer?.trim() ? { issuer: changes.issuer.trim() } : {}),
        ...(changes.publishedYear ? { published_year: changes.publishedYear } : {}),
        ...(changes.sourceUrl?.trim() ? { source_url: changes.sourceUrl.trim() } : {}),
        ...(changes.scope ? { scope: changes.scope } : {}),
      }),
    },
  )
  const documents = (result.documents ?? []).map(mapKnowledgeDocument)
  if (!knowledgeSourceGroupUpdateConfirmed(sourceGroupId, result.source_group_id, documents, result.job?.status)) {
    throw new Error('원본 정보 수정 결과를 확인하지 못했습니다.')
  }
  return documents
}

export async function updateKnowledgeRetrievalState(
  farmId: FarmId,
  sourceGroupId: string,
  retrievalState: Exclude<KnowledgeRetrievalState, 'needs_review'>,
): Promise<KnowledgeDocument[]> {
  const result = await request<{ documents?: Record<string, unknown>[]; document?: Record<string, unknown> }>(
    '/v1/knowledge/source-groups/retrieval-state',
    farmId,
    { method: 'PATCH', body: JSON.stringify({ source_group_id: sourceGroupId, retrieval_state: retrievalState }) },
  )
  return (result.documents ?? (result.document ? [result.document] : [])).map(mapKnowledgeDocument)
}

export type KnowledgePreviousRevision = {
  id: string
  createdAt: string
  documentCount: number
  versions: string[]
  changeSummary: string
}

export type KnowledgeRecoverableSourceGroup = {
  sourceGroupId: string
  title: string
  previousRevision: KnowledgePreviousRevision
}

function mapKnowledgePreviousRevision(revision: { id: string; created_at: string; document_count: number; versions: string[]; change_summary: string }): KnowledgePreviousRevision {
  return {
    id: revision.id,
    createdAt: revision.created_at,
    documentCount: revision.document_count,
    versions: revision.versions,
    changeSummary: revision.change_summary,
  }
}

export async function getKnowledgePreviousRevision(farmId: FarmId, sourceGroupId: string): Promise<KnowledgePreviousRevision | null> {
  const result = await request<{
    source_group_id: string
    previous_revision: null | { id: string; created_at: string; document_count: number; versions: string[]; change_summary: string }
  }>(`/v1/knowledge/source-groups/${encodeURIComponent(sourceGroupId)}/revision`, farmId)
  const revision = result.previous_revision
  if (!revision) return null
  return mapKnowledgePreviousRevision(revision)
}

export async function getRecoverableKnowledgeSourceGroups(farmId: FarmId): Promise<KnowledgeRecoverableSourceGroup[]> {
  type RawRevision = { id: string; created_at: string; document_count: number; versions: string[]; change_summary: string }
  type RawSource = { source_group_id: string; title: string; previous_revision: RawRevision }
  const result = await request<{ source_groups?: RawSource[] } | RawSource[]>('/v1/knowledge/source-groups/recoverable', farmId)
  const sources = Array.isArray(result) ? result : result.source_groups ?? []
  return sources.map((source) => ({
    sourceGroupId: source.source_group_id,
    title: source.title,
    previousRevision: mapKnowledgePreviousRevision(source.previous_revision),
  }))
}

export async function restorePreviousKnowledgeRevision(farmId: FarmId, sourceGroupId: string): Promise<KnowledgeDocument[]> {
  const result = await request<{
    source_group_id: string
    documents?: Record<string, unknown>[]
    job?: { status?: string }
  }>(`/v1/knowledge/source-groups/${encodeURIComponent(sourceGroupId)}/restore-previous`, farmId, { method: 'POST', body: JSON.stringify({}) }, 120_000)
  const documents = (result.documents ?? []).map(mapKnowledgeDocument)
  if (!knowledgeSourceGroupRestoreConfirmed(sourceGroupId, result.source_group_id, documents, result.job?.status)) {
    throw new Error('이전 내용 복원 결과를 확인하지 못했습니다.')
  }
  return documents
}

export async function seedKnowledge(farmId: FarmId): Promise<KnowledgeDocument[]> {
  const result = await request<{ documents?: Record<string, unknown>[]; document?: Record<string, unknown> } | Record<string, unknown>[]>('/v1/knowledge/seed', farmId, { method: 'POST', body: JSON.stringify({}) }, 30_000)
  const documents = Array.isArray(result) ? result : result.documents ?? (result.document ? [result.document] : [])
  return documents.map(mapKnowledgeDocument)
}

export async function reindexKnowledge(farmId: FarmId, id: string): Promise<KnowledgeDocument | null> {
  const result = await request<{ document?: Record<string, unknown> }>(`/v1/knowledge/documents/${encodeURIComponent(id)}/reindex`, farmId, { method: 'POST', body: JSON.stringify({}) }, 30_000)
  return result.document ? mapKnowledgeDocument(result.document) : null
}

export type KnowledgeReindexAllResult = {
  jobId: string
  status: 'running' | 'completed' | 'failed'
  processedDocuments: number
  processedChunks: number
  qdrantVectors: number
  activeProvider: string | null
  activeModel: string | null
}

export async function reindexAllKnowledge(farmId: FarmId): Promise<KnowledgeReindexAllResult> {
  const result = await request<{
    job: { id: string; status: 'running' | 'completed' | 'failed' }
    processed_documents: number
    processed_chunks: number
    qdrant_vectors: number
    active_embedding?: { provider?: string; model?: string }
  }>('/v1/knowledge/reindex-all', farmId, { method: 'POST', body: JSON.stringify({}) }, 120_000)
  return {
    jobId: result.job.id,
    status: result.job.status,
    processedDocuments: result.processed_documents,
    processedChunks: result.processed_chunks,
    qdrantVectors: result.qdrant_vectors,
    activeProvider: result.active_embedding?.provider ?? null,
    activeModel: result.active_embedding?.model ?? null,
  }
}

export async function deleteKnowledge(farmId: FarmId, id: string): Promise<void> {
  await request<unknown>(`/v1/knowledge/documents/${encodeURIComponent(id)}`, farmId, { method: 'DELETE' })
}

export async function getReadiness(farmId: FarmId): Promise<Resource<ReadinessService[]>> {
  try {
    let health: Record<string, unknown>
    try {
      health = await request<Record<string, unknown>>('/v1/system/readiness', farmId)
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error
      health = await request<Record<string, unknown>>('/v1/readiness', farmId)
    }
    const rawServices = health.services
    if (Array.isArray(rawServices)) {
      const services = rawServices.map((entry, index): ReadinessService => {
        const service = entry as Record<string, unknown>
        const rawState = String(service.state ?? service.status ?? 'unavailable').toLowerCase()
        const state: ReadinessService['state'] = rawState.includes('ready') || rawState === 'ok'
          ? 'ready'
          : rawState.includes('config')
            ? 'not_configured'
            : rawState.includes('degrad')
              ? 'degraded'
              : 'unavailable'
        return {
          id: String(service.id ?? service.name ?? `service-${index}`),
          label: String(service.label ?? service.name ?? service.id ?? `Service ${index + 1}`),
          state,
          detail: String(service.detail ?? service.message ?? rawState),
        }
      })
      return { data: services, state: services.some((item) => item.state === 'unavailable') ? 'degraded' : 'connected' }
    }
    const dependency = (name: 'telemetry' | 'farm_mcp' | 'qdrant' | 'falkordb', label: string): ReadinessService => {
      const value = health[name] as { configured?: boolean; reachable?: boolean; endpoint?: string } | undefined
      const configured = value?.configured ?? false
      const reachable = value?.reachable ?? false
      return {
        id: name,
        label,
        state: !configured ? 'not_configured' : reachable ? 'ready' : 'unavailable',
        detail: !configured ? '구성되지 않음' : reachable ? '연결 확인됨' : '연결 실패',
      }
    }
    const knowledge = health.knowledge as { status?: string; documents?: number; chunks?: number; backend?: string; embedding?: { provider?: string; model?: string; dimensions?: number; state?: string; degraded?: boolean } } | undefined
    const gateway = health.gateway as { configured?: boolean; reachable?: boolean; connection_state?: string; provider?: string; model?: string; scope?: string; last_success_at?: string | null; last_error?: string | null } | undefined
    const embedding = knowledge?.embedding
    const embeddingDetail = embedding
      ? ` · ${embedding.degraded ? 'degraded' : embedding.provider ?? 'embedding'} · ${embedding.model ?? 'model 미보고'}${embedding.dimensions ? ` (${embedding.dimensions}d)` : ''}`
      : ''
    const readiness: ReadinessService[] = [
      { id: 'api', label: 'Product API', state: health.mode === 'local_prototype' || health.status === 'ok' ? 'ready' : 'degraded', detail: health.mode === 'local_prototype' ? '연결 확인됨' : String(health.mode ?? '상태 확인') },
      dependency('telemetry', 'Telemetry pipeline'),
      dependency('farm_mcp', '장치 연결'),
      dependency('qdrant', 'Qdrant index'),
      dependency('falkordb', 'Evidence graph'),
      { id: 'knowledge', label: 'Knowledge runtime', state: knowledge?.status === 'ready' && !embedding?.degraded ? 'ready' : 'degraded', detail: knowledge ? `${knowledge.documents ?? 0} docs · ${knowledge.chunks ?? 0} chunks · ${knowledge.backend ?? 'unknown'}${embeddingDetail}` : '상태 미보고' },
      {
        id: 'gateway',
        label: 'LLMGateway',
        state: !gateway?.configured ? 'not_configured' : gateway.reachable ? 'ready' : 'degraded',
        detail: !gateway?.configured
          ? '공개 지식 생성 미구성'
          : gateway.reachable
            ? `${gateway.provider ?? 'llmgateway'} · 실제 호출 확인됨${gateway.last_success_at ? ` · ${formatTime(gateway.last_success_at)}` : ''}`
            : `${gateway.provider ?? 'llmgateway'} · ${gateway.connection_state === 'not_tested' ? '구성됨 · 실제 호출 전' : `최근 호출 ${gateway.connection_state ?? '미확인'}`}`,
      },
    ]
    return { data: readiness, state: readiness.some((item) => item.state === 'unavailable') ? 'degraded' : 'connected' }
  } catch (error) {
    return { data: [], state: 'unavailable', error: errorMessage(error) }
  }
}

export type AiSettingsTarget = 'advisor' | 'indexing_llm'
export type LlmServiceTier = 'default' | 'flex' | 'priority'

export type AiProviderSettingsView = {
  provider: string
  endpoint: string | null
  model: string | null
  serviceTier: LlmServiceTier
  apiKeyConfigured: boolean
  source: 'runtime' | 'environment' | 'not_configured'
}

export type AiSettingsResponse = {
  advisor: AiProviderSettingsView
  indexingLlm: AiProviderSettingsView
  embedding: {
    provider: string
    model: string
    activeProvider: string
    activeModel: string
    source: 'runtime' | 'environment' | 'default'
    reindexRequired: boolean
  }
  advisorApplies: 'next_request'
  indexingApplies: 'next_ingestion'
}

export type AiSettingsUpdate = {
  advisor?: { provider: 'llmgateway'; base_url?: string; model?: string; service_tier?: LlmServiceTier; api_key?: string }
  indexing_llm?: { provider: 'llmgateway'; base_url?: string; model?: string; service_tier?: LlmServiceTier; api_key?: string }
  embedding?: { provider: 'fastembed'; model: string }
}

export type AiSettingsTestResult = {
  target: AiSettingsTarget
  configured: boolean
  reachable: boolean
  provider: string
  requestedModel: string | null
  requestedServiceTier: LlmServiceTier | null
  model: string | null
  serviceTier: LlmServiceTier | null
  detail: string
}

function mapAiSettings(result: {
  advisor: { provider: string; endpoint?: string | null; model?: string | null; service_tier?: LlmServiceTier; api_key_configured: boolean; source: AiProviderSettingsView['source'] }
  indexing_llm: { provider: string; endpoint?: string | null; model?: string | null; service_tier?: LlmServiceTier; api_key_configured: boolean; source: AiProviderSettingsView['source'] }
  embedding: { provider: string; model: string; active_provider: string; active_model: string; source: AiSettingsResponse['embedding']['source']; reindex_required: boolean }
  advisor_applies?: 'next_request'
  indexing_applies?: 'next_ingestion'
}): AiSettingsResponse {
  const mapProvider = (item: typeof result.advisor): AiProviderSettingsView => ({
    provider: item.provider,
    endpoint: item.endpoint ?? null,
    model: item.model ?? null,
    serviceTier: item.service_tier ?? 'default',
    apiKeyConfigured: item.api_key_configured,
    source: item.source,
  })
  return {
    advisor: mapProvider(result.advisor),
    indexingLlm: mapProvider(result.indexing_llm),
    embedding: {
      provider: result.embedding.provider,
      model: result.embedding.model,
      activeProvider: result.embedding.active_provider,
      activeModel: result.embedding.active_model,
      source: result.embedding.source,
      reindexRequired: result.embedding.reindex_required,
    },
    advisorApplies: result.advisor_applies ?? 'next_request',
    indexingApplies: result.indexing_applies ?? 'next_ingestion',
  }
}

export async function getAiSettings(farmId: FarmId): Promise<AiSettingsResponse> {
  const result = await request<Parameters<typeof mapAiSettings>[0]>('/v1/system/ai-settings', farmId)
  return mapAiSettings(result)
}

export async function updateAiSettings(farmId: FarmId, settings: AiSettingsUpdate): Promise<AiSettingsResponse> {
  const result = await request<Parameters<typeof mapAiSettings>[0]>('/v1/system/ai-settings', farmId, {
    method: 'PUT',
    body: JSON.stringify(settings),
  }, 30_000)
  return mapAiSettings(result)
}

export async function resetAiSettings(farmId: FarmId): Promise<AiSettingsResponse> {
  const result = await request<Parameters<typeof mapAiSettings>[0]>('/v1/system/ai-settings/reset', farmId, {
    method: 'POST',
    body: JSON.stringify({}),
  }, 30_000)
  return mapAiSettings(result)
}

export async function testAiSettings(farmId: FarmId, target: AiSettingsTarget): Promise<AiSettingsTestResult> {
  const result = await request<{
    target: AiSettingsTarget
    configured: boolean
    reachable: boolean
    provider: string
    requested_model?: string | null
    requested_service_tier?: LlmServiceTier | null
    model?: string | null
    service_tier?: LlmServiceTier | null
    detail: string
  }>('/v1/system/ai-settings/test', farmId, {
    method: 'POST',
    body: JSON.stringify({ target }),
  }, 30_000)
  return {
    ...result,
    requestedModel: result.requested_model ?? null,
    requestedServiceTier: result.requested_service_tier ?? null,
    model: result.model ?? null,
    serviceTier: result.service_tier ?? null,
  }
}

export { ApiError, formatDate, normalizeApiErrorDetail }

export function askAdvisor(...args: Parameters<typeof requestAdvisor>): Promise<AdvisorResult> {
  return advisorRequests.run(args[0], () => requestAdvisor(...args))
}

export async function recheckAdvisor(farmId: FarmId, sessionId: string, responseId: string): Promise<void> {
  await advisorRequests.run(farmId, () => request(`/v1/advisor/sessions/${encodeURIComponent(sessionId)}/recheck`, farmId, { method: 'POST', body: JSON.stringify({ response_id: responseId }) }, 90_000))
}

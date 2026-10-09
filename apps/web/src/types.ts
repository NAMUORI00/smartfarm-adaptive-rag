export type FarmId = 'farm-wasabi-a'

export type Farm = {
  id: FarmId
  name: string
  location: string
  crop: string
  cultivar: string
  cultivationSystem: string
  productionGoal: string
  profileId: string
  growthStage: string
  lotId: string
  nextHarvest: string
  status: 'stable' | 'attention'
}

export type Metric = {
  staleAfterSeconds?: number
  key: string
  label: string
  value: string
  unit: string
  delta: string
  trend: 'up' | 'down' | 'steady'
  tone: 'mint' | 'sun' | 'blue' | 'rose'
  icon: 'thermometer' | 'droplet' | 'cloud' | 'bolt'
  status: 'normal' | 'warning' | 'critical'
  observedAt?: string | null
  zoneId?: string | null
  sensorId?: string | null
  quality?: 'good' | 'suspect' | 'bad' | 'stale' | 'missing'
  source?: string | null
}

export type TelemetryPoint = {
  time: string
  temperature: number
  humidity: number
  co2: number
  ec: number
  rootZoneTemperature: number
  substrateMoisture: number
  irrigationFlow: number
  irrigationPressure: number
  ppfd: number
  supplyPh: number
  drainEc: number
}

export type AdvisorDiagnostics = {
  provider: 'local' | 'llmgateway'
  privacy: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'
  requestedModel: string | null
  requestedServiceTier: 'default' | 'flex' | 'priority' | null
  model: string | null
  serviceTier: 'default' | 'flex' | 'priority' | null
  fallbackReason: string | null
  path: string[]
  gateReason: string
  runId: string | null
  backend: string | null
  candidateCount: number | null
  returnedCount: number | null
  queryScope: string | null
  channels: string[]
}

export type AdvisorExecution = {
  provider: 'local' | 'llmgateway'
  privacy: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'
  requestedModel: string | null
  requestedServiceTier: 'default' | 'flex' | 'priority' | null
  model: string | null
  serviceTier: 'default' | 'flex' | 'priority' | null
  fallbackReason: string | null
}

export type AdvisorToolDevice = {
  key: string
  target: ControlTarget | null
  zoneId: string | null
  label: string
  state: string
  controllable: boolean
  valueType: 'boolean' | 'percentage' | null
  minimum: number | null
  maximum: number | null
}

export type AdvisorToolTrace = {
  intent: 'conversation' | 'knowledge' | 'live_status' | 'control_request'
  status: 'not_required' | 'completed' | 'fallback' | 'unavailable'
  stateSource: 'farm_mcp' | 'telemetry_service' | 'fixture_fallback' | null
  availableTools: string[]
  invokedTools: string[]
  devices: AdvisorToolDevice[]
}

export type AdvisorAgentStep = {
  sequence: number
  kind: 'planning' | 'tool' | 'observation' | 'approval' | 'verification'
  status: 'running' | 'completed' | 'failed'
  label: string
  toolName: string | null
  detail: string | null
}

export type AdvisorAgentRun = {
  runId: string
  status: 'running' | 'awaiting_approval' | 'executing' | 'verifying' | 'completed' | 'failed'
  goal: string
  currentTarget: ControlTarget | null
  steps: AdvisorAgentStep[]
}

export type AdvisorRetrieval = {
  researchDiagnosticsOnly?: boolean
  researchQualityAccepted?: boolean | null
  runId: string | null
  backend: string | null
  candidateCount: number | null
  returnedCount: number | null
  queryScope: string | null
  channels: string[]
  /** How the retrieval-channel policy routed this question (the research module's own decision). */
  route?: { mode: string | null; path: string[]; weights: Record<string, number>; reason: string | null; profileState: string | null; graphReason: string | null }
}

export type ControlTarget =
  | 'root_zone_chiller'
  | 'irrigation_pump'
  | 'ventilation_fan'
  | 'roof_vent'
  | 'side_vent'
  | 'shade_curtain'
  | 'heater'
  | 'air_temperature_sensor_reset'

export type ControlDraft = {
  id: string
  origin: 'verified_telemetry_rule' | 'alert' | 'manual'
  action: 'set_actuator_state' | 'recalibrate_air_temperature_sensor'
  target: ControlTarget
  zoneId: string | null
  value: number | boolean
  rationale: string
  evidenceIds: string[]
  advisorMessageId: string | null
  advisorRunId: string | null
  alertId: string | null
  alertOccurrenceId: string | null
  beforeState: string | number | boolean | null
}

export type Alert = {
  id: string
  occurrenceId: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  detail: string
  time: string
  occurredAt?: string
  status: 'new' | 'acknowledged' | 'resolved'
  kind: 'crop_risk' | 'sensor_health' | 'equipment_fault'
  zoneId: string | null
}

export type AlertAdvisory = {
  alertId: string
  warning: string
  citations: string[]
  evidence: Evidence[]
  provider: 'local' | 'llmgateway'
  privacy: 'local_only' | 'public_only_remote' | 'simulation_and_public_remote'
  requestedModel: string | null
  requestedServiceTier: 'default' | 'flex' | 'priority' | null
  model: string | null
  serviceTier: 'default' | 'flex' | 'priority' | null
  remoteLlmUsed: boolean
  fallbackReason: string | null
  generatedAt: string | null
  cached: boolean
  controlDrafts: ControlDraft[]
  snapshot: unknown
}

export type Evidence = {
  id: string
  sourceId: string
  sourceKind: 'private_simulation' | 'private_knowledge' | 'public_knowledge' | 'synthetic_demo'
  sourceGroupId: string | null
  documentId: string | null
  source: string
  category: string
  excerpt: string
  score: number
  locator: string
  path: 'Dense' | 'Sparse' | 'Graph'
  selected: boolean
  issuer: string | null
  publishedYear: number | null
  documentType: string | null
  sourceUrl: string | null
  summary: string | null
  sourceLocator: string | null
  crop: string | null
  cultivationSystem: string | null
  evidenceClass: string | null
  growthStage: string | null
  embeddingModel: string | null
}

export type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  content: string
  createdAt: string
  evidenceIds?: string[]
  searchPath?: string[]
  gateReason?: string
}

export type AdvisorStateReview = { mode: 'selective' | 'full'; status: 'current' | 'stale' | 'updated' | 'needs_confirmation'; baseline_revision: number; previous_response_id: string | null; refresh_count: number; changed_units?: string[]; units: { id: string; text: string; evidence_ids: string[] }[] }

export type AdvisorTurn = {
  stateReview?: AdvisorStateReview | null
  recordedAt?: string
  id: string
  userMessage: ChatMessage
  assistantMessage: ChatMessage | null
  evidence: Evidence[]
  execution: AdvisorExecution
  retrieval: AdvisorRetrieval
  responseId: string | null
  controlDrafts: ControlDraft[]
  toolTrace: AdvisorToolTrace | null
  agentRun: AdvisorAgentRun | null
  queryContext: AdvisorQueryContext | null
  status: 'loading' | 'complete' | 'error'
  error: string | null
}

export type AdvisorQueryContext = {
  bedId?: string | null
  tier?: number | null
  cycleId?: string | null
  videoAnalysisId?: string | null
  selectedSourceIds: string[]
  includeSimulationContext: boolean
  selectedZoneIds: string[]
  zoneScopeMode: 'all' | 'focused'
  sourceVisibility: 'public' | 'all'
}

export type AdvisorSessionSummary = {
  id: string
  farmId: FarmId
  title: string
  preview: string
  turnCount: number
  createdAt: string
  updatedAt: string
}

export type AdvisorSession = AdvisorSessionSummary & {
  turns: AdvisorTurn[]
}

export type Approval = {
  createdAtIso?: string
  id: string
  target: ControlTarget
  zoneId: string | null
  requestedValue: string
  action: string
  device: string
  proposedBy: string
  reason: string
  impact: string
  status: 'waiting' | 'approved' | 'rejected' | 'failed'
  createdAt: string
  executionStatus: 'not_executed' | 'applied_to_simulator' | 'failed'
  executionId: string | null
  correlationId: string | null
  executedAt: string | null
  failureReason: string | null
  origin: 'verified_telemetry_rule' | 'manual' | null
  advisorRunId: string | null
  evidenceIds: string[]
  alertId: string | null
  alertOccurrenceId: string | null
  verification: ControlVerification | null
}

export type ControlVerification = {
  status: 'verified' | 'mismatch' | 'unavailable'
  outcome: 'device_applied' | 'device_pending' | 'recovery_pending' | 'resolved' | 'unrecovered' | 'mismatch' | 'unavailable'
  checkedAt: string
  targetState: string | null
  requestedValue: string | number | boolean
  detail: string
}

export type ProposalTransition = {
  before: string
  requested: string
}

export type RuntimeState = 'connected' | 'degraded' | 'unavailable'

export type Actuator = {
  key: string
  target?: ControlTarget | null
  label: string
  state: string
  controllable: boolean
  executionScope: 'simulator_only' | 'unknown'
  capability: {
    action: 'set_actuator_state' | 'recalibrate_air_temperature_sensor'
    valueType: 'boolean' | 'percentage'
    minimum: number | null
    maximum: number | null
    step: number | null
    mcpAction: string
  } | null
  zoneId?: string | null
  desiredValue?: number | boolean | null
  reportedValue?: number | boolean | null
  effectiveValue?: number | boolean | null
  unit?: string | null
  mode?: 'scheduled' | 'manual' | 'assisted' | 'off'
  health?: 'normal' | 'degraded' | 'fault' | 'offline'
  commandId?: string | null
  feedbackAt?: string | null
}

export type DerivedIndicator = {
  zoneId: string
  vpdKpa: number
  dliMolM2Day: number
  ecDeltaDsM: number
  rootHeatExposureDegreeMinutes: number
  source: string
}

export type OperationsIncident = {
  id: string
  alertId: string
  occurrenceId: string
  zoneId: string | null
  severity: 'info' | 'warning' | 'critical'
  status: 'open' | 'acknowledged' | 'recovering' | 'resolved'
  message: string
  openedAt: string
  lastObservedAt: string
  resolvedAt: string | null
}

export type OperationsClock = {
  speed: 1 | 5 | 10
  paused: boolean
  seed: number
  revision: number
}

export type AuditEvent = {
  id: string
  eventType: string
  actorId: string
  createdAt: string
  details: Record<string, unknown>
}

export type KnowledgeScope = 'public' | 'private' | 'synthetic'
export type KnowledgeRetrievalState = 'active' | 'paused' | 'needs_review'

export type KnowledgeDocument = {
  id: string
  sourceGroupId: string
  farmId: FarmId | null
  title: string
  scope: KnowledgeScope
  version: string | null
  retrievalState: KnowledgeRetrievalState
  status: 'queued' | 'processing' | 'ready' | 'failed' | 'unknown'
  updatedAt: string | null
  chunkCount: number | null
  vectorCount: number | null
  qdrantVectorCount: number | null
  indexBackend: 'qdrant' | 'sqlite_fallback' | null
  graphNodeCount: number | null
  graphEdgeCount: number | null
  sourceName: string | null
  checksum: string | null
  tags: string[]
  summary: string
  issuer: string | null
  publishedYear: number | null
  documentType: string | null
  sourceUrl: string | null
  summaryProvider: 'extractive' | 'provided' | 'llmgateway'
  isResearchArchive: boolean
  sourceLocator: string | null
  crop: string | null
  cultivationSystem: string | null
  evidenceClass: string | null
  growthStage: string | null
  embeddingModel: string | null
}

export type SourceCommandOperation = 'search' | 'add' | 'replace' | 'remove' | 'clear'
export type SourceCommandVisibility = 'public' | 'all'

export type KnowledgeSourceSearchMatch = {
  sourceGroupId: string
  title: string
  visibility: 'public' | 'private'
  score: number
  matchReasons: string[]
  documentCount: number
}

export type KnowledgeSourceSearchResult = {
  query: string
  visibility: SourceCommandVisibility
  sourceGroups: KnowledgeSourceSearchMatch[]
  count: number
}

export type KnowledgeSourceSearchRequest = {
  query: string
  visibility?: SourceCommandVisibility
  limit?: number
}

export type KnowledgeSourceCommandPreview = {
  operation: SourceCommandOperation
  query: string | null
  visibility: SourceCommandVisibility
  matchedSourceGroupIds: string[]
  sourceGroupIds: string[]
  count: number
  resultCount: number
  clarification: string | null
  error: string | null
}

export type KnowledgeSourceCommandPreviewRequest = {
  instruction: string
  operation?: SourceCommandOperation
  currentSourceGroupIds?: string[]
  searchResultSourceGroupIds?: string[]
  focusedSourceGroupId?: string | null
  visibility?: SourceCommandVisibility
  limit?: number
}

export type ReadinessService = {
  id: string
  label: string
  state: 'ready' | 'degraded' | 'unavailable' | 'not_configured'
  detail: string
}

export type DashboardSnapshot = {
  updatedAt: string
  metrics: Metric[]
  telemetry: TelemetryPoint[]
  telemetryByZone: Record<string, TelemetryPoint[]>
  alerts: Alert[]
  dailyBrief: string
  actuators: Actuator[]
  dataOrigin: 'telemetry_service' | 'fixture_fallback' | 'unknown'
  dataMode: 'simulated' | 'real' | 'mixed' | 'unavailable'
  inputMode: 'demo' | 'replay' | 'live' | 'mixed' | 'unavailable'
  operationalControlAllowed: boolean
  generatedAt: string
  activeScenarioIds: string[]
  zones: string[]
  derivedIndicators: DerivedIndicator[]
  incidents: OperationsIncident[]
  clock: OperationsClock | null
}

export type OperationCaseEvidence = {
  sourceId: string
  title: string
  kind: 'document' | 'operation'
  issuer: string | null
  sourceUrl: string | null
  sourceLocator: string | null
}

export type OperationCaseAction = {
  proposalId: string
  status: 'pending_approval' | 'approved' | 'rejected' | 'failed'
  target: string
  zoneId: string | null
  requestedValue: string | number | boolean
  rationale: string
  createdAt: string
  approvedAt: string | null
  approvedBy: string | null
  executionId: string | null
  executedAt: string | null
  expectedEffects: string[]
  verification: ControlVerification | null
  /** Set when the server's alert rule drafted the change (not a person picking it). */
  aiJudgmentSummary?: string | null
}

export type OperationCaseTimelineItem = {
  id: string
  stage: 'detected' | 'acknowledged' | 'evidence' | 'proposed' | 'decision' | 'executed' | 'verified' | 'resolved' | 'handoff'
  state: 'completed' | 'current' | 'attention'
  occurredAt: string | null
  title: string
  detail: string
}

export type OperationCase = {
  id: string
  incidentId: string
  alertId: string
  occurrenceId: string
  title: string
  zoneId: string | null
  severity: 'info' | 'warning' | 'critical'
  status: 'needs_action' | 'awaiting_approval' | 'monitoring' | 'resolved' | 'handoff'
  recoveryVerdict: 'not_measured' | 'pending' | 'recovered' | 'unrecovered'
  dataMode: DashboardSnapshot['dataMode']
  inputMode: DashboardSnapshot['inputMode']
  openedAt: string
  lastObservedAt: string
  acknowledgedAt: string | null
  resolvedAt: string | null
  expectedOutcome: string
  observedOutcome: string
  nextAction: string
  evidence: OperationCaseEvidence[]
  actions: OperationCaseAction[]
  timeline: OperationCaseTimelineItem[]
}

export type GatewayStatus = {
  state: 'not_connected' | 'ready' | 'degraded' | 'stale' | 'unavailable'
  readOnly: boolean
  source: string | null
  observedAt: string | null
  ageSeconds: number | null
  messageId: string | null
  sequence: number | null
  metricCount: number
  expectedMetricCount: number
  completenessPercent: number
  missingMetrics: string[]
  qualityCounts: Record<string, number>
  duplicateSensorMetrics: number
  unitErrors: number
  rejectedMessageCount: number
  rejectionCounts: Record<string, number>
  lastRejectionAt: string | null
  lastRejectionReason: string | null
  inputMode: DashboardSnapshot['inputMode']
}

export type CultivationStrategyThreshold = {
  metric: string
  lower: number | null
  upper: number | null
  unit: string
  sourceId: string | null
}

export type CultivationStrategyVersion = {
  versionId: string
  growthStage: string
  thresholds: CultivationStrategyThreshold[]
  evidenceSourceIds: string[]
  changeNote: string
  createdBy: string
  createdAt: string
  active: boolean
}

export type CultivationStrategyApplication = {
  versionId: string
  eventType: 'baseline' | 'apply' | 'rollback'
  actorId: string
  appliedAt: string
  fromVersionId: string | null
}

export type CultivationStrategies = {
  activeVersionId: string
  versions: CultivationStrategyVersion[]
  history: CultivationStrategyApplication[]
  sync: {
    desiredVersionId: string
    appliedVersionId: string
    runtimeVersionId: string | null
    state: 'synced' | 'pending' | 'failed' | 'out_of_sync'
    updatedAt: string
    lastError: string | null
  }
}

export type OperationMetrics = {
  lotId: string
  growthStage: string
  windowHours: number
  generatedAt: string
  incidentCount: number
  activeCount: number
  resolvedCount: number
  handoffCount: number
  acknowledgeMedianMinutes: number | null
  approvalMedianMinutes: number | null
  recoveryMedianMinutes: number | null
  recoveryRatePercent: number | null
  gatewayMissingRatePercent: number | null
  sourceGrain: string
}

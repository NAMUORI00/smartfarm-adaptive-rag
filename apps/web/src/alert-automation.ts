import type { Alert, AlertAdvisory } from './types'

export type AlertAutomationSettings = {
  enabled: boolean
  cropRisk: boolean
  sensorHealth: boolean
  equipmentFault: boolean
  showToast: boolean
  liveUpdates: boolean
}

export const ALERT_AUTOMATION_STORAGE_KEY = 'smartfarm.operator-preferences.v1'
export const ALERT_ANALYSIS_RETRY_MS = 30_000
export const MAX_CONCURRENT_ALERT_ANALYSES = 2
export const MAX_AUTOMATIC_ALERT_ATTEMPTS = 3

export type AlertAnalysisFailure = { token: string; retryAt: number; attempts: number }

export const defaultAlertAutomationSettings: AlertAutomationSettings = {
  enabled: true,
  cropRisk: true,
  sensorHealth: true,
  equipmentFault: true,
  showToast: true,
  liveUpdates: true,
}

const settingKeys = Object.keys(defaultAlertAutomationSettings) as Array<keyof AlertAutomationSettings>

export function parseAlertAutomationSettings(raw: string | null): AlertAutomationSettings {
  if (!raw) return { ...defaultAlertAutomationSettings }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return settingKeys.reduce((settings, key) => ({
      ...settings,
      [key]: typeof parsed[key] === 'boolean' ? parsed[key] : settings[key],
    }), { ...defaultAlertAutomationSettings })
  } catch {
    return { ...defaultAlertAutomationSettings }
  }
}

export function loadAlertAutomationSettings(): AlertAutomationSettings {
  if (typeof window === 'undefined') return { ...defaultAlertAutomationSettings }
  try {
    return parseAlertAutomationSettings(window.localStorage.getItem(ALERT_AUTOMATION_STORAGE_KEY))
  } catch {
    return { ...defaultAlertAutomationSettings }
  }
}

export function saveAlertAutomationSettings(settings: AlertAutomationSettings): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ALERT_AUTOMATION_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // The preference still applies for this session when storage is unavailable.
  }
}

export function shouldAutoAnalyzeAlert(alert: Alert, settings: AlertAutomationSettings): boolean {
  if (!settings.enabled || alert.status !== 'new') return false
  if (alert.kind === 'crop_risk') return settings.cropRisk
  if (alert.kind === 'sensor_health') return settings.sensorHealth
  return settings.equipmentFault
}

export function prioritizeAlertsForAnalysis(alerts: Alert[]): Alert[] {
  const severityRank: Record<Alert['severity'], number> = { critical: 0, warning: 1, info: 2 }
  return [...alerts].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])
}

export function alertAutomationFingerprint(alert: Alert): string {
  return JSON.stringify([alert.id, alert.occurrenceId, alert.kind, alert.severity, alert.title, alert.detail])
}

export function alertLifecycleToken(version: number, alert: Alert): string {
  return `${version}:${alertAutomationFingerprint(alert)}`
}

export function canStartAutomaticAlertAnalysis(input: {
  token: string
  completedToken?: string
  failure?: AlertAnalysisFailure
  inFlight: boolean
  inFlightCount: number
  now: number
}): boolean {
  if (input.inFlight || input.inFlightCount >= MAX_CONCURRENT_ALERT_ANALYSES) return false
  if (input.completedToken === input.token) return false
  if (input.failure?.token === input.token) {
    if (input.failure.attempts >= MAX_AUTOMATIC_ALERT_ATTEMPTS || input.failure.retryAt > input.now) return false
  }
  return true
}

export function shouldAcceptAutomaticAlertResult(
  alert: Alert,
  settings: AlertAutomationSettings,
  requestedToken: string,
  activeToken: string | undefined,
): boolean {
  return requestedToken === activeToken && settings.liveUpdates && shouldAutoAnalyzeAlert(alert, settings)
}

export function isRetryableAlertFallback(advisory: AlertAdvisory): boolean {
  return !advisory.remoteLlmUsed && advisory.requestedModel !== null
}

export function nextAlertAnalysisFailure(previousAttempts: number, automatic: boolean, now: number): Omit<AlertAnalysisFailure, 'token'> & { retrying: boolean } {
  const attempts = automatic ? previousAttempts + 1 : MAX_AUTOMATIC_ALERT_ATTEMPTS
  const retrying = automatic && attempts < MAX_AUTOMATIC_ALERT_ATTEMPTS
  return {
    attempts,
    retrying,
    retryAt: retrying ? now + ALERT_ANALYSIS_RETRY_MS : Number.POSITIVE_INFINITY,
  }
}

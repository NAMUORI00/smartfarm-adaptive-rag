import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ALERT_ANALYSIS_RETRY_MS,
  alertAutomationFingerprint,
  alertLifecycleToken,
  canStartAutomaticAlertAnalysis,
  defaultAlertAutomationSettings,
  isRetryableAlertFallback,
  MAX_AUTOMATIC_ALERT_ATTEMPTS,
  nextAlertAnalysisFailure,
  parseAlertAutomationSettings,
  prioritizeAlertsForAnalysis,
  shouldAcceptAutomaticAlertResult,
  shouldAutoAnalyzeAlert,
} from './alert-automation.ts'
import type { Alert } from './types.ts'
import type { AlertAdvisory } from './types.ts'

const baseAlert: Alert = {
  id: 'alert-1',
  occurrenceId: 'occurrence-1',
  severity: 'warning',
  title: '근권 온도 상승',
  detail: '근권 온도가 운영 범위를 벗어났습니다.',
  time: '10:30',
  status: 'new',
  kind: 'crop_risk',
}

test('alert automation defaults are enabled and invalid storage is recovered', () => {
  assert.deepEqual(parseAlertAutomationSettings(null), defaultAlertAutomationSettings)
  assert.deepEqual(parseAlertAutomationSettings('{broken'), defaultAlertAutomationSettings)
  assert.deepEqual(parseAlertAutomationSettings('{"enabled":false}'), {
    ...defaultAlertAutomationSettings,
    enabled: false,
  })
})

test('master and alert-kind switches independently gate automatic analysis', () => {
  assert.equal(shouldAutoAnalyzeAlert(baseAlert, defaultAlertAutomationSettings), true)
  assert.equal(shouldAutoAnalyzeAlert(baseAlert, { ...defaultAlertAutomationSettings, enabled: false }), false)
  assert.equal(shouldAutoAnalyzeAlert(baseAlert, { ...defaultAlertAutomationSettings, cropRisk: false }), false)
  assert.equal(shouldAutoAnalyzeAlert({ ...baseAlert, kind: 'sensor_health' }, { ...defaultAlertAutomationSettings, sensorHealth: false }), false)
  assert.equal(shouldAutoAnalyzeAlert({ ...baseAlert, kind: 'equipment_fault' }, { ...defaultAlertAutomationSettings, equipmentFault: false }), false)
  assert.equal(shouldAutoAnalyzeAlert({ ...baseAlert, status: 'resolved' }, defaultAlertAutomationSettings), false)
})

test('fingerprint is stable across polling but changes when alert meaning changes', () => {
  assert.equal(alertAutomationFingerprint(baseAlert), alertAutomationFingerprint({ ...baseAlert, time: '10:31' }))
  assert.notEqual(alertAutomationFingerprint(baseAlert), alertAutomationFingerprint({ ...baseAlert, occurrenceId: 'occurrence-2' }))
  assert.notEqual(alertAutomationFingerprint(baseAlert), alertAutomationFingerprint({ ...baseAlert, severity: 'critical' }))
  assert.notEqual(alertAutomationFingerprint(baseAlert), alertAutomationFingerprint({ ...baseAlert, detail: '새로운 관측 내용' }))
})

test('all eligible alerts are retained and critical alerts are analyzed first', () => {
  const alerts = [
    { ...baseAlert, id: 'info', severity: 'info' as const },
    { ...baseAlert, id: 'warning-1' },
    { ...baseAlert, id: 'critical', severity: 'critical' as const },
    { ...baseAlert, id: 'warning-2' },
  ]
  assert.deepEqual(prioritizeAlertsForAnalysis(alerts).map((alert) => alert.id), ['critical', 'warning-1', 'warning-2', 'info'])
})

test('automatic start policy bounds concurrency, deduplicates, and honors retry cooldown', () => {
  const token = alertLifecycleToken(1, baseAlert)
  const allowed = { token, inFlight: false, inFlightCount: 0, now: 1_000 }
  assert.equal(canStartAutomaticAlertAnalysis(allowed), true)
  assert.equal(canStartAutomaticAlertAnalysis({ ...allowed, inFlight: true }), false)
  assert.equal(canStartAutomaticAlertAnalysis({ ...allowed, inFlightCount: 2 }), false)
  assert.equal(canStartAutomaticAlertAnalysis({ ...allowed, completedToken: token }), false)
  assert.equal(canStartAutomaticAlertAnalysis({ ...allowed, failure: { token, attempts: 1, retryAt: 1_001 } }), false)
  assert.equal(canStartAutomaticAlertAnalysis({ ...allowed, failure: { token, attempts: MAX_AUTOMATIC_ALERT_ATTEMPTS, retryAt: 0 } }), false)
  assert.equal(canStartAutomaticAlertAnalysis({ ...allowed, failure: { token, attempts: 1, retryAt: 999 } }), true)
})

test('stale or disabled automatic results are rejected', () => {
  const token = alertLifecycleToken(2, baseAlert)
  assert.equal(shouldAcceptAutomaticAlertResult(baseAlert, defaultAlertAutomationSettings, token, token), true)
  assert.equal(shouldAcceptAutomaticAlertResult(baseAlert, defaultAlertAutomationSettings, token, alertLifecycleToken(3, baseAlert)), false)
  assert.equal(shouldAcceptAutomaticAlertResult(baseAlert, { ...defaultAlertAutomationSettings, enabled: false }, token, token), false)
  assert.equal(shouldAcceptAutomaticAlertResult(baseAlert, { ...defaultAlertAutomationSettings, liveUpdates: false }, token, token), false)
})

test('automatic failures retry twice at a bounded interval and manual failures wait for the operator', () => {
  const first = nextAlertAnalysisFailure(0, true, 10_000)
  assert.deepEqual(first, { attempts: 1, retrying: true, retryAt: 10_000 + ALERT_ANALYSIS_RETRY_MS })
  const exhausted = nextAlertAnalysisFailure(2, true, 10_000)
  assert.equal(exhausted.attempts, MAX_AUTOMATIC_ALERT_ATTEMPTS)
  assert.equal(exhausted.retrying, false)
  assert.equal(exhausted.retryAt, Number.POSITIVE_INFINITY)
  assert.equal(nextAlertAnalysisFailure(0, false, 10_000).retrying, false)
})

test('only a configured provider fallback is retried automatically', () => {
  const advisory: AlertAdvisory = {
    alertId: baseAlert.id,
    warning: '로컬 안내',
    citations: [],
    evidence: [],
    provider: 'local',
    privacy: 'local_only',
    requestedModel: 'openai/gpt-5.6-luna',
    requestedServiceTier: 'priority',
    model: null,
    serviceTier: null,
    remoteLlmUsed: false,
    fallbackReason: 'provider timeout',
    generatedAt: null,
    cached: false,
    controlDrafts: [],
    snapshot: {},
  }
  assert.equal(isRetryableAlertFallback(advisory), true)
  assert.equal(isRetryableAlertFallback({ ...advisory, requestedModel: null }), false)
  assert.equal(isRetryableAlertFallback({ ...advisory, remoteLlmUsed: true }), false)
})

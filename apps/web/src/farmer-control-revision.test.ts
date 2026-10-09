import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceRevision } from './farmer/workspace-state.ts'
import type { Actuator, DashboardSnapshot } from './types.ts'

const snapshot = { operationalControlAllowed: true, alerts: [] } as unknown as DashboardSnapshot
const fan = {
  key: 'fan', zoneId: 'zone-a', capability: { valueType: 'percentage' },
  reportedValue: 74.1, desiredValue: 74.1, mode: 'scheduled', health: 'normal',
} as unknown as Actuator

test('confirmation survives feedback drift only while its displayed percentage is unchanged', () => {
  assert.equal(deviceRevision(fan, snapshot), deviceRevision({...fan, reportedValue:74.2, desiredValue:74.2}, snapshot))
  assert.notEqual(deviceRevision(fan, snapshot), deviceRevision({...fan, reportedValue:75}, snapshot))
  assert.notEqual(deviceRevision(fan, snapshot), deviceRevision({...fan, desiredValue:80}, snapshot))
})

test('mode, fault, permission and related incident changes invalidate confirmation', () => {
  const baseline = deviceRevision(fan, snapshot)
  for (const change of [{mode:'manual'}, {health:'fault'}])
    assert.notEqual(baseline, deviceRevision({...fan, ...change} as Actuator, snapshot))
  assert.notEqual(baseline, deviceRevision(fan, {...snapshot, operationalControlAllowed:false}))
  assert.notEqual(baseline, deviceRevision(fan, {...snapshot, alerts:[{zoneId:'zone-a',status:'new',occurrenceId:'new-event'}] as DashboardSnapshot['alerts']}))
  assert.equal(baseline, deviceRevision(fan, {...snapshot, alerts:[{zoneId:'zone-b',status:'new',occurrenceId:'other-event'}] as DashboardSnapshot['alerts']}))
})

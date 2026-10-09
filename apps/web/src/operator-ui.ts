import type { Actuator, ControlTarget } from './types'

export type DeviceCategory = 'all' | 'environment' | 'irrigation' | 'ventilation' | 'sensor'

const controlTargets = new Set<ControlTarget>(['root_zone_chiller', 'irrigation_pump', 'ventilation_fan', 'roof_vent', 'side_vent', 'shade_curtain', 'heater', 'air_temperature_sensor_reset'])

export function logicalControlTarget(value: string | null | undefined): ControlTarget | null {
  const candidate = value?.split(':').at(-1)
  return candidate && controlTargets.has(candidate as ControlTarget) ? candidate as ControlTarget : null
}

export function actuatorControlTarget(actuator: Pick<Actuator, 'key' | 'target'>) {
  return actuator.target ?? logicalControlTarget(actuator.key)
}

export function actuatorCanBeControlled(actuator: Pick<Actuator, 'key' | 'target' | 'zoneId' | 'controllable'>) {
  return Boolean(actuator.controllable && actuator.zoneId && actuatorControlTarget(actuator))
}

export function controlIdentity(target: ControlTarget, zoneId?: string | null) {
  return `${zoneId ?? 'unscoped'}:${target}`
}

export function sameControlScope(left: { target: ControlTarget; zoneId?: string | null }, right: { target: ControlTarget; zoneId?: string | null }) {
  return left.target === right.target && (left.zoneId ?? null) === (right.zoneId ?? null)
}

export function actuatorForControl(actuators: Actuator[], target: ControlTarget, zoneId?: string | null) {
  return actuators.find((actuator) => (
    actuatorControlTarget(actuator) === target
    && (actuator.zoneId ?? null) === (zoneId ?? null)
  )) ?? null
}

export function deviceCategoryForKey(key: string): Exclude<DeviceCategory, 'all'> {
  const target = key.split(':').at(-1) ?? key
  if (target === 'irrigation_pump' || target === 'nutrient_dosing') return 'irrigation'
  if (target === 'ventilation_fan' || target === 'roof_vent' || target === 'side_vent') return 'ventilation'
  if (target.includes('sensor')) return 'sensor'
  return 'environment'
}

export function filterDevices(actuators: Actuator[], category: DeviceCategory, zoneId: 'all' | string = 'all') {
  return actuators.filter((actuator) => (
    (zoneId === 'all' || actuator.zoneId === zoneId)
    && (category === 'all' || deviceCategoryForKey(actuatorControlTarget(actuator) ?? '') === category)
  ))
}

export function deviceScopeLabel(actuator: Pick<Actuator, 'zoneId'>) {
  if (actuator.zoneId === 'zone-a') return 'A동 1구역'
  if (actuator.zoneId === 'zone-b') return 'A동 2구역'
  return '구역 미확인'
}

export function deviceActionLabel(target: ControlTarget, value: number | boolean) {
  if (target === 'air_temperature_sensor_reset') return '센서 다시 맞추기'
  if (typeof value === 'number') {
    const amount = `${Math.round(value)}%`
    if (target === 'roof_vent') return `천창 개도율 ${amount}로 조정`
    if (target === 'side_vent') return `측창 개도율 ${amount}로 조정`
    if (target === 'shade_curtain') return `차광률 ${amount}로 조정`
    return `환기팬 ${amount}로 조정`
  }
  if (target === 'root_zone_chiller') return value ? '냉각 시작' : '냉각 중지'
  if (target === 'irrigation_pump') return value ? '펌프 켜기' : '펌프 끄기'
  if (target === 'heater') return value ? '난방 시작' : '난방 중지'
  return value ? '장치 켜기' : '장치 끄기'
}

export function normalizedPercent(value: number, minimum = 0, maximum = 100) {
  if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return 0
  return Math.min(100, Math.max(0, ((value - minimum) / (maximum - minimum)) * 100))
}

export function actuatorStateIsEnabled(value: string | number | boolean) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  const numeric = Number.parseFloat(value)
  if (Number.isFinite(numeric)) return numeric > 0
  return /^(on|true|active|open)$/i.test(value.trim())
}

export function deviceStateWithMode(mode: Actuator['mode'], currentState: string) {
  if (mode === 'scheduled') return `예약됨 · 현재 ${currentState}`
  if (mode === 'manual') return `직접 조정 · 현재 ${currentState}`
  return currentState
}

export function sensorStability(metrics: Array<{ status: 'normal' | 'warning' | 'critical'; quality?: 'good' | 'suspect' | 'bad' | 'stale' | 'missing' }>) {
  const valid = metrics.filter((metric) => !metric.quality || !['bad', 'stale', 'missing'].includes(metric.quality))
  const normal = valid.filter((metric) => metric.status === 'normal').length
  return {
    percent: valid.length ? Math.round(normal / valid.length * 100) : null,
    normal,
    valid: valid.length,
    total: metrics.length,
    needsReview: metrics.length - valid.length,
  }
}

import type { Metric, TelemetryPoint } from './types.ts'

const metricFields: Array<[string, keyof Omit<TelemetryPoint, 'time'>]> = [
  ['air_temperature_c', 'temperature'],
  ['relative_humidity_pct', 'humidity'],
  ['co2_ppm', 'co2'],
  ['supply_ec_ds_m', 'ec'],
  ['root_zone_temperature_c', 'rootZoneTemperature'],
  ['substrate_moisture_pct', 'substrateMoisture'],
  ['irrigation_flow_l_min', 'irrigationFlow'],
  ['irrigation_pressure_bar', 'irrigationPressure'],
  ['ppfd_umol_m2_s', 'ppfd'],
  ['supply_ph', 'supplyPh'],
  ['drain_ec_ds_m', 'drainEc'],
]

export function synchronizeTelemetryLatest(points: TelemetryPoint[], metrics: Metric[]) {
  if (!points.length) return points
  const current = new Map(
    metrics
      .filter((metric) => metric.quality !== 'bad' && metric.quality !== 'stale' && metric.quality !== 'missing')
      .map((metric) => [metric.key, Number.parseFloat(metric.value)]),
  )
  const latest = { ...points.at(-1)! }
  for (const [metricKey, field] of metricFields) {
    const value = current.get(metricKey)
    if (value !== undefined && Number.isFinite(value)) latest[field] = value
  }
  return [...points.slice(0, -1), latest]
}

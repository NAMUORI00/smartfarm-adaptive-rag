export const MAX_TREND_SAMPLES = 120
export const DEFAULT_TREND_SAMPLES = 48

export type SensorTrendField =
  | 'temperature'
  | 'humidity'
  | 'rootZoneTemperature'
  | 'substrateMoisture'
  | 'ec'
  | 'supplyPh'

export type SensorTrendMetric = {
  key: string
  label: string
  unit: string
  precision: number
  field: SensorTrendField
}

export type SensorTrendGroup = {
  id: 'environment' | 'root-zone' | 'nutrient'
  label: '환경' | '근권' | '양액'
  metrics: readonly SensorTrendMetric[]
}

export type TrendTelemetryPoint = {
  time: string
  temperature?: number | null
  humidity?: number | null
  rootZoneTemperature?: number | null
  substrateMoisture?: number | null
  ec?: number | null
  supplyPh?: number | null
}

export type SensorTrendSample = {
  time: string
  value: number
}

export type SvgTrendPoint = SensorTrendSample & {
  x: number
  y: number
}

export type RecentDelta = {
  value: number
  label: string
  direction: 'up' | 'down' | 'steady'
}

export const sensorTrendGroups: readonly SensorTrendGroup[] = [
  {
    id: 'environment', label: '환경', metrics: [
      { key: 'air_temperature_c', label: '공기 온도', unit: '°C', precision: 1, field: 'temperature' },
      { key: 'relative_humidity_pct', label: '상대 습도', unit: '%', precision: 1, field: 'humidity' },
    ],
  },
  {
    id: 'root-zone', label: '근권', metrics: [
      { key: 'root_zone_temperature_c', label: '근권 온도', unit: '°C', precision: 1, field: 'rootZoneTemperature' },
      { key: 'substrate_moisture_pct', label: '배지 수분', unit: '%', precision: 1, field: 'substrateMoisture' },
    ],
  },
  {
    id: 'nutrient', label: '양액', metrics: [
      { key: 'supply_ec_ds_m', label: '공급 EC', unit: 'dS/m', precision: 2, field: 'ec' },
      { key: 'supply_ph', label: '공급 pH', unit: 'pH', precision: 2, field: 'supplyPh' },
    ],
  },
]

const sensorTrendMetrics = new Map<string, SensorTrendMetric>(
  sensorTrendGroups.flatMap((group) => group.metrics).map((metric) => [metric.key, metric]),
)

export function getSensorTrendDefinition(metricKey: string) {
  return sensorTrendMetrics.get(metricKey) ?? null
}

function boundedSampleCount(requested: number) {
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_TREND_SAMPLES
  return Math.min(Math.floor(requested), MAX_TREND_SAMPLES)
}

function sortableTime(value: string) {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (clock) {
    const hours = Number(clock[1])
    const minutes = Number(clock[2])
    const seconds = Number(clock[3] ?? 0)
    if (hours < 24 && minutes < 60 && seconds < 60) return hours * 3600 + minutes * 60 + seconds
    return null
  }
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function selectSensorTrendSamples(
  telemetryByZone: Readonly<Record<string, readonly TrendTelemetryPoint[]>>,
  zoneId: string,
  metricKey: string,
  maxSamples = DEFAULT_TREND_SAMPLES,
) {
  const definition = getSensorTrendDefinition(metricKey)
  if (!definition) return []

  const samples = (telemetryByZone[zoneId] ?? []).flatMap<SensorTrendSample>((point) => {
    const value = point[definition.field]
    return typeof value === 'number' && Number.isFinite(value) ? [{ time: point.time, value }] : []
  })
  const times = samples.map((sample) => sortableTime(sample.time))
  const chronological = times.every((time) => time !== null)
    ? samples.map((sample, index) => ({ sample, order: times[index]! }))
      .sort((left, right) => left.order - right.order)
      .map(({ sample }) => sample)
    : samples

  return chronological.slice(-boundedSampleCount(maxSamples))
}

export function normalizeSvgPoints(
  samples: readonly SensorTrendSample[],
  width: number,
  height: number,
  padding = 2,
  maxSamples = DEFAULT_TREND_SAMPLES,
): SvgTrendPoint[] {
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return []
  const safePadding = Number.isFinite(padding)
    ? Math.max(0, Math.min(padding, Math.min(width, height) / 2))
    : 0
  const finiteSamples = samples
    .filter((sample) => Number.isFinite(sample.value))
    .slice(-boundedSampleCount(maxSamples))
  if (!finiteSamples.length) return []

  const values = finiteSamples.map((sample) => sample.value)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const span = maximum - minimum
  const drawableWidth = Math.max(width - safePadding * 2, 0)
  const drawableHeight = Math.max(height - safePadding * 2, 0)

  return finiteSamples.map((sample, index) => ({
    ...sample,
    x: finiteSamples.length === 1
      ? width / 2
      : safePadding + (index / (finiteSamples.length - 1)) * drawableWidth,
    y: span === 0
      ? height / 2
      : safePadding + ((maximum - sample.value) / span) * drawableHeight,
  }))
}

export function recentDelta(
  samples: readonly SensorTrendSample[],
  unit: string,
  precision = 1,
): RecentDelta | null {
  const finite = samples.filter((sample) => Number.isFinite(sample.value))
  if (finite.length < 2) return null
  const safePrecision = Number.isInteger(precision) ? Math.max(0, Math.min(precision, 4)) : 1
  const scale = 10 ** safePrecision
  const value = Math.round((finite.at(-1)!.value - finite[0].value) * scale) / scale
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'steady'
  const sign = value > 0 ? '+' : ''
  return {
    value,
    direction,
    label: `${sign}${value.toFixed(safePrecision)}${unit ? ` ${unit}` : ''}`,
  }
}

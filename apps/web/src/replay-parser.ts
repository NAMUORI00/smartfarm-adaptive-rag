import type { OperationsReplayObservation } from './api'

type FlatReplayRow = {
  observed_at: string
  metric: string
  value: unknown
  unit: string
  zone_id?: string
  sensor_id?: string
  quality?: string
}

const qualities = new Set(['good', 'suspect', 'bad', 'stale', 'missing'])

function csvCells(line: string) {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"'
      index += 1
    } else if (char === '"') quoted = !quoted
    else if (char === ',' && !quoted) {
      cells.push(value.trim())
      value = ''
    } else value += char
  }
  if (quoted) throw new Error('CSV 따옴표가 닫히지 않았습니다.')
  cells.push(value.trim())
  return cells
}

function normalizedRow(row: FlatReplayRow, lineNumber: number) {
  const observedAt = new Date(row.observed_at)
  const value = typeof row.value === 'number' ? row.value : Number(row.value)
  if (Number.isNaN(observedAt.valueOf())) throw new Error(`${lineNumber}행의 관측 시각을 확인해 주세요.`)
  if (!row.metric?.trim() || !row.unit?.trim() || !Number.isFinite(value)) throw new Error(`${lineNumber}행의 센서명, 값, 단위를 확인해 주세요.`)
  const zoneId = row.zone_id?.trim() || 'zone-a'
  if (zoneId !== 'zone-a' && zoneId !== 'zone-b') throw new Error(`${lineNumber}행의 구역은 zone-a 또는 zone-b여야 합니다.`)
  const quality = row.quality?.trim() || 'good'
  if (!qualities.has(quality)) throw new Error(`${lineNumber}행의 품질 값이 올바르지 않습니다.`)
  return {
    observedAt: observedAt.toISOString(),
    reading: {
      metric: row.metric.trim(),
      value,
      unit: row.unit.trim(),
      zone_id: zoneId as 'zone-a' | 'zone-b',
      ...(row.sensor_id?.trim() ? { sensor_id: row.sensor_id.trim() } : {}),
      quality: quality as 'good' | 'suspect' | 'bad' | 'stale' | 'missing',
    },
  }
}

function groupRows(rows: Array<{ row: FlatReplayRow; lineNumber: number }>): OperationsReplayObservation[] {
  const grouped = new Map<string, OperationsReplayObservation['readings']>()
  for (const item of rows) {
    const normalized = normalizedRow(item.row, item.lineNumber)
    const readings = grouped.get(normalized.observedAt) ?? []
    readings.push(normalized.reading)
    grouped.set(normalized.observedAt, readings)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([observed_at, readings]) => ({ observed_at, readings }))
}

function parseCsv(text: string) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) throw new Error('CSV에는 헤더와 한 개 이상의 관측행이 필요합니다.')
  const headers = csvCells(lines[0]).map((item) => item.toLowerCase())
  for (const required of ['observed_at', 'metric', 'value', 'unit']) {
    if (!headers.includes(required)) throw new Error(`CSV 헤더에 ${required} 열이 필요합니다.`)
  }
  return groupRows(lines.slice(1).map((line, index) => {
    const cells = csvCells(line)
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex] ?? ''])) as FlatReplayRow
    return { row, lineNumber: index + 2 }
  }))
}

function parseNdjson(text: string) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) throw new Error('NDJSON 파일에 관측 기록이 없습니다.')
  const flatRows: Array<{ row: FlatReplayRow; lineNumber: number }> = []
  for (const [index, line] of lines.entries()) {
    let value: Record<string, unknown>
    try {
      value = JSON.parse(line) as Record<string, unknown>
    } catch {
      throw new Error(`${index + 1}행의 JSON 형식을 확인해 주세요.`)
    }
    if (Array.isArray(value.readings)) {
      const observedAt = new Date(String(value.observed_at ?? ''))
      if (Number.isNaN(observedAt.valueOf())) throw new Error(`${index + 1}행의 관측 시각을 확인해 주세요.`)
      const rows = value.readings.map((reading) => ({
        row: { ...(reading as FlatReplayRow), observed_at: observedAt.toISOString() },
        lineNumber: index + 1,
      }))
      flatRows.push(...rows)
    } else flatRows.push({ row: value as FlatReplayRow, lineNumber: index + 1 })
  }
  return groupRows(flatRows)
}

export function parseOperationsReplay(text: string, filename: string): OperationsReplayObservation[] {
  const observations = filename.toLowerCase().endsWith('.csv') ? parseCsv(text) : parseNdjson(text)
  if (!observations.length) throw new Error('재생할 관측 기록이 없습니다.')
  return observations
}

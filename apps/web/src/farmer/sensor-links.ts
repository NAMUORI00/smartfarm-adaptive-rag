import type { ControlTarget, DerivedIndicator, Metric, TelemetryPoint } from "../types";
import { synchronizeTelemetryLatest } from "../dashboard-trends.ts";
import { sensorStability } from "../operator-ui.ts";
import type { SensorTrendSample } from "../sensor-trends";
import { L } from "./i18n.ts";

type TelemetryField = keyof Omit<TelemetryPoint, "time">;

// Same metric → series mapping as dashboard-trends.ts (kept private there).
const metricFields: Array<[string, TelemetryField]> = [
  ["air_temperature_c", "temperature"],
  ["relative_humidity_pct", "humidity"],
  ["co2_ppm", "co2"],
  ["supply_ec_ds_m", "ec"],
  ["root_zone_temperature_c", "rootZoneTemperature"],
  ["substrate_moisture_pct", "substrateMoisture"],
  ["irrigation_flow_l_min", "irrigationFlow"],
  ["irrigation_pressure_bar", "irrigationPressure"],
  ["ppfd_umol_m2_s", "ppfd"],
  ["supply_ph", "supplyPh"],
  ["drain_ec_ds_m", "drainEc"],
];

export function telemetryFieldForMetric(key: string): TelemetryField | null {
  return metricFields.find(([metricKey]) => metricKey === key)?.[1] ?? null;
}

export function metricPrecision(key: string): number {
  if (/ec|ph/.test(key)) return 2;
  if (/ppfd|co2|solar|_pct$/.test(key)) return 0;
  return 1;
}

/** Recent values of one zone-scoped metric, ending with the value shown on the reading row. */
export function sparklineSamples(
  telemetryByZone: Readonly<Record<string, readonly TelemetryPoint[]>>,
  zoneId: string | null | undefined,
  metricKey: string,
  metrics: Metric[],
  maxSamples = 48,
): SensorTrendSample[] {
  const field = telemetryFieldForMetric(metricKey);
  if (!field || !zoneId) return [];
  const points = synchronizeTelemetryLatest([...(telemetryByZone[zoneId] ?? [])], metrics.filter((m) => m.zoneId === zoneId));
  return points
    .flatMap((point) => {
      const value = point[field];
      return typeof value === "number" && Number.isFinite(value) ? [{ time: point.time, value }] : [];
    })
    .slice(-Math.max(2, maxSamples));
}

/** Devices whose output plausibly moves this reading. Display only; approval still checks scope. */
export function relatedDeviceTargets(metricKey: string): ControlTarget[] {
  switch (metricKey) {
    case "root_zone_temperature_c": return ["root_zone_chiller"];
    case "air_temperature_c": return ["ventilation_fan", "roof_vent", "side_vent", "heater"];
    case "relative_humidity_pct": return ["ventilation_fan", "roof_vent", "side_vent"];
    case "substrate_moisture_pct":
    case "irrigation_flow_l_min":
    case "irrigation_pressure_bar": return ["irrigation_pump"];
    case "ppfd_umol_m2_s": return ["shade_curtain"];
    default: return [];
  }
}

export type BandGauge = {
  min: number;
  max: number;
  bandStart: number;
  bandEnd: number;
  needle: number;
  outside: boolean;
};

/** Positions (0–100 %) for a target-band gauge: the registered range as a band, the value as a needle. */
export function bandGauge(value: number, lower: number | null, upper: number | null): BandGauge | null {
  if (!Number.isFinite(value) || (lower === null && upper === null)) return null;
  const lo = lower ?? upper!;
  const hi = upper ?? lower!;
  if (hi < lo) return null;
  const pad = Math.max((hi - lo) / 2, Math.abs(hi || lo || 1) * 0.1, 0.5);
  const min = Math.min(lo - pad, value);
  const max = Math.max(hi + pad, value);
  const span = max - min || 1;
  const pct = (v: number) => Math.round(((v - min) / span) * 1000) / 10;
  return {
    min, max,
    bandStart: pct(lower ?? min),
    bandEnd: pct(upper ?? max),
    needle: pct(value),
    outside: (lower !== null && value < lower) || (upper !== null && value > upper),
  };
}

const derivedMetricKeys = {
  vpd: ["air_temperature_c", "relative_humidity_pct"],
  light: ["ppfd_umol_m2_s", "solar_w_m2"],
  ec: ["supply_ec_ds_m", "drain_ec_ds_m"],
  rootHeat: ["root_zone_temperature_c"],
};
const statusRank = { normal: 0, warning: 1, critical: 2 } as const;
const statusLabel = (status: Metric["status"]) => (status === "normal" ? L("정상", "Normal") : status === "warning" ? L("확인 필요", "Check needed") : L("위험", "Danger"));

function derivedStatus(metrics: Pick<Metric, "key" | "status">[], keys: string[]) {
  return metrics
    .filter((metric) => keys.includes(metric.key))
    .reduce<Metric["status"]>((status, metric) => (statusRank[metric.status] > statusRank[status] ? metric.status : status), "normal");
}

export type DerivedRow = { key: string; label: string; value: string; status: Metric["status"]; statusLabel: string };

/** The legacy "환경 균형" strip in farmer words; status follows the worst related reading. */
export function derivedIndicatorRows(indicator: DerivedIndicator, zoneMetrics: Pick<Metric, "key" | "status">[]): DerivedRow[] {
  const rows: Array<[string, string, string, string[]]> = [
    ["vpd", L("공기 건조 정도 (VPD)", "Air dryness (VPD)"), `${indicator.vpdKpa.toFixed(2)} kPa`, derivedMetricKeys.vpd],
    ["ec", L("공급·배액 EC 차이", "Supply–drain EC gap"), `${indicator.ecDeltaDsM.toFixed(2)} dS/m`, derivedMetricKeys.ec],
    ["light", L("오늘 광량", "Light today"), `${indicator.dliMolM2Day.toFixed(1)} mol/㎡`, derivedMetricKeys.light],
    ["rootHeat", L("근권 고온 노출", "Root-zone heat exposure"), `${Math.round(indicator.rootHeatExposureDegreeMinutes)} °C·min`, derivedMetricKeys.rootHeat],
  ];
  return rows.map(([key, label, value, keys]) => {
    const status = derivedStatus(zoneMetrics, keys);
    return { key, label, value, status, statusLabel: statusLabel(status) };
  });
}

const keyReadingOrder = [
  "root_zone_temperature_c",
  "air_temperature_c",
  "relative_humidity_pct",
  "substrate_moisture_pct",
  "supply_ec_ds_m",
  "co2_ppm",
  "supply_ph",
];

/**
 * The few readings a farmer looks at first, always in the same places so a
 * daily check is a glance: root temperature, air temperature, humidity,
 * substrate moisture. A problem is flagged on its tile, never moved.
 * Everything else waits behind "관측 전체".
 */
export function keyReadings<T extends Pick<Metric, "key" | "status" | "quality">>(metrics: T[], count = 4): T[] {
  return [...metrics]
    .map((m, index) => ({ m, index, order: keyReadingOrder.indexOf(m.key) }))
    .filter((entry) => entry.order !== -1)
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .slice(0, Math.max(0, count))
    .map(({ m }) => m);
}

/** Readings that need attention but are not among the key tiles, so the tiles can stay fixed without hiding a problem. */
export function otherProblemReadings<T extends Pick<Metric, "key" | "status" | "quality">>(metrics: T[], shown: T[]): T[] {
  return metrics.filter((m) => !shown.includes(m) && (m.status !== "normal" || (m.quality && m.quality !== "good")));
}

export function stabilityText(metrics: Parameters<typeof sensorStability>[0]): string {
  const s = sensorStability(metrics);
  if (!s.valid) return L("관측 안정도 계산 불가. 양질 관측이 없습니다", "Stability cannot be computed. No good-quality readings");
  return L(
    `관측 ${s.valid}개 중 ${s.normal}개 기준 범위${s.needsReview > 0 ? `, 품질 확인 ${s.needsReview}개` : ""}`,
    `${s.normal} of ${s.valid} readings in range${s.needsReview > 0 ? `, ${s.needsReview} quality check` : ""}`,
  );
}

export type ReadingCounts = { inRange: number; outside: number; noThreshold: number; qualityCheck: number };

/**
 * Honest tally for the "관측 전체" line: a reading without a registered range
 * is neither in nor out of range, and a reading of doubtful quality is not
 * counted as in range even when its status says normal.
 */
export function readingCounts(metrics: Pick<Metric, "key" | "status" | "quality">[], hasThreshold: (key: string) => boolean): ReadingCounts {
  const counts: ReadingCounts = { inRange: 0, outside: 0, noThreshold: 0, qualityCheck: 0 };
  for (const m of metrics) {
    if (m.quality && m.quality !== "good") { counts.qualityCheck += 1; continue; }
    if (m.status !== "normal") { counts.outside += 1; continue; }
    if (hasThreshold(m.key)) counts.inRange += 1;
    else counts.noThreshold += 1;
  }
  return counts;
}

export function readingCountsText(counts: ReadingCounts): string {
  const parts = [L(`기준 안 ${counts.inRange}개`, `${counts.inRange} in range`)];
  if (counts.outside) parts.push(L(`벗어남 ${counts.outside}개`, `${counts.outside} out of range`));
  if (counts.qualityCheck) parts.push(L(`품질 확인 ${counts.qualityCheck}개`, `${counts.qualityCheck} quality check`));
  if (counts.noThreshold) parts.push(L(`기준 없음 ${counts.noThreshold}개`, `${counts.noThreshold} no threshold`));
  return parts.join(", ");
}

/** "최근 32분" / "최근 2시간" — the span the sparkline actually covers; null when there is nothing to draw. */
export function sampleSpanText(samples: readonly SensorTrendSample[]): string | null {
  if (samples.length < 3) return null;
  const first = Date.parse(samples[0].time), last = Date.parse(samples[samples.length - 1].time);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return null;
  const minutes = Math.round((last - first) / 60000);
  if (minutes < 1) return L("최근 1분 미만", "Last minute");
  if (minutes < 90) return L(`최근 ${minutes}분`, `Last ${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  const hours = minutes / 60;
  const h = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return L(`최근 ${h}시간`, `Last ${h} ${h === 1 ? "hour" : "hours"}`);
}

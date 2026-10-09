import { farmWords } from "./ai-brief.ts";
import { getLang, L, term } from "./i18n.ts";

// Registered crop details arrive as a JSON record; they read as labelled values.
const RECORD_KEYS: Record<string, [string, string]> = {
  crop: ["작물", "Crop"], cultivar: ["품종", "Cultivar"], harvest_part: ["수확 부위", "Harvest part"], planted_on: ["정식일", "Planted"],
  initial_count: ["정식 개체", "Plants set"], remaining_count: ["남은 개체", "Plants left"], planned_harvest_from: ["수확 예정", "Harvest from"],
  planned_harvest_to: ["수확 종료", "Harvest to"], growth_stage: ["생육 단계", "Growth stage"],
};
const STATUS_WORDS: Record<string, [string, string]> = { normal: ["정상", "normal"], warning: ["주의", "warning"], critical: ["긴급", "critical"], unknown: ["알 수 없음", "unknown"], stale: ["지연", "stale"] };
/**
 * A source passage as a person reads it: a JSON record becomes labelled values,
 * and on the Korean screen the server's zone numbers and status words become
 * the screen's. On the English screen a Korean passage stays whole, not half-translated.
 */
export function readableExcerpt(text: string, zoneLabel: (id: string) => string): string {
  const t = text.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    try {
      const record = JSON.parse(t) as Record<string, unknown>;
      return Object.entries(record)
        .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
        .map(([k, v]) => `${RECORD_KEYS[k] ? L(...RECORD_KEYS[k]) : k} ${term(String(v))}`)
        .join(", ");
    } catch { /* not a record: read as text */ }
  }
  if (getLang() !== "ko") return t;
  return farmWords(t.replace(/\((normal|warning|critical|unknown|stale)\)/g, (_m, s: string) => `(${L(...STATUS_WORDS[s])})`), zoneLabel);
}

// The server names its own live sources in English or in its own words; the screen names them for a person.
const LOCATOR_NAMES: [RegExp, [string, string]][] = [
  [/^telemetry snapshot$/i, ["실시간 관측", "Live readings"]],
  [/^sensor timeseries$/i, ["관측 추이", "Reading trend"]],
  [/^alert registry$/i, ["경보 기록", "Alert log"]],
  [/^현재 장치 상태$/, ["장치 상태", "Device state"]],
];

/** Where a passage came from, in the screen's language: the live readings and the crop record are named by the screen. */
export function readableLocator(locator: string): string {
  const named = LOCATOR_NAMES.find(([pattern]) => pattern.test(locator.trim()));
  if (named) return L(...named[1]);
  const passage = locator.match(/^본문 구간 (\d+)$/);
  if (passage) return L(`본문 ${passage[1]}번째 구간`, `Passage ${passage[1]}`);
  if (getLang() === "ko") return locator;
  return locator
    .replace(/현재 센서 상태/g, "Current sensor state")
    .replace(/(\d+)번 베드/g, "Bed $1")
    .replace(/(\d+)단/g, "tier $1")
    .replace(/섹션 (\d+)/g, "Section $1")
    .replace(/(\d+)\s*[–-]\s*(\d+)쪽/g, "pp. $1–$2")
    .replace(/(\d+)쪽/g, "p. $1")
    .replace(/\s·\s/g, ", ");
}

const TELEMETRY_STATUS: Record<string, string> = { "기준 범위": "normal", "확인 필요": "warning", "즉시 확인": "critical" };
const TELEMETRY = /^(?:(\d+)구역\s*)?(?:\((zone-[a-z0-9-]+)\),\s*)?(\S+)\s+관측값:\s*(.+?)\s*\(상태:\s*([^)]+)\)\.?\s*(.*)$/s;

/** A live-reading passage ("1구역 (zone-a), 2026-…T03:11:59+00:00 관측값: 72 % (상태: 기준 범위).") and nothing else. */
export const isTelemetryPassage = (excerpt: string) => TELEMETRY.test(excerpt.trim());

/**
 * The live readings an answer used, one passage per reading, as one table: a
 * row per reading (named by the passage title "… 최신 상대 습도"), a cell per
 * zone, the reading's state, and a note when the sensor's value was set aside
 * or is the last one received. Null when no passage is a live reading.
 */
export function parseTelemetryPassages(passages: { source: string; excerpt: string }[]): { zones: string[]; rows: ParsedReading[]; observedAt: string | null } | null {
  const rows = new Map<string, ParsedReading>();
  const zones: string[] = [];
  let observedAt: string | null = null;
  for (const p of passages) {
    const m = p.excerpt.trim().match(TELEMETRY);
    if (!m) continue;
    const zone = m[2] ?? (m[1] ? ZONE_BY_NUMBER[m[1]] ?? `zone-${m[1]}` : "");
    if (!zones.includes(zone)) zones.push(zone);
    if (Number.isFinite(Date.parse(m[3])) && (!observedAt || Date.parse(m[3]) > Date.parse(observedAt))) observedAt = m[3];
    const label = p.source.includes("최신 ") ? p.source.split("최신 ").pop()!.trim() : p.source.trim();
    const note = /센서 품질 의심/.test(m[6]) ? L("판단 제외", "set aside") : /관측 지연/.test(m[6]) ? L("지연", "late") : undefined;
    const row = rows.get(label) ?? { label, cells: {} };
    row.cells[zone] = {
      value: m[4].replace(/\d+\.\d{3,}/g, (x) => String(Number(Number(x).toFixed(1)))),
      status: note && TELEMETRY_STATUS[m[5].trim()] === "normal" ? "warning" : TELEMETRY_STATUS[m[5].trim()] ?? "unknown",
      ...(note ? { note } : {}),
    };
    rows.set(label, row);
  }
  return rows.size ? { zones, rows: [...rows.values()], observedAt } : null;
}

/** Evidence groups the server names itself (not documents), in the screen's language. */
export function evidenceTitle(title: string): string {
  if (title === "현재 운영 관측") return L("현재 운영 관측", "Current farm readings");
  if (title === "선택한 재배 회차 등록 정보") return L("선택한 재배 회차 등록 정보", "Registered crop cycle");
  return title;
}

/** A cell's note says when the value was set aside (a suspect sensor) or is the last one received. */
export type ParsedReading = { label: string; cells: Record<string, { value: string; status: string; note?: string }> };
// The server numbers the zones ("1구역"); the layout names them (farmWords uses the same pairing).
const ZONE_BY_NUMBER: Record<string, string> = { "1": "zone-a", "2": "zone-b" };

/**
 * The live-readings passage ("1구역 재배실 온도: 65 °C (warning); …") as one row
 * per reading with a cell per zone, so it reads as a table instead of a wall of
 * text. Null when the passage is not that list.
 */
export function parseReadings(text: string): { zones: string[]; rows: ParsedReading[] } | null {
  const items = text.split(/;\s*/).map((s) => s.trim()).filter(Boolean);
  if (items.length < 3) return null;
  const rows = new Map<string, ParsedReading>();
  const zones: string[] = [];
  for (const item of items) {
    const m = item.match(/^(?:(\d+)\s?구역\s+)?(.+?):\s*(.+?)\s*\(([a-z_]+)\)$/);
    if (!m) return null;
    const zone = m[1] ? ZONE_BY_NUMBER[m[1]] ?? `zone-${m[1]}` : "";
    if (!zones.includes(zone)) zones.push(zone);
    const label = m[2].trim();
    const row = rows.get(label) ?? { label, cells: {} };
    row.cells[zone] = { value: m[3].replace(/\s*boolean$/, "").replace(/\d+\.\d{3,}/g, (x) => String(Number(Number(x).toFixed(1)))), status: m[4] };
    rows.set(label, row);
  }
  return { zones, rows: [...rows.values()] };
}

/** A reading any zone reports as other than normal. */
export const readingNeedsLook = (row: ParsedReading) => Object.values(row.cells).some((c) => c.status !== "normal");
export const statusWord = (status: string) => (STATUS_WORDS[status] ? L(...STATUS_WORDS[status]) : status);
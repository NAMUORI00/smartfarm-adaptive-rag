import type { Actuator, AdvisorQueryContext, Metric, OperationCase, OperationCaseAction } from "../types.ts";
import { L } from "./i18n.ts";

/**
 * The first page draws each part of the system as a data flow across four
 * lanes — the farmer's screen, the AI, the operations server and the site —
 * with one box per step. This module holds what those boxes compute from real
 * records (no number is made up) and how the wires between boxes are routed.
 */

export type Lane = "screen" | "ai" | "server" | "field";
/** Top to bottom: toward the person at the top, the greenhouse at the bottom. */
export const LANE_ORDER: Lane[] = ["screen", "ai", "server", "field"];

export function laneName(lane: Lane): string {
  return { screen: L("농부 화면", "Farmer's screen"), ai: L("AI 모델", "AI models"), server: L("운영 서버", "Operations server"), field: L("농장 현장", "On site") }[lane];
}

// ------------------------------------------------------------------ readings

export type SensorPass = {
  total: number;
  /** Readings that passed the quality check. */
  good: number;
  /** Readings whose quality is in doubt: kept out of the judgement. */
  doubtful: Metric[];
  inRange: number;
  outside: Metric[];
  noRange: number;
};

/** One zone's readings on their way in: how many, how many pass the quality check, where the good ones sit against the farm's range. */
export function sensorPass(metrics: Metric[], zoneId: string, hasRange: (key: string) => boolean): SensorPass {
  const zone = metrics.filter((m) => m.zoneId === zoneId);
  const doubtful = zone.filter((m) => !!m.quality && m.quality !== "good");
  const good = zone.filter((m) => !doubtful.includes(m));
  const outside = good.filter((m) => m.status !== "normal");
  const ranged = good.filter((m) => m.status === "normal" && hasRange(m.key));
  return { total: zone.length, good: good.length, doubtful, inRange: ranged.length, outside, noRange: good.length - outside.length - ranged.length };
}

const CROSS_CHECK = ["root_zone_temperature_c", "relative_humidity_pct", "air_temperature_c", "substrate_moisture_pct"];

/** The readings a doubtful one is checked against: other key readings of the same zone that read well (as the AI brief does). */
export function crossPartners(metrics: Metric[], zoneId: string, key: string, count = 2): Metric[] {
  return metrics
    .filter((m) => m.zoneId === zoneId && m.key !== key && CROSS_CHECK.includes(m.key) && (m.quality ?? "good") === "good" && m.status === "normal")
    .sort((a, b) => CROSS_CHECK.indexOf(a.key) - CROSS_CHECK.indexOf(b.key))
    .slice(0, count);
}

/**
 * A live reading the advisor read with a question, from its evidence record:
 * "…1구역 최신 근권 온도" + "…관측값: 16 °C (상태: 기준 범위)." → 근권 온도, 16 °C.
 * A reading marked as a doubtful sensor keeps that mark.
 */
export function readingEvidence(title: string, excerpt: string): { name: string; value: string; doubtful: boolean } | null {
  const m = /관측값:\s*([^()]+?)\s*\(상태:\s*[^)]+\)/.exec(excerpt);
  if (!m) return null;
  const name = (title.split("최신 ").pop() ?? title).trim();
  return { name, value: m[1].trim(), doubtful: /센서 품질 의심|판단 근거에서 제외/.test(excerpt) };
}

// ------------------------------------------------------------------ the studies in the dashboard

/** Where a study works in the dashboard; the same shapes the dashboard accepts as a place to open. */
export type DemoTarget =
  | { kind: "bed"; bedId: string; tier?: number; chat: true }
  | { kind: "zone"; zoneId: string; chat?: boolean }
  | { kind: "chat" }
  | { kind: "camera"; focus: "multiview" }
  | { kind: "device"; zoneId: string; key: string; tab: "state" };

/**
 * The real case of each study, to open from the first page: (1) the place the
 * cited answer was asked, with the advisor open on that answer; (2) the camera
 * page at the question put to two cameras; (3) the temperature sensor that
 * disagrees with the rest of its zone, on its state tab where the AI reads it
 * against the zone's other sensors and a recalibration (rechecked at approval)
 * starts — its zone when that sensor has no device, the first zone when every
 * reading is sound.
 */
export function studyTargets(input: {
  askedAt: AdvisorQueryContext | null | undefined;
  metrics: Pick<Metric, "key" | "zoneId" | "quality">[];
  actuators: Pick<Actuator, "key" | "target" | "zoneId">[];
  firstZone: string | null;
}): Record<1 | 2 | 3, DemoTarget> {
  const q = input.askedAt;
  const study1: DemoTarget = q?.bedId
    ? { kind: "bed", bedId: q.bedId, ...(q.tier ? { tier: q.tier } : {}), chat: true }
    : q?.zoneScopeMode === "focused" && q.selectedZoneIds[0]
      ? { kind: "zone", zoneId: q.selectedZoneIds[0], chat: true }
      : { kind: "chat" };
  const doubtful = input.metrics.filter((m) => m.zoneId && m.quality && m.quality !== "good");
  const doubt = doubtful.find((m) => m.key === "air_temperature_c") ?? doubtful[0] ?? null;
  const sensor = doubt?.key === "air_temperature_c" ? input.actuators.find((a) => a.zoneId === doubt.zoneId && a.target === "air_temperature_sensor_reset") ?? null : null;
  const study3: DemoTarget = sensor && doubt?.zoneId
    ? { kind: "device", zoneId: doubt.zoneId, key: sensor.key, tab: "state" }
    : doubt?.zoneId
      ? { kind: "zone", zoneId: doubt.zoneId }
      : input.firstZone ? { kind: "zone", zoneId: input.firstZone } : { kind: "chat" };
  return { 1: study1, 2: { kind: "camera", focus: "multiview" }, 3: study3 };
}

// ------------------------------------------------------------------ control

/** The change to replay: the newest one a person allowed, that reached the device and was then confirmed recovered. */
export function pickControlCase(cases: OperationCase[]): { item: OperationCase; action: OperationCaseAction } | null {
  const done = cases
    .filter((c) => c.status === "resolved" && c.recoveryVerdict === "recovered")
    .flatMap((item) => item.actions.filter((a) => a.status === "approved" && a.approvedAt && a.executedAt && a.verification).map((action) => ({ item, action })))
    .sort((a, b) => Date.parse(b.action.approvedAt!) - Date.parse(a.action.approvedAt!));
  return done[0] ?? null;
}

/** The time between two records: "1초", "41초", "2분 48초", "3시간 5분", "6일". */
export function gapText(from: string | null | undefined, to: string | null | undefined): string | null {
  const a = Date.parse(from ?? ""), b = Date.parse(to ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const s = Math.round((b - a) / 1000);
  if (s < 60) return L(`${s}초`, `${s} s`);
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r ? L(`${m}분 ${r}초`, `${m} min ${r} s`) : L(`${m}분`, `${m} min`);
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return m ? L(`${h}시간 ${m}분`, `${h} h ${m} min`) : L(`${h}시간`, `${h} h`);
  }
  const d = Math.floor(s / 86400);
  return L(`${d}일`, `${d} d`);
}

// ------------------------------------------------------------------ wiring

/** Where a box sits: its lane, its first column (1-based) and how many columns it spans. */
export type FlowCell = { id: string; lane: Lane; col: number; span?: number };
export type Box = { x: number; y: number; w: number; h: number };
/**
 * How a wire runs between two boxes:
 * - `column`: straight up or down between boxes of one column;
 * - `straight`: along one lane;
 * - `across`: along the source lane, then up or down into the target;
 * - `rise`: up or down out of the source, then along the target lane into it;
 * - `gap`: a turn in the gap before the target (the fallback, no room for a label).
 */
export type RouteKind = "column" | "straight" | "across" | "rise" | "gap";

const colEnd = (c: FlowCell) => c.col + (c.span ?? 1) - 1;

/** Picks the route that keeps a wire off other boxes, preferring to run along the lane the data leaves. */
export function routeKind(a: FlowCell, b: FlowCell, cells: FlowCell[], lanes: Lane[]): RouteKind {
  const taken = (lane: Lane, col: number) => cells.some((c) => c.id !== a.id && c.id !== b.id && c.lane === lane && c.col <= col && col <= colEnd(c));
  const between = (from: Lane, to: Lane) => {
    const i = lanes.indexOf(from), j = lanes.indexOf(to);
    return lanes.slice(Math.min(i, j) + 1, Math.max(i, j));
  };
  const free = (lane: Lane, from: number, to: number) => { for (let col = from; col <= to; col += 1) if (taken(lane, col)) return false; return true; };
  if (a.lane !== b.lane && a.col <= colEnd(b) && b.col <= colEnd(a)) return "column";
  if (a.lane === b.lane) return "straight";
  if (free(a.lane, colEnd(a) + 1, b.col) && between(a.lane, b.lane).every((lane) => !taken(lane, b.col))) return "across";
  if (between(a.lane, b.lane).every((lane) => !taken(lane, a.col)) && free(b.lane, a.col, b.col - 1)) return "rise";
  return "gap";
}

/** A wire as an SVG path with rounded turns, and where a label can sit (null when the wire runs only in a narrow gap). */
export function routePath(kind: RouteKind, a: Box, b: Box, radius = 10): { d: string; label: { x: number; y: number; room: number } | null } {
  const round = (n: number) => Math.round(n * 10) / 10;
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const up = bcy < acy;
  if (kind === "column") {
    // The middle of the width the two boxes share.
    const x = round((Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2);
    const y1 = round(up ? a.y : a.y + a.h), y2 = round(up ? b.y + b.h : b.y);
    return { d: `M${x} ${y1}V${y2}`, label: { x, y: round((y1 + y2) / 2), room: Math.abs(y2 - y1) } };
  }
  if (kind === "straight") {
    const x1 = round(a.x + a.w), x2 = round(b.x), y = round(acy);
    return { d: `M${x1} ${y}H${x2}`, label: x2 - x1 >= 64 ? { x: round((x1 + x2) / 2), y, room: x2 - x1 } : null };
  }
  if (kind === "across") {
    // Along the source lane to the target's middle, then into its top or bottom.
    const x1 = round(a.x + a.w), y1 = round(acy), x2 = round(bcx), y2 = round(up ? b.y + b.h : b.y);
    const r = Math.min(radius, Math.abs(y2 - y1) / 2, (x2 - x1) / 2);
    const dy = up ? -r : r;
    return {
      d: `M${x1} ${y1}H${round(x2 - r)}Q${x2} ${y1} ${x2} ${round(y1 + dy)}V${y2}`,
      label: x2 - x1 >= 64 ? { x: round((x1 + x2 - r) / 2), y: y1, room: x2 - x1 - r } : null,
    };
  }
  if (kind === "rise") {
    // Out of the source's top or bottom to the target lane, then along it into the target's side.
    const x1 = round(acx), y1 = round(up ? a.y : a.y + a.h), x2 = round(b.x), y2 = round(bcy);
    const r = Math.min(radius, Math.abs(y2 - y1) / 2, (x2 - x1) / 2);
    const dy = up ? -r : r;
    return {
      d: `M${x1} ${y1}V${round(y2 - dy)}Q${x1} ${y2} ${round(x1 + r)} ${y2}H${x2}`,
      label: x2 - x1 >= 64 ? { x: round((x1 + r + x2) / 2), y: y2, room: x2 - x1 - r } : null,
    };
  }
  const x1 = round(a.x + a.w), y1 = round(acy), x2 = round(b.x), y2 = round(bcy);
  const xm = round(x2 - Math.min(14, (x2 - x1) / 2));
  const r = Math.min(radius, Math.abs(y2 - y1) / 2, Math.max(0, xm - x1), Math.max(0, x2 - xm));
  if (Math.abs(y2 - y1) < 1) return { d: `M${x1} ${y1}H${x2}`, label: null };
  const dy = y2 > y1 ? r : -r;
  return { d: `M${x1} ${y1}H${round(xm - r)}Q${xm} ${y1} ${xm} ${round(y1 + dy)}V${round(y2 - dy)}Q${xm} ${y2} ${round(xm + r)} ${y2}H${x2}`, label: null };
}

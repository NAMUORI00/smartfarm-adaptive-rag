import type { CropCycle } from "../farm-spatial";
import type { Approval, OperationCase } from "../types";
import type { BriefAnchor, BriefItem } from "./ai-brief.ts";
import type { SinceItem } from "./since-summary.ts";
import { L, place } from "./i18n.ts";

/** One line to hand over; `at` is when it happened (open items have none). */
export type HandoverLine = { kind: "open" | SinceItem["kind"]; kindLabel: string; text: string; at: string | null };

const kindLabel = (k: HandoverLine["kind"]) => ({
  open: L("남은 일", "Open"),
  alert: L("경보", "Alert"),
  control: L("설비 변경", "Change"),
  recheck: L("답변 재확인", "Answer rechecked"),
  camera: L("카메라", "Camera"),
}[k]);

/** What to hand over: the open items first, then what happened, newest first. Records only. */
export function handoverLines(since: SinceItem[], open: BriefItem[], max = 10): HandoverLine[] {
  const lines: HandoverLine[] = open
    // Example cameras are not this farm's footage: they are not handed over.
    .filter((i) => !i.example && (i.tone !== "info" || i.go === "harvest"))
    .slice(0, 4)
    .map((i) => ({ kind: "open" as const, kindLabel: kindLabel("open"), text: `${i.what}: ${i.todo}`, at: null }));
  for (const s of since) lines.push({ kind: s.kind, kindLabel: kindLabel(s.kind), text: s.text, at: s.at });
  const seen = new Set<string>();
  return lines.filter((l) => (seen.has(l.text) ? false : (seen.add(l.text), true))).slice(0, max);
}

/** The handover in its groups, in a fixed order: what is still open, then alerts, changes, rechecks, cameras. */
export function handoverGroups(lines: HandoverLine[]): { kind: HandoverLine["kind"]; label: string; lines: HandoverLine[] }[] {
  const order: HandoverLine["kind"][] = ["open", "alert", "control", "recheck", "camera"];
  return order
    .map((kind) => ({ kind, label: kindLabel(kind), lines: lines.filter((l) => l.kind === kind) }))
    .filter((g) => g.lines.length > 0);
}

const seoulDate = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));

/** The last seven days in recorded counts: harvests, alert cases, allowed changes. */
export function weekSummary(input: { cycles: Pick<CropCycle, "bed_id" | "harvests">[]; cases: Pick<OperationCase, "openedAt" | "status">[]; approvals: Pick<Approval, "createdAtIso" | "status" | "executionStatus">[]; beds: { id: string; label: string }[]; now?: number }) {
  const now = input.now ?? Date.now();
  const from = now - 7 * 24 * 60 * 60 * 1000;
  const inWeek = (at?: string | null) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) >= from && Date.parse(at) <= now;
  const byBed = new Map<string, { label: string; count: number; kg: number }>();
  let harvestKg = 0, harvestCount = 0;
  for (const c of input.cycles) {
    for (const h of c.harvests ?? []) {
      if (!inWeek(h.harvested_at)) continue;
      harvestKg += h.weight_kg ?? 0;
      harvestCount += 1;
      const label = place(input.beds.find((b) => b.id === c.bed_id)?.label ?? c.bed_id);
      const row = byBed.get(c.bed_id) ?? { label, count: 0, kg: 0 };
      row.count += 1; row.kg += h.weight_kg ?? 0;
      byBed.set(c.bed_id, row);
    }
  }
  const cases = input.cases.filter((c) => inWeek(c.openedAt));
  const controls = input.approvals.filter((a) => inWeek(a.createdAtIso) && a.status === "approved");
  return {
    from: seoulDate(from),
    to: seoulDate(now),
    harvestKg,
    harvestCount,
    harvestBeds: byBed.size,
    byBed: [...byBed.values()].sort((a, b) => b.kg - a.kg),
    cases: cases.length,
    resolved: cases.filter((c) => c.status === "resolved").length,
    controls: controls.length,
    applied: controls.filter((a) => a.executionStatus === "applied_to_simulator").length,
  };
}

export type WorkStop = { id: string; item: BriefItem; anchor: BriefAnchor | null; urgent: boolean };

/**
 * Today's work in walking order: urgent items first, then the rest along the
 * rows of the house (zone by zone, row by row, the plant room last). Only the
 * brief's own items; nothing is added that the records do not show.
 */
export function workPlan(items: BriefItem[], beds: { id: string; zone_id: string; position: { x: number; z: number } }[], zoneOrder: string[]): WorkStop[] {
  const posOf = (a: BriefAnchor | null) => {
    if (!a) return [99, 99, 99];
    const zi = Math.max(0, zoneOrder.indexOf(a.zoneId));
    const bedId = a.kind === "bed" ? a.bedId : a.kind === "camera" ? a.bedId : null;
    const bed = bedId ? beds.find((b) => b.id === bedId) : undefined;
    if (bed) return [zi, bed.position.z, bed.position.x];
    // Devices and zone-wide items: the zone's plant room and end wall, after its beds.
    return [zi, 1e6, a.kind === "device" ? 1 : 0];
  };
  const stops = items
    .filter((i) => i.go !== "reconnect")
    .map((i) => ({ id: i.id, item: i, anchor: i.anchor, urgent: i.tone === "danger" }));
  return stops.sort((a, b) => {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    const pa = posOf(a.anchor), pb = posOf(b.anchor);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
}

import type { AdvisorTurn, Alert, Approval } from "../types";
import type { PatrolEvent } from "../video-api";
import { L, place, term } from "./i18n.ts";
import { shortAlertTitle } from "./todo-engine.ts";

/**
 * "Since you last looked": what the records say happened after a given time.
 * Alerts, allowed device changes, answers the assistant rechecked, and camera
 * records, each as one short line. Counts come from records only.
 */
export type SinceItem = { at: string; kind: "alert" | "control" | "recheck" | "camera"; text: string; zoneId?: string | null };
export type SinceSummary = {
  counts: { alerts: number; controls: number; rechecks: number; camera: number };
  total: number;
  text: string;
  items: SinceItem[];
};

export type SinceInput = {
  alerts: Pick<Alert, "title" | "occurredAt" | "zoneId" | "severity">[];
  approvals: Pick<Approval, "device" | "createdAtIso" | "zoneId" | "requestedValue">[];
  turns: (Pick<AdvisorTurn, "recordedAt" | "stateReview"> & Partial<Pick<AdvisorTurn, "queryContext">>)[];
  patrol: Pick<PatrolEvent, "title" | "created_at" | "status">[];
};

const after = (at: string | null | undefined, since: number) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) >= since;

/**
 * Each line reads as a short sentence, not a path: "A구역 재배실 온도 센서 확인, 위험",
 * "B구역 차광 커튼: 10%", "15번 베드 답변: 바뀐 부분 다시 확인". `placeOf` names where
 * a rechecked answer was asked (a bed or a zone); without it the line says "상담 답변".
 */
export function sinceSummary(input: SinceInput, sinceIso: string, zoneLabel: (id?: string | null) => string, max = 8, placeOf?: (turn: SinceInput["turns"][number]) => string | null): SinceSummary {
  const since = Date.parse(sinceIso);
  const items: SinceItem[] = [];
  for (const a of input.alerts) if (after(a.occurredAt, since)) items.push({ at: a.occurredAt!, kind: "alert", text: `${place(zoneLabel(a.zoneId))} ${term(shortAlertTitle(a.title))}${a.severity === "critical" ? L(", 위험", ", critical") : ""}`, zoneId: a.zoneId });
  for (const p of input.approvals) if (after(p.createdAtIso, since)) items.push({ at: p.createdAtIso!, kind: "control", text: `${place(zoneLabel(p.zoneId))} ${term(p.device.split("·").pop()!.trim())}: ${term(p.requestedValue)}`, zoneId: p.zoneId });
  for (const t of input.turns) {
    if (!t.stateReview?.previous_response_id || !after(t.recordedAt, since)) continue;
    const where = placeOf?.(t) ?? null;
    const updated = t.stateReview.status === "updated";
    items.push({
      at: t.recordedAt!,
      kind: "recheck",
      text: where
        ? updated ? L(`${where} 답변: 바뀐 부분 다시 확인`, `Advice for ${where}: changed parts rechecked`) : L(`${where} 답변: 상태가 바뀌어 새 질문 필요`, `Advice for ${where}: conditions changed, ask again`)
        : updated ? L("상담 답변: 바뀐 부분 다시 확인", "Advice: changed parts rechecked") : L("상담 답변: 상태가 바뀌어 새 질문 필요", "Advice: conditions changed, ask again"),
    });
  }
  for (const e of input.patrol) if (after(e.created_at, since)) items.push({ at: e.created_at, kind: "camera", text: `${L("카메라", "Camera")}: ${e.title}${e.status === "resolved" ? L(", 확인 완료", ", checked") : ""}` });
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const counts = {
    alerts: items.filter((i) => i.kind === "alert").length,
    controls: items.filter((i) => i.kind === "control").length,
    rechecks: items.filter((i) => i.kind === "recheck").length,
    camera: items.filter((i) => i.kind === "camera").length,
  };
  const parts = [
    counts.alerts ? L(`경보 ${counts.alerts}건`, `${counts.alerts} ${counts.alerts === 1 ? "alert" : "alerts"}`) : "",
    counts.controls ? L(`설비 변경 ${counts.controls}건`, `${counts.controls} equipment ${counts.controls === 1 ? "change" : "changes"}`) : "",
    counts.rechecks ? L(`답변 재확인 ${counts.rechecks}회`, `${counts.rechecks} advice ${counts.rechecks === 1 ? "recheck" : "rechecks"}`) : "",
    counts.camera ? L(`카메라 기록 ${counts.camera}건`, `${counts.camera} camera ${counts.camera === 1 ? "record" : "records"}`) : "",
  ].filter(Boolean);
  return { counts, total: items.length, text: parts.length ? parts.join(", ") : L("새 기록 없음", "No new records"), items: items.slice(0, max) };
}

const key = (farmId: string) => `farmer.lastSeen.${farmId}`;

/** The previous visit's time, or `fallbackHours` ago on a first visit or when storage is unavailable. */
export function readLastSeen(farmId: string, now = Date.now(), fallbackHours = 12): { iso: string; known: boolean } {
  try {
    const saved = localStorage.getItem(key(farmId));
    if (saved && Number.isFinite(Date.parse(saved)) && Date.parse(saved) < now) return { iso: saved, known: true };
  } catch { /* storage unavailable */ }
  return { iso: new Date(now - fallbackHours * 3600000).toISOString(), known: false };
}

export function writeLastSeen(farmId: string, now = Date.now()): void {
  try { localStorage.setItem(key(farmId), new Date(now).toISOString()); } catch { /* storage unavailable */ }
}

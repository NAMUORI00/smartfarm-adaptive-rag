import type { FarmLayout } from "../farm-spatial";
import type { PatrolEvent, ResearchVideoAnalysis } from "../video-api";
import { L } from "./i18n.ts";

export function cameraSummary(layout: Pick<FarmLayout, "cameras" | "beds"> | null): { registered: number; text: string } {
  const ids = new Set<string>([...(layout?.cameras ?? []).map((c) => c.id), ...(layout?.beds ?? []).flatMap((b) => b.camera_ids)]);
  const registered = ids.size;
  return { registered, text: registered
    ? L(`카메라 ${registered}대 등록. 실시간 화면 미연결`, `${registered} ${registered === 1 ? "camera" : "cameras"} registered. Live view not connected`)
    : L("현재 농장 카메라 미연결", "No farm cameras connected") };
}

export type CameraCard = { id: string; bedLabels: string[]; zoneIds: string[] };

/** Registered cameras with the beds and zones they are attached to; nothing is invented for unassigned ids. */
export function cameraCards(layout: Pick<FarmLayout, "cameras" | "beds"> | null, zoneId?: string | null): CameraCard[] {
  if (!layout) return [];
  const cards = new Map<string, CameraCard>();
  for (const camera of layout.cameras ?? []) cards.set(camera.id, { id: camera.id, bedLabels: [], zoneIds: [] });
  for (const bed of layout.beds) {
    for (const id of bed.camera_ids) {
      const card = cards.get(id) ?? { id, bedLabels: [], zoneIds: [] };
      card.bedLabels.push(bed.label);
      if (!card.zoneIds.includes(bed.zone_id)) card.zoneIds.push(bed.zone_id);
      cards.set(id, card);
    }
  }
  return [...cards.values()].filter((card) => !zoneId || !card.zoneIds.length || card.zoneIds.includes(zoneId));
}

export type DecisionKind = "held" | "answer" | "abstain" | "failed";
export type Decision = { kind: DecisionKind; title: string; note: string };

// The three research outcomes, each named so a farmer can tell them apart:
// an answer with evidence, a refusal to guess (abstain), or an answer the
// release policy is holding back. "failed" is a connection problem, not a result.
const decisionCopy = (kind: DecisionKind): Decision => {
  switch (kind) {
    case "held": return { kind, title: L("답변 공개 보류", "Answer withheld"), note: L("공개 기준이 아직 확인되지 않아 결론은 감추고 근거 화면만 보여줍니다.", "The release policy is not yet validated, so the conclusion is hidden and only the evidence frames are shown.") };
    case "answer": return { kind, title: L("영상 근거로 답함", "Answered from video evidence"), note: L("선택한 카메라의 전체 화면과 확대 영역을 근거로 답했습니다.", "Answered from the selected camera's full frame and zoomed region.") };
    case "abstain": return { kind, title: L("판단하지 않음 (기권)", "No judgment (abstained)"), note: L("화면 근거가 부족해 추측하지 않았습니다. 현장에서 직접 확인하세요.", "Not enough visual evidence, so no guess was made. Check on site.") };
    default: return { kind: "failed", title: L("영상 확인을 완료하지 못했습니다", "Video check could not be completed"), note: L("연결 또는 처리에 실패했습니다. 다시 시도하세요.", "Connection or processing failed. Try again.") };
  }
};

/** "카메라 1", "카메라 2" — research camera ids stay in the detail view. */
export function cameraDisplayName(cameraId: string | null | undefined, order: readonly string[]): string {
  if (!cameraId) return L("카메라 미확인", "Camera unknown");
  const index = order.indexOf(cameraId);
  return index === -1 ? cameraId : L(`카메라 ${index + 1}`, `Camera ${index + 1}`);
}

/** Research release is checked before the model's own decision, exactly as the legacy panel did. */
export function researchDecision(result: Pick<ResearchVideoAnalysis, "decision" | "release_hold_reason" | "stages">): Decision {
  const hold = result.release_hold_reason || result.stages?.release?.hold_reason;
  if (hold === "policy_not_validated" || hold === "confidence_below_threshold" || (result.release_hold_reason && result.decision !== "unavailable")) return decisionCopy("held");
  if (result.decision === "answer") return decisionCopy("answer");
  if (result.decision === "abstain") return decisionCopy("abstain");
  return decisionCopy("failed");
}


export function patrolStatusLabel(status: PatrolEvent["status"]): string {
  return status === "resolved" ? L("확인 완료", "Checked") : status === "reviewing" ? L("현장 확인 중", "Checking on site") : L("확인 필요", "Check needed");
}

export function openPatrolCount(events: Pick<PatrolEvent, "status">[]): number {
  return events.filter((e) => e.status !== "resolved").length;
}

/** Operator wording for stored history lines (moved from the legacy patrol panel). */
// Log lines written by the server, in the screen's language.
const HISTORY: Record<string, [string, string]> = {
  "AI 카메라 판독: 확인 필요": ["AI 카메라 판독: 확인 필요", "AI camera reading: to check"],
  "AI 카메라 판독: 다시 보임": ["AI 카메라 판독: 다시 보임", "AI camera reading: seen again"],
  "현장 확인 중": ["현장 확인 중", "Checking on site"],
  "허가된 출입": ["허가된 출입", "Authorized entry"],
  "오탐": ["잘못 본 것", "Not real"],
  "현장 조치 완료": ["조치 완료", "Handled"],
};

export function patrolHistoryLabel(label: string): string {
  if (label === "침입 의심 시연 이벤트 발생 · 자동 탐지 아님") return L("접근 확인 요청 접수. 자동 탐지 아님", "Access check request received. Not an automatic detection");
  if (HISTORY[label]) return L(...HISTORY[label]);
  return label
    .replace("AI 화면 확인: answer", L("AI 브리핑 완료", "AI briefing done"))
    .replace("AI 화면 확인: abstain", L("영상 근거 부족", "Not enough video evidence"))
    .replace("AI 화면 확인: unavailable", L("영상 분석 연결 확인 필요", "Check video analysis connection"));
}

/** video-api errors carry the HTTP status in parentheses; say what it means for the farmer. */
export function videoErrorMessage(error: string | undefined | null): string {
  if (!error) return "";
  if (/\(403\)/.test(error)) return L("처리 권한이 없습니다. 상태는 바뀌지 않았습니다.", "You do not have permission. Nothing was changed.");
  if (/\(409\)/.test(error)) return L("다른 확인이 진행 중이거나 이미 처리된 사건입니다. 목록을 새로고침하세요.", "Another check is in progress or this event was already handled. Refresh the list.");
  if (/\(404\)/.test(error)) return L("영상 기능이 꺼져 있거나 기록을 찾을 수 없습니다.", "Video is turned off or the record was not found.");
  return error;
}

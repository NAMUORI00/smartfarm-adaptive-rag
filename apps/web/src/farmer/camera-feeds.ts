import type { CameraCheckRow, CameraFeed, CameraReading, PatrolEvent } from "../video-api.ts";
import { L, place } from "./i18n.ts";
import { shortStamp } from "./time-format.ts";

/**
 * Camera feeds as the farmer sees them: one line per camera saying what the
 * AI saw in the latest segment, and the check records it raised. The AI only
 * observes; whether a sighting needs a look is the camera's registration on
 * the server (camera_feeds.py).
 */

const CHECKS: Record<string, { title: [string, string]; alert: [string, string] }> = {
  people: { title: ["사람", "People"], alert: ["사람 출입 확인", "Person entering"] },
  aisle: { title: ["통로", "Aisle"], alert: ["통로 막힘 확인", "Aisle blocked"] },
  floor_water: { title: ["바닥 물기", "Water on floor"], alert: ["바닥 물 고임 확인", "Water on the floor"] },
  leaves: { title: ["잎 상태", "Leaves"], alert: ["잎 변색 확인", "Leaf discoloration"] },
};

export const checkTitle = (id: string) => (CHECKS[id] ? L(...CHECKS[id].title) : id);
export const alertTitle = (id: string) => (CHECKS[id] ? L(...CHECKS[id].alert) : id);
export const feedTitle = (feed: Pick<CameraFeed, "title" | "title_en">) => L(feed.title, feed.title_en || place(feed.title));
/** What the AI saw, in the screen's language (it writes both). */
export const rowText = (row: Pick<CameraCheckRow, "summary_ko" | "summary_en">) => L(row.summary_ko, row.summary_en || row.summary_ko);

export type FeedTone = "warn" | "ok" | "info" | "off";
export type FeedHeadline = { tone: FeedTone; label: string; text: string };

/** The camera's one line: its open records first, then what the latest reading saw. */
export function feedHeadline(feed: Pick<CameraFeed, "state" | "latest" | "open_events">): FeedHeadline {
  if (feed.state === "no_signal") return { tone: "off", label: L("신호 없음", "No signal"), text: L("카메라 영상을 받지 못했습니다.", "No video is coming from this camera.") };
  const reading = feed.latest?.reading ?? null;
  const rows = reading && (reading.status === "read" || reading.status === "unchanged") ? reading.checks : [];
  const flagged = rows.find((r) => r.needs_check) ?? null;
  if (feed.open_events > 0) {
    return { tone: "warn", label: L(`확인 필요 ${feed.open_events}건`, `${feed.open_events} to check`), text: flagged ? rowText(flagged) : L("AI가 남긴 확인 기록이 있습니다.", "The AI left a record to check.") };
  }
  if (flagged) return { tone: "warn", label: alertTitle(flagged.id), text: rowText(flagged) };
  if (!feed.latest) return { tone: "info", label: L("받는 중", "Receiving"), text: L("첫 영상을 받는 중입니다.", "Receiving the first segment.") };
  if (!reading) return { tone: "info", label: L("판독 전", "Not read yet"), text: L("받은 영상을 판독하는 중입니다.", "Reading the segment just received.") };
  switch (reading.status) {
    case "unavailable": return { tone: "info", label: L("판독 안 함", "Not read"), text: L("이 카메라를 판독할 AI 모델이 설정되지 않았습니다.", "No AI model is set to read this camera.") };
    case "limit": return { tone: "info", label: L("판독 대기", "Waiting"), text: L("오늘 판독 한도에 닿아 내일 다시 판독합니다.", "Today's reading limit is reached; reading resumes tomorrow.") };
    case "waiting": return { tone: "info", label: L("판독 대기", "Waiting"), text: L("방금 판독해 다음 영상에서 다시 봅니다.", "Read a moment ago; the next segment is read later.") };
    case "failed": return { tone: "off", label: L("판독 실패", "Read failed"), text: L("AI 판독에 연결하지 못했습니다. 다음 영상에서 다시 시도합니다.", "Could not reach the AI; it tries again on the next segment.") };
  }
  const seen = rows.find((r) => r.decision === "answer" && r.present) ?? rows.find((r) => r.decision === "answer");
  if (seen) return { tone: "ok", label: L("확인할 일 없음", "Nothing to check"), text: rowText(seen) };
  return { tone: "info", label: L("판단 보류", "Held back"), text: L("화면만으로 판단하기 어렵습니다.", "The frames alone are not enough to judge.") };
}

/** When the shown reading was made: now, or kept from an earlier identical scene. */
export function readingNote(reading: CameraReading | null | undefined): string {
  if (!reading) return "";
  if (reading.status === "unchanged") {
    return L(`장면 변화 없음, ${shortStamp(reading.same_as_recorded_at)} 판독 유지`, `Scene unchanged; reading from ${shortStamp(reading.same_as_recorded_at)} kept`);
  }
  if (reading.status === "read" && reading.read_at) return L(`AI 판독 ${shortStamp(reading.read_at)}`, `AI read at ${shortStamp(reading.read_at)}`);
  return "";
}

export type CheckBadge = { tone: FeedTone; label: string };
export function checkBadge(row: CameraCheckRow): CheckBadge {
  if (row.needs_check) return { tone: "warn", label: L("확인 필요", "Check") };
  if (row.decision === "abstain") return { tone: "info", label: L("판단 보류", "Held back") };
  return { tone: "ok", label: row.present ? L("보임", "Seen") : L("없음", "None") };
}

/** How a person can close a camera record: an entrance sighting may be an authorized entry. */
export function outcomesFor(checkId: string | undefined): { outcome: "authorized" | "false_alarm" | "handled"; label: string }[] {
  const wrong = { outcome: "false_alarm" as const, label: L("잘못 본 것", "Not real") };
  if (checkId === "people") return [{ outcome: "authorized", label: L("허가된 출입", "Authorized") }, wrong];
  return [{ outcome: "handled", label: L("조치 완료", "Handled") }, wrong];
}

export const isCameraEvent = (e: Pick<PatrolEvent, "source">) => e.source === "camera_reading";
export const openCameraEvents = <T extends Pick<PatrolEvent, "source" | "status">>(events: T[]) => events.filter((e) => isCameraEvent(e) && e.status !== "resolved");
export const eventTitle = (e: Pick<PatrolEvent, "title" | "title_en">) => L(e.title, e.title_en || e.title);
export const eventText = (e: Pick<PatrolEvent, "analysis">) => (e.analysis ? L(e.analysis.answer, e.analysis.answer_en || e.analysis.answer) : "");

/** The FarmPlan tone of a camera: attention while something is waiting for a person. */
export const feedTone = (feed: Pick<CameraFeed, "state" | "latest" | "open_events">) => (feedHeadline(feed).tone === "warn" ? ("attention" as const) : ("ok" as const));

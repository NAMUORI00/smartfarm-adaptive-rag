import test from "node:test";
import assert from "node:assert/strict";
import { feedHeadline, feedTone, openCameraEvents, outcomesFor, readingNote, checkBadge, eventText, feedTitle } from "./farmer/camera-feeds.ts";
import { buildBrief } from "./farmer/ai-brief.ts";
import { setLang } from "./farmer/i18n.ts";
import type { CameraCheckRow, CameraSegment } from "./video-api.ts";

const row = (over: Partial<CameraCheckRow> = {}): CameraCheckRow => ({
  id: "aisle", decision: "answer", present: false, needs_check: false, summary_ko: "통로가 비어 있습니다.", summary_en: "The aisle is clear.", frames: [], box: null, confidence: 0.9, ...over,
});
const segment = (rows: CameraCheckRow[], status: "read" | "unchanged" = "read"): CameraSegment => ({
  id: "cam-a1.x", camera_id: "cam-a1", recorded_at: "2026-10-06T05:20:00Z", duration_seconds: 10, video_url: "/v1/video/cameras/segments/cam-a1.x/video", frames: [],
  reading: { status, read_at: "2026-10-06T05:20:05Z", checks: rows, same_as_recorded_at: "2026-10-06T05:00:00Z" },
});

test("a camera's one line: no signal, its open records, then what the latest reading saw", () => {
  assert.equal(feedHeadline({ state: "no_signal", latest: null, open_events: 0 }).tone, "off");
  assert.equal(feedHeadline({ state: "waiting", latest: null, open_events: 0 }).label, "받는 중");
  const clear = feedHeadline({ state: "receiving", latest: segment([row()]), open_events: 0 });
  assert.deepEqual(clear, { tone: "ok", label: "확인할 일 없음", text: "통로가 비어 있습니다." });
  const blocked = row({ present: true, needs_check: true, summary_ko: "통로 가운데 수레가 놓여 있습니다.", summary_en: "A cart stands in the aisle.", frames: [1] });
  assert.equal(feedHeadline({ state: "receiving", latest: segment([blocked]), open_events: 0 }).label, "통로 막힘 확인");
  // A record stays until a person closes it, even when the latest segment no longer shows it.
  const open = feedHeadline({ state: "receiving", latest: segment([row()]), open_events: 1 });
  assert.equal(open.tone, "warn");
  assert.equal(open.label, "확인 필요 1건");
  assert.equal(feedTone({ state: "receiving", latest: segment([row()]), open_events: 1 }), "attention");
  // A person in the room is seen, not a problem: the camera was not registered to raise it.
  const working = row({ id: "people", present: true, summary_ko: "작업자 1명이 선반 옆에 있습니다.", frames: [0] });
  assert.equal(feedHeadline({ state: "receiving", latest: segment([row(), working]), open_events: 0 }).text, "작업자 1명이 선반 옆에 있습니다.");
  const held = row({ decision: "abstain", present: null });
  assert.equal(feedHeadline({ state: "receiving", latest: segment([held]), open_events: 0 }).label, "판단 보류");
  const limit = { ...segment([]), reading: { status: "limit" as const, checks: [] } };
  assert.match(feedHeadline({ state: "receiving", latest: limit, open_events: 0 }).text, /한도/);
});

test("a repeated scene says its reading was kept, and the AI writes both languages", () => {
  assert.match(readingNote(segment([row()], "unchanged").reading), /^장면 변화 없음, .* 판독 유지$/);
  assert.match(readingNote(segment([row()]).reading), /^AI 판독 /);
  assert.equal(checkBadge(row({ needs_check: true, present: true })).label, "확인 필요");
  assert.equal(checkBadge(row({ decision: "abstain", present: null })).label, "판단 보류");
  setLang("en");
  try {
    assert.equal(feedHeadline({ state: "receiving", latest: segment([row()]), open_events: 0 }).text, "The aisle is clear.");
    assert.equal(feedTitle({ title: "A구역 통로", title_en: "Zone A aisle" }), "Zone A aisle");
    assert.equal(eventText({ analysis: { answer: "수레", answer_en: "A cart", id: "", decision: "answer", clip_id: "", start_seconds: 0, end_seconds: 10, frame_urls: [] } }), "A cart");
    assert.deepEqual(outcomesFor("people").map((o) => o.outcome), ["authorized", "false_alarm"]);
  } finally {
    setLang("ko");
  }
  assert.deepEqual(outcomesFor("floor_water").map((o) => o.outcome), ["handled", "false_alarm"]);
  assert.equal(openCameraEvents([{ source: "camera_reading", status: "new" }, { source: "camera_reading", status: "resolved" }, { source: "test_event", status: "new" }]).length, 1);
});

test("open camera records become brief items in place of the saved example findings", () => {
  const base = {
    connected: true, alerts: [], metrics: [], thresholds: [], actuators: [], pending: [], cycles: [], turns: [],
    beds: [{ id: "bed-04", label: "4번 베드", zone_id: "zone-a" }], zoneLabel: (id?: string | null) => (id === "zone-a" ? "A구역" : "B구역"),
    cameras: [{ id: "cam-a2", label_ko: "4번 베드 근접", label_en: "Bed 4 close-up", zone_id: "zone-a", bed_id: "bed-04", col: 0, row: 0, angle: 0, image: "", summary_ko: "", summary_en: "",
      questions: [{ id: "q1", question_ko: "", question_en: "", decision: "answer" as const, answer_ko: "예", answer_en: "Yes", reason_ko: "", reason_en: "", confidence: 0.9, box: null, alert: true, finding_ko: "잎 황변", finding_en: "Yellowing" }] }],
  };
  assert.equal(buildBrief(base).filter((i) => i.go === "camera").length, 1, "without feeds the saved finding stands");
  const items = buildBrief({ ...base, cameraEvents: [{ id: "e1", checkId: "floor_water", cameraId: "cam-b1", cameraTitle: "B구역 재배실", zoneId: "zone-b", bedId: null, title: "바닥 물 고임 확인", text: "배관 아래 바닥에 물이 고여 있습니다.", ask: "관수 배관 누수 점검 방법", synthetic: true, createdAt: "2026-10-06T05:20:00Z" }] });
  const camera = items.filter((i) => i.go === "camera");
  assert.equal(camera.length, 1);
  assert.equal(camera[0].what, "B구역 재배실 바닥 물 고임 확인");
  assert.equal(camera[0].ask, "관수 배관 누수 점검 방법");
  assert.equal(camera[0].example, true, "a generated example is never handed over as this farm's record");
  assert.deepEqual(camera[0].anchor, { kind: "camera", zoneId: "zone-b", cameraId: "cam-b1", bedId: null });
});

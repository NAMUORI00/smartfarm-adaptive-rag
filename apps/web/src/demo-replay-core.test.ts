import test from "node:test";
import assert from "node:assert/strict";
import { findPost, normalizeQuestion, requestKey, seriesIndex, shiftTimes, stableBody } from "./demo/replay-core.ts";
import type { ReplayPost } from "./demo/replay-core.ts";

test("a request is named by its path and its sorted, non-empty query", () => {
  assert.equal(requestKey("/v1/telemetry/series", "?zone_id=zone-a&hours=10"), "/v1/telemetry/series?hours=10&zone_id=zone-a");
  assert.equal(requestKey("/v1/audit/events", "?limit=25&q="), "/v1/audit/events?limit=25");
  assert.equal(requestKey("/v1/farm/layout", ""), "/v1/farm/layout");
});

test("recorded times move to now; dates move by whole days only when asked", () => {
  const day = 86_400_000;
  const text = JSON.stringify({ observed_at: "2026-10-09T11:09:05Z", at: "2026-10-09T11:09:05.123456+09:00", planted_on: "2026-09-20", note: "2026-10-09T11:09:05Z 기록" });
  const moved = JSON.parse(shiftTimes(text, 2 * day + 60_000, true));
  assert.equal(moved.observed_at, "2026-10-11T11:10:05.000Z");
  assert.equal(moved.at, "2026-10-11T02:10:05.123Z");
  assert.equal(moved.planted_on, "2026-09-22");
  assert.equal(moved.note, "2026-10-09T11:09:05Z 기록", "a time inside a sentence is left alone");
  assert.equal(JSON.parse(shiftTimes(text, 2 * day, false)).planted_on, "2026-09-20");
  assert.equal(shiftTimes(text, 0), text);
});

test("a recorded sequence loops", () => {
  assert.equal(seriesIndex(0, 10_000, 6), 0);
  assert.equal(seriesIndex(25_000, 10_000, 6), 2);
  assert.equal(seriesIndex(65_000, 10_000, 6), 0);
  assert.equal(seriesIndex(1_000, 10_000, 0), -1);
});

test("a write is matched by what was asked, not by its request ids", () => {
  const posts: ReplayPost[] = [
    { method: "POST", path: "/v1/advisor/questions", body: { question: "고추냉이 잎이 누렇게 변하는 원인", client_turn_id: "a", selected_zone_ids: ["zone-a"], session_id: "s" }, file: "json/1.json", status: 200, recorded_at: "2026-10-09T00:00:00Z" },
    { method: "POST", path: "/v1/video/cameras/ask", body: { camera_id: "cam-a1", question: "잎?", lang: "ko" }, file: "json/2.json", status: 200, recorded_at: "2026-10-09T00:00:00Z" },
  ];
  const asked = findPost(posts, "POST", "/v1/advisor/questions", { session_id: "s", selected_zone_ids: ["zone-a"], question: " 고추냉이 잎이 누렇게 변하는 원인? ", client_turn_id: "b" });
  assert.equal(asked?.file, "json/1.json");
  assert.equal(findPost(posts, "POST", "/v1/advisor/questions", { question: "고추냉이 잎이 누렇게 변하는 원인", selected_zone_ids: ["zone-b"], session_id: "s" }), null, "the same question about another place is another question");
  assert.equal(findPost(posts, "POST", "/v1/video/cameras/ask", { camera_id: "cam-a1", question: "잎?", lang: "en" }), null);
  assert.equal(normalizeQuestion("  잎이   누렇다?? "), "잎이 누렇다");
  assert.equal(stableBody({ b: 1, a: { request_id: "x", q: 2 } }), '{"a":{"q":2},"b":1}');
});

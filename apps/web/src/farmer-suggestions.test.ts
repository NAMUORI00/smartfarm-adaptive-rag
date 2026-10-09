import test from "node:test";
import assert from "node:assert/strict";
import { daysUntil, suggestedQuestions } from "./farmer/suggestions.ts";

test("a quiet bed offers state, guide and outlook", () => {
  const out = suggestedQuestions({ crop: "고추냉이", alerts: [], recentControl: null, harvestInDays: null });
  assert.deepEqual(out.map((s) => s.id), ["state", "guide", "outlook"]);
});

test("a sensor alert and a fresh device change push the generic questions out", () => {
  const out = suggestedQuestions({
    crop: "고추냉이",
    alerts: [{ title: "재배실 온도 센서 건전성 경보", kind: "sensor_health", severity: "warning" }],
    recentControl: { device: "근권 냉각기", value: "냉각 켜기" },
    harvestInDays: 3,
  });
  assert.deepEqual(out.map((s) => s.id), ["state", "sensor", "after-control"]);
  assert.match(out[1].question, /온도 센서 고장 점검 방법/);
  assert.equal(out[1].label, "센서 점검 방법");
  assert.match(out[2].question, /근권 냉각기를 "냉각 켜기"로 조절했습니다/);
  assert.match(out[2].question, /추정을 구분/);
});

test("a harvest within a week is offered when nothing more urgent is open", () => {
  const out = suggestedQuestions({ crop: "고추냉이", alerts: [], recentControl: null, harvestInDays: 0 });
  assert.equal(out[1].id, "harvest");
  assert.match(out[1].question, /오늘이에요/);
});

test("days until a date are counted in Seoul", () => {
  const now = Date.UTC(2026, 8, 22, 3); // 12:00 KST on 2026-09-22
  assert.equal(daysUntil("2026-09-25", now), 3);
  assert.equal(daysUntil("2026-09-22", now), 0);
  assert.equal(daysUntil("2026-09-20", now), -2);
  assert.equal(daysUntil(null, now), null);
});

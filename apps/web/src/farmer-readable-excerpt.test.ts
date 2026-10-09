import test from "node:test";
import assert from "node:assert/strict";
import { parseReadings, readableExcerpt, readingNeedsLook } from "./farmer/readable-excerpt.ts";
import { setLang } from "./farmer/i18n.ts";

const zoneLabel = (id: string) => (id === "zone-a" ? "A구역" : "B구역");

test("a registered crop record reads as labelled values, not JSON", () => {
  const text = readableExcerpt('{"crop": "고추냉이", "cultivar": "달마", "harvest_part": "근경", "planted_on": "2025-03-15", "remaining_count": 24}', zoneLabel);
  assert.equal(text, "작물 고추냉이, 품종 달마, 수확 부위 근경, 정식일 2025-03-15, 남은 개체 24");
});

test("zone numbers and status words become the screen's on the Korean screen", () => {
  assert.equal(readableExcerpt("2구역 재배실 온도: 18 °C (normal); 1구역 근권 온도: 21 °C (critical)", zoneLabel), "B구역 재배실 온도: 18 °C (정상); A구역 근권 온도: 21 °C (긴급)");
});

test("a Korean passage stays whole on the English screen", () => {
  setLang("en");
  try {
    const raw = "2구역 재배실 온도: 18 °C (normal)";
    assert.equal(readableExcerpt(raw, zoneLabel), raw);
    assert.match(readableExcerpt('{"crop": "고추냉이", "planted_on": "2025-03-15"}', zoneLabel), /^Crop .+, Planted 2025-03-15$/);
  } finally {
    setLang("ko");
  }
});

test("the live readings list becomes rows per reading with a cell per zone", () => {
  const parsed = parseReadings("1구역 재배실 온도: 64.9992 °C (warning); 1구역 상대 습도: 72 % (normal); 2구역 재배실 온도: 18 °C (normal); 2구역 강우 감지: 0 boolean (normal)");
  assert.deepEqual(parsed?.zones, ["zone-a", "zone-b"]);
  const room = parsed!.rows.find((r) => r.label === "재배실 온도")!;
  assert.deepEqual(room.cells["zone-a"], { value: "65 °C", status: "warning" });
  assert.equal(room.cells["zone-b"].value, "18 °C");
  assert.equal(readingNeedsLook(room), true);
  assert.equal(parsed!.rows.find((r) => r.label === "강우 감지")!.cells["zone-b"].value, "0");
  assert.equal(readingNeedsLook(parsed!.rows.find((r) => r.label === "상대 습도")!), false);
});

test("ordinary passages are not mistaken for a readings list", () => {
  assert.equal(parseReadings("생육 최적 온도는 12~15℃입니다. 고온에서는 무름병이 생깁니다."), null);
  assert.equal(parseReadings("a: 1 (normal); b: 2 (normal)"), null);
});
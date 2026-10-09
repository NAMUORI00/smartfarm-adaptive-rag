import test from "node:test";
import assert from "node:assert/strict";
import { periodState, periodText, seoulToday } from "./farmer/harvest-periods.ts";
import { setLang } from "./farmer/i18n.ts";

const range = { label: "물재배", months_min: 18, months_max: 24, from: "2026-09-15", to: "2027-03-15" };
const upTo = { label: "밭재배", months_min: null, months_max: 14, from: null, to: "2026-05-15" };
const after = { label: null, months_min: 3, months_max: null, from: "2026-06-15", to: null };

test("a period reads with its cultivation and its dates, either end open", () => {
  assert.equal(periodText(range), "물재배: 정식 후 18~24개월 → 2026.09.15 ~ 2027.03.15");
  assert.equal(periodText(upTo), "밭재배: 정식 후 14개월 이내 → 2026.05.15까지");
  assert.equal(periodText(after), "정식 후 3개월 이후 → 2026.06.15부터");
  // No "null" ever reaches the screen.
  assert.equal(periodText({ label: null, months_min: null, months_max: null, from: null, to: null }), "");
});

test("a period reads in English, and an untranslated cultivation name is left out", () => {
  setLang("en");
  try {
    assert.equal(periodText(range), "Water culture: 18–24 months after planting → 2026.09.15 to 2027.03.15");
    assert.equal(periodText(upTo), "Field culture: Up to 14 months after planting → by 2026.05.15");
    assert.equal(periodText({ ...after, label: "장기재배" }), "3 months or more after planting → from 2026.06.15");
  } finally {
    setLang("ko");
  }
});

test("today is placed before, within or past a period", () => {
  assert.equal(periodState(range, "2026-09-29"), "now");
  assert.equal(periodState(range, "2026-09-14"), "before");
  assert.equal(periodState(range, "2027-03-16"), "past");
  assert.equal(periodState(upTo, "2026-09-29"), "past");
  assert.equal(periodState(after, "2026-09-29"), "now");
  // The farm's date, not the machine's: 23:30 UTC is already the next day in Seoul.
  assert.equal(seoulToday(Date.parse("2026-09-28T23:30:00Z")), "2026-09-29");
});

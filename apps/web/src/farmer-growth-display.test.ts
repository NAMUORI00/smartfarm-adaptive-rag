import test from "node:test";
import assert from "node:assert/strict";
import { growthDisplay, growthText, guideMonths, plantScale } from "./farmer/growth-display.ts";
import type { CropCycle } from "./farm-spatial.ts";

const base: CropCycle = {
  id: "c1",
  bed_id: "bed-04",
  tier: 1,
  crop: "고추냉이",
  cultivar: "달마",
  harvest_part: "근경",
  planted_on: "2026-08-20",
  initial_count: 24,
  remaining_count: 24,
  planned_harvest_from: null,
  planned_harvest_to: null,
  status: "growing",
  latest_observation: null,
  harvests: [],
};
const now = Date.parse("2026-09-28T12:00:00+09:00");

test("a recorded observation sets the size, whatever the dates say", () => {
  const g = growthDisplay({ ...base, planned_harvest_from: "2026-10-01", latest_observation: { growth_percent: 40, observed_at: "2026-09-08T08:00:00Z" } }, now, 18);
  assert.equal(g?.basis, "observation");
  assert.equal(g?.fraction, 0.4);
  assert.match(growthText(g), /40%/);
});

test("a young planting is drawn small against the registered harvest date", () => {
  const young = growthDisplay({ ...base, planted_on: "2026-09-09", planned_harvest_from: "2027-09-09" }, now);
  assert.equal(young?.basis, "schedule");
  assert.equal(young?.days, 19);
  assert.ok(plantScale(young) < 0.35, `seedlings stay small (${plantScale(young)})`);
  const due = growthDisplay({ ...base, planted_on: "2025-03-15", planned_harvest_from: "2026-09-26" }, now);
  assert.equal(due?.fraction, 1);
  assert.equal(plantScale(due), 1);
});

test("without a harvest date the guides' shortest period is the yardstick", () => {
  const g = growthDisplay(base, now, 18);
  assert.equal(g?.basis, "reference");
  assert.equal(g?.days, 39);
  assert.ok(g!.fraction > 0 && g!.fraction < 0.2);
  assert.match(growthText(g), /정식 39일째, 재배 자료 18개월 기준/);
});

test("nothing registered keeps the model's own shape", () => {
  assert.equal(growthDisplay(base, now, null), null);
  assert.equal(plantScale(null), 1);
  assert.equal(growthDisplay({ ...base, remaining_count: 0 }, now, 18), null);
});

test("the guides' period is the shortest stated window", () => {
  assert.equal(guideMonths([{}, { periods: [{ months_min: null }, { months_min: 24 }] }, { periods: [{ months_min: 18 }] }]), 18);
  assert.equal(guideMonths([{}]), null);
});

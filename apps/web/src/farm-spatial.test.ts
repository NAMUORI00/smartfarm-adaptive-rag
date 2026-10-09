import test from "node:test";
import assert from "node:assert/strict";
import {
  advisorTurnAt,
  activePlantFraction,
  cycleAt,
  observationScale,
  selectedBed,
} from "./farm-spatial.ts";
import type { CropCycle, FarmLayout } from "./farm-spatial.ts";
import type { AdvisorTurn } from './types.ts';

test('restored advice follows the selected tier and crop cycle instead of the latest unrelated answer', () => {
  const turn = { id: 'same', status: 'complete', assistantMessage: { content: '관측 확인' }, queryContext: { bedId: 'bed-01', tier: 2, cycleId: 'c1' } } as AdvisorTurn;
  const other = { ...turn, id: 'new-crop', queryContext: { ...turn.queryContext!, cycleId: 'c2' } };
  assert.equal(advisorTurnAt([turn, other], { bedId: 'bed-01', tier: 2 }, 'c1')?.id, 'same');
  assert.equal(advisorTurnAt([turn], { bedId: 'bed-01', tier: 1 }, 'c1'), null);
  assert.equal(advisorTurnAt([turn], { bedId: 'bed-02', tier: 2 }, 'c1'), null);
  assert.equal(advisorTurnAt([turn], null, 'c1'), null);
});

const cycle: CropCycle = {
  id: "c1",
  bed_id: "bed-01",
  tier: 2,
  crop: "와사비",
  cultivar: "",
  harvest_part: "잎",
  planted_on: "2026-01-01",
  initial_count: 20,
  remaining_count: 10,
  planned_harvest_from: null,
  planned_harvest_to: null,
  status: "growing",
  latest_observation: null,
  harvests: [],
};
test("unobserved crops never acquire fabricated growth from time or count", () => {
  assert.equal(observationScale(cycle), null);
  assert.equal(
    observationScale({
      ...cycle,
      latest_observation: {
        growth_percent: 60,
        observed_at: "2026-01-02T00:00:00Z",
      },
    }),
    0.6,
  );
});
test("partial uprooting changes visible population while leaf-only harvest preserves it", () => {
  assert.equal(activePlantFraction(cycle), 0.5);
  assert.equal(activePlantFraction({ ...cycle, remaining_count: 20 }), 1);
  assert.equal(activePlantFraction({ ...cycle, remaining_count: 0 }), 0);
});
test("cycle focus never leaks across beds, tiers or closed cycles", () => {
  const closed = { ...cycle, status: "completed" };
  assert.equal(cycleAt([closed, cycle], { bedId: "bed-01", tier: 2 }), cycle);
  assert.equal(cycleAt([cycle], { bedId: "bed-02", tier: 2 }), null);
  assert.equal(cycleAt([cycle], { bedId: "bed-01", tier: 1 }), null);
});
test("selection resolves only registered layout identifiers", () => {
  const layout = { beds: [{ id: "bed-01", zone_id: "zone-a" }] } as FarmLayout;
  assert.equal(selectedBed(layout, { bedId: "bed-02", tier: 1 }), null);
  assert.equal(
    selectedBed(layout, { bedId: "bed-01", tier: 1 })?.zone_id,
    "zone-a",
  );
});

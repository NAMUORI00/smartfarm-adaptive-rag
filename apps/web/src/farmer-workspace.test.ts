import test from "node:test";
import assert from "node:assert/strict";
import {
  controlProvenance,
  observationProblem,
  relevantObservationKey,
  deviceRevision,
  plannedHarvests,
} from "./farmer/workspace-state.ts";
import type { DashboardSnapshot, Metric } from "./types.ts";
const metric = {
  key: "moisture",
  zoneId: "zone-a",
  value: "50",
  status: "normal",
  quality: "good",
  observedAt: new Date().toISOString(),
} as Metric;
const snapshot = {
  metrics: [metric],
  actuators: [],
  alerts: [],
  operationalControlAllowed: true,
  dataOrigin: "telemetry_service",
} as unknown as DashboardSnapshot;
test("missing and stale observations cannot be described as a normal farm", () => {
  assert.equal(observationProblem([]), true);
  assert.equal(observationProblem([metric]), false);
  assert.equal(
    observationProblem([{ ...metric, observedAt: "invalid" }]),
    true,
  );
  assert.equal(
    observationProblem([
      { ...metric, observedAt: new Date(Date.now() - 301000).toISOString() },
    ]),
    true,
  );
});
test("unrelated zone and normal jitter leave selective review unchanged", () => {
  const changed = {
    ...snapshot,
    metrics: [
      { ...metric, value: "51" },
      { ...metric, zoneId: "zone-b", value: "5", status: "critical" as const },
    ],
  };
  assert.equal(
    relevantObservationKey(snapshot, "zone-a", true),
    relevantObservationKey(changed, "zone-a", true),
  );
  assert.notEqual(
    relevantObservationKey(snapshot, "zone-a", false),
    relevantObservationKey(changed, "zone-a", false),
  );
});
test("quality change invalidates advice even without numeric change", () => {
  assert.notEqual(
    relevantObservationKey(snapshot, "zone-a", true),
    relevantObservationKey(
      { ...snapshot, metrics: [{ ...metric, quality: "stale" }] },
      "zone-a",
      true,
    ),
  );
});
test("changed scope, reported state or lost control eligibility invalidate an approval preview", () => {
  assert.notEqual(
    deviceRevision(undefined, snapshot),
    deviceRevision(undefined, {
      ...snapshot,
      operationalControlAllowed: false,
    }),
  );
});
test("harvest ordering uses registered dates and excludes ended cycles", () => {
  const cycles = [
    { id: "a", status: "growing", planned_harvest_from: "2026-10-02" },
    { id: "b", status: "growing", planned_harvest_from: "2026-09-12" },
    { id: "c", status: "growing", planned_harvest_from: null },
    { id: "d", status: "harvested", planned_harvest_from: "2026-09-01" },
  ];
  assert.deepEqual(
    plannedHarvests(cycles as never).map((c) => c.id),
    ["b", "a"],
  );
});

test("direct controls omit advisor-only provenance; advisor controls retain it", () => {
  assert.deepEqual(
    controlProvenance({ origin: "manual", advisorRunId: null } as never),
    {},
  );
  const result = controlProvenance({
    origin: "verified_telemetry_rule",
    advisorRunId: "run-1",
    evidenceIds: ["source-1"],
    alertId: "a",
    alertOccurrenceId: "o",
  } as never);
  assert.equal(result.advisorRunId, "run-1");
  assert.deepEqual(result.evidenceIds, ["source-1"]);
});

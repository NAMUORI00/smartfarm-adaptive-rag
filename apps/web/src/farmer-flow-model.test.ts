import test from "node:test";
import assert from "node:assert/strict";
import { crossPartners, gapText, pickControlCase, readingEvidence, routeKind, routePath, sensorPass, studyTargets } from "./farmer/flow-model.ts";
import type { FlowCell, Lane } from "./farmer/flow-model.ts";
import type { Metric, OperationCase, OperationCaseAction } from "./types.ts";

const metric = (key: string, over: Partial<Metric> = {}): Metric => ({
  key, label: key, value: "18", unit: "°C", delta: "", trend: "steady", tone: "mint", icon: "thermometer", status: "normal", zoneId: "zone-a", quality: "good", ...over,
});

test("readings on their way in: doubtful ones leave the judgement, the rest are placed against the range", () => {
  const metrics = [
    metric("air_temperature_c", { value: "64.9992", quality: "bad", status: "warning" }),
    metric("root_zone_temperature_c"),
    metric("relative_humidity_pct", { unit: "%" }),
    metric("co2_ppm", { status: "warning" }),
    metric("rain_detected"),
    metric("root_zone_temperature_c", { zoneId: "zone-b" }),
  ];
  const pass = sensorPass(metrics, "zone-a", (key) => key !== "rain_detected");
  assert.equal(pass.total, 5);
  assert.equal(pass.good, 4);
  assert.deepEqual(pass.doubtful.map((m) => m.key), ["air_temperature_c"]);
  assert.deepEqual(pass.outside.map((m) => m.key), ["co2_ppm"]);
  assert.equal(pass.inRange, 2);
  assert.equal(pass.noRange, 1);
  // The doubtful air temperature is checked against the root zone and the humidity of the same zone.
  assert.deepEqual(crossPartners(metrics, "zone-a", "air_temperature_c").map((m) => m.key), ["root_zone_temperature_c", "relative_humidity_pct"]);
});

test("the readings an answer read are named as the sensor, with a doubtful one kept marked", () => {
  assert.deepEqual(readingEvidence("고추냉이 고설베드 A동 · 1구역 최신 근권 온도", "1구역 (zone-a), 2026-09-28T04:20:08+00:00 관측값: 16 °C (상태: 기준 범위)."), { name: "근권 온도", value: "16 °C", doubtful: false });
  assert.deepEqual(
    readingEvidence("고추냉이 고설베드 A동 · 1구역 최신 재배실 온도", "1구역 (zone-a), 2026-09-28T04:20:08+00:00 관측값: 65 °C (상태: 확인 필요). 센서 품질 의심: 이 값은 실제 환경으로 해석하지 말고 판단 근거에서 제외하세요."),
    { name: "재배실 온도", value: "65 °C", doubtful: true },
  );
  assert.equal(readingEvidence("고추냉이 재배 기술 자료", "잎이 황변하면서 고사한다."), null);
});

const action = (over: Partial<OperationCaseAction>): OperationCaseAction => ({
  proposalId: "p", status: "approved", target: "ventilation_fan", zoneId: "zone-b", requestedValue: 100, rationale: "", createdAt: "2026-09-09T04:51:29Z",
  approvedAt: "2026-09-09T04:51:29Z", approvedBy: "demo-admin", executionId: "x", executedAt: "2026-09-09T04:51:30Z", expectedEffects: [],
  verification: { status: "verified", outcome: "device_applied", checkedAt: "2026-09-09T04:51:31Z", targetState: "100%", requestedValue: 100, detail: "" }, ...over,
});
const kase = (over: Partial<OperationCase>): OperationCase => ({
  id: "c", incidentId: "i", alertId: "a", occurrenceId: "o", title: "공기 온도가 시범 운영 recipe 상한을 벗어났습니다.", zoneId: "zone-b", severity: "warning", status: "resolved",
  recoveryVerdict: "recovered", dataMode: "simulated", inputMode: "demo", openedAt: "2026-09-09T04:38:33Z", lastObservedAt: "2026-09-09T04:53:39Z", acknowledgedAt: null,
  resolvedAt: "2026-09-09T04:53:39Z", expectedOutcome: "", observedOutcome: "", nextAction: "", evidence: [], actions: [action({})], timeline: [], ...over,
});

test("the control flow replays the newest change a person allowed that ended in recovery", () => {
  const older = kase({ id: "older" });
  const newer = kase({ id: "newer", actions: [action({ approvedAt: "2026-09-28T01:02:48Z", executedAt: "2026-09-28T01:02:49Z" })] });
  const open = kase({ id: "open", status: "needs_action", recoveryVerdict: "not_measured", actions: [action({ approvedAt: "2026-09-29T00:00:00Z" })] });
  const rejected = kase({ id: "rejected", actions: [action({ status: "rejected", approvedAt: "2026-09-30T00:00:00Z" })] });
  assert.equal(pickControlCase([older, newer, open, rejected])?.item.id, "newer");
  assert.equal(pickControlCase([open, rejected]), null);
});

test("gaps between records read as a person says them", () => {
  assert.equal(gapText("2026-09-28T01:02:48Z", "2026-09-28T01:02:49Z"), "1초");
  assert.equal(gapText("2026-09-28T01:02:49Z", "2026-09-28T01:03:30Z"), "41초");
  assert.equal(gapText("2026-09-28T01:03:30Z", "2026-09-28T01:06:18Z"), "2분 48초");
  assert.equal(gapText("2026-09-28T01:00:00Z", "2026-09-28T01:05:00Z"), "5분");
  assert.equal(gapText("2026-09-22T02:43:13Z", "2026-09-28T01:02:48Z"), "5일");
  assert.equal(gapText("2026-09-28T01:00:00Z", "2026-09-27T01:00:00Z"), null);
  assert.equal(gapText(null, "2026-09-28T01:00:00Z"), null);
});

const lanes: Lane[] = ["screen", "ai", "server", "field"];
const cell = (id: string, lane: Lane, col: number): FlowCell => ({ id, lane, col });

test("wires keep off other boxes and prefer running along the lane the data leaves", () => {
  const sensor = cell("sensor", "field", 1), inbox = cell("in", "server", 2), check = cell("check", "server", 3), range = cell("range", "server", 4), ai = cell("ai", "ai", 5), screen = cell("screen", "screen", 6);
  const cells = [sensor, inbox, check, range, ai, screen];
  assert.equal(routeKind(sensor, inbox, cells, lanes), "across");
  assert.equal(routeKind(inbox, check, cells, lanes), "straight");
  // The doubtful reading skips the range box: up out of the check box, then along the AI lane.
  assert.equal(routeKind(check, ai, cells, lanes), "rise");
  assert.equal(routeKind(range, ai, cells, lanes), "across");
  // Readings under the answer box in the same column.
  const readings = cell("readings", "field", 5);
  assert.equal(routeKind(readings, ai, [...cells, readings], lanes), "column");
});

test("routes turn into paths with a label on their long run", () => {
  const a = { x: 0, y: 300, w: 150, h: 80 }, b = { x: 176, y: 180, w: 150, h: 80 };
  const across = routePath("across", a, b);
  assert.match(across.d, /^M150 340H241Q251 340 251 330V260$/);
  assert.ok(across.label && across.label.y === 340 && across.label.room > 64);
  const rise = routePath("rise", a, { x: 352, y: 60, w: 150, h: 80 });
  assert.match(rise.d, /^M75 300V110Q75 100 85 100H352$/);
  const straight = routePath("straight", a, { x: 176, y: 300, w: 150, h: 80 });
  assert.equal(straight.d, "M150 340H176");
  assert.equal(straight.label, null);
  const column = routePath("column", { x: 0, y: 300, w: 150, h: 80 }, { x: 0, y: 60, w: 150, h: 100 });
  assert.equal(column.d, "M75 300V160");
});

test("each study opens where it works in the dashboard", () => {
  const context = (over: object) => ({ selectedSourceIds: [], includeSimulationContext: true, selectedZoneIds: [], zoneScopeMode: "all" as const, sourceVisibility: "public" as const, ...over });
  const metrics = [metric("air_temperature_c", { quality: "bad" }), metric("root_zone_temperature_c")];
  const actuators = [{ key: "a-fan", target: "ventilation_fan" as const, zoneId: "zone-a" }, { key: "a-sensor", target: "air_temperature_sensor_reset" as const, zoneId: "zone-a" }];
  // The answer asked for zone A opens zone A with the advisor; the doubtful air sensor opens its device.
  const zone = studyTargets({ askedAt: context({ selectedZoneIds: ["zone-a"], zoneScopeMode: "focused" }), metrics, actuators, firstZone: "zone-a" });
  assert.deepEqual(zone[1], { kind: "zone", zoneId: "zone-a", chat: true });
  assert.deepEqual(zone[2], { kind: "camera", focus: "multiview" });
  assert.deepEqual(zone[3], { kind: "device", zoneId: "zone-a", key: "a-sensor", tab: "state" });
  // An answer asked at a bed opens that bed and tier with the advisor; a farm-wide one opens the advisor alone.
  assert.deepEqual(studyTargets({ askedAt: context({ bedId: "bed-04", tier: 2 }), metrics, actuators, firstZone: null })[1], { kind: "bed", bedId: "bed-04", tier: 2, chat: true });
  assert.deepEqual(studyTargets({ askedAt: context({}), metrics, actuators, firstZone: null })[1], { kind: "chat" });
  // With every reading sound, study 3 opens the first zone.
  assert.deepEqual(studyTargets({ askedAt: null, metrics: [metric("air_temperature_c")], actuators, firstZone: "zone-a" })[3], { kind: "zone", zoneId: "zone-a" });
});

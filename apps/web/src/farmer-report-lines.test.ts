import test from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "./farmer/ai-brief.ts";
import type { BriefInput, BriefItem } from "./farmer/ai-brief.ts";
import { handoverGroups, handoverLines, weekSummary, workPlan } from "./farmer/report-lines.ts";

const zoneLabel = (id?: string | null) => (id === "zone-a" ? "A구역" : id === "zone-b" ? "B구역" : "농장");
const quiet: BriefInput = {
  connected: true, alerts: [], metrics: [], thresholds: [], actuators: [], pending: [], cycles: [],
  beds: [{ id: "bed-02", label: "2번 베드", zone_id: "zone-a" }, { id: "bed-10", label: "10번 베드", zone_id: "zone-b" }],
  zoneLabel, cameras: [], turns: [], now: Date.parse("2026-09-28T01:00:00Z"),
};
const passage = { sentence: "여름에는 연부병, 묵입병 등으로 고사하기 쉽다.", source_id: "p35", title: "고추냉이 재배 기술 자료 · 35쪽", location: "35쪽", source_url: null };

test("a disease notice needs both the sensor condition and a guide sentence, and is reference-only", () => {
  const watch = { window_hours: 12, reference_only: true as const, zones: [{ zone_id: "zone-a", conditions: [
    { id: "humid", metric: "relative_humidity_pct", label: "상대 습도 기준 상한 초과", hours: 3.46, threshold: 85, observed_max: 93, passages: [passage] },
    { id: "hot", metric: "air_temperature_c", label: "재배실 온도 기준 상한 초과", hours: 2.5, threshold: 20, observed_max: 24, passages: [] },
  ] }] };
  const items = buildBrief({ ...quiet, diseaseWatch: watch });
  assert.equal(items.length, 1, "a condition without a guide sentence raises nothing");
  assert.equal(items[0].what, "A구역 병해 주의: 상대 습도 기준 상한 초과");
  assert.match(items[0].why, /12시간 중 3.5시간/);
  assert.match(items[0].why, /연부병/);
  assert.equal(items[0].ref, "disease");
  assert.equal(items[0].go, "ask");
});

test("tomorrow's forecast is compared with the farm's own air-temperature range", () => {
  const weather = { configured: true as const, available: true as const, label: "제주", latitude: 33.45, longitude: 126.56, source: "Open-Meteo", fetched_at: "", reference_only: true as const,
    days: [{ date: "2026-09-28", t_max: 21, t_min: 17, precip_mm: 2, rh_max: 90 }, { date: "2026-09-29", t_max: 31, t_min: 4, precip_mm: 40, rh_max: 95 }] };
  const items = buildBrief({ ...quiet, weather, thresholds: [{ metric: "air_temperature_c", lower: 6, upper: 20 }] });
  assert.deepEqual(items.map((i) => i.id), ["weather:hot:2026-09-29", "weather:cold:2026-09-29", "weather:rain:2026-09-29"]);
  assert.match(items[0].why, /기준 상한 20°C보다 높습니다/);
  assert.ok(items.every((i) => i.ref === "weather" && i.anchor === null));
  // No registered range: no temperature notice is made up.
  assert.deepEqual(buildBrief({ ...quiet, weather }).map((i) => i.id), ["weather:rain:2026-09-29"]);
});

test("a device whose actual output stays off its request is pointed out without calling it a fault", () => {
  const items = buildBrief({ ...quiet, actuators: [{ key: "zone-a:ventilation_fan", target: "ventilation_fan", label: "환기팬", zoneId: "zone-a", state: "40%", health: "normal", desiredValue: 70, effectiveValue: 40, reportedValue: 40, capability: null }] });
  assert.equal(items[0].what, "환기팬 출력이 요청과 다름");
  assert.match(items[0].why, /요청 70%, 실제 출력 40%/);
  assert.match(items[0].why, /고장 판정은 아닙니다/);
  const close = buildBrief({ ...quiet, actuators: [{ key: "zone-a:ventilation_fan", target: "ventilation_fan", label: "환기팬", zoneId: "zone-a", state: "65%", health: "normal", desiredValue: 70, effectiveValue: 65, reportedValue: 65, capability: null }] });
  assert.equal(close.length, 0);
});

test("a seen alert steps back and an item hidden for today leaves the list", () => {
  const alert = { id: "farm-wasabi-a:root_zone_temperature_c:threshold:high", severity: "critical" as const, title: "근권 온도 경보", detail: "", kind: "crop_risk" as const, zoneId: "zone-a" };
  const cycles = [{ bed_id: "bed-10", tier: 1, crop: "고추냉이", remaining_count: 8, planned_harvest_from: "2026-09-20", status: "growing" }];
  const first = buildBrief({ ...quiet, alerts: [alert], cycles });
  assert.equal(first[0].id, "alert:zone-a:crop");
  const seen = buildBrief({ ...quiet, alerts: [alert], cycles, acknowledged: { [alert.id]: "2026-09-28T00:50:00Z" } });
  assert.equal(seen.find((i) => i.alertId)?.acknowledgedAt, "2026-09-28T00:50:00Z");
  assert.ok(seen.findIndex((i) => i.alertId) > 0, "a seen alert is no longer first");
  assert.equal(buildBrief({ ...quiet, cycles, hidden: ["harvest:bed-10"] }).length, 0);
});

test("the handover lists open items first, then the records, without repeats", () => {
  const open = [{ what: "2번 베드 수확 예정일 지남", todo: "수확 기록", tone: "attention", go: "harvest" }] as BriefItem[];
  const lines = handoverLines([
    { at: "2026-09-28T00:30:00Z", kind: "control", text: "A구역 / 환기팬 60%" },
    { at: "2026-09-28T00:10:00Z", kind: "alert", text: "A구역 / 근권 온도, 위험" },
  ], open);
  assert.deepEqual(lines.map((l) => l.kind), ["open", "control", "alert"]);
  assert.deepEqual(lines.map((l) => l.at), [null, "2026-09-28T00:30:00Z", "2026-09-28T00:10:00Z"]);
  assert.deepEqual(handoverGroups(lines).map((g) => [g.label, g.lines.length]), [["남은 일", 1], ["경보", 1], ["설비 변경", 1]]);
  assert.equal(lines[0].text, "2번 베드 수확 예정일 지남: 수확 기록");
  // An example camera's finding is not this farm's record.
  assert.equal(handoverLines([], [{ what: "출입 경계선 통과", todo: "화면 보기", tone: "attention", go: "camera", example: true }] as BriefItem[]).length, 0);
});

test("the week counts recorded harvests, cases and allowed changes only", () => {
  const now = Date.parse("2026-09-28T01:00:00Z");
  const week = weekSummary({
    now,
    beds: [{ id: "bed-02", label: "2번 베드" }],
    cycles: [{ bed_id: "bed-02", harvests: [{ weight_kg: 0.5, harvested_at: "2026-09-27T02:00:00Z", removed_count: 0 }, { weight_kg: 9, harvested_at: "2026-09-01T02:00:00Z", removed_count: 0 }] }],
    cases: [{ openedAt: "2026-09-26T00:00:00Z", status: "resolved" }, { openedAt: "2026-09-27T00:00:00Z", status: "needs_action" }],
    approvals: [{ createdAtIso: "2026-09-27T03:00:00Z", status: "approved", executionStatus: "applied_to_simulator" }, { createdAtIso: "2026-09-27T04:00:00Z", status: "rejected", executionStatus: "not_executed" }],
  });
  assert.equal(week.harvestKg, 0.5);
  assert.equal(week.harvestCount, 1);
  assert.equal(week.cases, 2);
  assert.equal(week.resolved, 1);
  assert.equal(week.controls, 1);
  assert.equal(week.applied, 1);
});

test("today's work puts urgent items first, then walks the rows zone by zone", () => {
  const item = (id: string, tone: BriefItem["tone"], anchor: BriefItem["anchor"]) => ({ id, tone, anchor, what: id, todo: "", go: "zone", ask: null, why: "", priority: 1, sources: [] }) as BriefItem;
  const beds = [{ id: "bed-02", zone_id: "zone-a", position: { x: 1, z: 0 } }, { id: "bed-10", zone_id: "zone-b", position: { x: 3, z: 1 } }, { id: "bed-01", zone_id: "zone-a", position: { x: 0, z: 0 } }];
  const stops = workPlan([
    item("b10", "info", { kind: "bed", zoneId: "zone-b", bedId: "bed-10" }),
    item("a-device", "attention", { kind: "device", zoneId: "zone-a", deviceKey: "zone-a:heater" }),
    item("b02", "info", { kind: "bed", zoneId: "zone-a", bedId: "bed-02" }),
    item("sensor", "danger", { kind: "device", zoneId: "zone-a", deviceKey: "zone-a:air_temperature_sensor_reset" }),
    item("b01", "attention", { kind: "bed", zoneId: "zone-a", bedId: "bed-01" }),
  ], beds, ["zone-a", "zone-b"]);
  assert.deepEqual(stops.map((s) => s.id), ["sensor", "b01", "b02", "a-device", "b10"]);
});

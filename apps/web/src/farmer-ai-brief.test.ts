import test from "node:test";
import assert from "node:assert/strict";
import { advisoryLines, alertMetricKey, buildBrief, farmWords } from "./farmer/ai-brief.ts";
import type { BriefInput } from "./farmer/ai-brief.ts";
import type { DemoCamera } from "./farmer/demo-cameras.ts";
import { setLang } from "./farmer/i18n.ts";

const zoneLabel = (id?: string | null) => (id === "zone-a" ? "A구역" : id === "zone-b" ? "B구역" : "농장");
const metric = (key: string, label: string, value: string, unit: string, extra: Partial<BriefInput["metrics"][number]> = {}) =>
  ({ key, label, value, unit, status: "normal", quality: "good", zoneId: "zone-a", ...extra }) as BriefInput["metrics"][number];
const device = (key: string, target: string, label: string, state: string, extra: Partial<BriefInput["actuators"][number]> = {}) =>
  ({ key, target, label, zoneId: "zone-a", state, health: "normal", effectiveValue: null, reportedValue: null, capability: { valueType: "boolean" }, ...extra }) as BriefInput["actuators"][number];
const quiet: BriefInput = {
  connected: true, alerts: [], metrics: [], thresholds: [], actuators: [], pending: [], cycles: [],
  beds: [{ id: "bed-04", label: "4번 베드", zone_id: "zone-a" }, { id: "bed-10", label: "10번 베드", zone_id: "zone-b" }],
  zoneLabel, cameras: [], turns: [], now: Date.parse("2026-09-28T01:00:00Z"),
};

test("the metric an alert is about is read from its id", () => {
  assert.equal(alertMetricKey("farm-wasabi-a:air_temperature_c:sensor-health"), "air_temperature_c");
  assert.equal(alertMetricKey("farm-wasabi-a:root_zone_temperature_c:threshold:high"), "root_zone_temperature_c");
  assert.equal(alertMetricKey("weird"), null);
});

test("a sensor fault is told apart from a real change by the other sensors of the zone", () => {
  const [item] = buildBrief({
    ...quiet,
    alerts: [{ id: "farm-wasabi-a:air_temperature_c:sensor-health", severity: "critical", title: "재배실 온도 센서 건전성 경보", detail: "", kind: "sensor_health", zoneId: "zone-a", occurredAt: "2026-09-28T00:00:00Z" }],
    metrics: [
      metric("air_temperature_c", "재배실 온도", "64.9992", "°C", { status: "warning", quality: "suspect" }),
      metric("root_zone_temperature_c", "근권 온도", "16.0008", "°C"),
      metric("relative_humidity_pct", "상대 습도", "71.9992", "%"),
    ],
    actuators: [device("zone-a:air_temperature_sensor_reset", "air_temperature_sensor_reset", "재배실 온도 센서 재보정", "normal")],
  });
  assert.equal(item.what, "재배실 온도 센서 이상 의심");
  assert.equal(item.tone, "danger");
  assert.match(item.why, /65\.0°C는 온실에서 나오기 어려운 값/);
  assert.match(item.why, /근권 온도 16\.0°C, 상대 습도 72%는 정상이라 실제 환경보다 센서 문제/);
  assert.match(item.why, /점검 전까지 이 값으로 설비를 조절하지 않습니다/);
  // Pinned on the sensor itself, and the question is one the growing guides answer.
  assert.deepEqual(item.anchor, { kind: "device", zoneId: "zone-a", deviceKey: "zone-a:air_temperature_sensor_reset" });
  assert.equal(item.ask, "온도 센서 고장 점검 방법");
  assert.equal(item.alertId, "farm-wasabi-a:air_temperature_c:sensor-health");
});

test("a reading out of range names the device that moves it and whether it runs", () => {
  const input: BriefInput = {
    ...quiet,
    alerts: [{ id: "farm-wasabi-a:root_zone_temperature_c:threshold:high", severity: "warning", title: "근권 온도 경보", detail: "", kind: "crop_risk", zoneId: "zone-a" }],
    metrics: [metric("root_zone_temperature_c", "근권 온도", "22.1", "°C", { status: "warning" })],
    thresholds: [{ metric: "root_zone_temperature_c", lower: 15, upper: 18 }],
    actuators: [device("zone-a:root_zone_chiller", "root_zone_chiller", "근권 냉각기", "off", { reportedValue: false })],
  };
  const [off] = buildBrief(input);
  assert.equal(off.what, "근권 온도 높음");
  assert.equal(off.why, "22.1°C로 기준 15.0–18.0°C보다 높습니다. 냉각기가 꺼져 있습니다.");
  assert.equal(off.todo, "냉각기 조절");
  assert.equal(off.anchor?.kind, "device");
  assert.equal(off.ask, "고추냉이 근권 온도 높을 때 관리");
  const [on] = buildBrief({ ...input, actuators: [device("zone-a:root_zone_chiller", "root_zone_chiller", "근권 냉각기", "on", { reportedValue: true })] });
  assert.match(on.why, /냉각기가 가동 중인데도 벗어나 있어/);
  assert.equal(on.todo, "냉각기 확인");
});

test("no connection comes first and nothing is claimed from stale values", () => {
  const items = buildBrief({ ...quiet, connected: false, cycles: [{ bed_id: "bed-10", tier: 1, crop: "고추냉이", remaining_count: 8, planned_harvest_from: "2026-09-20", status: "growing" }] });
  assert.equal(items[0].id, "reconnect");
  assert.equal(items[0].anchor, null);
});

test("an example camera finding is marked as an example and asks a searchable question", () => {
  const camera = {
    id: "cam-a2", label_ko: "4번 베드 근접", label_en: "Bed 4 close-up", zone_id: "zone-a", bed_id: "bed-04", col: 0, row: 0, angle: 0, image: "", summary_ko: "", summary_en: "",
    questions: [{ id: "q1", question_ko: "잎 끝이 황변하고 있습니까?", question_en: "", decision: "answer", answer_ko: "예, 앞쪽 잎의 가장자리에 황변이 보입니다.", answer_en: "", reason_ko: "", reason_en: "", confidence: 0.99, box: null, alert: true, finding_ko: "잎 가장자리 황변", ask_ko: "고추냉이 잎이 누렇게 변하는 원인" }],
  } as DemoCamera;
  const [item] = buildBrief({ ...quiet, cameras: [camera] });
  assert.equal(item.what, "4번 베드 잎 가장자리 황변");
  assert.equal(item.example, true);
  assert.match(item.why, /확신도 99%/);
  assert.equal(item.ask, "고추냉이 잎이 누렇게 변하는 원인");
  assert.deepEqual(item.askAt, { zoneId: "zone-a", bedId: "bed-04" });
  // Abstentions never raise an item.
  const abstain = { ...camera, questions: [{ ...camera.questions[0], decision: "abstain" as const }] };
  assert.equal(buildBrief({ ...quiet, cameras: [abstain] }).length, 0);
});

test("an answer rewritten after a sensor change is reported with how much changed", () => {
  const [item] = buildBrief({
    ...quiet,
    turns: [{ id: "t1", status: "complete", recordedAt: "2026-09-28T00:50:00Z", queryContext: { bedId: "bed-04", selectedSourceIds: [], includeSimulationContext: true, selectedZoneIds: ["zone-a"], zoneScopeMode: "focused", sourceVisibility: "public" }, stateReview: { mode: "selective", status: "updated", baseline_revision: 3, previous_response_id: "r0", refresh_count: 1, changed_units: ["state"], units: [] } }],
  });
  assert.equal(item.what, "4번 베드 답변을 새 값으로 고침");
  assert.match(item.why, /답의 1부분을 다시 확인하고 고쳤습니다/);
  assert.deepEqual(item.anchor, { kind: "bed", zoneId: "zone-a", bedId: "bed-04" });
});

test("overdue and near harvests are pinned to their bed", () => {
  const items = buildBrief({ ...quiet, cycles: [
    { bed_id: "bed-10", tier: 1, crop: "고추냉이", remaining_count: 8, planned_harvest_from: "2026-09-20", status: "growing" },
    { bed_id: "bed-04", tier: 1, crop: "고추냉이", remaining_count: 24, planned_harvest_from: "2026-12-20", status: "growing" },
  ] });
  assert.equal(items.length, 1);
  assert.equal(items[0].what, "10번 베드 수확 예정일 지남");
  assert.deepEqual(items[0].anchor, { kind: "bed", zoneId: "zone-b", bedId: "bed-10" });
});

test("the AI alert analysis gives its first check and first adjustment line", () => {
  const warning = "**현재 상황**\n- 경보: 활성.\n\n**우선 점검**\n1. 재배실 온도 64.9992°C 관측은 **계측 이상**으로 판단됩니다.\n2. 배선 점검.\n\n**조정 제안**\n- 센서값이 검증되기 전에는 환경장치 조정을 실행하지 마세요.\n\n**운영 원칙**\n- 원칙.";
  assert.deepEqual(advisoryLines(warning), {
    check: "재배실 온도 65°C 관측은 계측 이상으로 판단됩니다.",
    adjust: "센서값이 검증되기 전에는 환경장치 조정을 실행하지 마세요.",
  });
  assert.deepEqual(advisoryLines("no sections"), { check: null, adjust: null });
});

test("an English analysis is read by its English labels, as the model may translate them", () => {
  const english = "**현재 상황**\n- 경보: 활성.\n\n**Priority checks**\n1. Check the sensor wiring first.\n\n**Adjustment suggestions**\n- Do not change heating on the suspect reading.\n\n**Needs confirmation**\n- None.";
  assert.deepEqual(advisoryLines(english), { check: "Check the sensor wiring first.", adjust: "Do not change heating on the suspect reading." });
  // A Korean label with an English body still reads.
  assert.equal(advisoryLines("**우선 점검**\n1. Check drain EC.").check, "Check drain EC.");
});

test("a forecast value that did not come is not read as zero", () => {
  const weather = (day: { t_max: number | null; t_min: number | null; precip_mm: number | null }) => ({
    configured: true as const, available: true as const, label: "제주", latitude: 33.45, longitude: 126.56, source: "Open-Meteo", fetched_at: "2026-09-28T00:00:00Z", reference_only: true as const,
    days: [{ date: "2026-09-28", t_max: 20, t_min: 15, precip_mm: 0, rh_max: 80 }, { date: "2026-09-29", rh_max: 90, ...day }],
  });
  const thresholds = [{ metric: "air_temperature_c", lower: 10, upper: 20 }];
  const ids = (day: Parameters<typeof weather>[0]) => buildBrief({ ...quiet, thresholds, weather: weather(day) }).map((i) => i.id);
  // Null compared as 0 used to raise a cold warning "최저 null°C".
  assert.deepEqual(ids({ t_max: null, t_min: null, precip_mm: null }), []);
  assert.deepEqual(ids({ t_max: 27.5, t_min: 6, precip_mm: 40 }), ["weather:hot:2026-09-29", "weather:cold:2026-09-29", "weather:rain:2026-09-29"]);
});

test("the brief reads in English", () => {
  setLang("en");
  try {
    const [item] = buildBrief({
      ...quiet,
      alerts: [{ id: "farm-wasabi-a:root_zone_temperature_c:threshold:high", severity: "warning", title: "근권 온도 경보", detail: "", kind: "crop_risk", zoneId: "zone-a" }],
      metrics: [metric("root_zone_temperature_c", "근권 온도", "22.1", "°C", { status: "warning" })],
      thresholds: [{ metric: "root_zone_temperature_c", lower: 15, upper: 18 }],
      actuators: [device("zone-a:root_zone_chiller", "root_zone_chiller", "근권 냉각기", "off", { reportedValue: false })],
    });
    assert.equal(item.what, "Root-zone temperature high");
    assert.equal(item.todo, "Adjust Chiller");
  } finally {
    setLang("ko");
  }
});

test("server wording is shown with the layout's zone names", () => {
  assert.equal(
    farmWords("1구역 활성 critical 경보에 대응합니다. 2구역과 12구역은 그대로.", zoneLabel),
    "A구역 활성 긴급 경보에 대응합니다. B구역과 12구역은 그대로.",
  );
  assert.equal(farmWords("재배실 온도 64.9992°C, 시범 운영 recipe 상한", zoneLabel), "재배실 온도 65°C, 시범 운영 재배 기준 상한");
  assert.equal(farmWords("Current status: Zone 2, Zone 1 and Zone 12", (id) => (id === "zone-a" ? "Zone A" : "Zone B")), "Current status: Zone B, Zone A and Zone 12");
});

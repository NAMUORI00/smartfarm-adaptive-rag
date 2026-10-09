import test from "node:test";
import assert from "node:assert/strict";
import { deviceLevel, deviceShortLabel, stageCues } from "./farmer/stage-cues.ts";
import type { Actuator, Metric } from "./types.ts";
import { setLang } from "./farmer/i18n.ts";

const metric = (key: string, value: string, status: Metric["status"] = "normal", extra: Partial<Metric> = {}): Metric => ({
  key, label: key, value, unit: "°C", delta: "", trend: "steady", tone: "mint", icon: "thermometer", status, zoneId: "zone-a", quality: "good", ...extra,
});
const device = (target: Actuator["target"], extra: Partial<Actuator> = {}): Actuator => ({
  key: `zone-a:${target}`, target, label: String(target), state: "off", controllable: true, executionScope: "simulator_only", zoneId: "zone-a", health: "normal",
  capability: { action: "set_actuator_state", valueType: target === "ventilation_fan" || target === "roof_vent" || target === "side_vent" || target === "shade_curtain" ? "percentage" : "boolean", minimum: 0, maximum: 100, step: 5, mcpAction: "x" },
  ...extra,
});
const thresholds = [{ metric: "air_temperature_c", lower: 6, upper: 20, unit: "°C", sourceId: null }, { metric: "root_zone_temperature_c", lower: 10, upper: 16, unit: "°C", sourceId: null }];

test("a doubtful air sensor is said as a sensor problem, not as heat", () => {
  const out = stageCues({ metrics: [metric("air_temperature_c", "65", "warning", { quality: "suspect" })], thresholds, alerts: [], actuators: [], zoneId: "zone-a", connected: true });
  assert.equal(out.air, null);
  assert.equal(out.sensor, "attention");
  assert.equal(out.cues[0].id, "sensor_suspect");
  assert.equal(out.cues[0].part, "sensor");
});

test("readings above their range become hot cues on the right part of the bed", () => {
  const out = stageCues({ metrics: [metric("air_temperature_c", "24.4", "warning"), metric("root_zone_temperature_c", "21", "critical")], thresholds, alerts: [], actuators: [], zoneId: "zone-a", connected: true });
  assert.equal(out.air, "hot");
  assert.equal(out.root, "hot");
  // Danger first, then attention.
  assert.deepEqual(out.cues.map((c) => c.id), ["root_high", "air_high"]);
  assert.match(out.cues[0].label, /근권 온도 높음 21 °C/);
  assert.equal(out.cues[0].tone, "danger");
});

test("device reports drive airflow and on-devices get a flow cue; faults come first", () => {
  const out = stageCues({
    metrics: [], thresholds, alerts: [], zoneId: "zone-a", connected: true,
    actuators: [device("ventilation_fan", { effectiveValue: 40 }), device("heater", { effectiveValue: true }), device("irrigation_pump", { health: "fault" }), device("roof_vent", { effectiveValue: 60 })],
  });
  assert.equal(out.airflow.fan, 0.4);
  assert.equal(out.airflow.heater, true);
  assert.equal(out.airflow.roofVent, 0.6);
  assert.equal(out.cues[0].label, "펌프 점검 필요");
  assert.ok(out.cues.some((c) => c.id === "running" && /가동: 난방 중, 환기팬 40% 출력/.test(c.label)));
});

test("crop-risk alerts tint the plants and the cue says it is an alert level", () => {
  const out = stageCues({ metrics: [], thresholds, alerts: [{ kind: "crop_risk", severity: "critical", status: "new", zoneId: "zone-a", title: "근권 온도 경보" }], actuators: [], zoneId: "zone-a", connected: true });
  assert.equal(out.plantTone, "danger");
  assert.match(out.cues[0].note, /실측이 아닙니다/);
});

test("device level reads percentages and booleans in the device's words", () => {
  assert.deepEqual(deviceLevel(device("shade_curtain", { effectiveValue: 35 })), { on: true, percent: 35, text: "35% 펼침" });
  assert.deepEqual(deviceLevel(device("root_zone_chiller", { reportedValue: true })), { on: true, percent: null, text: "냉각 중" });
  assert.deepEqual(deviceLevel(device("heater", { state: "off" })), { on: false, percent: null, text: "꺼짐" });
  assert.equal(deviceShortLabel("air_temperature_sensor_reset", "공기 온도 센서 재보정"), "온도 센서");
});

test("a lost connection stops every flow and says the values are the last received", () => {
  const out = stageCues({ metrics: [metric("air_temperature_c", "24.4", "warning")], thresholds, alerts: [], actuators: [device("heater", { effectiveValue: true })], zoneId: "zone-a", connected: false });
  assert.equal(out.airflow.heater, false);
  assert.equal(out.air, null);
  assert.equal(out.cues[0].id, "offline");
});

test("a critical sensor alert keeps its red grade on the stage", () => {
  const out = stageCues({ metrics: [metric("air_temperature_c", "65", "critical", { quality: "suspect" })], thresholds, alerts: [{ kind: "sensor_health", severity: "critical", status: "new", zoneId: "zone-a", title: "재배실 온도 센서 건전성 경보" }], actuators: [], zoneId: "zone-a", connected: true });
  assert.equal(out.sensor, "danger");
  assert.equal(out.cues[0].tone, "danger");
});

test("in English cues and device words are English", () => {
  setLang("en");
  try {
    const out = stageCues({ metrics: [metric("root_zone_temperature_c", "21", "critical")], thresholds, alerts: [], actuators: [device("ventilation_fan", { effectiveValue: 40 }), device("heater", { effectiveValue: true })], zoneId: "zone-a", connected: true });
    assert.equal(out.cues[0].label, "Root temp high 21 °C");
    assert.ok(out.cues.some((c) => c.id === "running" && c.label === "Running: heating, Fan 40% output"));
    assert.deepEqual(deviceLevel(device("shade_curtain", { effectiveValue: 35 })), { on: true, percent: 35, text: "35% extended" });
    assert.equal(deviceShortLabel("root_zone_chiller", "x"), "Chiller");
  } finally {
    setLang("ko");
  }
});

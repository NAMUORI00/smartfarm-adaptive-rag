import test from "node:test";
import assert from "node:assert/strict";
import { controlHold } from "./farmer/control-gate.ts";
import { deviceGap, deviceProgress, SETTLE_MS, trackProgress } from "./farmer/device-progress.ts";
import { josa, setLang } from "./farmer/i18n.ts";
import type { Metric } from "./types.ts";

const now = Date.parse("2026-09-29T06:00:00Z");
const metric = (key: string, label: string, over: Partial<Metric> = {}): Metric => ({
  key, label, value: "18", unit: "°C", delta: "", trend: "steady", tone: "mint", icon: "thermometer", status: "normal", zoneId: "zone-a", quality: "good",
  observedAt: new Date(now - 5_000).toISOString(), ...over,
} as Metric);

const zone = [
  metric("air_temperature_c", "재배실 온도", { quality: "suspect", status: "warning" }),
  metric("root_zone_temperature_c", "근권 온도"),
  metric("substrate_moisture_pct", "배지 수분지수", { unit: "%" }),
  metric("relative_humidity_pct", "상대 습도", { unit: "%" }),
];

test("a doubtful air reading holds the air devices, not the chiller or the pump", () => {
  assert.equal(controlHold("root_zone_chiller", zone, [], true, now), null);
  assert.equal(controlHold("irrigation_pump", zone, [], true, now), null);
  const heater = controlHold("heater", zone, [], true, now);
  assert.equal(heater?.metric?.key, "air_temperature_c");
  assert.equal(heater?.issue, "센서 품질 확인");
  assert.equal(controlHold("ventilation_fan", zone, [], true, now)?.metric?.key, "air_temperature_c");
  // A device with no reading of its own is judged by the whole zone; no readings at all hold everything.
  assert.equal(controlHold("something_else", zone, [], true, now)?.metric?.key, "air_temperature_c");
  assert.deepEqual(controlHold("root_zone_chiller", [], [], true, now), { metric: null, issue: "관측 없음" });
  // A late root-zone reading does hold the chiller.
  const late = [metric("root_zone_temperature_c", "근권 온도", { observedAt: new Date(now - 20 * 60_000).toISOString() })];
  assert.equal(controlHold("root_zone_chiller", late, [], true, now)?.issue, "관측 지연");
});

test("a room-temperature sensor alert pauses every device of its zone, as the server does", () => {
  const alert = { id: "farm-wasabi-a:air_temperature_c:sensor-health", kind: "sensor_health" as const, status: "new" as const };
  for (const target of ["root_zone_chiller", "irrigation_pump", "heater"]) {
    const hold = controlHold(target, zone, [alert], true, now);
    assert.equal(hold?.zoneWide, true, target);
    assert.equal(hold?.metric?.key, "air_temperature_c");
  }
  // Once resolved, or for another alert, only the device's own readings count again.
  assert.equal(controlHold("root_zone_chiller", zone, [{ ...alert, status: "resolved" }], true, now), null);
  assert.equal(controlHold("root_zone_chiller", zone, [{ ...alert, id: "farm-wasabi-a:air_temperature_c:data-quality" }], true, now), null);
});

test("a request the device has not yet carried out settles for a moment, then reads as a difference", () => {
  const asked = { desiredValue: true, effectiveValue: false, reportedValue: false, health: "normal" as const };
  assert.equal(deviceGap(asked), true);
  assert.deepEqual(deviceProgress(asked, now - 3_000, now), { state: "settling", want: "켜짐", got: "꺼짐" });
  assert.deepEqual(deviceProgress(asked, now - SETTLE_MS - 1, now), { state: "differs", want: "켜짐", got: "꺼짐" });
  // A small percentage gap that lasts is noise; a large one is a difference; a fault is shown as a fault.
  assert.equal(deviceProgress({ desiredValue: 40, effectiveValue: 35, health: "normal" }, now - SETTLE_MS - 1, now), null);
  assert.deepEqual(deviceProgress({ desiredValue: 100, effectiveValue: 25, health: "normal" }, now - SETTLE_MS - 1, now), { state: "differs", want: "100%", got: "25%" });
  assert.equal(deviceProgress({ ...asked, health: "fault" }, now - 3_000, now), null);
  assert.equal(deviceProgress({ desiredValue: true, effectiveValue: true, health: "normal" }, now, now), null);
});

test("gaps are timed from when they were first seen and forgotten when they close", () => {
  const seen = new Map<string, number>();
  const pump = { key: "zone-b:irrigation_pump", desiredValue: true, effectiveValue: false, reportedValue: false, health: "normal" as const };
  assert.equal(trackProgress([pump], seen, now)["zone-b:irrigation_pump"].state, "settling");
  assert.equal(trackProgress([pump], seen, now + SETTLE_MS + 1)["zone-b:irrigation_pump"].state, "differs");
  assert.deepEqual(trackProgress([{ ...pump, effectiveValue: true }], seen, now + SETTLE_MS + 2), {});
  assert.equal(seen.size, 0);
});

test("Korean particles follow the last syllable of the name", () => {
  assert.equal(josa("천창", "과", "와"), "과");
  assert.equal(josa("근권 냉각기", "과", "와"), "와");
  assert.equal(josa("차광 커튼", "과", "와"), "과");
  assert.equal(josa("관수 펌프", "과", "와"), "와");
  assert.equal(josa("CO₂", "과", "와"), "와");
});

test("the hold reason reads in English", () => {
  setLang("en");
  try {
    const hold = controlHold("heater", [metric("air_temperature_c", "재배실 온도", { quality: "suspect" })], [], true, now);
    assert.equal(hold?.issue, "Check sensor quality");
    assert.deepEqual(deviceProgress({ desiredValue: true, effectiveValue: false, health: "normal" }, now, now), { state: "settling", want: "on", got: "off" });
  } finally {
    setLang("ko");
  }
});

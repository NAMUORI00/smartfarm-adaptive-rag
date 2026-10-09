import test from "node:test";
import assert from "node:assert/strict";
import {
  bandGauge,
  derivedIndicatorRows,
  keyReadings,
  metricPrecision,
  otherProblemReadings,
  readingCounts,
  readingCountsText,
  relatedDeviceTargets,
  sampleSpanText,
  sparklineSamples,
  stabilityText,
  telemetryFieldForMetric,
} from "./farmer/sensor-links.ts";
import type { Metric, TelemetryPoint } from "./types.ts";

const point = (time: string, rootZoneTemperature: number): TelemetryPoint => ({
  time, temperature: 18, humidity: 70, co2: 500, ec: 2, rootZoneTemperature,
  substrateMoisture: 60, irrigationFlow: 1, irrigationPressure: 1, ppfd: 100, supplyPh: 6, drainEc: 2.1,
});

test("metric keys map to telemetry fields and precision follows the unit", () => {
  assert.equal(telemetryFieldForMetric("root_zone_temperature_c"), "rootZoneTemperature");
  assert.equal(telemetryFieldForMetric("unknown_metric"), null);
  assert.equal(metricPrecision("supply_ec_ds_m"), 2);
  assert.equal(metricPrecision("ppfd_umol_m2_s"), 0);
  assert.equal(metricPrecision("air_temperature_c"), 1);
});

test("sparkline samples end with the currently shown reading and keep only the tail", () => {
  const series = { "zone-a": Array.from({ length: 60 }, (_, i) => point(`10:${String(i).padStart(2, "0")}`, 15 + i * 0.01)) };
  const metrics = [{ key: "root_zone_temperature_c", zoneId: "zone-a", value: "17.5", quality: "good" } as Metric];
  const samples = sparklineSamples(series, "zone-a", "root_zone_temperature_c", metrics, 10);
  assert.equal(samples.length, 10);
  assert.equal(samples.at(-1)?.value, 17.5);
  assert.deepEqual(sparklineSamples(series, null, "root_zone_temperature_c", metrics), []);
  assert.deepEqual(sparklineSamples(series, "zone-b", "root_zone_temperature_c", metrics), []);
});

test("related devices only name equipment that can move the reading", () => {
  assert.deepEqual(relatedDeviceTargets("root_zone_temperature_c"), ["root_zone_chiller"]);
  assert.deepEqual(relatedDeviceTargets("substrate_moisture_pct"), ["irrigation_pump"]);
  assert.deepEqual(relatedDeviceTargets("supply_ph"), []);
});

test("band gauge places the registered range as a band and the value as a needle", () => {
  const inside = bandGauge(15, 12, 19)!;
  assert.equal(inside.outside, false);
  assert.ok(inside.bandStart < inside.needle && inside.needle < inside.bandEnd);
  const above = bandGauge(25, 12, 19)!;
  assert.equal(above.outside, true);
  assert.equal(above.needle, 100);
  assert.equal(bandGauge(15, null, null), null);
  assert.equal(bandGauge(Number.NaN, 12, 19), null);
  const lowerOnly = bandGauge(10, 8, null)!;
  assert.equal(lowerOnly.outside, false);
});

test("derived rows take the worst status of the readings they depend on", () => {
  const rows = derivedIndicatorRows(
    { zoneId: "zone-a", vpdKpa: 0.41, dliMolM2Day: 0, ecDeltaDsM: 0.18, rootHeatExposureDegreeMinutes: 0, source: "x" },
    [{ key: "air_temperature_c", status: "warning" }, { key: "relative_humidity_pct", status: "normal" }, { key: "root_zone_temperature_c", status: "critical" }],
  );
  assert.equal(rows.find((r) => r.key === "vpd")?.status, "warning");
  assert.equal(rows.find((r) => r.key === "rootHeat")?.statusLabel, "위험");
  assert.equal(rows.find((r) => r.key === "ec")?.status, "normal");
  assert.equal(rows.find((r) => r.key === "vpd")?.value, "0.41 kPa");
});

test("key readings put problems first, then the familiar values in a fixed order", () => {
  const metrics = [
    { key: "supply_ph", status: "normal" },
    { key: "co2_ppm", status: "normal" },
    { key: "air_temperature_c", status: "normal" },
    { key: "irrigation_flow_l_min", status: "warning" },
    { key: "root_zone_temperature_c", status: "normal" },
    { key: "relative_humidity_pct", status: "normal", quality: "stale" },
  ] as const;
  const picked = keyReadings([...metrics]);
  // Fixed places: a problem is flagged on its tile, never moved to the front.
  assert.deepEqual(picked.map((m) => m.key), ["root_zone_temperature_c", "air_temperature_c", "relative_humidity_pct", "co2_ppm"]);
  assert.deepEqual(otherProblemReadings([...metrics], picked).map((m) => m.key), ["irrigation_flow_l_min"]);
  assert.equal(keyReadings([], 4).length, 0);
});

test("reading counts keep unregistered ranges and doubtful quality out of 'in range'", () => {
  const counts = readingCounts(
    [
      { key: "a", status: "normal" },
      { key: "b", status: "normal" },
      { key: "c", status: "warning" },
      { key: "d", status: "normal", quality: "stale" },
    ],
    (key) => key === "a",
  );
  assert.deepEqual(counts, { inRange: 1, outside: 1, noThreshold: 1, qualityCheck: 1 });
  assert.equal(readingCountsText(counts), "기준 안 1개, 벗어남 1개, 품질 확인 1개, 기준 없음 1개");
  assert.equal(readingCountsText({ inRange: 3, outside: 0, noThreshold: 0, qualityCheck: 0 }), "기준 안 3개");
});

test("the sparkline span is stated from the samples, not assumed", () => {
  const at = (minutes: number) => ({ time: new Date(Date.UTC(2026, 8, 22, 7, minutes)).toISOString(), value: 1 });
  assert.equal(sampleSpanText([at(0), at(1)]), null);
  assert.equal(sampleSpanText([at(0), at(16), at(32)]), "최근 32분");
  assert.equal(sampleSpanText([at(0), at(60), at(150)]), "최근 2.5시간");
});

test("stability text never counts poor-quality readings as normal", () => {
  assert.equal(stabilityText([{ status: "normal" }, { status: "warning" }, { status: "normal", quality: "stale" }]), "관측 2개 중 1개 기준 범위, 품질 확인 1개");
  assert.match(stabilityText([{ status: "normal", quality: "missing" }]), /계산 불가/);
});

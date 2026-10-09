import type { Actuator, Alert, ControlTarget, Metric } from "../types.ts";
import { L } from "./i18n.ts";
import { relatedDeviceTargets } from "./sensor-links.ts";
import { observationIssue, observationProblem } from "./workspace-state.ts";

/**
 * Why a change to one device is on hold, the way the server decides it.
 *
 * - While a room-temperature sensor-health alert is active in the zone, the
 *   server pauses every physical device there (only the sensor recalibration
 *   goes through): `zoneWide`.
 * - Otherwise a device is held back only by the readings it moves or is judged
 *   by — the chiller by the root-zone temperature, the pump by substrate
 *   moisture and flow, the heater, fan and vents by the air readings — so a late
 *   humidity reading does not stop the chiller. A device with no related reading
 *   is judged by the whole zone. `metric` is null when the zone sends no readings.
 */
export type ControlHold = { metric: Metric | null; issue: string; zoneWide?: boolean };

/** The server's pause rule (services/api/app/main.py, has_active_air_temperature_sensor_alert). */
export function sensorAlertPause(zoneAlerts: Pick<Alert, "id" | "kind" | "status">[]): boolean {
  return zoneAlerts.some((a) => a.status !== "resolved" && a.kind === "sensor_health" && a.id.toLowerCase().endsWith(":air_temperature_c:sensor-health"));
}

export function controlHold(
  target: ControlTarget | string | null | undefined,
  zoneMetrics: Metric[],
  zoneAlerts: Pick<Alert, "id" | "kind" | "status">[] = [],
  connected = true,
  now = Date.now(),
): ControlHold | null {
  if (sensorAlertPause(zoneAlerts)) {
    return { metric: zoneMetrics.find((m) => m.key === "air_temperature_c") ?? null, issue: L("센서 이상 경보", "Sensor alert"), zoneWide: true };
  }
  if (!zoneMetrics.length) return { metric: null, issue: L("관측 없음", "No readings") };
  const related = zoneMetrics.filter((m) => relatedDeviceTargets(m.key).includes(target as ControlTarget));
  const judged = related.length ? related : zoneMetrics;
  const held = judged.find((m) => observationProblem([m], now));
  return held ? { metric: held, issue: observationIssue(held, connected, now) } : null;
}

/** What each kind of device carries to its beds, for the plan and the work view. */
export function deviceReach(target: Actuator["target"] | string | null | undefined): string | null {
  switch (target) {
    case "root_zone_chiller": return L("근권에 찬 양액", "Chilled nutrient to the root zone");
    case "heater": return L("재배실 공기 난방", "Warm air for the room");
    case "irrigation_pump": return L("점적 관수", "Drip irrigation");
    default: return null;
  }
}

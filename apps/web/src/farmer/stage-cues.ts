import type { Actuator, Alert, ControlTarget, CultivationStrategyThreshold, Metric } from "../types";
import { L, term } from "./i18n.ts";

/**
 * What the 3D stage shows, derived only from things the farm actually
 * reported: zone readings against registered ranges, unresolved alerts, and
 * device reports. Nothing here is a prediction. The same cues drive the
 * particles, tints and lamps in FarmMap and the small callout chips over the
 * model, so the eye and the text never disagree.
 */
export type Tone = "ok" | "attention" | "danger";
export type CuePart = "air" | "root" | "substrate" | "lamp" | "sensor" | "plants" | "device";
export type CueIcon = "temperature" | "water" | "sensor" | "warning" | "sun" | "fan" | "snow" | "flame" | "window" | "curtain" | "crop" | "controls";
export type Cue = {
  id: string;
  part: CuePart;
  tone: Tone;
  /** Two to four words: "재배실 65 °C", "온도 센서 의심". */
  label: string;
  icon: CueIcon;
  /** One line of provenance, shown on demand. */
  note: string;
  metricKey?: string;
  deviceKey?: string;
};

export type DeviceLevel = { on: boolean; percent: number | null; text: string };

const deviceWords = (): Record<string, { on: string; off: string }> => ({
  root_zone_chiller: { on: L("냉각 중", "cooling"), off: L("꺼짐", "off") },
  irrigation_pump: { on: L("관수 중", "irrigating"), off: L("멈춤", "stopped") },
  heater: { on: L("난방 중", "heating"), off: L("꺼짐", "off") },
});
// What a percentage means for each device, so "17%" never stands alone.
const percentWords = (): Record<string, string> => ({
  roof_vent: L("열림", "open"),
  side_vent: L("열림", "open"),
  shade_curtain: L("펼침", "extended"),
  ventilation_fan: L("출력", "output"),
});

/** Normalise a device report to on/off and an optional percentage, in the device's own words. */
export function deviceLevel(a: Pick<Actuator, "target" | "state" | "effectiveValue" | "reportedValue" | "capability" | "health">): DeviceLevel {
  const raw = a.effectiveValue ?? a.reportedValue ?? null;
  const percentage = a.capability?.valueType === "percentage";
  if (percentage) {
    const percent = typeof raw === "number" ? raw : typeof raw === "boolean" ? (raw ? 100 : 0) : Number.parseFloat(String(a.state));
    const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
    const word = percentWords()[a.target ?? ""];
    return { on: (value ?? 0) > 0, percent: value, text: value === null ? L("보고 없음", "No report") : `${value}%${word ? ` ${word}` : ""}` };
  }
  if (raw === null && !String(a.state ?? "").trim()) return { on: false, percent: null, text: L("보고 없음", "No report") };
  const on = typeof raw === "boolean" ? raw : typeof raw === "number" ? raw > 0 : /^(on|true|running|open|enabled|1)$/i.test(String(a.state));
  const words = deviceWords()[a.target ?? ""] ?? { on: L("켜짐", "on"), off: L("꺼짐", "off") };
  return { on, percent: null, text: on ? words.on : words.off };
}

/** Short device names for plan chips and callouts. */
export function deviceShortLabel(target: ControlTarget | string | null | undefined, label: string): string {
  switch (target) {
    case "roof_vent": return L("천창", "Roof vent");
    case "side_vent": return L("측창", "Side vent");
    case "shade_curtain": return L("차광", "Shade");
    case "ventilation_fan": return L("환기팬", "Fan");
    case "root_zone_chiller": return L("냉각기", "Chiller");
    case "heater": return L("난방", "Heater");
    case "irrigation_pump": return L("펌프", "Pump");
    case "air_temperature_sensor_reset": return L("온도 센서", "Temp sensor");
    default: return term(label.replace(/\s*(재보정|리셋)$/, ""));
  }
}

export function deviceIcon(target: ControlTarget | string | null | undefined): CueIcon {
  switch (target) {
    case "ventilation_fan": return "fan";
    case "roof_vent":
    case "side_vent": return "window";
    case "shade_curtain": return "curtain";
    case "root_zone_chiller": return "snow";
    case "heater": return "flame";
    case "irrigation_pump": return "water";
    case "air_temperature_sensor_reset": return "sensor";
    default: return "controls";
  }
}

export type Airflow = {
  fan: number;
  heater: boolean;
  chiller: boolean;
  pump: boolean;
  roofVent: number;
  sideVent: number;
  curtain: number;
};

export type StageCues = {
  cues: Cue[];
  /** Plant tint follows the zone's crop-risk alerts, never a leaf measurement. */
  plantTone: Tone;
  moisture: number | null;
  /** 0–1 lamp brightness from light readings; null when nothing is reported. */
  lamp: number | null;
  air: "hot" | "cold" | "ok" | null;
  root: "hot" | "cold" | "ok" | null;
  sensor: Tone | null;
  airflow: Airflow;
};

type Direction = "high" | "low" | "out" | null;

function numberOf(metric: Metric | undefined): number | null {
  if (!metric) return null;
  const n = Number(metric.value.replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function direction(metric: Metric | undefined, threshold: CultivationStrategyThreshold | undefined): Direction {
  if (!metric || metric.status === "normal") return null;
  const value = numberOf(metric);
  if (value !== null && threshold) {
    if (threshold.upper !== null && value > threshold.upper) return "high";
    if (threshold.lower !== null && value < threshold.lower) return "low";
  }
  return "out";
}

const toneOf = (metric: Metric): Tone => (metric.status === "critical" ? "danger" : "attention");
const rank: Record<Tone, number> = { danger: 0, attention: 1, ok: 2 };

export function stageCues(input: {
  metrics: Metric[];
  thresholds: CultivationStrategyThreshold[];
  alerts: Pick<Alert, "kind" | "severity" | "status" | "zoneId" | "title">[];
  actuators: Actuator[];
  zoneId: string | null;
  connected: boolean;
}): StageCues {
  const zoneId = input.zoneId;
  const metrics = input.metrics.filter((m) => !zoneId || !m.zoneId || m.zoneId === zoneId);
  const alerts = input.alerts.filter((a) => a.status !== "resolved" && (!zoneId || !a.zoneId || a.zoneId === zoneId));
  const actuators = input.actuators.filter((d) => !zoneId || d.zoneId === zoneId);
  const metric = (key: string) => metrics.find((m) => m.key === key);
  const threshold = (key: string) => input.thresholds.find((t) => t.metric === key);
  const suspect = (m: Metric | undefined) => !!m && !!m.quality && m.quality !== "good";
  const cues: Cue[] = [];
  const fmt = (m: Metric) => `${numberOf(m)?.toLocaleString(L("ko-KR", "en-US"), { maximumFractionDigits: 1 }) ?? m.value} ${m.unit}`.trim();
  const dirWord = (d: Direction) => (d === "high" ? L("높음", "high") : d === "low" ? L("낮음", "low") : L("확인", "check"));
  const range = (key: string) => `${threshold(key)?.lower ?? "—"}–${threshold(key)?.upper ?? "—"}`;
  // The same sensor problem keeps the alert's own grade everywhere: red when the alert is critical.
  const sensorAlertTone: Tone = alerts.some((a) => a.kind === "sensor_health" && a.severity === "critical") ? "danger" : "attention";

  // Air temperature: a doubtful sensor is said as such instead of as heat.
  const airMetric = metric("air_temperature_c");
  let air: StageCues["air"] = null;
  let sensor: Tone | null = null;
  if (airMetric) {
    if (suspect(airMetric)) {
      sensor = sensorAlertTone;
      cues.push({ id: "sensor_suspect", part: "sensor", tone: sensorAlertTone, label: L("온도 센서 확인 필요", "Check temp sensor"), icon: "sensor", note: L("값을 믿기 전에 센서·배선·통신을 확인하세요", "Check the sensor, wiring and link before trusting the value"), metricKey: airMetric.key });
    } else {
      const d = direction(airMetric, threshold(airMetric.key));
      air = d === "high" ? "hot" : d === "low" ? "cold" : "ok";
      sensor = "ok";
      if (d) cues.push({ id: `air_${d}`, part: "air", tone: toneOf(airMetric), label: L(`기온 ${dirWord(d)} ${fmt(airMetric)}`, `Air temp ${dirWord(d)} ${fmt(airMetric)}`), icon: "temperature", note: L(`${airMetric.label}. 기준 ${range(airMetric.key)}`, `${term(airMetric.label)}. Range ${range(airMetric.key)}`), metricKey: airMetric.key });
    }
  }

  const rootMetric = metric("root_zone_temperature_c");
  let root: StageCues["root"] = null;
  if (rootMetric && !suspect(rootMetric)) {
    const d = direction(rootMetric, threshold(rootMetric.key));
    root = d === "high" ? "hot" : d === "low" ? "cold" : "ok";
    if (d) cues.push({ id: `root_${d}`, part: "root", tone: toneOf(rootMetric), label: L(`근권 온도 ${dirWord(d)} ${fmt(rootMetric)}`, `Root temp ${dirWord(d)} ${fmt(rootMetric)}`), icon: "temperature", note: L(`${rootMetric.label}. 배지 속 온도`, `${term(rootMetric.label)}. Temperature inside the substrate`), metricKey: rootMetric.key });
  } else if (rootMetric) {
    cues.push({ id: "root_sensor", part: "root", tone: "attention", label: L("근권 센서 의심", "Root sensor suspect"), icon: "sensor", note: L("값을 믿기 전에 센서를 확인하세요", "Check the sensor before trusting the value"), metricKey: rootMetric.key });
  }

  const humidity = metric("relative_humidity_pct");
  if (humidity && !suspect(humidity)) {
    const d = direction(humidity, threshold(humidity.key));
    if (d) cues.push({ id: `humid_${d}`, part: "air", tone: toneOf(humidity), label: L(`습도 ${dirWord(d)} ${fmt(humidity)}`, `Humidity ${dirWord(d)} ${fmt(humidity)}`), icon: "water", note: term(humidity.label), metricKey: humidity.key });
  }

  const moistureMetric = metric("substrate_moisture_pct");
  const moisture = moistureMetric && !suspect(moistureMetric) ? numberOf(moistureMetric) : null;
  if (moistureMetric && !suspect(moistureMetric)) {
    const d = direction(moistureMetric, threshold(moistureMetric.key));
    if (d) cues.push({ id: `soil_${d}`, part: "substrate", tone: toneOf(moistureMetric), label: L(`배지 수분 ${d === "low" ? "부족" : d === "high" ? "과다" : "확인"} ${fmt(moistureMetric)}`, `Substrate moisture ${d === "low" ? "low" : d === "high" ? "high" : "check"} ${fmt(moistureMetric)}`), icon: "water", note: term(moistureMetric.label), metricKey: moistureMetric.key });
  }

  const light = metric("ppfd_umol_m2_s");
  let lamp: number | null = null;
  if (light && !suspect(light)) {
    const value = numberOf(light);
    const t = threshold(light.key);
    const reference = t?.lower ?? t?.upper ?? null;
    lamp = value === null ? null : reference ? Math.max(0, Math.min(1, value / reference)) : value > 0 ? 1 : 0;
    const d = direction(light, t);
    if (d === "low" || (value !== null && value <= 0 && light.status !== "normal")) cues.push({ id: "light_low", part: "lamp", tone: toneOf(light), label: L(`광량 부족 ${fmt(light)}`, `Light low ${fmt(light)}`), icon: "sun", note: term(light.label), metricKey: light.key });
    else if (d) cues.push({ id: `light_${d}`, part: "lamp", tone: toneOf(light), label: L(`광량 확인 ${fmt(light)}`, `Check light ${fmt(light)}`), icon: "sun", note: term(light.label), metricKey: light.key });
  }

  // Crop-risk alerts tint the plants; the legend says it is an alert level.
  const cropAlerts = alerts.filter((a) => a.kind === "crop_risk");
  const plantTone: Tone = cropAlerts.some((a) => a.severity === "critical") ? "danger" : cropAlerts.length ? "attention" : "ok";
  if (plantTone !== "ok") cues.push({ id: "crop_risk", part: "plants", tone: plantTone, label: L(`작물 위험 경보 ${cropAlerts.length}건`, `${cropAlerts.length} crop risk ${cropAlerts.length === 1 ? "alert" : "alerts"}`), icon: "crop", note: L("잎 색은 경보 단계 표현이며 잎 상태 실측이 아닙니다", "Leaf color shows the alert level, not a measured leaf condition") });
  if (alerts.some((a) => a.kind === "sensor_health") && !cues.some((c) => c.part === "sensor" || c.id === "root_sensor")) {
    // A sensor alert turns the probe lamp to the alert's grade even when the air reading itself looks fine.
    if (sensor === null || sensor === "ok") sensor = sensorAlertTone;
    cues.push({ id: "sensor_alert", part: "sensor", tone: sensorAlertTone, label: L("센서 건전성 경보", "Sensor health alert"), icon: "sensor", note: L("센서·배선·통신을 먼저 점검하세요", "Check the sensor, wiring and link first") });
  }

  const airflow: Airflow = { fan: 0, heater: false, chiller: false, pump: false, roofVent: 0, sideVent: 0, curtain: 0 };
  const running: string[] = [];
  const runningOrder = ["heater", "root_zone_chiller", "irrigation_pump", "ventilation_fan"];
  for (const d of [...actuators].sort((a, b) => runningOrder.indexOf(a.target ?? "") - runningOrder.indexOf(b.target ?? ""))) {
    const level = deviceLevel(d);
    const short = deviceShortLabel(d.target, d.label);
    if (d.health === "fault" || d.health === "offline") {
      cues.push({ id: `device_${d.key}`, part: "device", tone: "attention", label: `${short} ${d.health === "offline" ? L("응답 없음", "not responding") : L("점검 필요", "needs service")}`, icon: deviceIcon(d.target), note: L(`${d.label}. 장치 보고값`, `${term(d.label)}. Device-reported value`), deviceKey: d.key });
      continue;
    }
    switch (d.target) {
      case "ventilation_fan": airflow.fan = (level.percent ?? (level.on ? 100 : 0)) / 100; break;
      case "heater": airflow.heater = level.on; break;
      case "root_zone_chiller": airflow.chiller = level.on; break;
      case "irrigation_pump": airflow.pump = level.on; break;
      case "roof_vent": airflow.roofVent = (level.percent ?? 0) / 100; break;
      case "side_vent": airflow.sideVent = (level.percent ?? 0) / 100; break;
      case "shade_curtain": airflow.curtain = (level.percent ?? 0) / 100; break;
    }
    // Running devices are one chip: what the devices report, not a measured effect.
    if (level.on && d.target && ["heater", "root_zone_chiller", "irrigation_pump", "ventilation_fan"].includes(d.target)) {
      running.push(level.percent === null ? level.text : `${short} ${level.text}`);
    }
  }
  if (running.length) cues.push({ id: "running", part: "device", tone: "ok", label: `${L("가동:", "Running:")} ${running.join(", ")}`, icon: "controls", note: L("장치가 보고한 작동 상태입니다. 효과는 관측값에서 확인하세요.", "Operating state reported by the devices. Check the effect in the readings.") });
  if (!input.connected) {
    // Nothing moves on a lost connection: the last values are shown still.
    Object.assign(airflow, { fan: 0, heater: false, chiller: false, pump: false });
    air = null; root = null;
    cues.unshift({ id: "offline", part: "sensor", tone: "attention", label: L("수신 끊김 (마지막 수신값)", "Disconnected (last received values)"), icon: "warning", note: L("연결이 끊겨 마지막에 받은 값으로만 그립니다", "Connection lost. Drawn from the last received values only") });
  }

  cues.sort((a, b) => rank[a.tone] - rank[b.tone]);
  return { cues: cues.slice(0, 4), plantTone, moisture, lamp, air, root, sensor, airflow };
}

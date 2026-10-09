import type { Actuator, Alert, AdvisorTurn, CultivationStrategyThreshold, Metric } from "../types";
import type { CropCycle } from "../farm-spatial";
import { L, place, term } from "./i18n.ts";
import { daysUntil } from "./suggestions.ts";
import { metricPrecision, relatedDeviceTargets } from "./sensor-links.ts";
import { deviceLevel, deviceShortLabel } from "./stage-cues.ts";
import { shortAlertTitle } from "./todo-engine.ts";
import type { DemoCamera } from "./demo-cameras.ts";
import type { DiseaseWatch, WeatherForecast } from "./assist-api.ts";

/**
 * The AI brief: what the farmer most wants to know first — where the problem
 * is, what it most likely is, what to do about it — ranked and pinned to the
 * place it concerns. Each item is reasoned only from what the farm reported:
 * a reading checked against the other sensors of the same zone, a device's
 * own report, an unanswered change, a registered harvest date, an example
 * camera's saved analysis, an advice the assistant rechecked after a value
 * changed. When the AI alert analysis is available for an alert, its own
 * words replace the rule line (see `advisoryLines`).
 */
export type BriefTone = "danger" | "attention" | "info";
export type BriefAnchor =
  | { kind: "zone"; zoneId: string }
  | { kind: "bed"; zoneId: string; bedId: string }
  | { kind: "device"; zoneId: string; deviceKey: string }
  | { kind: "camera"; zoneId: string; cameraId: string; bedId: string | null };
/** Where the judgement came from; shown as small tags so the reasoning is visible. */
export type BriefSource = "sensor" | "device" | "camera" | "records" | "advice" | "guides" | "weather";
/** What the primary button does. */
export type BriefGo = "reconnect" | "sensor" | "device" | "zone" | "harvest" | "camera" | "advice" | "pending" | "ask";

export type BriefItem = {
  id: string;
  tone: BriefTone;
  priority: number;
  anchor: BriefAnchor | null;
  /** A few words: the thing and its state. */
  what: string;
  /** One or two sentences of reasoning from the data. */
  why: string;
  /** The primary button. */
  todo: string;
  go: BriefGo;
  /** A question for the advisor, phrased so the growing guides can be searched. */
  ask: string | null;
  /** The place the question is about. */
  askAt?: { zoneId: string | null; bedId?: string | null };
  /** The alert whose AI analysis can be attached. */
  alertId?: string;
  sources: BriefSource[];
  /** The item rests on an example camera, not this farm's footage. */
  example?: boolean;
  since?: string | null;
  /** When the farmer marked the alert as seen (server record). */
  acknowledgedAt?: string | null;
  /** A reference-only item: the card carries the matching notice. */
  ref?: "disease" | "weather";
};

/** One open camera record, with its camera's name. */
export type CameraEventItem = {
  id: string; checkId: string; cameraId: string; cameraTitle: string; zoneId: string | null; bedId: string | null;
  title: string; text: string; ask: string | null; synthetic: boolean; createdAt: string;
};

export type BriefInput = {
  connected: boolean;
  alerts: Pick<Alert, "id" | "severity" | "title" | "detail" | "kind" | "zoneId" | "occurredAt">[];
  metrics: Pick<Metric, "key" | "label" | "value" | "unit" | "status" | "quality" | "zoneId">[];
  thresholds: Pick<CultivationStrategyThreshold, "metric" | "lower" | "upper">[];
  actuators: Pick<Actuator, "key" | "target" | "label" | "zoneId" | "state" | "health" | "effectiveValue" | "reportedValue" | "desiredValue" | "capability">[];
  pending: { target: string; zoneId: string | null }[];
  cycles: Pick<CropCycle, "bed_id" | "tier" | "crop" | "remaining_count" | "planned_harvest_from" | "status">[];
  beds: { id: string; label: string; zone_id: string }[];
  zoneLabel: (id?: string | null) => string;
  cameras: DemoCamera[];
  /** Open records the camera readings raised (camera_feeds.py); when given, the saved example findings are not used. */
  cameraEvents?: CameraEventItem[];
  turns: Pick<AdvisorTurn, "id" | "status" | "stateReview" | "queryContext" | "recordedAt">[];
  now?: number;
  /** alertId → when it was marked seen; seen items stay, lower in the list. */
  acknowledged?: Record<string, string>;
  /** Items the farmer put away for today. */
  hidden?: string[];
  diseaseWatch?: DiseaseWatch | null;
  weather?: WeatherForecast | null;
  /** Devices still applying a change a moment ago (device-progress.ts): not yet a difference. */
  settling?: string[];
};

const num = (m?: Pick<Metric, "value"> | null) => {
  if (!m) return null;
  const n = Number(String(m.value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
};
const show = (key: string, v: number) => v.toFixed(metricPrecision(key));
const unitOf = (unit: string) => (unit === "%" || unit === "°C" ? unit : ` ${unit}`);
/** The metric an alert is about, from its id ("farm:root_zone_temperature_c:threshold:high"). */
export function alertMetricKey(alertId: string): string | null {
  const part = alertId.split(":")[1];
  return part && /_[a-z0-9]+$/.test(part) ? part : null;
}
function alertDirection(alertId: string): "high" | "low" | null {
  return /threshold:high|:high\b/.test(alertId) ? "high" : /threshold:low|:low\b/.test(alertId) ? "low" : null;
}
// Values a greenhouse sensor cannot really report: the reading is the problem, not the room.
function implausible(key: string, v: number): boolean {
  if (key === "air_temperature_c") return v > 45 || v < -15;
  if (key === "root_zone_temperature_c") return v > 40 || v < -5;
  if (key === "relative_humidity_pct" || key === "substrate_moisture_pct") return v > 100 || v < 0;
  return false;
}
/** A camera answer without its leading yes/no: "예, 잎 가장자리에…" → "잎 가장자리에…". */
function plain(answer: string | null | undefined) {
  return (answer ?? "").replace(/^(예|네|아니요|아니오|Yes|No)[,.]\s*/i, "");
}
/** 이/가 after a Korean word: "환기팬이", "냉각기가". */
function iGa(word: string) {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? `${word}이` : `${word}가`;
}
const CROSS_CHECK = ["root_zone_temperature_c", "relative_humidity_pct", "air_temperature_c", "substrate_moisture_pct"];

export function buildBrief(input: BriefInput): BriefItem[] {
  const items: BriefItem[] = [];
  const now = input.now ?? Date.now();
  const zoneName = (id?: string | null) => place(input.zoneLabel(id));
  const deviceIn = (zoneId: string | null | undefined, target: string) =>
    input.actuators.find((a) => a.zoneId === zoneId && (a.target ?? a.key) === target) ?? null;

  if (!input.connected) {
    items.push({
      id: "reconnect", tone: "attention", priority: 100, anchor: null, go: "reconnect", ask: null, sources: ["sensor"],
      what: L("농장 데이터 수신 끊김", "Farm data disconnected"),
      why: L("화면의 값은 마지막 수신값입니다. 연결이 돌아오면 다시 판단합니다.", "Values shown are the last received. The brief is redone once data returns."),
      todo: L("다시 연결", "Reconnect"),
    });
  }

  // Alerts: one item per zone and kind, the most severe first.
  const groups = new Map<string, BriefInput["alerts"]>();
  for (const a of input.alerts) {
    const key = `${a.zoneId ?? "farm"}:${a.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const rank = { critical: 3, warning: 2, info: 1 } as const;
  const faultDevices = new Set<string>();
  for (const group of groups.values()) {
    const first = [...group].sort((a, b) => rank[b.severity] - rank[a.severity])[0];
    const critical = first.severity === "critical";
    const zoneId = first.zoneId;
    const key = alertMetricKey(first.id);
    const metric = key ? input.metrics.find((m) => m.key === key && (!zoneId || m.zoneId === zoneId)) ?? null : null;
    const value = num(metric);
    const label = metric ? term(metric.label) : term(shortAlertTitle(first.title));
    const since = group.map((a) => a.occurredAt).filter(Boolean).sort()[0] ?? null;
    const base = { alertId: first.id, since, tone: (critical ? "danger" : "attention") as BriefTone, askAt: { zoneId } };

    if (first.kind === "sensor_health") {
      const others = input.metrics
        .filter((m) => m.zoneId === zoneId && m.key !== key && CROSS_CHECK.includes(m.key) && (m.quality ?? "good") === "good" && m.status === "normal")
        .slice(0, 2)
        .map((m) => `${term(m.label)} ${show(m.key, num(m) ?? 0)}${unitOf(m.unit)}`);
      const odd = key && value !== null && implausible(key, value);
      const sensorDevice = key === "air_temperature_c" ? deviceIn(zoneId, "air_temperature_sensor_reset") : null;
      const reading = metric && value !== null ? `${show(metric.key, value)}${unitOf(metric.unit)}` : null;
      items.push({
        ...base, id: `alert:${zoneId}:sensor`, priority: critical ? 95 : 75,
        anchor: sensorDevice && zoneId ? { kind: "device", zoneId, deviceKey: sensorDevice.key } : zoneId ? { kind: "zone", zoneId } : null,
        what: L(`${label} 센서 이상 의심`, `${label} sensor suspect`),
        why: [
          reading
            ? odd
              ? L(`수신값 ${reading}는 온실에서 나오기 어려운 값입니다.`, `A reading of ${reading} is not possible in a greenhouse.`)
              : L(`수신값 ${reading}의 품질이 판단 기준에 못 미칩니다.`, `The ${reading} reading does not meet the quality bar.`)
            : L("센서 값의 품질이 판단 기준에 못 미칩니다.", "The sensor readings do not meet the quality bar."),
          others.length
            ? L(`같은 구역 ${others.join(", ")}는 정상이라 실제 환경보다 센서 문제로 보입니다.`, `${others.join(" and ")} in the same zone read normal, so the sensor is the likelier problem.`)
            : "",
          L("점검 전까지 이 값으로 설비를 조절하지 않습니다.", "Equipment is not adjusted on this value until it is checked."),
        ].filter(Boolean).join(" "),
        todo: L("센서 점검", "Check sensor"), go: "sensor",
        ask: key === "air_temperature_c" || key === "root_zone_temperature_c" ? "온도 센서 고장 점검 방법" : `${metric?.label ?? "센서"} 센서 고장 점검 방법`,
        sources: ["sensor"],
      });
      continue;
    }

    if (first.kind === "equipment_fault") {
      const target = first.id.split(":").find((p) => input.actuators.some((a) => (a.target ?? a.key) === p)) ?? null;
      const device = target ? deviceIn(zoneId, target) : null;
      if (device) faultDevices.add(device.key);
      items.push({
        ...base, id: `alert:${zoneId}:equipment`, priority: critical ? 92 : 82,
        anchor: device && zoneId ? { kind: "device", zoneId, deviceKey: device.key } : zoneId ? { kind: "zone", zoneId } : null,
        what: device ? L(`${term(device.label)} 이상`, `${term(device.label)} fault`) : term(shortAlertTitle(first.title)),
        why: L("설비가 이상을 보고했습니다. 전원·통신과 현장 상태를 확인하세요.", "The equipment reported a fault. Check power, communication and the unit on site."),
        todo: L("설비 확인", "Check equipment"), go: device ? "device" : "zone",
        ask: device ? `${device.label} 고장 점검 방법` : null,
        sources: ["device"],
      });
      continue;
    }

    // Crop risk: a reading out of its range, and the device that moves it.
    const threshold = key ? input.thresholds.find((t) => t.metric === key) : undefined;
    const dir = alertDirection(first.id) ?? (value !== null && threshold ? (threshold.upper !== null && value > threshold.upper ? "high" : threshold.lower !== null && value < threshold.lower ? "low" : null) : null);
    const device = key ? relatedDeviceTargets(key).map((t) => deviceIn(zoneId, t)).find(Boolean) ?? null : null;
    const running = device ? deviceLevel(device).on : false;
    const range = threshold && threshold.lower !== null && threshold.upper !== null && metric
      ? `${show(metric.key, threshold.lower)}–${show(metric.key, threshold.upper)}${unitOf(metric.unit)}` : null;
    const reading = metric && value !== null ? `${show(metric.key, value)}${unitOf(metric.unit)}` : null;
    const deviceName = device ? term(deviceShortLabel(device.target, device.label)) : null;
    items.push({
      ...base, id: `alert:${zoneId}:crop`, priority: critical ? 90 : 70,
      anchor: device && zoneId ? { kind: "device", zoneId, deviceKey: device.key } : zoneId ? { kind: "zone", zoneId } : null,
      what: dir
        ? L(`${label} ${dir === "high" ? "높음" : "낮음"}`, `${label} ${dir === "high" ? "high" : "low"}`)
        : term(shortAlertTitle(first.title)),
      why: [
        reading && range
          ? L(`${reading}로 기준 ${range}${dir === "low" ? "보다 낮습니다" : "보다 높습니다"}.`, `${reading}, ${dir === "low" ? "below" : "above"} the ${range} range.`)
          : reading ? L(`현재 ${reading}입니다.`, `Currently ${reading}.`) : "",
        device && deviceName
          ? running
            ? L(`${iGa(deviceName)} 가동 중인데도 벗어나 있어 설비 상태를 확인해야 합니다.`, `${deviceName} is running yet the value is out of range; check the unit.`)
            : L(`${iGa(deviceName)} 꺼져 있습니다.`, `${deviceName} is off.`)
          : "",
      ].filter(Boolean).join(" ") || L("관측과 설비를 함께 확인하세요.", "Check the readings and the equipment together."),
      todo: device && deviceName ? (running ? L(`${deviceName} 확인`, `Check ${deviceName}`) : L(`${deviceName} 조절`, `Adjust ${deviceName}`)) : L("값 확인", "Check values"),
      go: device ? "device" : "zone",
      ask: metric ? `고추냉이 ${metric.label} ${dir === "low" ? "낮을 때" : "높을 때"} 관리` : null,
      sources: device ? ["sensor", "device"] : ["sensor"],
    });
  }

  // Devices that report a fault without an alert of their own.
  for (const d of input.actuators) {
    if (faultDevices.has(d.key) || !d.zoneId || (d.health !== "fault" && d.health !== "offline")) continue;
    const offline = d.health === "offline";
    items.push({
      id: `device:${d.key}`, tone: "attention", priority: 84, go: "device", sources: ["device"], askAt: { zoneId: d.zoneId },
      anchor: { kind: "device", zoneId: d.zoneId, deviceKey: d.key },
      what: L(`${term(d.label)} ${offline ? "응답 없음" : "점검 필요"}`, `${term(d.label)} ${offline ? "not responding" : "needs service"}`),
      why: offline
        ? L("장치가 보고를 보내지 않습니다. 전원과 통신을 확인하세요.", "The device sends no report. Check power and communication.")
        : L("장치가 이상을 보고했습니다. 현장에서 확인하세요.", "The device reported a fault. Check it on site."),
      todo: L("설비 확인", "Check equipment"), ask: `${d.label} 고장 점검 방법`,
    });
  }

  // Changes sent with no reply yet.
  for (const p of input.pending) {
    const d = deviceIn(p.zoneId, p.target);
    items.push({
      id: `pending:${p.zoneId}:${p.target}`, tone: "attention", priority: 80, go: "pending", ask: null, sources: ["device", "records"],
      anchor: d && p.zoneId ? { kind: "device", zoneId: p.zoneId, deviceKey: d.key } : p.zoneId ? { kind: "zone", zoneId: p.zoneId } : null,
      what: L(`${d ? term(d.label) : "설비"} 변경 결과 미확인`, `${d ? term(d.label) : "Equipment"} change unconfirmed`),
      why: L("변경을 보낸 뒤 장치 응답을 받지 못했습니다. 같은 요청으로 결과만 다시 확인합니다.", "No reply came after the change was sent. Only the same request is checked again."),
      todo: L("결과 확인", "Check result"),
    });
  }

  // Advice the assistant rechecked after a value changed, or that no longer matches.
  const latest = new Map<string, BriefInput["turns"][number]>();
  for (const t of input.turns) {
    if (t.status !== "complete" || !t.stateReview) continue;
    const at = t.queryContext?.bedId ?? t.queryContext?.selectedZoneIds?.[0] ?? "farm";
    latest.set(at, t);
  }
  for (const [at, t] of latest) {
    const review = t.stateReview!;
    const recent = !t.recordedAt || now - Date.parse(t.recordedAt) < 60 * 60 * 1000;
    const bed = input.beds.find((b) => b.id === t.queryContext?.bedId);
    const zoneId = bed?.zone_id ?? t.queryContext?.selectedZoneIds?.[0] ?? null;
    const anchor: BriefAnchor | null = bed ? { kind: "bed", zoneId: bed.zone_id, bedId: bed.id } : zoneId ? { kind: "zone", zoneId } : null;
    const where = bed ? place(bed.label) : zoneId ? zoneName(zoneId) : L("농장", "Farm");
    if (review.status === "updated" && recent) {
      const changed = review.changed_units?.length ?? 0;
      items.push({
        id: `advice:${at}:${t.id}`, tone: "info", priority: 50, anchor, go: "advice", ask: null, sources: ["advice", "sensor"], askAt: { zoneId, bedId: bed?.id ?? null },
        what: L(`${where} 답변을 새 값으로 고침`, `${where}: answer updated to new values`),
        why: changed
          ? L(`센서 값이 바뀌어 답의 ${changed}부분을 다시 확인하고 고쳤습니다. 나머지는 그대로입니다.`, `Readings changed, so ${changed} ${changed === 1 ? "part" : "parts"} of the answer were rechecked and rewritten. The rest stands.`)
          : L("센서 값이 바뀌어 답을 다시 확인했습니다.", "Readings changed, so the answer was rechecked."),
        todo: L("답변 보기", "View answer"),
      });
    } else if ((review.status === "stale" || review.status === "needs_confirmation") && recent) {
      items.push({
        id: `advice:${at}:${t.id}`, tone: "attention", priority: 45, anchor, go: "advice", ask: null, sources: ["advice", "sensor"], askAt: { zoneId, bedId: bed?.id ?? null },
        what: L(`${where} 답변이 지금 상태와 다름`, `${where}: answer no longer matches`),
        why: L("답한 뒤 값이 계속 바뀌어 고쳐 쓰는 대신 새로 물어야 합니다.", "Values kept changing after the answer, so it needs a new question rather than a rewrite."),
        todo: L("다시 묻기", "Ask again"),
      });
    }
  }

  // Camera readings: each open record the AI raised from a camera, until a person closes it.
  for (const e of input.cameraEvents ?? []) {
    if (!e.zoneId) continue;
    const bed = e.bedId ? input.beds.find((b) => b.id === e.bedId) : undefined;
    items.push({
      id: `camera-event:${e.id}`, tone: "attention", priority: 56, go: "camera", sources: ["camera"], example: e.synthetic,
      anchor: { kind: "camera", zoneId: e.zoneId, cameraId: e.cameraId, bedId: e.bedId },
      what: bed ? L(`${bed.label} ${e.title}`, `${place(bed.label)}: ${e.title}`) : L(`${e.cameraTitle} ${e.title}`, `${e.cameraTitle}: ${e.title}`),
      why: L(`${e.cameraTitle} 카메라 AI 판독: ${e.text}`, `${e.cameraTitle} camera, AI reading: ${e.text}`),
      todo: L("화면 보기", "View camera"),
      ask: e.ask, askAt: { zoneId: e.zoneId, bedId: e.bedId }, since: e.createdAt,
    });
  }

  // Example cameras: the saved finding, never presented as this farm's footage.
  for (const c of input.cameraEvents ? [] : input.cameras) {
    const q = c.questions.find((x) => x.alert && x.decision === "answer");
    if (!q) continue;
    const bed = c.bed_id ? input.beds.find((b) => b.id === c.bed_id) : undefined;
    const finding = L(q.finding_ko ?? q.answer_ko ?? "", q.finding_en ?? q.answer_en ?? "");
    items.push({
      id: `camera:${c.id}:${q.id}`, tone: "attention", priority: 55, go: "camera", sources: ["camera"], example: true,
      anchor: { kind: "camera", zoneId: c.zone_id, cameraId: c.id, bedId: c.bed_id },
      what: bed ? L(`${bed.label} ${finding}`, `${place(bed.label)}: ${finding}`) : finding,
      why: L(`${c.label_ko} 카메라 판독: ${plain(q.answer_ko)} 확신도 ${Math.round(q.confidence * 100)}%.`, `${c.label_en} camera: ${plain(q.answer_en)} Confidence ${Math.round(q.confidence * 100)}%.`),
      todo: L("화면 보기", "View frame"),
      ask: q.ask_ko ?? null, askAt: { zoneId: c.zone_id, bedId: c.bed_id },
    });
  }

  // Harvests that are due: past, today, or within three days.
  const byBed = new Map<string, { days: number; cycle: BriefInput["cycles"][number] }>();
  for (const c of input.cycles) {
    if (c.status !== "growing") continue;
    const d = daysUntil(c.planned_harvest_from, now);
    if (d === null || d > 3) continue;
    const prev = byBed.get(c.bed_id);
    if (!prev || d < prev.days) byBed.set(c.bed_id, { days: d, cycle: c });
  }
  for (const [bedId, { days, cycle }] of byBed) {
    const bed = input.beds.find((b) => b.id === bedId);
    if (!bed) continue;
    const when = days < 0 ? L("수확 예정일 지남", "harvest overdue") : days === 0 ? L("오늘 수확", "harvest today") : L(`수확 D-${days}`, `harvest in ${days} ${days === 1 ? "day" : "days"}`);
    items.push({
      id: `harvest:${bedId}`, tone: days < 0 ? "attention" : "info", priority: days < 0 ? 42 : days === 0 ? 40 : 25, go: "harvest", sources: ["records"],
      anchor: { kind: "bed", zoneId: bed.zone_id, bedId },
      what: L(`${bed.label} ${when}`, `${place(bed.label)}: ${when}`),
      why: L(
        `${cycle.tier}단 ${cycle.crop} ${cycle.remaining_count}주, 예정일 ${cycle.planned_harvest_from}.${days < 0 ? " 수확했으면 기록을, 미뤘으면 예정일을 고치세요." : ""}`,
        `Tier ${cycle.tier}, ${term(cycle.crop)} ${cycle.remaining_count} plants, planned ${cycle.planned_harvest_from}.${days < 0 ? " Record the harvest, or move the date." : ""}`,
      ),
      todo: L("수확 기록", "Record harvest"), ask: "고추냉이 수확 시기", askAt: { zoneId: bed.zone_id, bedId },
    });
  }

  // A device whose actual output stays away from what was requested.
  for (const d of input.actuators) {
    if (!d.zoneId || d.health === "fault" || d.health === "offline" || input.settling?.includes(d.key) || items.some((i) => i.anchor?.kind === "device" && i.anchor.deviceKey === d.key)) continue;
    const want = d.desiredValue, got = d.effectiveValue;
    if (want === undefined || want === null || got === undefined || got === null) continue;
    const gap = typeof want === "number" && typeof got === "number" ? Math.abs(want - got) >= 20 : typeof want === "boolean" && typeof got === "boolean" ? want !== got : false;
    if (!gap) continue;
    const show = (v: unknown) => (typeof v === "boolean" ? (v ? L("켜짐", "on") : L("꺼짐", "off")) : `${Math.round(Number(v))}%`);
    items.push({
      id: `output:${d.key}`, tone: "attention", priority: 62, go: "device", sources: ["device"], askAt: { zoneId: d.zoneId },
      anchor: { kind: "device", zoneId: d.zoneId, deviceKey: d.key },
      what: L(`${term(d.label)} 출력이 요청과 다름`, `${term(d.label)} output differs from request`),
      why: L(`요청 ${show(want)}, 실제 출력 ${show(got)}입니다. 설비 보고값이며 고장 판정은 아닙니다. 현장에서 동작을 확인하세요.`, `Requested ${show(want)}, actual output ${show(got)}. This is the device's own report, not a fault verdict; check it on site.`),
      todo: L("설비 확인", "Check equipment"), ask: `${d.label} 출력이 요청보다 낮을 때 점검 방법`,
    });
  }

  // Sensor records meeting a condition the growing guides tie to disease.
  for (const zone of input.diseaseWatch?.zones ?? []) {
    for (const c of zone.conditions) {
      if (!c.passages.length) continue;
      const hours = Math.round(c.hours * 10) / 10;
      items.push({
        id: `disease:${zone.zone_id}:${c.id}`, tone: "attention", priority: 48, go: "ask", sources: ["sensor", "guides"], ref: "disease",
        anchor: { kind: "zone", zoneId: zone.zone_id }, askAt: { zoneId: zone.zone_id },
        what: L(`${zoneName(zone.zone_id)} 병해 주의: ${c.label}`, `${zoneName(zone.zone_id)} disease watch: ${term(c.label)}`),
        why: L(`최근 ${input.diseaseWatch!.window_hours}시간 중 ${hours}시간 동안 ${c.label}. 자료: "${c.passages[0].sentence}"`, `${hours} of the last ${input.diseaseWatch!.window_hours} hours: ${term(c.label)}. Guide: "${c.passages[0].sentence}"`),
        todo: L("예방 방법 묻기", "Ask about prevention"), ask: `고추냉이 ${c.label} 병해 예방 방법`,
      });
    }
  }

  // Tomorrow's forecast against the farm's own air-temperature range.
  const w = input.weather;
  const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  if (w && w.configured && "days" in w && w.available) {
    const day = w.days[1] ?? w.days[0];
    const air = input.thresholds.find((t) => t.metric === "air_temperature_c");
    const upper = air?.upper, lower = air?.lower;
    const when = w.days[1] ? L("내일", "Tomorrow") : L("오늘", "Today");
    if (day && known(day.t_max) && known(upper) && day.t_max > upper) {
      items.push({
        id: `weather:hot:${day.date}`, tone: "info", priority: 44, go: "ask", sources: ["weather"], ref: "weather", anchor: null, askAt: { zoneId: null },
        what: L(`${when} 최고 ${day.t_max}°C 예보`, `${when}: high of ${day.t_max}°C forecast`),
        why: L(`${w.label} 예보가 재배실 기준 상한 ${upper}°C보다 높습니다. 차광·환기·냉각을 미리 점검하세요.`, `The ${w.label} forecast is above the room's upper limit of ${upper}°C. Check shading, ventilation and cooling ahead.`),
        todo: L("대비 방법 묻기", "Ask how to prepare"), ask: "고추냉이 고온기 차광과 환기 관리",
      });
    }
    if (day && known(day.t_min) && known(lower) && day.t_min < lower) {
      items.push({
        id: `weather:cold:${day.date}`, tone: "info", priority: 43, go: "ask", sources: ["weather"], ref: "weather", anchor: null, askAt: { zoneId: null },
        what: L(`${when} 최저 ${day.t_min}°C 예보`, `${when}: low of ${day.t_min}°C forecast`),
        why: L(`${w.label} 예보가 재배실 기준 하한 ${lower}°C보다 낮습니다. 난방과 보온을 미리 점검하세요.`, `The ${w.label} forecast is below the room's lower limit of ${lower}°C. Check heating and insulation ahead.`),
        todo: L("대비 방법 묻기", "Ask how to prepare"), ask: "고추냉이 저온기 보온 관리",
      });
    }
    if (day && known(day.precip_mm) && day.precip_mm >= 30) {
      items.push({
        id: `weather:rain:${day.date}`, tone: "info", priority: 42, go: "ask", sources: ["weather"], ref: "weather", anchor: null, askAt: { zoneId: null },
        what: L(`${when} 비 ${day.precip_mm}mm 예보`, `${when}: ${day.precip_mm} mm of rain forecast`),
        why: L("측창과 배수로를 미리 점검하세요.", "Check side vents and drainage ahead."),
        todo: L("대비 방법 묻기", "Ask how to prepare"), ask: "고추냉이 장마철 습도와 배수 관리",
      });
    }
  }

  // Seen alerts stay but step back; items put away for today leave the list.
  for (const item of items) {
    const at = item.alertId ? input.acknowledged?.[item.alertId] : undefined;
    // Seen goes behind everything not yet seen (camera 55, harvest 42), still in the list.
    if (at) { item.acknowledgedAt = at; item.priority = Math.min(item.priority - 60, 30); }
  }
  return items.filter((i) => !input.hidden?.includes(i.id)).sort((a, b) => b.priority - a.priority);
}

/**
 * The AI alert analysis is markdown with fixed sections. The brief needs two
 * lines of it: the first thing to check and the first adjustment advice.
 * Long decimals from raw readings are rounded for reading.
 */
export function advisoryLines(warning: string): { check: string | null; adjust: string | null } {
  // An English analysis carries English labels (the server asks for fixed ones; older replies vary).
  const section = (label: RegExp) => {
    const found = label.exec(warning);
    if (!found) return null;
    const rest = warning.slice(found.index + found[0].length);
    const end = rest.search(/\n\s*\*\*[^*]+\*\*|\n##\s/);
    const body = end >= 0 ? rest.slice(0, end) : rest;
    const line = body.split("\n").map((l) => l.trim()).find((l) => /^(\d+\.|[-*])\s+/.test(l));
    return line ? clean(line.replace(/^(\d+\.|[-*])\s+/, "")) : null;
  };
  return {
    check: section(/\*\*\s*(?:우선 점검|priority checks?|checks? first|what to check first)\s*:?\s*\*\*/i),
    adjust: section(/\*\*\s*(?:조정 제안|adjustment suggestions?|suggested adjustments?|adjustments?)\s*:?\s*\*\*/i),
  };
}
/**
 * Text written by the server names zones by number ("1구역") and severities in
 * English ("critical"); the screen names zones as the layout does ("A구역").
 */
export function farmWords(text: string, zoneLabel: (id: string) => string): string {
  return text
    .replace(/(^|[^0-9])1\s?구역/g, (_m, pre: string) => `${pre}${zoneLabel("zone-a")}`)
    .replace(/(^|[^0-9])2\s?구역/g, (_m, pre: string) => `${pre}${zoneLabel("zone-b")}`)
    // An English answer names them the server's way too ("Zone 1").
    .replace(/\bZone 1\b/g, () => zoneLabel("zone-a"))
    .replace(/\bZone 2\b/g, () => zoneLabel("zone-b"))
    .replace(/\bcritical\b/g, L("긴급", "critical"))
    .replace(/\bwarning\b/g, L("주의", "warning"))
    .replace(/\brecipe\b/g, L("재배 기준", "recipe"))
    // Raw sensor decimals ("64.9992°C") read as a person reads them.
    .replace(/\d+\.\d{3,}/g, (m) => String(Number(Number(m).toFixed(1))));
}
function clean(text: string) {
  return text
    .replace(/\*\*/g, "")
    .replace(/\d+\.\d{3,}/g, (m) => String(Number(Number(m).toFixed(1))))
    .replace(/\s+/g, " ")
    .trim();
}

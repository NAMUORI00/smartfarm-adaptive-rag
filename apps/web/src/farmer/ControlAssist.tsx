import { useEffect, useState } from "react";
import type { ControlDraft, FarmId, TelemetryPoint } from "../types";
import { previewControl } from "./assist-api";
import type { ControlPreview } from "./assist-api";
import { L, term } from "./i18n";
import { shortStamp } from "./time-format";

/**
 * Before "변경 허용": what the device definition says this change moves, and
 * where those values stand now. Read-only; no proposal or command is made.
 */
export function ControlPreviewBox({ farmId, draft }: { farmId: FarmId; draft: ControlDraft }) {
  const [preview, setPreview] = useState<ControlPreview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "none">("loading");
  useEffect(() => {
    if (!draft.zoneId) { setState("none"); return; }
    const ctrl = new AbortController();
    setState("loading");
    previewControl(farmId, { target: draft.target, zone_id: draft.zoneId, value: draft.value }, ctrl.signal)
      .then((p) => { setPreview(p); setState("ready"); })
      .catch(() => { if (!ctrl.signal.aborted) setState("none"); });
    return () => ctrl.abort();
  }, [farmId, draft.target, draft.zoneId, String(draft.value)]);
  if (state === "none") return null;
  return (
    <section className="fm-preview" aria-label={L("영향 미리보기", "Effect preview")}>
      <small className="fm-preview-head">{L("영향 미리보기, 장치 명령 없음", "Effect preview, no command sent")}</small>
      {state === "loading" ? (
        <p className="fm-hint">{L("설비 정의를 확인하는 중…", "Reading the device definition…")}</p>
      ) : preview && (
        <>
          {preview.expected_effects.length > 0 && (
            <ul className="fm-preview-effects">
              {preview.expected_effects.map((e) => <li key={e}>{term(e)}</li>)}
            </ul>
          )}
          {preview.related_metrics.length > 0 && (
            <p className="fm-preview-now">
              {L("지금 값", "Now")}: {preview.related_metrics.map((m) => `${term(m.label)} ${typeof m.value === "number" ? Number(m.value.toFixed(1)) : m.value}${m.unit === "%" || m.unit === "°C" ? m.unit : ` ${m.unit}`}${m.quality && m.quality !== "good" ? L(" (센서 의심, 판단에 쓰지 않음)", " (sensor suspect, not used)") : ""}`).join(", ")}
            </p>
          )}
          <small className="fm-hint">{L("설비 정의에 적힌 영향 방향이며 변화량을 약속하지 않습니다. 허용한 뒤에는 실제 관측으로 회복을 확인합니다.", "Directions from the device definition, not promised amounts. After allowing, recovery is checked against real readings.")}</small>
        </>
      )}
    </section>
  );
}

/** Which recorded series a device moves, for the before/after picture. */
export function seriesForTarget(target: string): { field: keyof TelemetryPoint; label: string; unit: string }[] {
  const t = (field: keyof TelemetryPoint, ko: string, en: string, unit: string) => ({ field, label: L(ko, en), unit });
  switch (target) {
    case "root_zone_chiller": return [t("rootZoneTemperature", "근권 온도", "Root-zone temperature", "°C")];
    case "heater": return [t("temperature", "재배실 온도", "Room temperature", "°C")];
    case "ventilation_fan":
    case "roof_vent":
    case "side_vent": return [t("temperature", "재배실 온도", "Room temperature", "°C"), t("humidity", "상대 습도", "Relative humidity", "%")];
    case "irrigation_pump": return [t("substrateMoisture", "배지 수분", "Substrate moisture", "%"), t("irrigationFlow", "관수 유량", "Irrigation flow", "L/min")];
    case "shade_curtain": return [t("ppfd", "광량", "Light", "µmol")];
    case "air_temperature_sensor_reset": return [t("temperature", "재배실 온도", "Room temperature", "°C")];
    default: return [];
  }
}

/**
 * The recorded values of one series around an allowed change: a line with the
 * moment of the change marked, and the average before against the latest
 * value after. Only recorded points; nothing is drawn past the last reading.
 */
export function EffectChart({ points, at, field, label, unit }: { points: TelemetryPoint[]; at: string; field: keyof TelemetryPoint; label: string; unit: string }) {
  const t0 = Date.parse(at);
  const series = points
    .map((p) => ({ t: Date.parse(p.time), v: Number(p[field]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && Math.abs(p.t - t0) <= 90 * 60 * 1000)
    .sort((a, b) => a.t - b.t);
  const before = series.filter((p) => p.t < t0);
  const after = series.filter((p) => p.t >= t0);
  if (before.length < 2 || after.length < 1) {
    return <p className="fm-hint">{L(`${label}: 변경 전후 기록이 아직 충분하지 않습니다.`, `${label}: not enough readings around the change yet.`)}</p>;
  }
  const W = 280, H = 64, pad = 4;
  const tMin = series[0].t, tMax = series[series.length - 1].t;
  const vMin = Math.min(...series.map((p) => p.v)), vMax = Math.max(...series.map((p) => p.v));
  const x = (t: number) => pad + ((t - tMin) / Math.max(1, tMax - tMin)) * (W - pad * 2);
  const y = (v: number) => H - pad - ((v - vMin) / Math.max(0.001, vMax - vMin)) * (H - pad * 2);
  const avg = before.reduce((s, p) => s + p.v, 0) / before.length;
  const last = after[after.length - 1].v;
  const fmt = (v: number) => `${Number(v.toFixed(1))}${unit === "%" || unit === "°C" ? unit : ` ${unit}`}`;
  return (
    <figure className="fm-effect">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={L(`${label} 변경 전 평균 ${fmt(avg)}, 변경 후 최근 ${fmt(last)}`, `${label}: ${fmt(avg)} average before, ${fmt(last)} latest after`)}>
        <rect x={x(t0)} y={0} width={Math.max(0, W - pad - x(t0))} height={H} className="fm-effect-after" />
        <polyline points={series.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")} className="fm-effect-line" />
        <line x1={x(t0)} x2={x(t0)} y1={0} y2={H} className="fm-effect-mark" />
      </svg>
      <figcaption>
        <strong>{label}</strong> {L(`변경 전 평균 ${fmt(avg)} → 최근 ${fmt(last)}`, `${fmt(avg)} before → ${fmt(last)} latest`)}
        <small>{L(`${shortStamp(at)} 변경, 기록된 값만 표시`, `Changed ${shortStamp(at)}; recorded values only`)}</small>
      </figcaption>
    </figure>
  );
}

import { useEffect, useState } from "react";
import { rangeSelectionForActuator } from "../device-chat";
import type { Actuator } from "../types";
import { operationalStateText } from "./control-labels";
import { progressText } from "./device-progress";
import type { DeviceProgress } from "./device-progress";
import { L, place, term } from "./i18n";

/** One irrigation as the telemetry simulator runs it (services/telemetry/app/simulator.py, IRRIGATION_CYCLE_SECONDS). */
const SIMULATED_IRRIGATION_SECONDS = 120;
const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  return m ? L(`${m}분 ${s}초`, `${m} min ${s} s`) : L(`${s}초`, `${s} s`);
};
export function DeviceControl({
  device: d,
  scope,
  disabled,
  disabledReason,
  onReview,
  stateText,
  progress,
  bare = false,
}: {
  /** The device on the stage: the panel head already names it and says its state. */
  bare?: boolean;
  /** The device is still applying a change, or stays away from it. */
  progress?: DeviceProgress | null;
  /** Overrides the reported state line, e.g. a sensor says what its reading is doing, not "on". */
  stateText?: string;
  device: Actuator;
  scope: string;
  disabled: boolean;
  disabledReason?: string;
  onReview: (v: number | boolean) => void;
}) {
  // The pump's only action is one irrigation that stops by itself; while it runs, the card counts it down.
  const oneShot = d.capability?.mcpAction === "start_irrigation_cycle";
  const irrigating = oneShot && (d.effectiveValue ?? d.reportedValue) === true;
  const cycle = d.executionScope === "simulator_only" ? SIMULATED_IRRIGATION_SECONDS : null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!irrigating) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [irrigating]);
  // Only a cycle the farmer started has a known start; a scheduled one just says it is running.
  const started = irrigating && d.mode === "manual" && d.feedbackAt ? Date.parse(d.feedbackAt) : NaN;
  // The clock state is only ticked while irrigating; the first render after the start reads the time itself.
  const left = cycle && Number.isFinite(started) ? Math.max(0, cycle - Math.round((Math.max(now, Date.now()) - started) / 1000)) : null;
  const [value, setValue] = useState<number | boolean>(() =>
    d.capability?.valueType === "percentage"
      ? rangeSelectionForActuator(
          Number(d.reportedValue ?? 0),
          d.desiredValue,
          d.capability.minimum ?? 0,
          d.capability.maximum ?? 100,
          d.capability.step ?? 1,
        ).value
      : typeof d.reportedValue === "boolean"
        ? d.reportedValue
        : false,
  );
  return (
    <article className={`farm-device ${bare ? "is-bare" : ""}`}>
      {!bare && <h3>{term(d.label)}</h3>}
      {bare ? (
        <p>{L("적용 범위", "Applies to")}: {d.zoneId ? place(scope) : L("구역 연결 확인 필요", "Check zone link")}</p>
      ) : (
        <p>
          {L("현재", "Now")}{" "}
          {stateText ?? operationalStateText(d.state)}{", "}
          {d.zoneId ? place(scope) : L("구역 연결 확인 필요", "Check zone link")}
        </p>
      )}
      <small>
        {d.mode
          ? L(`운전 상태: ${d.mode === "manual" ? "직접 조절" : d.mode === "off" ? "꺼짐" : "설정 운전"}`, `Mode: ${d.mode === "manual" ? "manual" : d.mode === "off" ? "off" : "scheduled"}`)
          : ""}
        {d.health && d.health !== "normal" ? `${d.mode ? ", " : ""}${L("장치 상태 확인 필요", "check device status")}` : ""}
      </small>
      {progress && <p className={`fm-device-progress is-${progress.state}`} role="status">{progressText(progress)}{progress.state === "differs" ? L(". 장치 보고값이며 고장 판정은 아닙니다.", ". This is the device's own report, not a fault verdict.") : ""}</p>}
      {d.controllable && d.capability ? (
        <>
          <div className="farm-device-value">
            {d.capability.action === "recalibrate_air_temperature_sensor" ? (
              <p>{L("온도 센서 재보정 작업을 요청합니다.", "Requests a temperature sensor recalibration.")}</p>
            ) : oneShot ? (
              <p className="fm-irrigation">
                {irrigating
                  ? left !== null ? L(`관수 중, 약 ${clock(left)} 남음`, `Irrigating, about ${clock(left)} left`) : L("관수 중", "Irrigating")
                  : cycle ? L(`관수 1회는 약 ${cycle / 60}분이며 끝나면 스스로 멈춥니다.`, `One irrigation runs for about ${cycle / 60} min and stops by itself.`) : L("관수 1회는 끝나면 스스로 멈춥니다.", "One irrigation stops by itself.")}
              </p>
            ) : d.capability.valueType === "boolean" ? (
              <>
                <button
                  aria-pressed={value === false}
                  onClick={() => setValue(false)}
                >
                  {L("정지", "Stop")}
                </button>
                <button
                  aria-pressed={value === true}
                  onClick={() => setValue(true)}
                >
                  {L("가동", "Run")}
                </button>
              </>
            ) : (
              <label>
                {L("변경 예정", "Set to")} {String(value)}%
                <input
                  type="range"
                  min={d.capability.minimum ?? 0}
                  max={d.capability.maximum ?? 100}
                  step={d.capability.step ?? 1}
                  value={Number(value)}
                  onChange={(e) => setValue(Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <button
            disabled={disabled || d.health === "offline"}
            onClick={() =>
              onReview(
                d.capability?.action === "recalibrate_air_temperature_sensor"
                  ? true
                  : oneShot ? !irrigating : value,
              )
            }
          >
            {d.capability.action === "recalibrate_air_temperature_sensor"
              ? L("재보정 요청 확인", "Review recalibration request")
              : oneShot
                ? irrigating ? L("관수 멈춤 확인", "Review stopping irrigation") : L("관수 1회 시작 확인", "Review one irrigation")
                : L("변경 내용 확인", "Review change")}
          </button>
          {(disabled || d.health === "offline") && <p role="status">{disabledReason ?? (d.health === "offline" ? L("장치 연결을 먼저 확인하세요.", "Check the device connection first.") : L("최근 관측·연결 상태를 먼저 확인하세요.", "Check recent readings and the connection first."))}</p>}
        </>
      ) : (
        <p>{L("상태 조회만 가능한 설비입니다.", "This equipment is read-only.")}</p>
      )}
    </article>
  );
}

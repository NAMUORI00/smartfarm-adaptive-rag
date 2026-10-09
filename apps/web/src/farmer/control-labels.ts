import { operationalUiCopy } from "../operator-copy";
import { actuatorStateIsEnabled } from "../operator-ui";
import type { ControlTarget } from "../types";
import { L } from "./i18n.ts";
export function controlValueText(
  value: number | boolean,
  target?: ControlTarget,
) {
  if (target === "air_temperature_sensor_reset") return L("재보정 실행", "Run recalibration");
  if (typeof value === "number") return `${Math.round(value)}%`;
  if (target === "root_zone_chiller") return value ? L("냉각 켜기", "Cooling on") : L("냉각 끄기", "Cooling off");
  if (target === "irrigation_pump") return value ? L("관수 시작", "Start irrigation") : L("관수 멈춤", "Stop irrigation");
  if (target === "heater") return value ? L("난방 켜기", "Heating on") : L("난방 끄기", "Heating off");
  return value ? L("켜기", "Turn on") : L("끄기", "Turn off");
}

export function controlToggleLabels(target: ControlTarget) {
  if (target === "root_zone_chiller")
    return [L("냉각 켜기", "Cooling on"), L("냉각 끄기", "Cooling off")] as const;
  if (target === "irrigation_pump") return [L("관수 시작", "Start irrigation"), L("관수 멈춤", "Stop irrigation")] as const;
  if (target === "heater") return [L("난방 켜기", "Heating on"), L("난방 끄기", "Heating off")] as const;
  return [L("켜기", "Turn on"), L("끄기", "Turn off")] as const;
}

export function controlStateText(
  value: string | number | boolean,
  target: ControlTarget,
) {
  if (target === "air_temperature_sensor_reset") return L("센서 관측 재확인", "Recheck sensor reading");
  if (typeof value === "number") return `${Math.round(value)}%`;
  if (
    target === "ventilation_fan" ||
    target === "roof_vent" ||
    target === "side_vent" ||
    target === "shade_curtain"
  ) {
    const numeric = Number.parseFloat(String(value));
    return Number.isFinite(numeric)
      ? `${Math.round(numeric)}%`
      : operationalStateText(value);
  }
  const enabled = actuatorStateIsEnabled(value);
  if (target === "root_zone_chiller") return enabled ? L("냉각 중", "Cooling") : L("꺼짐", "Off");
  if (target === "irrigation_pump") return enabled ? L("관수 중", "Irrigating") : L("멈춤", "Stopped");
  if (target === "heater") return enabled ? L("난방 중", "Heating") : L("꺼짐", "Off");
  return enabled ? L("켜짐", "On") : L("꺼짐", "Off");
}

export function operationalStateText(value: string | number | boolean) {
  if (typeof value === "boolean") return value ? L("켜짐", "On") : L("꺼짐", "Off");
  if (typeof value === "number") return String(Math.round(value * 10) / 10);
  const normalized = value.trim().toLowerCase();
  // Percent reports carry simulator decimals ("67.4% open"); the plan chips show whole percents, so match them.
  const percent = normalized.match(/^([0-9.]+)%(?: (open|closed))?$/);
  if (percent) return `${Math.round(Number(percent[1]))}%${percent[2] === "open" ? L(" 열림", " open") : percent[2] === "closed" ? L(" 닫힘", " closed") : ""}`;
  return (
    (
      {
        on: L("켜짐", "On"),
        off: L("꺼짐", "Off"),
        true: L("켜짐", "On"),
        false: L("꺼짐", "Off"),
        ready: L("사용 가능", "Ready"),
        completed: L("완료", "Completed"),
        running: L("진행 중", "Running"),
        failed: L("확인 필요", "Check needed"),
        "recipe locked": L("운영 기준 잠금", "Recipe locked"),
      } as Record<string, string>
    )[normalized] ?? operationalUiCopy(value)
  );
}

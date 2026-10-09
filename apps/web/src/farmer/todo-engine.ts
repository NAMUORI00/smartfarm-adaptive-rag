import type { Alert } from "../types";
import { L, place as placeName, term } from "./i18n.ts";

/** Icon names are a subset of FarmIcon paths; kept as strings so this module stays React-free. */
export type TodoIcon = "sensor" | "map" | "warning" | "records" | "clock" | "camera" | "advisor" | "harvest" | "check";
export type TodoKind = "reconnect" | "zone" | "pending" | "state" | "camera" | "advisor" | "records" | "crop";

export type TodoTone = "ok" | "attention" | "danger";

export type TodoItem = {
  id: string;
  kind: TodoKind;
  tone: TodoTone;
  title: string;
  detail: string;
  icon: TodoIcon;
  action: string;
  zoneId?: string | null;
  /** ISO time the situation began, when known (an alert's occurrence time). */
  since?: string | null;
  priority: number;
};

export type TodoInput = {
  connected: boolean;
  /** The first reply has not arrived yet: nothing failed and nothing is known. */
  connecting?: boolean;
  /** Unresolved alerts, already sorted by severity. */
  alerts: (Pick<Alert, "occurrenceId" | "severity" | "title" | "zoneId" | "occurredAt"> & { kind?: Alert["kind"] })[];
  observationProblem: boolean;
  pendingControls: number;
  activeCases: number;
  patrolOpen: number;
  adviceStale: boolean;
  plannedHarvests: number;
  zoneLabel: (id?: string | null) => string;
};

const severityRank = { critical: 3, warning: 2, info: 1 } as const;

/**
 * "재배실 온도 센서 건전성 경보" → "재배실 온도 센서 확인". Alert titles are
 * written for operators; the first screen needs the place and the thing to
 * check, nothing more.
 */
export function shortAlertTitle(title: string): string {
  return title
    .replace(/\s*경보$/, "")
    .replace(/센서\s*건전성/, "센서 확인")
    .replace(/\s+/g, " ")
    .trim();
}

function zoneDetail(alert: TodoInput["alerts"][number], critical: boolean): string {
  if (alert.kind === "sensor_health") return L("센서 값이 허용 범위를 벗어났습니다. 센서와 배선을 먼저 확인하세요.", "Sensor value is outside the allowed range. Check the sensor and wiring first.");
  if (alert.kind === "equipment_fault") return L("설비 응답이 없습니다. 설비 상태를 확인하세요.", "Equipment is not responding. Check the equipment status.");
  return critical
    ? L("값이 기준을 크게 벗어났습니다. 관측을 보고 설비를 확인하세요.", "Values are far outside the range. Review the readings and check the equipment.")
    : L("관측을 보고 필요한 설비를 확인하세요.", "Review the readings and check the equipment that needs it.");
}

/**
 * One list for everything the farm is asking for today. The first item is the
 * primary action; the rest are offered as "다른 할 일". Alerts are grouped per
 * zone so one noisy zone does not crowd out cameras, advice or records.
 */
export function buildTodos(input: TodoInput): TodoItem[] {
  const items: TodoItem[] = [];
  // Neither "connection lost" nor "all fine" is true before the first reply.
  if (input.connecting) {
    return [{
      id: "connecting", kind: "reconnect", tone: "ok", priority: 100, icon: "sensor", action: L("다시 확인", "Check again"),
      title: L("농장 데이터 수신 중", "Receiving farm data"),
      detail: L("수신이 끝나면 확인할 항목을 표시합니다.", "Items to check will appear once data arrives."),
    }];
  }
  if (!input.connected) {
    items.push({
      id: "reconnect", kind: "reconnect", tone: "attention", priority: 100, icon: "sensor", action: L("다시 연결", "Reconnect"),
      title: L("농장 데이터 수신 끊김", "Farm data disconnected"),
      detail: L("화면의 값은 마지막 수신값입니다. 연결 상태를 확인하세요.", "Values shown are the last received. Check the connection."),
    });
  }
  const zones = new Map<string, TodoInput["alerts"]>();
  for (const alert of input.alerts) {
    const key = alert.zoneId ?? "farm";
    zones.set(key, [...(zones.get(key) ?? []), alert]);
  }
  for (const [key, alerts] of zones) {
    const sorted = [...alerts].sort((a, b) => severityRank[b.severity] - severityRank[a.severity]);
    const first = sorted[0];
    const critical = first.severity === "critical";
    const place = placeName(input.zoneLabel(first.zoneId));
    const others = new Set(sorted.map((a) => a.title)).size - 1;
    items.push({
      id: `zone:${key}`, kind: "zone", tone: critical ? "danger" : "attention", priority: critical ? 90 : 70,
      icon: critical ? "warning" : "map", action: L(`${place} 보기`, `Open ${place}`), zoneId: first.zoneId ?? null,
      since: [...sorted].map((a) => a.occurredAt).filter(Boolean).sort()[0] ?? null,
      // Two notices with the same title are one problem, so "외 n건" counts distinct titles only.
      title: L(
        `${place} / ${shortAlertTitle(first.title)}${others > 0 ? ` 외 ${others}건` : ""}`,
        `${place} / ${term(shortAlertTitle(first.title))}${others > 0 ? ` and ${others} more` : ""}`,
      ),
      detail: zoneDetail(first, critical),
    });
  }
  if (input.pendingControls > 0) {
    items.push({
      id: "pending", kind: "pending", tone: "attention", priority: 80, icon: "records", action: L("결과 확인", "Check result"),
      title: L(`응답 미수신 설비 변경 ${input.pendingControls}건`, `${input.pendingControls} equipment ${input.pendingControls === 1 ? "change" : "changes"} awaiting response`),
      detail: L("같은 요청의 결과를 다시 조회합니다. 새 명령은 만들지 않습니다.", "Looks up the result of the same request again. No new command is sent."),
    });
  }
  if (input.connected && input.observationProblem) {
    items.push({
      id: "state", kind: "state", tone: "attention", priority: 60, icon: "sensor", action: L("값 확인", "Check values"),
      title: L("관측 지연 또는 센서 확인 필요", "Readings delayed or sensor check needed"),
      detail: L("일부 항목은 마지막 수신값입니다.", "Some values are the last received."),
    });
  }
  if (input.patrolOpen > 0) {
    items.push({
      id: "camera", kind: "camera", tone: "attention", priority: 50, icon: "camera", action: L("카메라 보기", "Open cameras"),
      title: L(`카메라 확인 기록 ${input.patrolOpen}건 미처리`, `${input.patrolOpen} camera ${input.patrolOpen === 1 ? "record" : "records"} not handled`),
      detail: L("브리핑을 읽고 현장 확인 결과를 남기세요.", "Read the briefing and record what you found on site."),
    });
  }
  if (input.adviceStale) {
    items.push({
      id: "advisor", kind: "advisor", tone: "attention", priority: 40, icon: "advisor", action: L("새로 묻기", "Ask again"),
      title: L("상담 답변과 현재 상태 불일치", "Advice no longer matches current status"),
      detail: L("센서 값이 계속 변하고 있어 새 질문이 필요합니다.", "Sensor values keep changing, so a new question is needed."),
    });
  }
  if (input.activeCases > 0) {
    items.push({
      id: "records", kind: "records", tone: "attention", priority: 30, icon: "records", action: L("진행 작업", "Open tasks"),
      title: L("진행 중인 작업", "Tasks in progress"),
      detail: L("장치가 응답했는지, 환경이 회복됐는지 확인하세요.", "Check whether the device responded and conditions recovered."),
    });
  }
  if (!items.length) {
    items.push({
      id: "crop", kind: "crop", tone: "ok", priority: 10, icon: "check", action: L("수확 일정", "Harvest schedule"),
      title: L("이상 없음", "No issues"),
      detail: input.plannedHarvests > 0
        ? L(`모든 관측값이 기준 범위 안에 있습니다. 수확 일정 ${input.plannedHarvests}건 등록.`, `All readings are in range. ${input.plannedHarvests} ${input.plannedHarvests === 1 ? "harvest" : "harvests"} scheduled.`)
        : L("모든 관측값이 기준 범위 안에 있습니다.", "All readings are in range."),
    });
  } else if (input.plannedHarvests > 0) {
    items.push({
      id: "crop", kind: "crop", tone: "ok", priority: 10, icon: "harvest", action: L("수확 일정", "Harvest schedule"),
      title: L(`수확 일정 ${input.plannedHarvests}건`, `${input.plannedHarvests} ${input.plannedHarvests === 1 ? "harvest" : "harvests"} scheduled`),
      detail: L("등록된 수확 예정일을 확인하세요.", "Check the registered harvest dates."),
    });
  }
  return items.sort((a, b) => b.priority - a.priority);
}

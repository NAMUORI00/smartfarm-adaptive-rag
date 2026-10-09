import type {
  DashboardSnapshot,
  Metric,
  Actuator,
  ControlDraft,
} from "../types";
import type { FarmSelection, CropCycle } from "../farm-spatial";
import { L } from "./i18n.ts";

export function observationProblem(metrics: Metric[], now = Date.now()) {
  return (
    !metrics.length ||
    metrics.some(
      (m) =>
        !m.observedAt ||
        !Number.isFinite(Date.parse(m.observedAt)) ||
        now - Date.parse(m.observedAt) > ((m as Metric & {staleAfterSeconds?: number}).staleAfterSeconds ?? 300) * 1000 ||
        (m.quality && m.quality !== "good"),
    )
  );
}
/** Short, farmer-facing reason why a reading cannot be trusted right now. Empty when it can. */
export function observationIssue(m: Metric, connected: boolean, now = Date.now()) {
  if (!connected) return L("마지막 수신값", "Last received value");
  if (!m.observedAt || !Number.isFinite(Date.parse(m.observedAt))) return L("수신 시각 없음", "No receive time");
  if (now - Date.parse(m.observedAt) > ((m as Metric & {staleAfterSeconds?: number}).staleAfterSeconds ?? 300) * 1000) return L("관측 지연", "Reading delayed");
  if (m.quality && m.quality !== "good") return L("센서 품질 확인", "Check sensor quality");
  return "";
}
export function latestObservedAt(metrics: Metric[]) {
  return metrics.map((m) => m.observedAt).filter((at): at is string => !!at).sort().at(-1) ?? null;
}
export function relevantObservationKey(
  snapshot: DashboardSnapshot,
  zoneId: string,
  selective: boolean,
) {
  return JSON.stringify({
    metrics: snapshot.metrics
      .filter((m) => !m.zoneId || m.zoneId === zoneId)
      .map((m) => [
        m.key,
        selective &&
        m.status === "normal" &&
        (!m.quality || m.quality === "good")
          ? null
          : m.value,
        m.status,
        m.quality,
        observationProblem([m]),
      ]),
    devices: snapshot.actuators
      .filter((d) => !d.zoneId || d.zoneId === zoneId)
      .map((d) => [
        d.key,
        d.desiredValue,
        d.reportedValue,
        d.effectiveValue,
        d.mode,
        d.health,
      ]),
    alerts: snapshot.alerts
      .filter((a) => !a.zoneId || a.zoneId === zoneId)
      .map((a) => [a.occurrenceId, a.status, a.severity]),
    allowed: snapshot.operationalControlAllowed,
    origin: snapshot.dataOrigin,
  });
}
export function deviceRevision(
  device: Actuator | undefined | null,
  snapshot: DashboardSnapshot,
) {
  // Match the percentage precision shown in the confirmation. Server approval
  // still checks current permissions, direction, scope and incident identity.
  const displayedValue = (value: unknown) =>
    device?.capability?.valueType === "percentage" && typeof value === "number"
      ? Math.round(value)
      : value;
  return JSON.stringify([
    device?.key,
    device?.zoneId,
    device?.capability,
    displayedValue(device?.reportedValue),
    displayedValue(device?.desiredValue),
    device?.mode,
    device?.health,
    snapshot.operationalControlAllowed,
    snapshot.alerts
      .filter((a) => a.status !== "resolved" && (!device?.zoneId || !a.zoneId || a.zoneId === device.zoneId))
      .map((a) => a.occurrenceId),
  ]);
}
export function manualDraft(
  d: Actuator,
  value: boolean | number,
): ControlDraft {
  if (!d.target || !d.capability || !d.zoneId || !d.controllable)
    throw new Error(L("장치의 적용 범위를 먼저 확인하세요.", "Check the device's scope first."));
  return {
    id: crypto.randomUUID(),
    origin: "manual",
    action: d.capability.action,
    target: d.target,
    zoneId: d.zoneId,
    value,
    rationale: "운영자가 선택한 설비 조절",
    evidenceIds: [],
    advisorMessageId: null,
    advisorRunId: null,
    alertId: null,
    alertOccurrenceId: null,
    beforeState: d.reportedValue ?? d.state,
  };
}
export function selectionKey(s: FarmSelection | null) {
  return s ? `${s.bedId}:${s.tier}` : "farm";
}
export function plannedHarvests(cycles: CropCycle[]) {
  return cycles
    .filter((c) => c.status === "growing" && c.planned_harvest_from)
    .sort((a, b) =>
      a.planned_harvest_from!.localeCompare(b.planned_harvest_from!),
    );
}

// The API reserves origin for advisor provenance. Direct controls omit it.
export function controlProvenance(draft: ControlDraft) {
  return draft.advisorRunId
    ? {
        origin:
          draft.origin === "manual"
            ? ("manual" as const)
            : ("verified_telemetry_rule" as const),
        advisorRunId: draft.advisorRunId,
        evidenceIds: draft.evidenceIds,
        alertId: draft.alertId,
        alertOccurrenceId: draft.alertOccurrenceId,
      }
    : {};
}

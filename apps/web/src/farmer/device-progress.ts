import type { Actuator } from "../types.ts";
import { L } from "./i18n.ts";

/**
 * A device's request against what it actually does. Right after a change the
 * device takes a few seconds to report the new state ("settling"); a gap that
 * lasts past that, or a large one on a percentage, is a difference the farmer
 * should see ("differs", the brief's 20-point rule). A faulty or silent device
 * is shown as such elsewhere, not as a difference.
 */
export type DeviceProgress = { state: "settling" | "differs"; want: string; got: string };
export const SETTLE_MS = 30_000;

type Report = Pick<Actuator, "desiredValue" | "effectiveValue" | "reportedValue" | "health">;

const shown = (v: number | boolean) => (typeof v === "boolean" ? (v ? L("켜짐", "on") : L("꺼짐", "off")) : `${Math.round(v)}%`);

/** Whether the device is not (yet) doing what it was asked. */
export function deviceGap(d: Report): boolean {
  const want = d.desiredValue, got = d.effectiveValue ?? d.reportedValue;
  if (want === null || want === undefined || got === null || got === undefined) return false;
  if (typeof want === "boolean" || typeof got === "boolean") return want !== got;
  return Math.abs(want - got) >= 1;
}

/** `since`: when this gap was first seen; the device is still carrying out the request within SETTLE_MS of it. */
export function deviceProgress(d: Report, since: number, now: number): DeviceProgress | null {
  if (d.health === "fault" || d.health === "offline" || !deviceGap(d)) return null;
  const want = d.desiredValue as number | boolean, got = (d.effectiveValue ?? d.reportedValue) as number | boolean;
  if (now - since < SETTLE_MS) return { state: "settling", want: shown(want), got: shown(got) };
  const large = typeof want === "boolean" || typeof got === "boolean" || Math.abs(Number(want) - Number(got)) >= 20;
  return large ? { state: "differs", want: shown(want), got: shown(got) } : null;
}

/** One line for the device: what was asked and what it does now. */
export function progressText(p: DeviceProgress): string {
  return p.state === "settling"
    ? L(`요청 ${p.want}, 장치 반영 중`, `Requested ${p.want}, the device is applying it`)
    : L(`요청 ${p.want}, 실제 ${p.got}`, `Requested ${p.want}, actual ${p.got}`);
}

/**
 * Tracks when each gap was first seen, so a gap that lasts turns from
 * "settling" into "differs". Call with each new report; gaps that close are forgotten.
 */
export function trackProgress(actuators: Pick<Actuator, "key" | "desiredValue" | "effectiveValue" | "reportedValue" | "health">[], seen: Map<string, number>, now: number): Record<string, DeviceProgress> {
  const out: Record<string, DeviceProgress> = {};
  const open = new Set<string>();
  for (const d of actuators) {
    if (!deviceGap(d)) continue;
    open.add(d.key);
    if (!seen.has(d.key)) seen.set(d.key, now);
    const p = deviceProgress(d, seen.get(d.key)!, now);
    if (p) out[d.key] = p;
  }
  for (const key of [...seen.keys()]) if (!open.has(key)) seen.delete(key);
  return out;
}

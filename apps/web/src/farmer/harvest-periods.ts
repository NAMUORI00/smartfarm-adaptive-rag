import { getLang, L, term } from "./i18n.ts";

/** A period a growing guide states in months, dated from this cycle's planting (either end may be open). */
export type HarvestPeriod = { label: string | null; months_min: number | null; months_max: number | null; from: string | null; to: string | null };

const day = (iso: string) => iso.replaceAll("-", ".");

/** Today in the farm's time zone, as YYYY-MM-DD. */
export const seoulToday = (now = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));

/**
 * "정식 후 18~24개월 → 2026.09.15 ~ 2027.03.15"; a period open at one end reads
 * "까지" or "부터". The cultivation it belongs to leads the line when the
 * sentence names one ("물재배: …"), in English only when that name translates.
 */
export function periodText(p: HarvestPeriod): string {
  const tag = p.label ? term(p.label) : null;
  const lead = tag && (getLang() === "ko" || !/[가-힣]/.test(tag)) ? `${tag}: ` : "";
  if (p.months_min !== null && p.months_max !== null && p.from && p.to) {
    return lead + L(`정식 후 ${p.months_min}~${p.months_max}개월 → ${day(p.from)} ~ ${day(p.to)}`, `${p.months_min}–${p.months_max} months after planting → ${day(p.from)} to ${day(p.to)}`);
  }
  if (p.months_max !== null && p.to) {
    return lead + L(`정식 후 ${p.months_max}개월 이내 → ${day(p.to)}까지`, `Up to ${p.months_max} months after planting → by ${day(p.to)}`);
  }
  if (p.months_min !== null && p.from) {
    return lead + L(`정식 후 ${p.months_min}개월 이후 → ${day(p.from)}부터`, `${p.months_min} months or more after planting → from ${day(p.from)}`);
  }
  return "";
}

/** Where today falls against a period (dates compared as YYYY-MM-DD). */
export function periodState(p: HarvestPeriod, today: string): "before" | "now" | "past" {
  if (p.from && today < p.from) return "before";
  if (p.to && today > p.to) return "past";
  return "now";
}

export const periodStateText = (state: "before" | "now" | "past") =>
  ({ before: L("기간 전", "Not yet"), now: L("지금 기간", "Now"), past: L("지남", "Passed") })[state];

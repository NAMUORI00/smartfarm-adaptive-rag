import type { CropCycle } from "../farm-spatial.ts";
import { L } from "./i18n.ts";

export type GrowthBasis = "observation" | "schedule" | "reference";
export type GrowthDisplay = {
  /** 0 = just planted, 1 = full size. */
  fraction: number;
  basis: GrowthBasis;
  /** Days since planting (farm time). */
  days: number;
  /** The guides' period used for "reference". */
  months?: number;
  /** The observation used for "observation". */
  percent?: number;
  observedAt?: string;
};

const DAY = 86_400_000;
const MONTH = 30.44 * DAY;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const farmDate = (day: string | null | undefined) => (day ? Date.parse(`${day}T00:00:00+09:00`) : Number.NaN);
// Leaves fill out early in the season and the crop spends the rest of it
// maturing, so the size follows an ease-out curve of the season's share.
const season = (share: number) => 1 - (1 - clamp(share)) ** 2;

/**
 * How big the plants on a tier are drawn, and on what basis. A recorded growth
 * observation wins. Without one, the days since planting set the size against
 * the registered harvest date, or else against the shortest period the growing
 * guides give for this crop. That is a picture of where the crop is in its
 * season, named as such on screen, not a measured size. With none of these the
 * answer is null and the model keeps its own shape.
 */
export function growthDisplay(cycle: CropCycle | null | undefined, now = Date.now(), referenceMonths?: number | null): GrowthDisplay | null {
  if (!cycle || cycle.remaining_count <= 0) return null;
  const start = farmDate(cycle.planted_on);
  const days = Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / DAY)) : 0;
  const seen = cycle.latest_observation;
  if (seen) {
    return { fraction: clamp(seen.growth_percent / 100), basis: "observation", days, percent: seen.growth_percent, observedAt: seen.observed_at };
  }
  if (!Number.isFinite(start)) return null;
  const due = farmDate(cycle.planned_harvest_from);
  if (Number.isFinite(due) && due > start) return { fraction: season((now - start) / (due - start)), basis: "schedule", days };
  if (referenceMonths && referenceMonths > 0) return { fraction: season((now - start) / (referenceMonths * MONTH)), basis: "reference", days, months: referenceMonths };
  return null;
}

/** The scale applied to the model's plants: a seedling is small but still visible. */
export const plantScale = (g: GrowthDisplay | null) => (g ? 0.25 + 0.75 * g.fraction : 1);

/** The shortest period the growing guides give for a crop, from the harvest-guide passages. */
export function guideMonths(passages: { periods?: { months_min: number | null }[] }[]): number | null {
  const months = passages.flatMap((p) => p.periods ?? []).map((w) => w.months_min).filter((m): m is number => typeof m === "number" && m > 0);
  return months.length ? Math.min(...months) : null;
}

/** One line under the 3D bed: what the plant size there is based on. */
export function growthText(g: GrowthDisplay | null): string {
  if (!g) return L("크기 기준 없음, 모형 기본 크기", "No size basis, model's own size");
  const day = L(`정식 ${g.days}일째`, `Day ${g.days} since planting`);
  if (g.basis === "observation") {
    const at = g.observedAt ? g.observedAt.slice(5, 10).replace("-", ".") : "";
    return L(`생육 관찰 ${Math.round(g.percent ?? g.fraction * 100)}%${at ? ` (${at})` : ""} 크기`, `Size from the ${Math.round(g.percent ?? g.fraction * 100)}% growth record${at ? ` (${at})` : ""}`);
  }
  if (g.basis === "schedule") return L(`${day}, 수확 예정일 기준 크기`, `${day}, size drawn against the harvest date`);
  return L(`${day}, 재배 자료 ${g.months}개월 기준 크기`, `${day}, size drawn against the guides' ${g.months} months`);
}

import type { CropCycle } from "../farm-spatial";
import { daysUntil } from "./suggestions";
import { L, term } from "./i18n";

/**
 * Planting to harvest as one bar: where today sits, and the registered harvest
 * window. Built only from registered dates; no yield or growth estimate.
 */
export function HarvestTimeline({ cycle, now = Date.now() }: { cycle: CropCycle; now?: number }) {
  const start = Date.parse(`${cycle.planted_on}T00:00:00+09:00`);
  const from = cycle.planned_harvest_from ? Date.parse(`${cycle.planned_harvest_from}T00:00:00+09:00`) : null;
  const to = cycle.planned_harvest_to ? Date.parse(`${cycle.planned_harvest_to}T00:00:00+09:00`) : from;
  const days = daysUntil(cycle.planned_harvest_from, now);
  const dayWord = (n: number) => (n === 1 ? "1 day" : `${n} days`);
  const headline = days === null ? L("수확 예정일 미등록", "No harvest date registered") : days < 0 ? L(`수확 예정일이 ${-days}일 지났습니다`, `Harvest date passed ${dayWord(-days)} ago`) : days === 0 ? L("오늘 수확 예정", "Harvest due today") : L(`수확까지 ${days}일`, `${dayWord(days)} to harvest`);
  if (!Number.isFinite(start) || from === null || to === null || !Number.isFinite(from)) {
    return (
      <section className="fm-harvest">
        <h3>{headline}</h3>
        <p className="fm-note">{L(`정식 ${cycle.planted_on}, 남은 개체 ${cycle.remaining_count}주`, `Planted ${cycle.planted_on}, ${cycle.remaining_count} ${cycle.remaining_count === 1 ? "plant" : "plants"} left`)}</p>
      </section>
    );
  }
  const end = Math.max(to, now) + 86400000 * 3;
  const pct = (t: number) => Math.max(0, Math.min(100, ((t - start) / Math.max(end - start, 1)) * 100));
  const grown = Math.floor((now - start) / 86400000);
  return (
    <section className={`fm-harvest ${days !== null && days <= 7 ? "is-soon" : ""}`}>
      <h3>{headline}</h3>
      <div className="fm-harvest-bar" role="img" aria-label={L(`정식 ${cycle.planted_on}, 수확 예정 ${cycle.planned_harvest_from}${cycle.planned_harvest_to ? `~${cycle.planned_harvest_to}` : ""}, 오늘은 정식 ${grown}일째`, `Planted ${cycle.planted_on}, harvest due ${cycle.planned_harvest_from}${cycle.planned_harvest_to ? ` to ${cycle.planned_harvest_to}` : ""}, today is day ${grown} since planting`)}>
        <span className="fm-harvest-grown" style={{ width: `${pct(now)}%` }} />
        <span className="fm-harvest-window" style={{ left: `${pct(from)}%`, width: `${Math.max(pct(to) - pct(from), 1.5)}%` }} />
        <span className="fm-harvest-today" style={{ left: `${pct(now)}%` }} />
      </div>
      <div className="fm-harvest-legend">
        <span>{L("정식", "Planted")} {cycle.planted_on.slice(5).replace("-", "/")}</span>
        <span>{L(`오늘, ${grown}일째`, `Today, day ${grown}`)}</span>
        <span>{L("수확", "Harvest")} {cycle.planned_harvest_from!.slice(5).replace("-", "/")}{cycle.planned_harvest_to ? `–${cycle.planned_harvest_to.slice(5).replace("-", "/")}` : ""}</span>
      </div>
      <p className="fm-note">{term(cycle.crop)}, {term(cycle.harvest_part)}, {L(`남은 개체 ${cycle.remaining_count}주`, `${cycle.remaining_count} ${cycle.remaining_count === 1 ? "plant" : "plants"} left`)}</p>
    </section>
  );
}

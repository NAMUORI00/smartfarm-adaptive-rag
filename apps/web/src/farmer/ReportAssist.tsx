import { useEffect, useMemo, useState } from "react";
import { getOperationMetrics } from "../api";
import type { CropCycle, FarmLayout } from "../farm-spatial";
import type { Approval, FarmId, OperationCase, OperationMetrics } from "../types";
import type { BriefItem } from "./ai-brief";
import { handoverGroups, handoverLines, weekSummary } from "./report-lines";
import type { HandoverLine } from "./report-lines";
import type { SinceItem } from "./since-summary";
import { FarmIcon } from "./FarmIcon";
import { L, term } from "./i18n";
import { RefNote } from "./RefNote";
import { shortStamp, stamp } from "./time-format";

/**
 * The shift handover: what is still open, then what happened, each in its own
 * group with the time it happened. "인계 완료" keeps this list as the last
 * handover on this device; next time, only lines that were not in it are marked
 * new. Regenerated from the records each time, so nothing here is typed by hand.
 */
export function HandoverNote({ farmId, since, items, open, sinceLabel, hours, onHours }: {
  farmId: FarmId;
  since: SinceItem[];
  items: BriefItem[];
  open: BriefItem[];
  sinceLabel: string;
  hours: 12 | 24;
  onHours: (hours: 12 | 24) => void;
}) {
  const key = `farmer.handoverMemo.${farmId}`;
  const lines = useMemo(() => handoverLines(since, open.length ? open : items), [since, open, items]);
  const [previous, setPrevious] = useState<{ at: string; lines: string[] } | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null");
      return saved && typeof saved.at === "string" && Array.isArray(saved.lines) ? saved : null;
    } catch { return null; }
  });
  const [copied, setCopied] = useState(false);
  const text = [L(`인수인계, ${stamp(new Date().toISOString())}`, `Handover, ${stamp(new Date().toISOString())}`), ...lines.map((l) => `- ${l.at ? `${shortStamp(l.at)} ` : ""}${l.text}`)].join("\n");
  const isNew = (l: HandoverLine) => !!previous && !previous.lines.includes(l.text);
  function handOver() {
    const memo = { at: new Date().toISOString(), lines: lines.map((l) => l.text) };
    try { localStorage.setItem(key, JSON.stringify(memo)); } catch { /* storage unavailable */ }
    setPrevious(memo);
  }
  return (
    <section className="fm-handover" aria-label={L("교대 인수인계", "Shift handover")}>
      <h2 className="fm-print-only">{L(`교대 인수인계, ${stamp(new Date().toISOString())}`, `Shift handover, ${stamp(new Date().toISOString())}`)}</h2>
      <div className="fm-handover-top">
        <div className="fm-segment" role="group" aria-label={L("넘길 기간", "Period")}>
          {([12, 24] as const).map((h) => <button type="button" key={h} aria-pressed={hours === h} onClick={() => onHours(h)}>{L(`최근 ${h}시간`, `Last ${h} h`)}</button>)}
        </div>
        <small>{sinceLabel}{previous ? L(`, 지난 인계 ${shortStamp(previous.at)}`, `, last handover ${shortStamp(previous.at)}`) : ""}</small>
      </div>
      {lines.length === 0 ? (
        <p className="fm-brief-calm">{L("넘길 일이 없습니다.", "Nothing to hand over.")}</p>
      ) : handoverGroups(lines).map((g) => (
        <section key={g.kind} className={`fm-handover-group is-${g.kind}`} aria-label={g.label}>
          <h3>{g.label}<b>{g.lines.length}</b></h3>
          <ul className="fm-handover-list">
            {g.lines.map((l) => (
              <li key={l.text} className={isNew(l) ? "is-new" : ""}>
                {l.at ? <time dateTime={l.at}>{shortStamp(l.at)}</time> : <span className="fm-handover-now">{L("지금", "Now")}</span>}
                <span>{l.text}</span>
                {isNew(l) && <em className="fm-badge is-info">{L("새로", "New")}</em>}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div className="fm-brief-actions">
        <button type="button" className="fm-primary" disabled={!lines.length} onClick={handOver} title={L("지금 목록을 이 기기의 마지막 인계로 남깁니다.", "Keeps this list as the last handover on this device.")}>{L("인계 완료", "Handed over")}</button>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); }); }}>
          <FarmIcon name="copy" />{copied ? L("복사함", "Copied") : L("복사", "Copy")}
        </button>
        <button type="button" onClick={() => window.print()}><FarmIcon name="print" />{L("인쇄", "Print")}</button>
      </div>
      <small className="fm-hint">{L("'인계 완료'를 누르면 지금 목록이 기준이 되어, 다음 인계 때 새로 생긴 줄에만 '새로'가 붙습니다.", "After 'Handed over', the next handover marks only the lines that are new since.")}</small>
    </section>
  );
}

/** A week on one page: recorded counts only, printable. */
export function WeeklyReport({ farmId, layout, cycles, cases, approvals, onBack }: { farmId: FarmId; layout: FarmLayout | null; cycles: CropCycle[]; cases: OperationCase[]; approvals: Approval[]; onBack: () => void }) {
  const [metrics, setMetrics] = useState<OperationMetrics | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    void getOperationMetrics(farmId, 168).then((r) => { setMetrics(r.data); setState(r.data ? "ready" : "error"); }).catch(() => setState("error"));
  }, [farmId]);
  const week = weekSummary({ cycles, cases, approvals, beds: layout?.beds ?? [] });
  // Minutes read as minutes up to two hours, as hours up to two days, then as days.
  const minutes = (v: number | null) =>
    v === null ? L("기록 없음", "No record")
    : v < 120 ? L(`${Math.round(v)}분`, `${Math.round(v)} min`)
    : v < 2880 ? L(`약 ${Math.round(v / 60)}시간`, `about ${Math.round(v / 60)} h`)
    : L(`약 ${(v / 1440).toFixed(1)}일`, `about ${(v / 1440).toFixed(1)} days`);
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const farmName = layout?.farm?.name ?? "";
  return (
    <section className="fm-report" aria-labelledby="fm-report-title">
      <header className="fm-report-head">
        <button type="button" className="fm-back" onClick={onBack}><FarmIcon name="back" />{L("설정으로", "Back to settings")}</button>
        <h2 id="fm-report-title">{L("주간 보고서", "Weekly report")}</h2>
        <small>{L(`${week.from} ~ ${week.to}${farmName ? `, ${farmName}` : ""}`, `${week.from} to ${week.to}${farmName ? `, ${term(farmName)}` : ""}`)}</small>
        <button type="button" onClick={() => window.print()}><FarmIcon name="print" />{L("인쇄·PDF", "Print / PDF")}</button>
      </header>
      <div className="fm-report-grid">
        <article><small>{L("수확", "Harvest")}</small><strong>{L(`${week.harvestKg.toFixed(2)}kg`, `${week.harvestKg.toFixed(2)} kg`)}</strong><span>{L(`${week.harvestCount}회, ${week.harvestBeds}개 베드`, `${count(week.harvestCount, "time", "times")}, ${count(week.harvestBeds, "bed", "beds")}`)}</span></article>
        <article><small>{L("경보 사건", "Alert cases")}</small><strong>{week.cases}</strong><span>{L(`해결 ${week.resolved}, 진행 ${week.cases - week.resolved}`, `${week.resolved} resolved, ${week.cases - week.resolved} open`)}</span></article>
        <article><small>{L("허용한 설비 변경", "Allowed changes")}</small><strong>{week.controls}</strong><span>{L(`장치 응답 ${week.applied}`, `${week.applied} replied`)}</span></article>
        <article><small>{L("회복까지 걸린 시간 (중앙값)", "Time to recover (median)")}</small><strong>{state === "ready" && metrics ? minutes(metrics.recoveryMedianMinutes) : "—"}</strong><span>{state === "ready" && metrics ? L(`확인까지 ${minutes(metrics.acknowledgeMedianMinutes)}, 허용까지 ${minutes(metrics.approvalMedianMinutes)}`, `${metrics.acknowledgeMedianMinutes === null ? "No acknowledgement recorded" : `Acknowledged in ${minutes(metrics.acknowledgeMedianMinutes)}`}, ${metrics.approvalMedianMinutes === null ? "no approval recorded" : `allowed in ${minutes(metrics.approvalMedianMinutes)}`}`) : state === "loading" ? L("집계 중…", "Counting…") : L("집계를 불러오지 못했습니다", "Could not load the counts")}</span></article>
      </div>
      {week.byBed.length > 0 && (
        <table className="fm-report-table">
          <caption>{L("베드별 수확", "Harvest by bed")}</caption>
          <thead><tr><th>{L("베드", "Bed")}</th><th>{L("횟수", "Times")}</th><th>{L("무게", "Weight")}</th></tr></thead>
          <tbody>{week.byBed.map((b) => <tr key={b.label}><td>{b.label}</td><td>{b.count}</td><td>{b.kg.toFixed(2)}kg</td></tr>)}</tbody>
        </table>
      )}
      <RefNote kind="report" />
    </section>
  );
}

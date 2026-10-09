import { useState } from "react";
import { actuatorForControl } from "../operator-ui";
import { stamp as formatSensorUpdateTime } from "./time-format";
import type { AuditEvent } from "../types";
import { FarmIcon } from "./FarmIcon";
import { HistoryBrowser } from "./HistoryBrowser";
import { pendingControls } from "./pending-controls";
import type { FarmRuntime } from "./useFarmRuntime";
import { L, place, term } from "./i18n";

function recordTitle(event: AuditEvent): string {
  const kind = event.eventType;
  if (kind.includes("correct")) return L("입력 정정 기록", "Input correction record");
  if (kind.includes("harvest")) return L("수확 기록", "Harvest record");
  if (kind.includes("discard") || kind.includes("closure")) return L("재배 종료 기록", "Cycle end record");
  if ((kind.includes("observation") || kind.includes("observed"))) return L("생육 관측 기록", "Growth check record");
  if (kind.includes("cultivation")) return L("재배 기록", "Cultivation record");
  if (kind.includes("control") || kind.includes("approval")) return L("설비 조절 기록", "Equipment control record");
  if (kind.includes("advisor")) return L("농업 자문 기록", "Farming advice record");
  return L("농장 운영 기록", "Farm operations record");
}

/** Unconfirmed changes are shown by the workspace itself, so `showPending` is
 * off wherever the panel already carries that prompt. */
export function RecentWork({ runtime: r, onRecords, onResume, showPending = true }: {
  runtime: FarmRuntime;
  onRecords?: () => void;
  onResume: (pending: ReturnType<typeof pendingControls>[number]) => void;
  showPending?: boolean;
}) {
  const [historyOpened, setHistoryOpened] = useState(false);
  const seen = new Set<string>();
  const latest = [...r.audit].sort((a, b) =>
    (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
  ).filter(event => {
    const key = typeof event.details.proposal_id === "string" ? `control:${event.details.proposal_id}` : event.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
  const pending = pendingControls(r.farmId);

  return <section className="fm-recent" aria-label={L("최근 작업 기록", "Recent work records")}>
    {showPending && pending.length > 0 && <section className="fm-pending-work" aria-label={L("변경 결과 확인 필요", "Change results to check")}>
      <strong><FarmIcon name="warning" />{L(`변경 결과 확인 필요 ${pending.length}건`, `${pending.length} ${pending.length === 1 ? "change result" : "change results"} to check`)}</strong>
      {pending.map(p => <button key={p.requestId} onClick={() => onResume(p)}>
        {term(actuatorForControl(r.snapshot?.actuators ?? [], p.draft.target, p.draft.zoneId)?.label) || L("설비", "Equipment")}, {place(r.layout?.zones.find(z => z.id === p.draft.zoneId)?.label) || L("적용 구역 확인 필요", "Check target zone")} {L("결과 확인", "Check result")}
      </button>)}
    </section>}
    <h3>{L("최근 저장 기록", "Recently saved records")}</h3>
    <div className="fm-recent-rows">
      {latest.map(event => <article key={event.id}>
        <strong>{recordTitle(event)}</strong>
        <time dateTime={event.createdAt}>{formatSensorUpdateTime(event.createdAt)}</time>
      </article>)}
      {!latest.length && <p>{r.connected ? L("아직 표시할 작업 기록이 없습니다.", "No work records to show yet.") : L("기록 연결을 확인하고 있습니다. 아직 받은 기록이 없습니다.", "Checking the records connection. No records received yet.")}</p>}
    </div>
    <details onToggle={event => { if (event.currentTarget.open) setHistoryOpened(true); }}>
      <summary>{L("기록 찾아보기", "Browse records")}</summary>
      {historyOpened && <HistoryBrowser key={r.farmId} farmId={r.farmId} layout={r.layout} />}
      {onRecords && <button onClick={onRecords}>{L("작업 결과", "Work results")}</button>}
    </details>
  </section>;
}

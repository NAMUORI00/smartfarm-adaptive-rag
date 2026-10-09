import type { ControlDraft } from "../types";
import { advisoryLines, farmWords } from "./ai-brief";
import type { ReaderTarget } from "./DocReader";
import { FarmIcon } from "./FarmIcon";
import type { BriefItem, BriefSource } from "./ai-brief";
import type { AdviceState } from "./useAlertAdvice";
import { L } from "./i18n";
import { shortStamp } from "./time-format";
import { RefNote } from "./RefNote";
import type { WorkStop } from "./report-lines";

/** The one mark for everything the AI did: a square "AI" tag, never a sparkle. */
export function AiMark({ title }: { title?: string }) {
  return <span className="fm-ai" title={title} aria-label={title ?? "AI"}>AI</span>;
}

const sourceName = (s: BriefSource, example?: boolean) => ({
  sensor: L("센서 교차 확인", "Sensors cross-checked"),
  device: L("설비 보고", "Equipment report"),
  camera: example ? L("카메라 판독 (예시)", "Camera reading (example)") : L("카메라 판독", "Camera reading"),
  records: L("재배 기록", "Crop records"),
  advice: L("답변 재확인", "Answer rechecked"),
  guides: L("재배 자료 조건", "Guide conditions"),
  weather: L("기상 예보", "Weather forecast"),
}[s]);

export type BriefProps = {
  items: BriefItem[];
  advice: Record<string, AdviceState>;
  active: string | null;
  /** "센서 20 · 설비 16 · 카메라 4" and the time of the last reading. */
  watched: string;
  onHover: (id: string | null) => void;
  onGo: (item: BriefItem) => void;
  onAsk: (item: BriefItem) => void;
  onDraft: (draft: ControlDraft) => void;
  /** The layout's zone name, to show server wording ("1구역") as the screen does. */
  zoneLabel?: (id: string) => string;
  /** Mark an alert as seen (server record). */
  onAck?: (item: BriefItem) => void;
  /** Put an item away for today (this device). */
  onHide?: (item: BriefItem) => void;
  /** Ask the AI alert analysis again after values moved. */
  onRefresh?: (alertId: string) => void;
  /** Alert ids being acknowledged right now. */
  acking?: string[];
  phone?: boolean;
  /** Inside a detail panel: a heading of its own, no reading summary, no overflow list. */
  compact?: boolean;
  title?: string;
  /** The column around it already names the view and the reading time. */
  headless?: boolean;
  /** Opens the guide passages the AI alert analysis used, in the evidence reader. */
  onOpenSources?: (target: ReaderTarget) => void;
};

/**
 * What to look at first, decided by the AI from everything the farm reported.
 * Numbers match the pins on the plan. Each card says what, why and what to do;
 * when the AI alert analysis is back, its first check is shown with the mark,
 * and its adjustment proposal opens the usual review-and-allow flow.
 */
export function AiBrief({ items, advice, active, watched, onHover, onGo, onAsk, onDraft, zoneLabel = (id) => id, onAck, onHide, onRefresh, acking = [], phone = false, compact = false, title, headless = false, onOpenSources }: BriefProps) {
  // A phone shows two cards before the plan list; the rest fold.
  const shown = phone ? 2 : 3;
  const top = items.slice(0, shown);
  const rest = compact ? [] : items.slice(shown);
  const headingId = compact ? "fm-brief-panel-title" : "fm-brief-title";
  return (
    <section className={`fm-brief ${phone ? "is-phone" : ""} ${compact ? "is-compact" : ""}`} aria-labelledby={headless ? undefined : headingId} aria-label={headless ? title ?? L("먼저 볼 곳", "Look here first") : undefined}>
      {!headless && (
        <header className="fm-brief-head">
          <AiMark title={L("AI가 고른 우선순위", "Ranked by the AI")} />
          <h2 id={headingId}>{title ?? L("먼저 볼 곳", "Look here first")}</h2>
          {watched && <small>{watched}</small>}
        </header>
      )}
      {top.length === 0 ? (
        <p className="fm-brief-calm">{L("지금은 먼저 볼 곳이 없습니다. 모든 관측값이 기준 안에 있습니다.", "Nothing needs a look right now. All readings are in range.")}</p>
      ) : (
        <ol className="fm-brief-list">
          {top.map((item, i) => (
            <BriefCard key={item.id} rank={i + 1} item={item} state={item.alertId ? advice[item.alertId] : undefined} active={active === item.id} onHover={onHover} onGo={onGo} onAsk={onAsk} onDraft={onDraft} zoneLabel={zoneLabel} onAck={onAck} onHide={onHide} onRefresh={onRefresh} acking={!!item.alertId && acking.includes(item.alertId)} onOpenSources={onOpenSources} />
          ))}
        </ol>
      )}
      {rest.length > 0 && (
        <details className="fm-brief-more">
          <summary>{L(`다른 항목 ${rest.length}건`, `${rest.length} more`)}</summary>
          <ul>
            {rest.map((item) => (
              <li key={item.id}>
                <button type="button" className={`is-${item.tone}`} onClick={() => onGo(item)}>
                  <strong>{item.what}</strong>
                  <span>{item.todo}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function BriefCard({ rank, item, state, active, onHover, onGo, onAsk, onDraft, zoneLabel, onAck, onHide, onRefresh, acking, onOpenSources }: {
  rank: number; item: BriefItem; state?: AdviceState; active: boolean; zoneLabel: (id: string) => string;
  onAck?: BriefProps["onAck"]; onHide?: BriefProps["onHide"]; onRefresh?: BriefProps["onRefresh"]; acking: boolean;
  onHover: BriefProps["onHover"]; onGo: BriefProps["onGo"]; onAsk: BriefProps["onAsk"]; onDraft: BriefProps["onDraft"];
  onOpenSources?: BriefProps["onOpenSources"];
}) {
  const ready = state?.status === "ready" ? state.advisory : null;
  const lines = ready ? advisoryLines(farmWords(ready.warning, zoneLabel)) : null;
  const draft = ready?.controlDrafts[0] ?? null;
  const byModel = !!ready?.remoteLlmUsed;
  const guideEvidence = ready ? ready.evidence.filter((e) => e.sourceKind !== "private_simulation" && e.documentId) : [];
  const guides = guideEvidence.length;
  // One main action and one more; the rest (asking, marking seen, hiding) waits behind "⋯", so every card keeps one row.
  const second: { label: string; title: string; run: () => void } | null = draft
    ? { label: L("AI 조정안 확인", "Review AI proposal"), title: L(farmWords(draft.rationale, zoneLabel), "Prepared by the AI alert analysis. Review it before allowing."), run: () => onDraft(draft) }
    : item.ask && item.go !== "ask"
      ? { label: L("AI에게 묻기", "Ask the AI"), title: L(item.ask, "Searches the growing guides for this"), run: () => onAsk(item) }
      : null;
  const more: { label: string; title?: string; run: () => void; disabled?: boolean }[] = [
    ...(draft && item.ask && item.go !== "ask" ? [{ label: L("AI에게 묻기", "Ask the AI"), title: L(item.ask, "Searches the growing guides for this"), run: () => onAsk(item) }] : []),
    ...(onAck && item.alertId && !item.acknowledgedAt ? [{ label: acking ? L("기록 중…", "Saving…") : L("확인함", "Mark as seen"), title: L("이 경보를 봤다고 기록합니다. 경보는 값이 회복되면 닫힙니다.", "Records that you saw this alert. It closes when values recover."), run: () => onAck(item), disabled: acking }] : []),
    ...(onHide && !item.alertId ? [{ label: L("오늘 숨기기", "Hide today"), title: L("오늘 이 기기에서만 목록에서 뺍니다.", "Removes it from the list on this device for today."), run: () => onHide(item) }] : []),
  ];
  return (
    <li
      className={`fm-brief-item is-${item.tone} ${active ? "is-active" : ""}`}
      onMouseEnter={() => onHover(item.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(item.id)}
      onBlur={() => onHover(null)}
    >
      <span className="fm-brief-rank" aria-hidden="true">{rank}</span>
      <div className="fm-brief-body">
        <p className="fm-brief-what">
          <strong>{item.what}</strong>
          {item.example && <em className="fm-badge is-info">{L("예시", "Example")}</em>}
          {item.acknowledgedAt && <em className="fm-badge is-off">{L(`확인함 ${shortStamp(item.acknowledgedAt)}`, `Seen ${shortStamp(item.acknowledgedAt)}`)}</em>}
        </p>
        <p className="fm-brief-why" title={item.why}>{item.why}</p>
        {state?.status === "loading" && <p className="fm-brief-ai is-loading"><AiMark />{L("AI가 경보를 분석하는 중…", "The AI is analysing this alert…")}</p>}
        {lines?.check && (
          <p className="fm-brief-ai" title={[lines.check, lines.adjust].filter(Boolean).join(" ")}>
            <AiMark title={byModel ? L("AI 경보 분석 (재배 자료 근거)", "AI alert analysis (from growing guides)") : L("자동 경보 분석", "Automatic alert analysis")} />
            <span className="fm-brief-ai-text"><span lang={/[가-힣]/.test(lines.check) ? "ko" : undefined}>{lines.check}</span>{ready?.generatedAt && <small className="fm-brief-ai-at">{L(`${shortStamp(ready.generatedAt)} 분석`, /[가-힣]/.test(lines.check) ? `Analysed ${shortStamp(ready.generatedAt)}, written in Korean` : `Analysed ${shortStamp(ready.generatedAt)}`)}{onRefresh && item.alertId && <button type="button" className="fm-brief-refresh" onClick={() => onRefresh(item.alertId!)}>{L("다시 분석", "Analyse again")}</button>}</small>}</span>
          </p>
        )}
        <p className="fm-brief-tags">
          <span className="fm-brief-tags-label">{L("근거", "Based on")}</span>
          {item.sources.map((s) => <span key={s}>{sourceName(s, item.example)}</span>)}
          {guides > 0 && (onOpenSources
            ? (
              <button type="button" className="fm-brief-guides" onClick={() => onOpenSources({ passages: guideEvidence.map((e) => ({ documentId: e.documentId!, chunkId: e.id, text: e.excerpt, kind: "read" as const })) })} title={L("AI 경보 분석이 읽은 재배 자료를 원문에서 봅니다", "Read the guide passages the AI alert analysis used")}>
                <FarmIcon name="file" />{L(`재배 자료 ${guides}건`, `${guides} guide ${guides === 1 ? "passage" : "passages"}`)}
              </button>
            )
            : <span>{L(`재배 자료 ${guides}건`, `${guides} guide ${guides === 1 ? "passage" : "passages"}`)}</span>)}
        </p>
        <div className="fm-brief-actions">
          <button type="button" className="fm-primary" onClick={() => onGo(item)}>{item.todo}</button>
          {second && <button type="button" onClick={second.run} title={second.title}>{second.label}</button>}
          {more.length > 0 && (
            <details className="fm-more">
              <summary aria-label={L("다른 할 일", "More actions")} title={L("다른 할 일", "More actions")}><FarmIcon name="more" /></summary>
              <div role="menu">
                {more.map((m) => (
                  <button type="button" role="menuitem" key={m.label} disabled={m.disabled} title={m.title} onClick={(e) => { (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open"); m.run(); }}>{m.label}</button>
                ))}
              </div>
            </details>
          )}
        </div>
        {item.ref && <RefNote kind={item.ref} compact />}
      </div>
    </li>
  );
}

/**
 * Today's work in walking order, numbered like the route drawn on the plan.
 * A tick only marks the list on this device; records are made by the task's
 * own button (a harvest record, an alert marked seen, a change allowed).
 */
export function WorkPlanList({ stops, done, onToggle, onGo, active, onHover, phone = false }: {
  stops: WorkStop[]; done: string[]; onToggle: (id: string) => void; onGo: (item: BriefItem) => void; active: string | null; onHover: (id: string | null) => void; phone?: boolean;
}) {
  if (!stops.length) return <p className="fm-brief-calm">{L("오늘 기록에 잡힌 작업이 없습니다.", "No work in today's records.")}</p>;
  // Stops keep their walking number; the finished ones move below the ones still to do.
  const numbered = stops.map((s, i) => ({ s, n: i + 1 }));
  const ordered = [...numbered.filter(({ s }) => !done.includes(s.id)), ...numbered.filter(({ s }) => done.includes(s.id))];
  const finished = stops.filter((s) => done.includes(s.id)).length;
  return (
    <>
      <p className="fm-work-progress">
        <strong>{L(`완료 ${finished}/${stops.length}`, `${finished} of ${stops.length} done`)}</strong>
        <span>{phone ? L("번호는 걷는 순서입니다.", "Numbers are the walking order.") : L("배치도의 번호와 점선이 걷는 순서입니다.", "Numbers and the dashed line on the plan are the walking order.")}</span>
      </p>
      <ol className="fm-work-list">
        {ordered.map(({ s, n }) => {
          const finishedStop = done.includes(s.id);
          return (
            <li key={s.id} className={`is-${s.item.tone} ${finishedStop ? "is-done" : ""} ${active === s.id ? "is-active" : ""}`} onMouseEnter={() => onHover(s.id)} onMouseLeave={() => onHover(null)}>
              <label className="fm-work-check"><input type="checkbox" checked={finishedStop} onChange={() => onToggle(s.id)} aria-label={L(`${n}번 작업 완료 표시: ${s.item.what}`, `Mark stop ${n} done: ${s.item.what}`)} /></label>
              <span className="fm-brief-rank" aria-hidden="true">{n}</span>
              <span className="fm-work-what">
                <strong>{s.item.what}</strong>
                {s.urgent && !finishedStop && <em className="fm-badge is-danger">{L("먼저", "First")}</em>}
              </span>
              <button type="button" className="fm-work-go" onClick={() => onGo(s.item)}>{s.item.todo}</button>
            </li>
          );
        })}
      </ol>
      <small className="fm-hint">{L("완료 표시는 이 기기에만 남습니다. 기록은 각 작업 버튼으로 남깁니다.", "Ticks stay on this device; records are made with each task's button.")}</small>
    </>
  );
}


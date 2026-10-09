import { useEffect, useRef, useState } from "react";
import type { AdvisorTurn, ControlDraft, Evidence } from "../types";
import { AdvisorMarkdown } from "../AdvisorMarkdown";
import type { CiteRenderer } from "../AdvisorMarkdown";
import { groupAnswerEvidence } from "../evidence-library";
import type { EvidenceSourceGroup } from "../evidence-library";
import { shortStamp, stamp as formatSensorUpdateTime } from "./time-format";
import { FarmIcon } from "./FarmIcon";
import { Steps } from "./Steps";
import { ModuleTag } from "./ModuleTag";
import { routeText } from "./research-modules";
import { answerRevision, retrievalSummary, revisionSummary, revisionTally, unitChangeLabel, unitLabel } from "./answer-diff";
import { backendText, getLang, L, prose, term } from "./i18n";
import { evidenceTitle, isTelemetryPassage, parseReadings, parseTelemetryPassages, readableExcerpt, readableLocator, readingNeedsLook, statusWord } from "./readable-excerpt";
import type { ParsedReading } from "./readable-excerpt";
import { passagePlaces } from "./doc-reader";
import type { ReaderTarget } from "./DocReader";
import { AiMark } from "./AiBrief";
import { farmWords } from "./ai-brief";

// The last step says what the research does — recheck only what depends on a
// changed value — without claiming a rewrite that may not have happened.
const answerSteps = () => [L("자료 찾기", "Find sources"), L("관측 읽기", "Read sensors"), L("답 쓰기", "Write answer"), L("필요한 부분만 다시 확인", "Recheck only affected parts")];
// Pill ids stay Korean because the route methods are matched against them.
const ROUTE_METHODS = ["의미 검색", "낱말 검색", "관계 근거"] as const;
const methodName = (m: string) => ({ "의미 검색": L("의미 검색", "Semantic search"), "낱말 검색": L("낱말 검색", "Keyword search"), "관계 근거": L("관계 근거", "Relation evidence") } as Record<string, string>)[m] ?? m;

export const withReadableTimes = (text: string) =>
  text.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})/g, (at) => formatSensorUpdateTime(at));

/**
 * Who wrote the answer, shown after the AI tag: the agent (its model is not
 * named on screen), so the line reads "AI 에이전트", or the local summary quoting the sources.
 */
export function authorOf(turn: AdvisorTurn) {
  if (turn.execution.provider === "llmgateway") return { text: L("에이전트", "agent"), note: L("센서 값과 검색한 재배 자료를 AI가 읽고 쓴 답입니다.", "Written by the AI from your readings and the growing guides it found.") };
  return {
    text: L("원문 발췌", "Quoted, in Korean"),
    note: turn.execution.privacy === "local_only"
      ? L("농장 전용 자료나 관측이 있어 외부 AI로 보내지 않고, 찾은 원문의 문장을 그대로 옮겼습니다.", "Farm-only records were involved, so nothing was sent to an outside AI; sentences are quoted from the sources found.")
      : L("찾은 원문의 문장을 그대로 옮겼습니다.", "Sentences are quoted from the sources found."),
  };
}

// The live-readings group is named by the screen, not a document: it follows the language.
const groupTitle = evidenceTitle;

/**
 * The live readings the answer used, as a table by zone: the readings to check
 * first, the ones in range folded below. Replaces one long line of "A; B; C…".
 */
function ReadingsTable({ parsed, zoneLabel, observedAt }: { parsed: { zones: string[]; rows: ParsedReading[] }; zoneLabel: (id: string) => string; observedAt?: string | null }) {
  const look = parsed.rows.filter(readingNeedsLook);
  const rest = parsed.rows.filter((r) => !readingNeedsLook(r));
  const head = (
    <thead><tr><th scope="col">{L("항목", "Reading")}</th>{parsed.zones.map((z) => <th scope="col" key={z}>{z ? zoneLabel(z) : L("값", "Value")}</th>)}</tr></thead>
  );
  const body = (rows: ParsedReading[]) => (
    <tbody>
      {rows.map((r) => (
        <tr key={r.label}>
          <th scope="row">{term(r.label)}</th>
          {parsed.zones.map((z) => {
            const cell = r.cells[z];
            return (
              <td key={z} className={cell ? `is-${cell.status}` : ""}>
                {cell ? cell.value : "-"}
                {cell && (cell.note || cell.status !== "normal") && <small>{cell.note ?? statusWord(cell.status)}</small>}
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  );
  return (
    <div className="fm-readings">
      {observedAt && <small className="fm-readings-at">{L(`${formatSensorUpdateTime(observedAt)} 관측`, `Read ${formatSensorUpdateTime(observedAt)}`)}</small>}
      {look.length > 0 && (
        <table className="fm-readings-table">
          <caption>{L(`확인이 필요한 값 ${look.length}개`, `${look.length} ${look.length === 1 ? "reading" : "readings"} to check`)}</caption>
          {head}{body(look)}
        </table>
      )}
      {rest.length > 0 && (
        <details>
          <summary>{L(`정상 범위 ${rest.length}개`, `${rest.length} in range`)}</summary>
          <table className="fm-readings-table">{head}{body(rest)}</table>
        </details>
      )}
    </div>
  );
}

/** Where the passages of one source sit ("34, 36쪽"), for its chip. */
const groupPlaces = (g: EvidenceSourceGroup) => (isDocumentGroup(g) ? passagePlaces(g.passages.map((p) => p.sourceLocator ?? p.locator)) : null);
/** A group of passages from a guide (not the live readings or a device report): it opens in the reader. */
const isDocumentGroup = (g: EvidenceSourceGroup) => g.passages.some((p) => p.documentId && p.sourceKind !== "private_simulation");

/** The reader's view of one cited source: every passage of it the answer used, opening at `at`. */
function sourceTarget(turn: AdvisorTurn, g: EvidenceSourceGroup, at?: Evidence): ReaderTarget {
  const passages = g.passages.filter((p) => p.documentId);
  return {
    passages: passages.map((p) => ({ documentId: p.documentId!, chunkId: p.id, text: p.excerpt, kind: "read" as const })),
    start: at ? Math.max(0, passages.indexOf(at)) : 0,
    responseId: turn.responseId ?? null,
  };
}

/**
 * Source numbers in the answer text: the n-th passage the AI was given, shown
 * as its source's number. Numbers written together ("[7][8]") that come from
 * one source show that source once; a tap opens its first cited passage.
 */
function citeRenderer(turn: AdvisorTurn, groups: EvidenceSourceGroup[], open: (index: number, item: Evidence) => void, plainReadings = false): CiteRenderer {
  return (numbers, key) => {
    const marks: { index: number; item: Evidence }[] = [];
    for (const n of numbers) {
      const item = turn.evidence[n - 1];
      const index = item ? groups.findIndex((g) => g.passages.includes(item)) : -1;
      if (index >= 0 && !marks.some((m) => m.index === index)) marks.push({ index, item });
    }
    if (!marks.length) return null;
    return marks.map(({ index, item }) => {
      const title = [groupTitle(groups[index].title), groupPlaces(groups[index])].filter(Boolean).join(", ");
      if (plainReadings && !isDocumentGroup(groups[index])) return <sup key={`${key}-${index}`} className="fm-cite-mark is-plain" title={title}>{index + 1}</sup>;
      return (
        <button key={`${key}-${index}`} type="button" className="fm-cite-mark" onClick={() => open(index, item)} aria-label={L(`근거 ${index + 1}: ${title}`, `Source ${index + 1}: ${title}`)} title={title}>
          {index + 1}
        </button>
      );
    });
  };
}

/** Whether an earlier answer used any guide (not only the live readings). */
export const usedGuides = (turn: AdvisorTurn) => groupAnswerEvidence(turn.evidence).some(isDocumentGroup);

/** The numbered sources of an earlier answer in the thread: a guide opens in the reader where the answer used it; the readings of that moment are listed, not opened. */
export function HistorySources({ turn, onOpenSource }: { turn: AdvisorTurn; onOpenSource?: (target: ReaderTarget) => void }) {
  const groups = groupAnswerEvidence(turn.evidence);
  if (!groups.length || !onOpenSource) return null;
  return <CiteRow groups={groups} canOpen={isDocumentGroup} onOpen={(i) => { const g = groups[i]; if (g && isDocumentGroup(g)) onOpenSource(sourceTarget(turn, g)); }} />;
}

/** Source numbers in an earlier answer of the thread: a guide opens in the reader, the live readings stay a plain number. */
export function historyCite(turn: AdvisorTurn, onOpenSource?: (target: ReaderTarget) => void): CiteRenderer | undefined {
  if (!onOpenSource) return undefined;
  const groups = groupAnswerEvidence(turn.evidence);
  return citeRenderer(turn, groups, (index, item) => onOpenSource(sourceTarget(turn, groups[index], item)), true);
}

/** Numbered sources under the answer, as the deployed console showed them; a tap opens that source where it was cited. */
function CiteRow({ groups, onOpen, canOpen }: { groups: EvidenceSourceGroup[]; onOpen: (index: number) => void; canOpen?: (g: EvidenceSourceGroup) => boolean }) {
  if (!groups.length) return <p className="fm-sources-line">{L("참고 자료 없음 (관측값만 사용)", "No sources (sensor readings only)")}</p>;
  return (
    <div className="fm-cite-row" aria-label={L("답변 근거", "Answer sources")}>
      {groups.map((g, i) => {
        const places = groupPlaces(g);
        return (
          <button type="button" key={g.id} disabled={canOpen ? !canOpen(g) : false} onClick={() => onOpen(i)} title={[groupTitle(g.title), places].filter(Boolean).join(", ")}>
            <span>{i + 1}</span><span className="fm-cite-text"><i className="fm-cite-title">{groupTitle(g.title)}</i>{places && <small className="fm-cite-place">{places}</small>}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The advisor's reply inside a chat bubble: the answer, its numbered sources
 * and, only when asked for, the readings and passages behind it. A recheck that
 * rewrote parts of the answer says so above the text, with the previous
 * wording one toggle away. How the answer was made (the research modules) sits
 * behind "자세히" and only when the module display is on.
 */
export function AnswerCard({ turn, turns, busy, onReview, onRecheck, zoneLabel = (id) => id, onOpenLibrary, onOpenSource }: {
  zoneLabel?: (id: string) => string;
  /** Where the growing guides are managed. */
  onOpenLibrary?: () => void;
  /** Opens cited passages in the evidence reader, inside their documents. */
  onOpenSource?: (target: ReaderTarget) => void;
  turn: AdvisorTurn;
  turns: AdvisorTurn[];
  busy: boolean;
  onReview: (draft: ControlDraft) => void;
  onRecheck: (responseId: string) => void;
}) {
  const [showBefore, setShowBefore] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Opened details come into view; the thread does not jump when they close.
  useEffect(() => { if (moreOpen) requestAnimationFrame(() => moreRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }, [moreOpen]);
  function openEvidence(id: string) {
    setMoreOpen(true);
    requestAnimationFrame(() => document.getElementById(`fm-ev-${turn.id}-${id}`)?.scrollIntoView({ block: "nearest" }));
  }
  const review = turn.stateReview ?? null;
  const revision = answerRevision(turn, turns);
  const blocked = !!review && ["stale", "needs_confirmation"].includes(review.status);
  const groups = groupAnswerEvidence(turn.evidence);
  /** A source group opens in the reader at the given passage; the live readings open below the answer. */
  function openGroup(index: number, at?: Evidence) {
    const g = groups[index];
    if (!g) return;
    if (!onOpenSource || !isDocumentGroup(g)) { openEvidence(g.id); return; }
    onOpenSource(sourceTarget(turn, g, at));
  }
  // "[n]" in the answer is the n-th passage the AI was given; it shows as that passage's source number.
  const cite = citeRenderer(turn, groups, openGroup);
  const content = turn.assistantMessage?.content ?? "";
  // The server's own fixed lines read in the screen's language; anything else (the model's text) stays as written.
  const shown = content.split("\n").map((line) => prose(line)).join("\n");
  // The previous wording stays reachable even when a fresh question is required,
  // so the farmer can see what moved before asking again. No toggle when no
  // wording moved: showing the same sentence twice explains nothing.
  const canCompare = !!revision && revision.units.some((u) => u.textChanged && u.before !== null);
  const evidenceUnit = revision?.units.find((u) => u.id === "evidence");
  const route = routeText(turn.retrieval.route, turn.assistantMessage?.searchPath ?? []);
  const author = authorOf(turn);
  const time = <time dateTime={turn.recordedAt} title={formatSensorUpdateTime(turn.recordedAt ?? null)}>{shortStamp(turn.recordedAt ?? null)}</time>;
  // A reply that searched nothing (small talk, or the answer service being
  // unreachable) is a plain message: no sources, steps or pills it never used.
  const plain = turn.status === "error" || (turn.retrieval.route?.mode === "conversation" && !groups.length && !review);
  if (plain) {
    return (
      <article className="fm-answer is-plain">
        <p role={turn.status === "error" ? "alert" : undefined}>{turn.error || shown || L("답변을 받지 못했습니다. 잠시 후 다시 질문하세요.", "No answer received. Ask again in a moment.")}</p>
        <footer className="fm-answer-foot">
          <span className="fm-answer-ai" title={L("자료 검색 없이 작성된 답변", "Answered without searching sources")}><AiMark />{L("자료 검색 없음", "No sources searched")}</span>
          {time}
        </footer>
      </article>
    );
  }

  return (
    <article className="fm-answer">
      {revision && review && review.status !== "current" && (
        <div className={`fm-revision ${blocked ? "warn" : ""}`} role={blocked ? "alert" : "status"}>
          <FarmIcon name={blocked ? "warning" : "compare"} />
          <span>{revisionSummary(revision)}</span>
          {canCompare && (
            <button type="button" aria-pressed={showBefore} onClick={() => setShowBefore((v) => !v)}>
              {showBefore ? L("수정 전 닫기", "Hide previous") : L("수정 전 보기", "Show previous")}
            </button>
          )}
        </div>
      )}
      {!revision && blocked && <p className="fm-revision warn" role="alert">{L("상태가 변경되었습니다. 새로 질문하세요.", "Conditions have changed. Ask a new question.")}</p>}
      {review?.mode === "selective" ? (
        review.units.filter((u) => u.id !== "evidence").map((u) => {
          const unit = revision?.units.find((x) => x.id === u.id);
          return (
            <div key={u.id} className={`fm-unit ${unit?.textChanged ? "is-changed" : unit?.rechecked ? "is-rechecked" : ""}`}>
              <small className="fm-unit-label">
                {unitLabel(u.id)}{unit ? `: ${unitChangeLabel(unit)}` : ""}
              </small>
              {showBefore && unit && unit.before !== null && unit.textChanged && (
                <p className="fm-unit-before"><small>{L("수정 전", "Before")}</small>{farmWords(backendText(withReadableTimes(unit.before)), zoneLabel)}</p>
              )}
              <p>{showBefore && unit?.textChanged && <small className="fm-unit-after">{L("수정 후", "After")}</small>}{farmWords(backendText(withReadableTimes(u.text)), zoneLabel)}</p>
            </div>
          );
        })
      ) : (
        <div className="fm-answer-body"><AdvisorMarkdown content={farmWords(withReadableTimes(shown), zoneLabel)} cite={cite} /></div>
      )}
      <CiteRow groups={groups} onOpen={(index) => openGroup(index)} />
      {turn.controlDrafts.map((d) => (
        <button key={d.id} className="fm-wide" disabled={busy || blocked} onClick={() => onReview(d)}>
          {L("변경 내용 확인", "Review change")}
        </button>
      ))}
      <footer className="fm-answer-foot">
        <span className="fm-answer-ai" title={author.note}><AiMark title={author.note} />{author.text}</span>
        {time}
        {turn.retrieval.researchDiagnosticsOnly && <span title={L("원문을 함께 확인하세요.", "Check the original sources too.")}>{L("검색 품질 검토 중", "Search under review")}</span>}
        <span className="fm-answer-foot-tools">
          {turn.responseId && review && !blocked && (
            <button type="button" disabled={busy} onClick={() => onRecheck(turn.responseId!)} title={L("최신 센서 값으로 이 답을 다시 확인합니다", "Recheck this answer against the latest sensor values")}>
              {L("재확인", "Recheck")}
            </button>
          )}
          <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            {L("자세히", "Details")}
          </button>
        </span>
      </footer>
      {moreOpen && (
        <div className="fm-answer-more" ref={moreRef}>
          {revision && <p className="fm-hint">{revisionTally(revision)}</p>}
          {review?.mode === "selective" && (
            <section>
              <h4>{L("참고 관측", "Readings used")}{evidenceUnit ? `: ${unitChangeLabel(evidenceUnit)}` : ""}</h4>
              {review.units.filter((u) => u.id === "evidence").map((u) => (
                <p key={u.id}>{backendText(withReadableTimes(u.text))}</p>
              ))}
              {showBefore && evidenceUnit?.before && evidenceUnit.textChanged && <p className="fm-unit-before"><small>{L("수정 전", "Before")}</small>{withReadableTimes(evidenceUnit.before)}</p>}
            </section>
          )}
          <section>
            <h4>
              {L("참고 자료", "Sources")} ({groups.length})
              {onOpenLibrary && <button type="button" className="fm-link-button" onClick={onOpenLibrary}>{L("자료실에서 관리", "Manage in the library")}</button>}
            </h4>
            {groups.map((g, i) => {
              const document = isDocumentGroup(g);
              const telemetry = document ? null : parseTelemetryPassages(g.passages.map((p) => ({ source: p.source, excerpt: p.excerpt })));
              const inventory = document || telemetry ? null : parseReadings(g.representative.excerpt);
              // Alerts, device states and trends that came with the readings, each as one line.
              const others = document ? [] : g.passages.filter((p) => !isTelemetryPassage(p.excerpt) && !(inventory && p === g.representative));
              const places = groupPlaces(g);
              return (
                <article key={g.id} id={`fm-ev-${turn.id}-${g.id}`} className="fm-evidence">
                  <span className="fm-cite-index">{i + 1}</span>
                  <strong>{groupTitle(g.title)}</strong>
                  {document && (g.representative.issuer || g.representative.publishedYear || places) && (
                    <small>{[g.representative.issuer, g.representative.publishedYear, places].filter(Boolean).join(", ")}</small>
                  )}
                  {telemetry ? <ReadingsTable parsed={telemetry} zoneLabel={zoneLabel} observedAt={telemetry.observedAt} />
                    : inventory ? <ReadingsTable parsed={inventory} zoneLabel={zoneLabel} />
                    : document ? <p className="fm-evidence-excerpt" lang={getLang() !== "ko" && /[가-힣]/.test(g.representative.excerpt) ? "ko" : undefined}>{readableExcerpt(g.representative.excerpt, zoneLabel)}</p>
                    : null}
                  {others.map((p) => (
                    <p key={p.id} className="fm-evidence-line" lang={getLang() !== "ko" && /[가-힣]/.test(p.excerpt) ? "ko" : undefined}>
                      <small>{readableLocator(p.locator)}</small>{readableExcerpt(withReadableTimes(p.excerpt), zoneLabel)}
                    </p>
                  ))}
                  {document && onOpenSource ? (
                    <button type="button" className="fm-evidence-open" onClick={() => openGroup(i)}>
                      <FarmIcon name="file" />{g.passages.length > 1 ? L(`원문에서 보기, 인용 ${g.passages.length}곳`, `Read in the source, ${g.passages.length} passages`) : L("원문에서 보기", "Read in the source")}
                    </button>
                  ) : document && g.representative.sourceUrl && /^https?:/.test(g.representative.sourceUrl) ? (
                    <a href={g.representative.sourceUrl} target="_blank" rel="noreferrer">{L("원문 보기", "View original")}</a>
                  ) : null}
                </article>
              );
            })}
            {!groups.length && <p className="fm-hint">{L("연결된 자료 없음", "No linked sources")}</p>}
          </section>
          {review?.mode === "selective" && (
            <details>
              <summary>{L("원문 답변", "Original answer")}</summary>
              <AdvisorMarkdown content={content} />
            </details>
          )}
          {/* How the answer was made: the research modules, only with the module display on. */}
          <section className="fm-research-only">
            <h4>{L("답변이 만들어진 과정", "How this answer was made")}</h4>
            <Steps
              label={L("답변이 만들어진 순서", "How this answer was made")}
              items={answerSteps()}
              completed={revision ? 4 : 3}
              active={revision ? 3 : null}
              now={revision ? undefined : L("3/4 답변 작성 완료. 값이 바뀌면 해당 항목만 재확인", "3/4 Answer written. If values change, only affected parts are rechecked")}
            />
            <p className="fm-hint">{retrievalSummary(turn)}</p>
            <div className="fm-route" aria-label={L("이 질문을 찾은 방법", "How sources were found for this question")}>
              <span className="fm-route-label">{L("검색 방법", "Search method")}</span>
              {ROUTE_METHODS.map((m) => (
                <span key={m} className={`fm-route-pill ${route.methods.includes(m) ? "is-on" : ""}`}>{methodName(m)}</span>
              ))}
              {route.note && <small className="fm-route-note">{route.note}</small>}
            </div>
            {revision && (
              <div className="fm-unit-strip" role="img" aria-label={L(`답변 ${revision.total}부분 중 다시 확인 ${revision.changed.length}, 문구 고침 ${revision.textChanged.length}`, `Of ${revision.total} answer parts, ${revision.changed.length} rechecked, ${revision.textChanged.length} reworded`)}>
                {revision.units.map((u) => (
                  <span key={u.id} className={u.textChanged ? "is-changed" : u.rechecked ? "is-rechecked" : "is-same"} title={`${u.label}: ${unitChangeLabel(u)}`}>
                    <small>{u.label}</small>
                  </span>
                ))}
              </div>
            )}
            <ModuleTag id="qact" diagram={{ methods: route.methods }} live={L(`${route.methods.join(" + ") || "의미 검색"}으로 자료 ${groups.length}개를 찾았습니다.${route.note ? ` ${route.note}` : ""}`, `Found ${groups.length} ${groups.length === 1 ? "source" : "sources"} with ${route.methods.map(methodName).join(" + ") || methodName("의미 검색")}.${route.note ? ` ${route.note}` : ""}`)} />
            {review?.mode === "selective" && (
              <ModuleTag
                id="sr"
                diagram={revision ? { changedUnits: revision.changed } : undefined}
                live={revision ? `${revisionTally(revision)}. ${revisionSummary(revision)}` : L("이 답은 세 부분으로 나뉘어 있습니다. 센서 값이 바뀌면 그 값에 기대는 부분만 다시 씁니다.", "This answer has three parts. When a sensor value changes, only the parts that depend on it are rewritten.")}
              />
            )}
            <ModuleTag id="rag" live={groups.length ? L(`재배 자료 ${groups.length}개를 번호로 붙였습니다. 번호를 누르면 원문 위치가 열립니다.`, `Numbered ${groups.length} cultivation ${groups.length === 1 ? "source" : "sources"}. Tap a number to open the original passage.`) : L("관련 자료가 없어 관측만으로 답했습니다.", "No related sources, so the answer uses sensor readings only.")} />
          </section>
        </div>
      )}
    </article>
  );
}

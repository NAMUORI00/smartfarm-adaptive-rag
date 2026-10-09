import { useEffect, useMemo, useState } from "react";
import { deleteKnowledge, getKnowledge, updateKnowledgeRetrievalState, uploadKnowledge } from "../api";
import type { FarmId, KnowledgeDocument } from "../types";
import { documentCitations, forgetKnowledgeDocuments, libraryStats, metricReferenceSources, retrievalPolicy, searchPassages } from "./assist-api";
import type { LibraryStats, MetricReferenceSources, PassageCitations, PassageHit, RetrievalPolicy } from "./assist-api";
import { AiMark } from "./AiBrief";
import { askedPlace, BookReader, readingHistory } from "./BookReader";
import type { AskedPlace, BookStart } from "./BookReader";
import { bookParts } from "./book-text";
import type { ReadingMark } from "./book-text";
import { isFileUrl } from "./doc-reader";
import { forgetLibraryDocuments } from "./DocReader";
import { FarmIcon } from "./FarmIcon";
import { getLang, josa, L, term } from "./i18n";
import { RefNote } from "./RefNote";
import { Switch } from "./Settings";
import { entryOf, entryStats, filterLibrary, kindName, libraryBooks, libraryCounts, libraryEntries, scanSuspect, sortLibrary, thinOnCultivation } from "./library-entries";
import type { EntryStats, LibraryEntry, LibraryFilter, LibrarySort } from "./library-entries";
import { readableLocator } from "./readable-excerpt";
import { shortStamp } from "./time-format";

const PAGE = 30;
/** Guides shown per kind before "show all". */
const FIRST = 5;
const korean = (text: string | null | undefined) => (getLang() !== "ko" && text && /[가-힣]/.test(text) ? "ko" : undefined);
const number = (n: number) => n.toLocaleString(getLang() === "ko" ? "ko-KR" : "en-US");

// Which guides the readings' reference boxes quote: one request, kept by the server until a guide changes.
const references = new Map<string, Promise<MetricReferenceSources | null>>();
const referencesOf = (farmId: FarmId) => {
  if (!references.has(farmId)) references.set(farmId, metricReferenceSources(farmId).catch(() => { references.delete(farmId); return null; }));
  return references.get(farmId)!;
};
/** "고추냉이 재배 기술 자료 · 34쪽" with its location "34쪽": the place is named once, in the screen's language. */
const sourceName = (title: string, location: string | null) => {
  const bare = title.replace(/\s*[·|-]\s*(?:\d+\s*쪽|섹션\s*\d+)\s*$/u, "").trim() || title;
  return [bare, location ? readableLocator(location) : null].filter(Boolean).join(", ");
};
/** Kinds of guide, in the order a grower reaches for them. */
const KINDS = ["official_agronomy", "farm_sop", "public_reference", "peer_reviewed", "simulated"];
const kindOf = (e: LibraryEntry) => (KINDS.includes(e.evidenceClass ?? "") ? e.evidenceClass! : "other");
const printedGuide = (e: LibraryEntry) => /pdf/i.test(e.type ?? "") || isFileUrl(e.url);
const entryMeta = (e: LibraryEntry) => [e.issuer, e.year, e.type ? term(e.type) : null, e.pages ? readableLocator(e.pages) : e.parts > 1 ? L(`${e.parts}개 부분`, `${e.parts} parts`) : null].filter(Boolean).join(", ");

type Change = { kind: "use" | "stop" | "remove"; entry: LibraryEntry };
type Open = { entryId: string; start?: BookStart | null };
/** Opened from another screen: a page of a guide, and a sentence on it. */
export type LibraryFocus = { documentId: string; quote?: string | null };

/**
 * 자료실, made for reading. One list, top to bottom: the guides read lately
 * (to carry on), those waiting for a check, those the AI cites most, then each
 * kind of guide with its most useful first; those that say little about growing
 * are set apart. A guide opens in the reader. Searching finds guides by title
 * and sentences in their text. Managing (answer use, adding and removing) is
 * one step aside, and beside each guide's text.
 */
export function Library({ farmId, focus, metricKeys, metricLabel, onOpenReading, onOpenAnswer, placeOf }: {
  farmId: FarmId;
  /** A page to open, when another screen pointed here. */
  focus?: LibraryFocus | null;
  metricKeys: string[];
  metricLabel: (key: string) => string;
  onOpenReading: (metricKey: string) => void;
  onOpenAnswer: (asked: AskedPlace) => void;
  /** Where an answer was asked about (a bed or a zone). */
  placeOf: (asked: AskedPlace) => string | null;
}) {
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [policy, setPolicy] = useState<RetrievalPolicy | null>(null);
  const [mode, setMode] = useState<"read" | "manage">("read");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [citations, setCitations] = useState<PassageCitations | null>(null);
  const [history, setHistory] = useState<ReadingMark[]>(() => readingHistory(farmId));
  const [filter, setFilter] = useState<LibraryFilter>({ state: "all", scope: "all", query: "", kind: "all" });
  const [sort, setSort] = useState<LibrarySort>("suggested");
  // Most of the crawled literature is chemistry, medicine or tourism: it can be set aside while managing.
  const [hideThin, setHideThin] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [change, setChange] = useState<Change | null>(null);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState("");
  const [found, setFound] = useState<{ query: string; items: PassageHit[]; state: "idle" | "loading" | "ready" | "error" }>({ query: "", items: [], state: "idle" });

  async function load() {
    const result = await getKnowledge(farmId);
    setDocs(result.data);
    setState(result.state === "connected" ? "ready" : "error");
    if (result.error) setMessage(result.error);
  }
  function refreshCounts() {
    libraryStats(farmId).then(setStats).catch(() => undefined);
    retrievalPolicy(farmId).then(setPolicy).catch(() => undefined);
  }
  useEffect(() => { void load(); refreshCounts(); }, [farmId]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => libraryBooks(libraryEntries(docs, farmId)), [docs, farmId]);
  const statsOf = useMemo(() => {
    const cache = new Map<string, EntryStats>();
    return (e: LibraryEntry) => {
      if (!cache.has(e.id)) cache.set(e.id, entryStats(e, stats?.documents));
      return cache.get(e.id)!;
    };
  }, [stats]);
  // In each kind the guides that say most about growing, and the most cited, come first.
  const byUse = (a: LibraryEntry, b: LibraryEntry) => {
    const sa = statsOf(a), sb = statsOf(b);
    return Number(thinOnCultivation(sa)) - Number(thinOnCultivation(sb)) || sb.cited - sa.cited || sb.cultivationTerms - sa.cultivationTerms || a.title.localeCompare(b.title, "ko");
  };
  const openEntry = open ? entries.find((e) => e.id === open.entryId) ?? null : null;

  // Pointed here from the evidence reader or an answer: that page of that guide, the sentence marked.
  useEffect(() => {
    if (!focus || !entries.length) return;
    const e = entryOf(entries, focus.documentId);
    if (e) { setOpen({ entryId: e.id, start: { documentId: focus.documentId, quote: focus.quote ?? null } }); setMode("read"); }
  }, [focus, entries.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Where answers cited the open guide, passage by passage.
  useEffect(() => {
    setCitations(null);
    if (!openEntry) return;
    let live = true;
    documentCitations(farmId, openEntry.documentIds).then((c) => { if (live) setCitations(c); }).catch(() => undefined);
    return () => { live = false; };
  }, [farmId, openEntry?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The guides' own sentences that carry every searched word, a moment after typing stops.
  useEffect(() => {
    const q = filter.query.trim();
    if (q.length < 2 || mode === "manage") { setFound({ query: "", items: [], state: "idle" }); return; }
    const ctrl = new AbortController();
    const id = window.setTimeout(() => {
      setFound((f) => ({ ...f, query: q, state: "loading" }));
      searchPassages(farmId, q, ctrl.signal)
        .then((r) => setFound({ query: q, items: r.passages, state: "ready" }))
        .catch(() => { if (!ctrl.signal.aborted) setFound({ query: q, items: [], state: "error" }); });
    }, 400);
    return () => { window.clearTimeout(id); ctrl.abort(); };
  }, [farmId, filter.query, mode]);

  function read(e: LibraryEntry, start?: BookStart | null) {
    setOpen({ entryId: e.id, start: start ?? null });
    setChange(null);
    requestAnimationFrame(() => document.querySelector(".fm-library")?.scrollTo({ top: 0 }));
  }
  function closeBook() {
    setOpen(null);
    setChange(null);
    setHistory(readingHistory(farmId));
  }
  function ask(next: Change) {
    // Removing always asks; using or not using asks when it turns off the pinned search policy.
    if (next.kind === "remove" || policy?.changes_fall_back) setChange(next);
    else void apply(next);
  }
  async function apply({ kind, entry }: Change) {
    setChange(null);
    setBusy(entry.id);
    setMessage("");
    try {
      if (kind === "remove") {
        for (const id of entry.documentIds) await deleteKnowledge(farmId, id);
        setOpen(null);
        setMessage(L(`'${entry.title}'${josa(entry.title, "을", "를")} 자료실에서 지웠습니다.`, `Removed '${entry.title}' from the library.`));
      } else {
        for (const group of entry.groupIds) {
          const updated = await updateKnowledgeRetrievalState(farmId, group, kind === "use" ? "active" : "paused");
          setDocs((all) => all.map((d) => updated.find((u) => u.id === d.id) ?? d));
        }
        setMessage(kind === "use"
          ? L(`'${entry.title}'${josa(entry.title, "을", "를")} 답변에 씁니다.`, `Answers now use '${entry.title}'.`)
          : L(`'${entry.title}'${josa(entry.title, "을", "를")} 답변에 쓰지 않습니다.`, `Answers no longer use '${entry.title}'.`));
      }
      forgetKnowledgeDocuments();
      forgetLibraryDocuments();
      await load();
      refreshCounts();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : L("바꾸지 못했습니다.", "Could not change it."));
    } finally {
      setBusy(null);
    }
  }

  // ---------------------------------------------------------------- the reading room
  if (openEntry) {
    const url = openEntry.url;
    return (
      <section className="fm-library is-reading" aria-label={L("자료실", "Reference library")}>
        {message && <p className="fm-library-message" role="status">{message}</p>}
        <BookReader
          // A guide opened anew (another guide, page or sentence) starts its reader afresh.
          key={`${openEntry.id}|${open?.start?.documentId ?? ""}|${open?.start?.quote ?? ""}`}
          farmId={farmId}
          entryId={openEntry.id}
          title={openEntry.title}
          kindLabel={kindName(openEntry.evidenceClass)}
          meta={entryMeta(openEntry)}
          parts={bookParts(openEntry.documentIds, docs)}
          printed={printedGuide(openEntry)}
          start={open?.start}
          citations={citations}
          sourceLink={url ? { href: url, file: isFileUrl(url) } : null}
          onBack={closeBook}
          onOpenAnswer={onOpenAnswer}
          placeOf={placeOf}
          info={(
            <BookInfo
              farmId={farmId}
              entry={openEntry}
              stats={statsOf(openEntry)}
              citations={citations}
              busy={busy === openEntry.id}
              change={change && change.entry.id === openEntry.id ? change : null}
              fallsBack={!!policy?.changes_fall_back}
              onAsk={ask}
              onApply={(c) => void apply(c)}
              onCancel={() => setChange(null)}
              metricKeys={metricKeys}
              metricLabel={metricLabel}
              onOpenReading={onOpenReading}
              onOpenAnswer={onOpenAnswer}
              placeOf={placeOf}
            />
          )}
        />
      </section>
    );
  }

  // ---------------------------------------------------------------- the list
  const row = (e: LibraryEntry) => <GuideRow key={e.id} entry={e} stats={statsOf(e)} onOpen={() => read(e)} />;
  const query = filter.query.trim();
  const waiting = entries.filter((e) => e.state === "needs_review").sort(byUse);
  const mostCited = entries.filter((e) => statsOf(e).cited > 0).sort((a, b) => statsOf(b).cited - statsOf(a).cited || byUse(a, b));
  const groups = [...KINDS, "other"]
    .map((key) => ({ key, guides: entries.filter((e) => kindOf(e) === key).sort(byUse) }))
    .filter((g) => g.guides.length);
  const reading = history.map((h) => ({ h, e: entries.find((x) => x.id === h.entryId) })).filter((r): r is { h: ReadingMark; e: LibraryEntry } => !!r.e);
  const toggle = (key: string) => setExpanded((all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key]));
  /** One kind of guide: its most useful first; all of them on request, those that say little about growing set apart. */
  const group = (key: string, title: string, guides: LibraryEntry[], note?: string) => {
    const open = expanded.includes(key);
    const useful = guides.filter((e) => !thinOnCultivation(statsOf(e)));
    const thin = guides.filter((e) => thinOnCultivation(statsOf(e)));
    const first = (useful.length ? useful : thin).slice(0, FIRST);
    return (
      <section key={key} className="fm-guide-group" aria-labelledby={`fm-group-${key}`}>
        <header className="fm-guide-group-head">
          <h3 id={`fm-group-${key}`}>{title}</h3>
          <small>{L(`${number(guides.length)}개`, `${number(guides.length)}`)}</small>
          {note && <small className="fm-guide-group-note">{note}</small>}
        </header>
        <ul className="fm-guide-list">{(open ? useful : first).map(row)}</ul>
        {open && thin.length > 0 && useful.length > 0 && (
          <details className="fm-guide-thin">
            <summary>{L(`재배 이야기가 적은 자료 ${number(thin.length)}개`, `${number(thin.length)} that say little about growing`)}</summary>
            <p className="fm-hint">{L("본문에 재배 관련 낱말이 거의 없는 자료입니다(성분, 약리, 관광 등). AI 상담은 이 자료도 찾을 수 있습니다.", "Their text carries almost no growing-practice words (chemistry, medicine, tourism). The AI advisor can still search them.")}</p>
            <ul className="fm-guide-list">{thin.map(row)}</ul>
          </details>
        )}
        {open && !useful.length && thin.length > FIRST && <ul className="fm-guide-list">{thin.slice(FIRST).map(row)}</ul>}
        {guides.length > first.length && (
          <button type="button" className="fm-guide-more" aria-expanded={open} onClick={() => toggle(key)}>
            {open ? L("접기", "Show fewer") : L(`${number(guides.length)}개 모두 보기`, `Show all ${number(guides.length)}`)}<FarmIcon name={open ? "up" : "down"} />
          </button>
        )}
      </section>
    );
  };

  const front = (
    <>
      {reading.length > 0 && (
        <section className="fm-guide-group is-reading" aria-labelledby="fm-group-reading">
          <header className="fm-guide-group-head"><h3 id="fm-group-reading">{L("이어 읽기", "Carry on reading")}</h3></header>
          <ul className="fm-guide-list">
            {reading.map(({ h, e }) => (
              <li key={e.id}>
                <button type="button" className="fm-guide-row is-continue" onClick={() => read(e, { documentId: h.documentId })}>
                  <span className="fm-guide-main">
                    <strong lang={korean(e.title)}>{e.title}</strong>
                    <small>{L(`${h.part}에서 멈춤, ${shortStamp(h.at)}`, `Stopped at ${h.part}, ${shortStamp(h.at)}`)}</small>
                  </span>
                  <span className="fm-guide-go">{L("이어 읽기", "Carry on")}<FarmIcon name="chevron" /></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {waiting.length > 0 && group("waiting", L("확인을 기다리는 자료", "Waiting for a check"), waiting, L("확인하기 전에는 답변에 쓰지 않습니다.", "Answers do not use them until checked."))}
      {mostCited.length > 0 && group("cited", L("AI가 자주 인용한 자료", "Most cited by the AI"), mostCited)}
      {groups.map((g) => group(g.key, kindName(g.key === "other" ? null : g.key), g.guides))}
    </>
  );

  const titleHits = query ? sortLibrary(filterLibrary(entries, { state: "all", scope: "all", query, kind: "all" }), "suggested", statsOf) : [];
  // Guides whose names carry the words first, then sentences in the guides' text; a search that finds nothing says so once.
  const nothing = !titleHits.length && found.state === "ready" && !found.items.length;
  const results = query && (
    <>
      {titleHits.length > 0 && (
        <section className="fm-guide-group" aria-labelledby="fm-found-guides">
          <header className="fm-guide-group-head">
            <h3 id="fm-found-guides">{L("이름에서 찾은 자료", "Guides by name")}</h3>
            <small>{L(`${number(titleHits.length)}개`, `${number(titleHits.length)}`)}</small>
          </header>
          <ul className="fm-guide-list">{titleHits.slice(0, 12).map(row)}</ul>
        </section>
      )}
      {nothing && <p className="fm-hint" role="status">{L("이름과 본문 모두에서 찾지 못했습니다. 낱말을 줄이거나 바꿔 보세요.", "Nothing found in the names or the text. Try fewer or other words.")}</p>}
      {found.state !== "idle" && !nothing && (
        <section className="fm-lib-found" aria-label={L("본문에서 찾은 문장", "Sentences found in the text")}>
          <h3>{found.state === "loading" ? L("본문에서 찾는 중…", "Searching the text…") : L(`본문에서 찾은 문장 ${found.items.length}개`, `${found.items.length} ${found.items.length === 1 ? "sentence" : "sentences"} in the text`)}</h3>
          {found.state === "error" && <p className="fm-hint">{L("본문 찾기를 하지 못했습니다.", "Could not search the text.")}</p>}
          <ul>
            {found.items.slice(0, 10).map((p) => {
              const e = entryOf(entries, p.document_id);
              return (
                <li key={`${p.chunk_id}:${p.sentence}`}>
                  <button type="button" onClick={() => e && read(e, { documentId: p.document_id, quote: p.sentence })}>
                    <q lang={korean(p.sentence)}>{highlight(p.sentence, found.query)}</q>
                    <small lang={korean(p.title)}>{sourceName(p.title, p.location)}</small>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );

  // ---------------------------------------------------------------- managing
  const counts = libraryCounts(entries);
  const kinds = [...entries.reduce((m, e) => m.set(e.evidenceClass ?? "", (m.get(e.evidenceClass ?? "") ?? 0) + 1), new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
  const thinCount = entries.filter((e) => thinOnCultivation(statsOf(e))).length;
  const shown = sortLibrary(filterLibrary(entries, filter).filter((e) => !hideThin || !thinOnCultivation(statsOf(e))), sort, statsOf);
  const stateTabs: [LibraryFilter["state"], string, number][] = [
    ["all", L("전체", "All"), counts.all],
    ["active", L("답변에 사용", "Used"), counts.active],
    ["needs_review", L("검토 대기", "To check"), counts.needs_review],
    ["paused", L("사용 중지", "Not used"), counts.paused],
  ];
  const setStateFilter = (next: LibraryFilter["state"]) => { setFilter((f) => ({ ...f, state: next })); setLimit(PAGE); };
  const manageRow = (e: LibraryEntry) => {
    const s = statsOf(e);
    const meta = [e.issuer, e.year, e.pages ? readableLocator(e.pages) : e.parts > 1 ? L(`${e.parts}개 부분`, `${e.parts} parts`) : null, s.cited ? L(`인용 ${s.cited}회`, `cited ${s.cited}×`) : null, thinOnCultivation(s) ? L("재배 내용 적음", "little on growing") : null].filter(Boolean).join(", ");
    return (
      <li key={e.id}>
        <button type="button" className={`fm-lib-row is-${e.state}`} onClick={() => read(e)}>
          <span className="fm-lib-row-main">
            <small className="fm-lib-kind">{kindName(e.evidenceClass)}</small>
            <strong lang={korean(e.title)}>{e.title}</strong>
            {e.summary && e.summary !== e.title && <span className="fm-lib-row-summary" lang={korean(e.summary)}>{e.summary}</span>}
            <small className="fm-lib-row-meta" lang={korean(meta)}>{meta}</small>
          </span>
          <span className="fm-lib-row-badges">
            {e.state === "needs_review" && <em className="fm-badge is-warn">{L("검토 대기", "To check")}</em>}
            {e.state === "paused" && <em className="fm-badge is-off">{L("사용 중지", "Not used")}</em>}
            {e.state === "active" && e.pausedParts > 0 && <em className="fm-badge is-off">{L(`${e.pausedParts}쪽 사용 중지`, `${e.pausedParts} pages not used`)}</em>}
            {e.scope === "private" && <em className="fm-badge is-info">{L("농장 전용", "Farm only")}</em>}
            {e.owned && <em className="fm-badge is-info">{L("우리 농장이 올림", "Added by this farm")}</em>}
            {e.status === "working" && <em className="fm-badge is-info">{L("색인 중", "Indexing")}</em>}
            {e.status === "failed" && <em className="fm-badge is-danger">{L("색인 실패", "Indexing failed")}</em>}
          </span>
        </button>
      </li>
    );
  };
  const manage = (
    <div className="fm-lib-manage">
      {policy?.active && (
        <p className="fm-lib-policy">
          {L("답변은 지금 고정된 자료 목록에 맞춘 검색 방식(질문별 검색 방법 고르기)으로 자료를 찾습니다. 자료를 더하거나 빼거나 사용을 바꾸면 기본 검색으로 돌아갑니다.", "Answers now search with the policy tuned to this exact set of guides (choosing a search method per question). Adding, removing or changing any guide switches answers back to the default search.")}
        </p>
      )}
      <div className="fm-lib-tools">
        <div className="fm-segment fm-lib-states" role="group" aria-label={L("답변 사용 여부", "Use in answers")}>
          {stateTabs.map(([key, label, n]) => (
            <button type="button" key={key} aria-pressed={filter.state === key} onClick={() => setStateFilter(key)}>{label} <b>{n}</b></button>
          ))}
        </div>
        <label className="fm-lib-sort">
          <span className="fm-visually-hidden">{L("정렬", "Sort")}</span>
          <select value={sort} onChange={(e) => setSort(e.target.value as LibrarySort)}>
            <option value="suggested">{L("추천 순", "Suggested")}</option>
            <option value="cited">{L("많이 인용된 순", "Most cited")}</option>
            <option value="recent">{L("최근 추가 순", "Recently added")}</option>
            <option value="name">{L("이름 순", "By name")}</option>
          </select>
        </label>
      </div>
      <div className="fm-lib-kinds" role="group" aria-label={L("자료 종류", "Kind of guide")}>
        <button type="button" aria-pressed={!filter.kind || filter.kind === "all"} onClick={() => { setFilter((f) => ({ ...f, kind: "all" })); setLimit(PAGE); }}>{L("모든 종류", "All kinds")}</button>
        {kinds.map(([kind, n]) => (
          <button type="button" key={kind || "other"} aria-pressed={filter.kind === kind} onClick={() => { setFilter((f) => ({ ...f, kind })); setLimit(PAGE); }}>{kindName(kind)} <b>{n}</b></button>
        ))}
        {thinCount > 0 && (
          <button type="button" className="fm-lib-thin" aria-pressed={hideThin} onClick={() => { setHideThin((v) => !v); setLimit(PAGE); }} title={L("본문에 재배 관련 낱말이 거의 없는 자료입니다. 본문 낱말로 자동 판단하며, 숨겨도 AI 상담은 계속 찾을 수 있습니다.", "Guides whose text carries almost no growing-practice words, judged from their words. Hiding them here does not stop the AI advisor from searching them.")}>
            {hideThin ? L(`재배 내용 적은 자료 ${thinCount}개 숨김`, `${thinCount} with little on growing hidden`) : L(`재배 내용 적은 자료 ${thinCount}개 숨기기`, `Hide ${thinCount} with little on growing`)}
          </button>
        )}
      </div>
      {state === "ready" && !shown.length && <p className="fm-hint">{L("맞는 자료가 없습니다.", "No matching guides.")}</p>}
      <ul className="fm-lib-list">{shown.slice(0, limit).map(manageRow)}</ul>
      {shown.length > limit && (
        <button type="button" className="fm-wide" onClick={() => setLimit((n) => n + PAGE)}>{L(`더 보기 (${shown.length - limit}건 남음)`, `Show more (${shown.length - limit} left)`)}</button>
      )}
    </div>
  );

  return (
    <section className="fm-library" aria-labelledby="fm-library-title">
      <header className="fm-page-head">
        <h2 id="fm-library-title">{L("자료실", "Reference library")}</h2>
        {state === "ready" && (
          <p className="fm-lib-summary">{L(`자료 ${number(entries.length)}개, 쪽/절 ${number(docs.length)}`, `${number(entries.length)} guides, ${number(docs.length)} pages or sections`)}</p>
        )}
        <div className="fm-lib-head-actions">
          <button type="button" className="fm-lib-manage-toggle" aria-pressed={mode === "manage"} onClick={() => { setMode((m) => (m === "manage" ? "read" : "manage")); setLimit(PAGE); }}>
            <FarmIcon name={mode === "manage" ? "book" : "list"} />{mode === "manage" ? L("읽기 목록", "Reading list") : L("자료 관리", "Manage")}
          </button>
          <button type="button" className="fm-primary" aria-expanded={adding} onClick={() => setAdding((v) => !v)}><FarmIcon name={adding ? "close" : "plus"} />{L("자료 추가", "Add a guide")}</button>
        </div>
      </header>
      {adding && (
        <LibraryUpload
          farmId={farmId}
          warnFallback={!!policy?.changes_fall_back}
          onCancel={() => setAdding(false)}
          onDone={async (title) => {
            setAdding(false);
            forgetLibraryDocuments();
            await load();
            refreshCounts();
            setMode("manage");
            setStateFilter("needs_review");
            setMessage(L(`'${title}'${josa(title, "을", "를")} 올렸습니다. 내용을 확인한 뒤 '답변에 사용'을 누르면 AI 답변에 쓰입니다.`, `Uploaded '${title}'. Check it, then choose 'Use in answers' for the AI to use it.`));
          }}
        />
      )}
      <label className="fm-lib-search">
        <FarmIcon name="search" />
        <span className="fm-visually-hidden">{mode === "manage" ? L("자료 거르기", "Filter guides") : L("자료 찾기", "Find a guide")}</span>
        <input type="search" value={filter.query} onChange={(e) => { setFilter((f) => ({ ...f, query: e.target.value })); setLimit(PAGE); }} placeholder={mode === "manage" ? L("이름, 기관, 요약으로 거르기", "Filter by name, issuer or summary") : L("자료 제목이나 본문 낱말로 찾기", "Find by title or words in the text")} />
      </label>
      {message && <p className="fm-library-message" role="status">{message}</p>}
      {state === "loading" && <p role="status" className="fm-hint">{L("자료를 불러오는 중…", "Loading guides…")}</p>}
      {state === "error" && <p role="alert">{L("자료 목록을 불러오지 못했습니다.", "Could not load the guides.")} <button type="button" className="fm-link-button" onClick={() => void load()}>{L("다시 시도", "Try again")}</button></p>}
      {state === "ready" && (mode === "manage" ? manage : query ? results : front)}
    </section>
  );
}

/** The searched words marked in a found sentence. */
function highlight(sentence: string, query: string) {
  const words = query.split(/\s+/).filter((w) => w.length > 0).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return sentence;
  const parts = sentence.split(new RegExp(`(${words.join("|")})`, "gi"));
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}

/** A guide in the reading list: its title, who issued it, its length and how often answers cited it. */
function GuideRow({ entry, stats, onOpen }: { entry: LibraryEntry; stats: EntryStats; onOpen: () => void }) {
  const length = entry.pages ? readableLocator(entry.pages) : entry.parts > 1 ? L(`${entry.parts}개 부분`, `${entry.parts} parts`) : null;
  const meta = [kindName(entry.evidenceClass), entry.issuer, entry.year, length].filter(Boolean).join(", ");
  const badge = entry.state === "needs_review" ? [L("확인 필요", "To check"), "is-warn"]
    : entry.state === "paused" ? [L("답변에 안 씀", "Not used"), "is-off"]
      : entry.scope === "private" ? [L("농장 전용", "Farm only"), "is-info"] : null;
  return (
    <li>
      <button type="button" className={`fm-guide-row is-${kindOf(entry)}`} onClick={onOpen}>
        <span className="fm-guide-main">
          <strong lang={korean(entry.title)}>{entry.title}</strong>
          <small lang={korean(meta)}>{meta}</small>
        </span>
        <span className="fm-guide-side">
          {badge && <em className={`fm-badge ${badge[1]}`}>{badge[0]}</em>}
          {stats.cited > 0 && <span className="fm-guide-cited" title={L(`답변 인용 ${stats.cited}회`, `Cited ${stats.cited}×`)}><AiMark />{L(`${stats.cited}회`, `${stats.cited}×`)}</span>}
          <FarmIcon name="chevron" />
        </span>
      </button>
    </li>
  );
}

/** Beside the text: whether answers use the guide, where it was used, how its text was extracted. */
function BookInfo({ farmId, entry, stats, citations, busy, change, fallsBack, onAsk, onApply, onCancel, metricKeys, metricLabel, onOpenReading, onOpenAnswer, placeOf }: {
  farmId: FarmId;
  entry: LibraryEntry;
  stats: EntryStats;
  citations: PassageCitations | null;
  busy: boolean;
  change: Change | null;
  fallsBack: boolean;
  onAsk: (change: Change) => void;
  onApply: (change: Change) => void;
  onCancel: () => void;
  metricKeys: string[];
  metricLabel: (key: string) => string;
  onOpenReading: (metricKey: string) => void;
  onOpenAnswer: (asked: AskedPlace) => void;
  placeOf: (asked: AskedPlace) => string | null;
}) {
  const [uses, setUses] = useState<{ key: string; places: string[] }[] | null>(null);
  useEffect(() => {
    let live = true;
    setUses(null);
    void referencesOf(farmId).then((sources) => {
      if (!live) return;
      setUses((sources?.metrics ?? [])
        .filter((m) => metricKeys.includes(m.metric))
        .flatMap((m) => {
          const mine = m.passages.filter((p) => entry.documentIds.includes(p.document_id));
          return mine.length ? [{ key: m.metric, places: [...new Set(mine.map((p) => p.location).filter((v): v is string => !!v))] }] : [];
        }));
    });
    return () => { live = false; };
  }, [farmId, entry.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const thin = thinOnCultivation(stats);
  const scanned = scanSuspect(entry, stats);
  const answers = citations?.answers.slice(0, 4) ?? [];
  return (
    <div className="fm-book-infobody">
      <div className="fm-lib-use">
        {entry.state === "needs_review" ? (
          <>
            <span><strong>{L("확인을 기다리는 자료", "Waiting for a check")}</strong><small>{L("글을 읽어 보고 답변에 쓰게 합니다.", "Read it, then let answers use it.")}</small></span>
            <button type="button" className="fm-primary" disabled={busy || entry.status !== "ready"} onClick={() => onAsk({ kind: "use", entry })}>{L("답변에 사용", "Use in answers")}</button>
          </>
        ) : (
          <>
            <span>
              <strong>{L("답변에 사용", "Used in answers")}</strong>
              <small>{entry.state === "active" ? entry.pausedParts ? L(`${entry.pausedParts}쪽은 쓰지 않습니다.`, `${entry.pausedParts} pages are not used.`) : L("AI 상담이 이 자료를 찾아 인용합니다.", "The AI advisor searches and cites it.") : L("AI 상담이 이 자료를 찾지 않습니다.", "The AI advisor does not search it.")}</small>
            </span>
            <Switch on={entry.state === "active"} disabled={busy} label={L("답변에 사용", "Used in answers")} onChange={(on) => onAsk({ kind: on ? "use" : "stop", entry })} />
          </>
        )}
      </div>
      {change && (
        <div className="fm-lib-confirm" role="alertdialog" aria-label={L("변경 확인", "Confirm the change")}>
          <p>
            {change.kind === "remove"
              ? L(`'${entry.title}'${josa(entry.title, "을", "를")} 자료실에서 지웁니다. 되돌릴 수 없습니다.`, `'${entry.title}' will be removed from the library. This cannot be undone.`)
              : change.kind === "use"
                ? L(`'${entry.title}'${josa(entry.title, "을", "를")} 답변에 씁니다.`, `Answers will use '${entry.title}'.`)
                : L(`'${entry.title}'${josa(entry.title, "을", "를")} 답변에서 뺍니다.`, `Answers will stop using '${entry.title}'.`)}
          </p>
          {fallsBack && <p className="fm-lib-confirm-warn">{L("이 변경으로 자료 목록이 검색 방식을 맞춘 때와 달라져, 질문별 검색 방법 고르기가 꺼지고 모든 질문을 기본 검색으로 찾습니다.", "This changes the set of guides the search policy was tuned to: choosing a search method per question turns off, and every question uses the default search.")}</p>}
          <div>
            <button type="button" className={change.kind === "remove" ? "fm-danger" : "fm-primary"} onClick={() => onApply(change)}>{change.kind === "remove" ? L("지우기 확인", "Confirm remove") : L("계속", "Continue")}</button>
            <button type="button" onClick={onCancel}>{L("취소", "Cancel")}</button>
          </div>
        </div>
      )}
      <section className="fm-lib-usage" aria-label={L("쓰임", "Where it is used")}>
        <h4>{L("이 자료를 인용한 답변", "Answers that cited it")}</h4>
        <p className="fm-lib-usage-count">
          {citations === null ? L("답변 기록을 찾는 중…", "Looking through the answers…")
            : citations.answer_count ? L(`답변 ${citations.answer_count}개${citations.answers[0]?.asked_at ? `, 최근 ${shortStamp(citations.answers[0].asked_at)}` : ""}`, `${citations.answer_count} ${citations.answer_count === 1 ? "answer" : "answers"}${citations.answers[0]?.asked_at ? `, last ${shortStamp(citations.answers[0].asked_at)}` : ""}`)
              : L("아직 답변에 인용되지 않았습니다.", "Not cited by an answer yet.")}
        </p>
        {answers.map((a) => (
          <button type="button" key={a.response_id ?? `${a.question}:${a.asked_at}`} className="fm-setting-row is-nav" onClick={() => onOpenAnswer(askedPlace(a))}>
            <span>
              <strong lang={korean(a.question)}>{a.question}</strong>
              <small>{[a.asked_at ? shortStamp(a.asked_at) : null, placeOf(askedPlace(a)) ?? L("농장 전체", "Whole farm")].filter(Boolean).join(", ")}</small>
            </span>
            <FarmIcon name="chevron" />
          </button>
        ))}
        <h5>{L("대시보드 관측 기준에 쓰임", "Quoted for a reading's range")}</h5>
        {uses === null ? <p className="fm-hint" role="status">{L("관측 기준 문장을 확인하는 중…", "Checking the readings' reference sentences…")}</p>
          : uses.length ? uses.map((u) => (
            <button type="button" key={u.key} className="fm-setting-row is-nav" onClick={() => onOpenReading(u.key)}>
              <span><strong>{L(`${metricLabel(u.key)} 기준 문장`, `${metricLabel(u.key)} range sentence`)}</strong><small>{u.places.map((p) => readableLocator(p)).join(", ")}</small></span>
              <FarmIcon name="chevron" />
            </button>
          ))
          : <p className="fm-hint">{L("관측 행의 재배 자료 기준으로 인용되지 않습니다.", "Not quoted in any reading's guide range.")}</p>}
      </section>
      <section className="fm-lib-quality" aria-label={L("추출한 글", "Extracted text")}>
        <h4>{L("추출한 글", "Extracted text")}</h4>
        <p>{L(`${entry.parts}개 쪽이나 절, 글자 ${number(stats.chars)}자, 검색 조각 ${number(stats.chunks)}개`, `${entry.parts} ${entry.parts === 1 ? "page or section" : "pages or sections"}, ${number(stats.chars)} characters, ${number(stats.chunks)} ${stats.chunks === 1 ? "passage" : "passages"}`)}</p>
        {(stats.emptyParts > 0 || scanned || thin) && (
          <ul className="fm-lib-flags">
            {stats.emptyParts > 0 && <li>{L(`글이 추출되지 않은 쪽 ${stats.emptyParts}개`, `${stats.emptyParts} ${stats.emptyParts === 1 ? "page" : "pages"} with no extracted text`)}</li>}
            {scanned && <li>{L("쪽당 글자가 매우 적습니다. 스캔한 PDF일 수 있고, 그림 속 글은 읽지 않았습니다.", "Very little text per page: it may be a scanned PDF, and text inside images was not read.")}</li>}
            {thin && <li>{L("본문에 재배 관련 낱말이 거의 없습니다. 재배 질문의 근거로 맞는지 확인하세요.", "The text carries almost no growing-practice words. Check that it fits growing questions.")}</li>}
          </ul>
        )}
      </section>
      {entry.owned && (
        <footer className="fm-lib-detail-foot">
          <button type="button" className="fm-danger-outline" disabled={busy} onClick={() => onAsk({ kind: "remove", entry })}>{L("자료 지우기", "Remove the guide")}</button>
        </footer>
      )}
    </div>
  );
}

/** Adding the farm's own document: farm-only by default, so it never goes to an outside AI unless the farm allows it. */
function LibraryUpload({ farmId, onCancel, onDone, warnFallback }: { farmId: FarmId; onCancel: () => void; onDone: (title: string) => void | Promise<void>; warnFallback: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState<"private" | "public">("private");
  const [issuer, setIssuer] = useState("");
  const [year, setYear] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="fm-library-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!file || !title.trim()) return;
        setBusy(true); setError("");
        uploadKnowledge(farmId, file, scope, { title: title.trim(), issuer, publishedYear: year })
          .then(() => onDone(title.trim()))
          .catch((err) => setError(err instanceof Error ? err.message : L("올리지 못했습니다.", "Could not upload it.")))
          .finally(() => setBusy(false));
      }}
    >
      <label>{L("파일 (PDF, Word DOCX, TXT, MD, CSV)", "File (PDF, Word DOCX, TXT, MD, CSV)")}<input type="file" accept=".pdf,.docx,.txt,.md,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown,text/csv" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, "")); }} /></label>
      <label>{L("자료 이름", "Title")}<input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder={L("예: 우리 농장 관수 기준, GAP 인증 기준", "e.g. Our irrigation rules, GAP criteria")} /></label>
      <fieldset className="fm-library-scope">
        <legend>{L("공개 범위", "Scope")}</legend>
        <label><input type="radio" name="fm-library-scope" checked={scope === "private"} onChange={() => setScope("private")} /><span><b>{L("농장 전용", "Farm only")}</b><small>{L("우리 농장 기준과 기록. 외부 AI로 보내지 않고 원문 발췌로만 답합니다(설정에서 허용한 경우 제외).", "Your own rules and records. Not sent to an outside AI; answers quote them (unless allowed in settings).")}</small></span></label>
        <label><input type="radio" name="fm-library-scope" checked={scope === "public"} onChange={() => setScope("public")} /><span><b>{L("공개 자료", "Public")}</b><small>{L("누구나 볼 수 있는 기관 자료나 논문. 외부 AI가 읽고 답할 수 있습니다.", "Published guides or papers anyone can read. The outside AI may read them.")}</small></span></label>
      </fieldset>
      <div className="fm-library-meta">
        <label>{L("발행 기관 (선택)", "Issuer (optional)")}<input value={issuer} maxLength={120} onChange={(e) => setIssuer(e.target.value)} /></label>
        <label>{L("발행 연도 (선택)", "Year (optional)")}<input inputMode="numeric" value={year} maxLength={4} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} /></label>
      </div>
      {warnFallback && <p className="fm-lib-confirm-warn">{L("올리면 자료 목록이 검색 방식을 맞춘 때와 달라져, 질문별 검색 방법 고르기가 꺼지고 모든 질문을 기본 검색으로 찾습니다.", "Uploading changes the set of guides the search policy was tuned to: choosing a search method per question turns off, and every question uses the default search.")}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="fm-library-add-actions">
        <button className="fm-primary" disabled={!file || !title.trim() || busy}>{busy ? L("올리는 중…", "Uploading…") : L("올리기", "Upload")}</button>
        <button type="button" onClick={onCancel}>{L("취소", "Cancel")}</button>
      </div>
      <p className="fm-hint">{L("올린 자료는 '검토 대기'로 들어갑니다. 내용을 확인하고 '답변에 사용'을 눌러야 AI 답변에 쓰입니다. 올린 파일은 원본 그대로 보관해 원본 보기에서 인용한 곳을 표시합니다.", "Uploads start as 'Waiting for a check'. Answers use them after you choose 'Use in answers'. The file is kept as it is, and the original view marks where answers cited it.")}</p>
      <RefNote kind="standards" compact />
    </form>
  );
}

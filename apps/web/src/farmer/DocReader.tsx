import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { getKnowledge } from "../api";
import type { FarmId, KnowledgeDocument } from "../types";
import { evidenceFeedback, knowledgeDocument, originalStatus, sendEvidenceFeedback } from "./assist-api";
import type { KnowledgeDocumentDetail, OriginalStatus } from "./assist-api";
import { bookKey, findSpan, isFileUrl, pageNumber, segments, textFragmentUrl } from "./doc-reader";
import type { Mark } from "./doc-reader";
import type { Highlight, Jump } from "./original-types";
import { FarmIcon } from "./FarmIcon";
import { getLang, L, term } from "./i18n";
import { readableLocator } from "./readable-excerpt";

const OriginalViewer = lazy(() => import("./OriginalViewer").then((m) => ({ default: m.OriginalViewer })));

/** A place in a guide to show: the excerpt the AI read from one passage, or a sentence the screen quoted. */
export type ReaderPassage = { documentId: string; chunkId?: string | null; text?: string | null; kind: "read" | "quote" };
export type ReaderTarget = {
  passages: ReaderPassage[];
  /** Which passage opens first. */
  start?: number;
  /** The answer these passages were cited in: its passages can be flagged as not fitting the question. */
  responseId?: string | null;
};

// Every page of the library, read once, to step to the neighbouring pages of the same guide.
const libraries = new Map<string, Promise<KnowledgeDocument[]>>();
function libraryDocuments(farmId: FarmId) {
  if (!libraries.has(farmId)) libraries.set(farmId, getKnowledge(farmId).then((r) => r.data).catch(() => { libraries.delete(farmId); return []; }));
  return libraries.get(farmId)!;
}
export const forgetLibraryDocuments = () => libraries.clear();

const korean = (text: string | null | undefined) => (getLang() !== "ko" && text && /[가-힣]/.test(text) ? "ko" : undefined);
const withoutPage = (title: string) => title.replace(/\s*[·|-]\s*(?:\d+\s*쪽|섹션\s*\d+)\s*$/u, "").trim() || title;

/**
 * The evidence reader. The cited part is shown inside its document: the
 * excerpt the AI was given is marked strongly, the rest of the passage it came
 * from lightly, and a quoted sentence on its own. Passages of one answer are
 * stepped through; neighbouring pages of the same guide are one tap away; a
 * guide opens first as its original file with the passage marked where it is
 * written (a PDF page, a web page as published, an article, a Word document),
 * the extracted text one tap away; the whole guide opens in the
 * library's reader. Beside the chat on a wide screen, so the answer and its
 * source are read together.
 */
export function DocReader({ farmId, target, onClose, onOpenLibrary, beside = false }: {
  farmId: FarmId;
  target: ReaderTarget;
  onClose?: () => void;
  /** The whole guide in the library's reader, at this page and passage. */
  onOpenLibrary?: (documentId: string, quote?: string | null) => void;
  /** Next to the open chat window. */
  beside?: boolean;
}) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, target.start ?? 0), Math.max(0, target.passages.length - 1)));
  const [pageDoc, setPageDoc] = useState<string | null>(null);
  const passage = target.passages[index] ?? null;
  const documentId = pageDoc ?? passage?.documentId ?? null;
  const [doc, setDoc] = useState<KnowledgeDocumentDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Why the document could not be read: not found or not visible here, or the connection (tried again on request).
  const [missing, setMissing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"text" | "original">("text");
  const chosen = useRef(false);
  const [original, setOriginal] = useState<OriginalStatus | null>(null);
  // Whether the original was asked about yet: the extracted text does not flash up before the original replaces it.
  const [checked, setChecked] = useState(false);
  // The original could not be asked about (the connection): the extracted text is shown, and asking again is offered.
  const [statusLost, setStatusLost] = useState(false);
  const [failed, setFailed] = useState("");
  const [jump, setJump] = useState<Jump | null>(null);
  // Which of this document's passages the original holds, in the order of the highlights.
  const [marked, setMarked] = useState<boolean[] | null>(null);
  // Of those not found as written, which were marked as the same content in the source's own words.
  const [similar, setSimilar] = useState<boolean[] | null>(null);
  const [library, setLibrary] = useState<KnowledgeDocument[]>([]);
  const [flagged, setFlagged] = useState<string[]>([]);
  const [flagError, setFlagError] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  // The way chosen (or opened) is kept from passage to passage; a document without an original shows its extracted text.
  const canOriginal = !!original && (original.available || original.fetchable) && !failed;
  const view = canOriginal && mode === "original" ? "original" : "text";
  const waiting = !checked && !(chosen.current && mode === "text");

  // A new target (another citation tapped) starts over at its own first passage.
  useEffect(() => {
    setIndex(Math.min(Math.max(0, target.start ?? 0), Math.max(0, target.passages.length - 1)));
    setPageDoc(null);
  }, [target]);
  useEffect(() => {
    if (!documentId) return;
    let live = true;
    setState("loading");
    setOriginal(null);
    setChecked(false);
    setStatusLost(false);
    setMarked(null);
    setSimilar(null);
    setFailed("");
    setMissing(false);
    knowledgeDocument(farmId, documentId)
      .then((d) => { if (live) { setDoc(d); setState("ready"); } })
      .catch((e: { status?: number }) => {
        if (!live) return;
        setMissing(e?.status === 404 || e?.status === 403);
        setState("error");
      });
    originalStatus(farmId, documentId)
      .then((s) => {
        if (!live) return;
        setOriginal(s);
        // The original opens first when there is one, unless the reader chose the extracted text.
        if (!chosen.current && (s.available || s.fetchable)) setMode("original");
      })
      .catch((e: { status?: number }) => { if (live && !e?.status) setStatusLost(true); })
      .finally(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [farmId, documentId, attempt]);
  useEffect(() => { void libraryDocuments(farmId).then(setLibrary); }, [farmId]);
  // A reader left open while the connection was down reads again once the browser is back online.
  useEffect(() => {
    if (!(state === "error" && !missing) && !statusLost) return;
    const again = () => setAttempt((n) => n + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [state, missing, statusLost]);
  useEffect(() => {
    if (!target.responseId) return;
    let live = true;
    evidenceFeedback(farmId, target.responseId)
      .then((r) => { if (live) setFlagged(r.feedback.map((f) => `${f.document_id}:${f.chunk_id ?? ""}`)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [farmId, target.responseId]);
  // Opening moves focus into the reader; Escape (below) and the close button give it back.
  useEffect(() => { rootRef.current?.focus(); }, [target]);

  // The marks on this document: every passage of the target that lives here.
  const marks = useMemo(() => {
    const byChunk = new Map<string, Mark[]>();
    if (!doc) return byChunk;
    for (const p of target.passages) {
      if (p.documentId !== doc.id) continue;
      const chunks = p.chunkId ? doc.chunks.filter((c) => c.id === p.chunkId) : doc.chunks;
      for (const chunk of chunks.length ? chunks : doc.chunks) {
        const span = findSpan(chunk.text, p.text);
        if (p.kind === "read" && p.chunkId === chunk.id) {
          const list = byChunk.get(chunk.id) ?? [];
          list.push({ start: 0, end: chunk.text.length, kind: "retrieved" });
          if (span) list.push({ ...span, kind: "read" });
          byChunk.set(chunk.id, list);
          break;
        }
        if (span) {
          byChunk.set(chunk.id, [...(byChunk.get(chunk.id) ?? []), { ...span, kind: p.kind === "quote" ? "quote" : "read" }]);
          break;
        }
      }
    }
    return byChunk;
  }, [doc, target]);
  // The current passage is brought into view once its document is on screen.
  useEffect(() => {
    if (state !== "ready" || view !== "text") return;
    const id = requestAnimationFrame(() => {
      const current = passage && doc && passage.documentId === doc.id ? bodyRef.current?.querySelector<HTMLElement>(`[data-chunk="${CSS.escape(passage.chunkId ?? "")}"] .fm-mark-read, [data-chunk="${CSS.escape(passage.chunkId ?? "")}"] .fm-mark-quote`) : null;
      const any = current ?? bodyRef.current?.querySelector<HTMLElement>(".fm-mark-read, .fm-mark-quote");
      // The start of the cited part, not its middle: a long excerpt would open cut off at the top.
      if (any) any.scrollIntoView({ block: "start" });
      else bodyRef.current?.scrollTo({ top: 0 });
    });
    return () => cancelAnimationFrame(id);
  }, [state, view, doc, index, passage]);

  const pages = useMemo(() => {
    if (!doc) return [];
    const key = bookKey({ id: doc.id, sourceGroupId: doc.source_group_id, sourceUrl: doc.source_url });
    return library
      .filter((d) => bookKey(d) === key)
      .map((d) => ({ id: d.id, page: pageNumber(d.sourceLocator) ?? pageNumber(d.title) }))
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0));
  }, [doc, library]);
  const pageAt = pages.findIndex((p) => p.id === doc?.id);
  const prevPage = pageAt > 0 ? pages[pageAt - 1] : null;
  const nextPage = pageAt >= 0 && pageAt < pages.length - 1 ? pages[pageAt + 1] : null;
  const locator = doc?.source_locator ?? null;
  const passageText = passage && doc && passage.documentId === doc.id ? passage.text ?? null : null;
  const siteLink = doc?.source_url && /^https?:/i.test(doc.source_url) ? textFragmentUrl(doc.source_url, passageText) : null;
  // The passages of this answer that live in this document, the current one as the one opened at.
  const highlights: Highlight[] = useMemo(() => (doc
    ? target.passages.filter((p) => p.documentId === doc.id && p.text).map((p) => ({ text: p.text!, page: original?.page ?? pageNumber(locator), kind: p === passage ? "quote" as const : "cited" as const }))
    : []), [doc, target, passage, original, locator]);
  // Stepping to another passage of the same document turns the original to it.
  useEffect(() => {
    if (view === "original" && passage && doc && passage.documentId === doc.id) setJump({ page: original?.page ?? pageNumber(locator), text: passage.text ?? null, nonce: Date.now() });
  }, [index]); // eslint-disable-line react-hooks/exhaustive-deps
  // The passage opened at could not be found in the original (it holds the other passages, or none).
  const quoteAt = highlights.findIndex((h) => h.kind === "quote");
  const quoteMissing = marked !== null && quoteAt >= 0 && marked[quoteAt] === false;
  const quoteLike = quoteMissing && !!similar?.[quoteAt];
  const flagKey = passage ? `${passage.documentId}:${passage.chunkId ?? ""}` : "";
  const stateBadge = doc?.retrieval_state === "needs_review" ? L("검토 대기", "Waiting for a check") : doc?.retrieval_state === "paused" ? L("답변에 쓰지 않음", "Not used in answers") : null;

  async function flag() {
    if (!passage) return;
    setFlagError("");
    try {
      await sendEvidenceFeedback(farmId, { document_id: passage.documentId, chunk_id: passage.chunkId ?? null, response_id: target.responseId ?? null });
      setFlagged((f) => [...new Set([...f, flagKey])]);
    } catch (e) {
      setFlagError(e instanceof Error ? e.message : L("기록하지 못했습니다.", "Could not record it."));
    }
  }
  // Another passage or page keeps the way it is being read (the original turns to it).
  function go(step: number) {
    setPageDoc(null);
    setIndex((i) => Math.min(target.passages.length - 1, Math.max(0, i + step)));
  }
  const readKinds = target.passages.some((p) => p.kind === "read");

  return (
    <section
      ref={rootRef}
      className={`fm-reader is-floating ${beside ? "is-beside" : ""}`}
      role="dialog"
      aria-label={L("근거 원문", "Source text")}
      tabIndex={-1}
      onKeyDown={(e) => { if (e.key === "Escape" && onClose) { e.stopPropagation(); onClose(); } }}
    >
      <header className="fm-reader-head">
        <FarmIcon name="file" />
        <div className="fm-reader-title">
          <h2 lang={korean(doc?.title)}>{doc ? withoutPage(doc.title) : L("근거 원문", "Source text")}</h2>
          {doc && (
            <p>
              <span lang={korean([doc.issuer, doc.document_type].join(""))}>{[doc.issuer, doc.published_year, doc.document_type ? term(doc.document_type) : null, locator ? readableLocator(locator) : null].filter(Boolean).join(", ")}</span>
              <em className={`fm-badge ${doc.scope === "private" ? "is-info" : "is-off"}`}>{doc.scope === "private" ? L("농장 전용", "Farm only") : L("공개 자료", "Public")}</em>
              {stateBadge && <em className="fm-badge is-warn">{stateBadge}</em>}
            </p>
          )}
        </div>
        {onClose && <button type="button" className="fm-reader-close" aria-label={L("원문 닫기", "Close source")} onClick={onClose}><FarmIcon name="close" /></button>}
      </header>
      <div className="fm-reader-bar">
        {target.passages.length > 1 && (
          <div className="fm-reader-step" role="group" aria-label={L("인용한 곳", "Cited passages")}>
            <button type="button" aria-label={L("이전 인용", "Previous passage")} disabled={index === 0} onClick={() => go(-1)}><FarmIcon name="back" /></button>
            <span>{L(`인용 ${index + 1}/${target.passages.length}`, `Passage ${index + 1} of ${target.passages.length}`)}</span>
            <button type="button" aria-label={L("다음 인용", "Next passage")} disabled={index >= target.passages.length - 1} onClick={() => go(1)}><FarmIcon name="chevron" /></button>
          </div>
        )}
        {canOriginal && (
          <div className="fm-segment fm-reader-mode" role="group" aria-label={L("보기 방식", "View")}>
            <button type="button" aria-pressed={view === "original"} onClick={() => { chosen.current = true; setMode("original"); }}>{L("원본", "Original")}</button>
            <button type="button" aria-pressed={view === "text"} onClick={() => { chosen.current = true; setMode("text"); }}>{L("추출한 글", "Extracted text")}</button>
          </div>
        )}
        {pages.length > 1 && (
          <div className="fm-reader-pages" role="group" aria-label={L("같은 자료의 다른 쪽", "Other pages of this guide")}>
            <button type="button" disabled={!prevPage} onClick={() => prevPage && setPageDoc(prevPage.id)}>
              <FarmIcon name="back" />{prevPage?.page ? L(`${prevPage.page}쪽`, `p. ${prevPage.page}`) : L("이전 쪽", "Previous")}
            </button>
            <button type="button" disabled={!nextPage} onClick={() => nextPage && setPageDoc(nextPage.id)}>
              {nextPage?.page ? L(`${nextPage.page}쪽`, `p. ${nextPage.page}`) : L("다음 쪽", "Next")}<FarmIcon name="chevron" />
            </button>
          </div>
        )}
      </div>
      {view === "text" && marks.size > 0 && (
        <p className="fm-reader-legend">
          {readKinds && <span><i className="fm-mark-read" aria-hidden="true" />{L("AI에게 넘긴 부분", "Given to the AI")}</span>}
          {readKinds && <span><i className="fm-mark-retrieved" aria-hidden="true" />{L("같은 검색 조각", "Rest of the passage found")}</span>}
          {target.passages.some((p) => p.kind === "quote") && <span><i className="fm-mark-quote" aria-hidden="true" />{L("인용한 문장", "Quoted sentence")}</span>}
        </p>
      )}
      {statusLost && state === "ready" && (
        <p className="fm-book-failed" role="status">
          {L("서버에 연결하지 못해 원본을 확인하지 못했습니다. 추출한 글로 보여 줍니다.", "Could not reach the server to check for the original, so the extracted text is shown.")}{" "}
          <button type="button" className="fm-link-button" onClick={() => setAttempt((n) => n + 1)}>{L("다시 확인", "Check again")}</button>
        </p>
      )}
      {failed && <p className="fm-book-failed" role="status">{L(`원본을 열지 못해 추출한 글로 보여 줍니다. ${failed}`, `The original could not be opened, so the extracted text is shown. ${failed}`)}</p>}
      {view === "original" && original?.origin === "local_changed" && (
        <p className="fm-book-failed" role="status">{L("이 원본은 자료를 모은 뒤 다시 받은 파일이라 일부가 다를 수 있습니다.", "This original was downloaded again after the guide was collected, so parts of it may differ.")}</p>
      )}
      {view === "original" && quoteMissing && (
        <p className="fm-book-failed" role="status">
          {quoteLike
            ? L("이 자료는 원문을 요약해 담아 인용한 글과 같은 글은 원본에 없습니다. 같은 내용을 담은 원문 문장을 점선으로 표시했습니다.", "This guide was kept as a summary, so the cited words are not in the original. The original sentences that say the same are underlined with dashes.")
            : L("이 인용은 원본의 글과 달라 원본에서 찾지 못했습니다(요약이나 번역으로 담긴 자료 등).", "This passage reads differently in the original, so it could not be found there (a guide kept as a summary or a translation, for example).")}{" "}
          <button type="button" className="fm-link-button" onClick={() => { chosen.current = true; setMode("text"); }}>{L("추출한 글에서 보기", "See it in the extracted text")}</button>
        </p>
      )}
      <div className={`fm-reader-body ${view === "original" ? "is-original" : ""}`} ref={bodyRef} lang={korean(doc?.chunks[0]?.text)}>
        {(state === "loading" || (state === "ready" && waiting)) && <p className="fm-hint" role="status">{L("원문을 불러오는 중…", "Loading the source…")}</p>}
        {state === "error" && (missing
          ? <p role="alert">{L("이 자료를 찾지 못했습니다. 자료가 지워졌거나 이 농장에서 볼 수 없는 자료입니다.", "This guide was not found. It may have been removed or is not visible on this farm.")}</p>
          : (
            <div className="fm-reader-retry" role="alert">
              <p>{L("서버에 연결하지 못해 원문을 불러오지 못했습니다.", "Could not reach the server to load the source.")}</p>
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>{L("다시 불러오기", "Try again")}</button>
            </div>
          ))}
        {state === "ready" && doc && view === "text" && !waiting && (
          doc.chunks.length ? doc.chunks.map((chunk) => (
            <p key={chunk.id} className="fm-reader-chunk" data-chunk={chunk.id}>
              {segments(chunk.text, marks.get(chunk.id) ?? []).map((s, i) =>
                s.kind ? <mark key={i} className={`fm-mark-${s.kind}`}>{s.text}</mark> : <span key={i}>{s.text}</span>,
              )}
            </p>
          )) : <p className="fm-hint">{L("이 자료에서 추출한 글이 없습니다.", "No text was extracted from this document.")}</p>
        )}
        {state === "ready" && doc && view === "original" && original && (
          <Suspense fallback={<p className="fm-hint" role="status">{L("원본 보기를 준비하는 중…", "Preparing the original…")}</p>}>
            <OriginalViewer
              farmId={farmId}
              documentId={doc.id}
              status={original}
              sourceUrl={doc.source_url && /^https?:/i.test(doc.source_url) && !isFileUrl(doc.source_url) ? doc.source_url : null}
              highlights={highlights}
              focusPage={original.page ?? pageNumber(locator)}
              jump={jump}
              onMarked={(located, like) => { setMarked(located); setSimilar(like ?? null); }}
              onFail={setFailed}
            />
          </Suspense>
        )}
      </div>
      <footer className="fm-reader-foot">
        {siteLink && (
          <a href={siteLink} target="_blank" rel="noreferrer">
            {isFileUrl(doc?.source_url) ? L("원문 파일 열기", "Open the source file") : passageText ? L("원문 사이트에서 이 부분 보기", "See this part on the source site") : L("원문 사이트 열기", "Open the source site")}
            <FarmIcon name="external" />
          </a>
        )}
        {onOpenLibrary && doc && <button type="button" onClick={() => onOpenLibrary(doc.id, passageText)}>{L("자료 전체 읽기", "Read the whole guide")}</button>}
        {target.responseId && passage && (flagged.includes(flagKey)
          ? <span className="fm-reader-flagged" role="status"><FarmIcon name="check" />{L("질문과 관계없다고 기록함", "Recorded as not fitting")}</span>
          : <button type="button" className="fm-reader-flag" onClick={() => void flag()} title={L("검색 평가 자료로만 남깁니다. 답변과 자료는 바뀌지 않습니다.", "Kept for evaluating search only. The answer and the guide do not change.")}><FarmIcon name="flag" />{L("질문과 관계없음", "Does not fit the question")}</button>)}
        {flagError && <small role="alert">{flagError}</small>}
      </footer>
    </section>
  );
}

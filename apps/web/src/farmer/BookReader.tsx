import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { FarmId } from "../types";
import { AiMark } from "./AiBrief";
import { bookTexts, originalStatus } from "./assist-api";
import type { CitingAnswer, KnowledgeDocumentDetail, OriginalStatus, PassageCitations } from "./assist-api";
import { findSpans, reflowText, rememberReading, runningHead, tocLabel } from "./book-text";
import type { BookPart, ReadingMark } from "./book-text";
import { findSpan, pageNumber, segments } from "./doc-reader";
import type { Mark } from "./doc-reader";
import type { Highlight, Jump } from "./original-types";
import { FarmIcon } from "./FarmIcon";
import { getLang, L } from "./i18n";
import { shortStamp } from "./time-format";

const OriginalViewer = lazy(() => import("./OriginalViewer").then((m) => ({ default: m.OriginalViewer })));

/** Where a guide opens: a page, and a sentence on it to mark. */
export type BookStart = { documentId?: string | null; quote?: string | null };
/** The place an answer was asked about, as the workspace opens it. */
export type AskedPlace = { queryContext?: { bedId?: string | null; zoneScopeMode?: string; selectedZoneIds?: string[] } | null; responseId?: string | null };

const SIZES = [16, 18, 20] as const;
// How large an original is drawn (a PDF page, a web page, a Word document).
const ZOOMS = [0.8, 1, 1.25, 1.5] as const;
const SIZE_KEY = "farmer.bookSize";
const korean = (text: string | null | undefined) => (getLang() !== "ko" && text && /[가-힣]/.test(text) ? "ko" : undefined);
const pageId = (documentId: string) => `fm-book-${documentId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export function useWide(query = "(min-width: 1100px)") {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return wide;
}

/** The guides this farm read lately, newest first (this device only). */
export const readingKey = (farmId: FarmId) => `farmer.reading.${farmId}`;
export function readingHistory(farmId: FarmId): ReadingMark[] {
  try {
    const value = JSON.parse(localStorage.getItem(readingKey(farmId)) ?? "[]");
    return Array.isArray(value) ? value.filter((v) => v && typeof v.entryId === "string" && typeof v.documentId === "string") : [];
  } catch {
    return [];
  }
}

/** An answer as the place it was asked about. */
export const askedPlace = (a: CitingAnswer): AskedPlace => ({
  queryContext: { bedId: a.bed_id, zoneScopeMode: a.zone_scope_mode, selectedZoneIds: a.selected_zone_ids },
  responseId: a.response_id,
});

/** One page of a guide made ready to read: its text, the text as shown, its stored passages and its running head. */
type Page = { part: BookPart; doc: KnowledgeDocumentDetail | null; text: string; display: string; chunks: { id: string; start: number; end: number; cited: number }[]; head: { start: number; end: number } | null };

/**
 * The library's reading room: one guide read like a book. The contents list
 * its pages (each named by its first heading, with how often answers cited it);
 * the guide opens as its original file (a PDF page by page, a web page as it
 * was published, an article, a Word document) with the passages answers cited
 * marked in it; the text the library extracted is one tap away, page after
 * page with a printed page re-flowed into paragraphs and a line beside what
 * answers cited, and each page names the questions that cited it. Words can be
 * looked for, the page made larger, and the place is kept to carry on later.
 */
export function BookReader({ farmId, entryId, title, kindLabel, meta, parts, printed, start, citations, sourceLink, info, onBack, onOpenAnswer, placeOf }: {
  farmId: FarmId;
  entryId: string;
  title: string;
  kindLabel: string;
  meta: string;
  parts: BookPart[];
  /** A printed guide (a PDF): its lines are re-flowed and its pages can be shown as printed. */
  printed: boolean;
  start?: BookStart | null;
  citations: PassageCitations | null;
  sourceLink: { href: string; file: boolean } | null;
  /** Whether answers use it, where it is used, how its text was extracted. */
  info: ReactNode;
  onBack: () => void;
  onOpenAnswer: (asked: AskedPlace) => void;
  placeOf: (asked: AskedPlace) => string | null;
}) {
  const wide = useWide();
  const [docs, setDocs] = useState<Map<string, KnowledgeDocumentDetail>>(new Map());
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [current, setCurrent] = useState<string | null>(start?.documentId ?? parts[0]?.id ?? null);
  const [mode, setMode] = useState<"text" | "original">("text");
  const chosen = useRef(false);
  const [original, setOriginal] = useState<OriginalStatus | null>(null);
  // Whether the original was asked about yet: the extracted text does not flash up before the original replaces it.
  const [checked, setChecked] = useState(false);
  const [failed, setFailed] = useState("");
  const [zoom, setZoom] = useState(1);
  const [jump, setJump] = useState<Jump | null>(null);
  const [originalFound, setOriginalFound] = useState(0);
  // Which cited passages the original holds (a guide kept as a summary or translation holds none of them).
  const [marked, setMarked] = useState<boolean[] | null>(null);
  // Of those not found as written, which were marked as the same content in the source's own words.
  const [similar, setSimilar] = useState<boolean[] | null>(null);
  const [size, setSize] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem(SIZE_KEY));
      return (SIZES as readonly number[]).includes(saved) ? saved : 18;
    } catch {
      return 18;
    }
  });
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const textRef = useRef<HTMLDivElement>(null);
  const ids = parts.map((p) => p.id).join("|");

  useEffect(() => {
    let live = true;
    setState("loading");
    bookTexts(farmId, parts.map((p) => p.id))
      .then((read) => {
        if (!live) return;
        setDocs(new Map(read.map((d) => [d.id, d])));
        setState(read.length ? "ready" : "error");
      })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [farmId, ids]); // eslint-disable-line react-hooks/exhaustive-deps
  // A guide's pages share one original file: whether it can be shown is asked once, and it opens first when it can.
  useEffect(() => {
    if (!parts[0]) return;
    let live = true;
    setMarked(null);
    setSimilar(null);
    originalStatus(farmId, start?.documentId ?? parts[0].id)
      .then((s) => {
        if (!live) return;
        setOriginal(s);
        if (!chosen.current && (s.available || s.fetchable)) setMode("original");
      })
      .catch(() => undefined)
      .finally(() => { if (live) setChecked(true); });
    return () => { live = false; };
  }, [farmId, ids]); // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = !checked && !(chosen.current && mode === "text");

  const pages: Page[] = useMemo(() => parts.map((part) => {
    const doc = docs.get(part.id) ?? null;
    const chunks = [...(doc?.chunks ?? [])].sort((a, b) => a.ordinal - b.ordinal);
    let text = "";
    const ranges: Page["chunks"] = [];
    chunks.forEach((c, i) => {
      if (i) text += "\n";
      const at = text.length;
      text += c.text;
      ranges.push({ id: c.id, start: at, end: text.length, cited: citations?.chunks[c.id]?.count ?? 0 });
    });
    return { part, doc, text, display: printed ? reflowText(text) : text, chunks: ranges, head: printed ? runningHead(text) : null };
  }), [parts, docs, citations, printed]);

  // Words looked for, numbered through the whole guide.
  const found = useMemo(() => {
    let index = 0;
    return pages.map((p) => findSpans(p.text, query.trim().length >= 1 ? query : "").map((s) => ({ ...s, index: index++ })));
  }, [pages, query]);
  const textTotal = found.reduce((n, f) => n + f.length, 0);
  const total = mode === "original" ? originalFound : textTotal;
  // The passages answers cited, and the sentence opened at, to mark in the original.
  const highlights: Highlight[] = useMemo(() => {
    const out: Highlight[] = [];
    for (const p of pages) for (const c of p.chunks) if (c.cited) out.push({ text: p.text.slice(c.start, c.end), page: pageNumber(p.part.locator), kind: "cited" });
    if (start?.quote) out.push({ text: start.quote, page: pageNumber(parts.find((x) => x.id === start.documentId)?.locator), kind: "quote" });
    return out;
  }, [pages, start, parts]);

  // Opened at a page or a sentence: brought into view once the text is there and the pages
  // have their cited-answer lines (which would push it down), or after a moment without them.
  const [placed, setPlaced] = useState(false);
  useEffect(() => {
    if (state !== "ready" || placed || mode !== "text" || waiting) return;
    const place = () => {
      const quote = textRef.current?.querySelector<HTMLElement>("mark.fm-mark-quote");
      // A long passage opens at its start, just under the tools; a sentence in the middle of the screen.
      if (quote) quote.scrollIntoView({ block: quote.getBoundingClientRect().height > window.innerHeight * 0.4 ? "start" : "center" });
      else if (start?.documentId) document.getElementById(pageId(start.documentId))?.scrollIntoView({ block: "start" });
      setPlaced(true);
    };
    if (citations) {
      const id = requestAnimationFrame(place);
      return () => cancelAnimationFrame(id);
    }
    const id = window.setTimeout(place, 1200);
    return () => window.clearTimeout(id);
  }, [state, citations, placed, mode, waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  // The page being read: the one crossing the upper part of the screen.
  useEffect(() => {
    if (state !== "ready" || mode !== "text") return;
    const observer = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      const doc = seen[0]?.target.getAttribute("data-doc");
      if (doc) setCurrent(doc);
    }, { rootMargin: "-18% 0px -72% 0px" });
    for (const p of parts) {
      const el = document.getElementById(pageId(p.id));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [state, mode, ids]); // eslint-disable-line react-hooks/exhaustive-deps
  // The place is kept, to carry on reading from the library's front shelf.
  useEffect(() => {
    if (state !== "ready" || !current) return;
    const part = parts.find((p) => p.id === current);
    if (!part) return;
    const id = window.setTimeout(() => {
      const mark: ReadingMark = { entryId, documentId: current, title, part: part.label, at: new Date().toISOString() };
      try { localStorage.setItem(`farmer.reading.${farmId}`, JSON.stringify(rememberReading(readingHistory(farmId), mark))); } catch { /* storage unavailable */ }
    }, 700);
    return () => window.clearTimeout(id);
  }, [state, current]); // eslint-disable-line react-hooks/exhaustive-deps
  // The current found word comes into view (the original brings its own).
  useEffect(() => {
    if (!textTotal || mode !== "text") return;
    textRef.current?.querySelector<HTMLElement>(`mark[data-find="${hit}"]`)?.scrollIntoView({ block: "center" });
  }, [hit, textTotal, query, mode]);

  function goTo(documentId: string) {
    setCurrent(documentId);
    if (mode === "text") { document.getElementById(pageId(documentId))?.scrollIntoView({ block: "start" }); return; }
    // In the original: a PDF turns to the page; another document to where the section's text begins.
    const part = pages.find((p) => p.part.id === documentId);
    setJump({ page: pageNumber(part?.part.locator), text: part?.text.slice(0, 200) ?? null, nonce: Date.now() });
  }
  function resize(step: number) {
    if (mode === "original") {
      const at = ZOOMS.indexOf(zoom as (typeof ZOOMS)[number]);
      setZoom(ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, at + step))]);
      return;
    }
    const at = SIZES.indexOf(size as (typeof SIZES)[number]);
    const next = SIZES[Math.min(SIZES.length - 1, Math.max(0, at + step))];
    setSize(next);
    try { localStorage.setItem(SIZE_KEY, String(next)); } catch { /* storage unavailable */ }
  }
  function choose(next: "text" | "original") {
    chosen.current = true;
    setMode(next);
    setHit(0);
    setMarked(null);
    setSimilar(null);
  }
  /** A PDF page read in the original: the guide's page it is, when the library holds it. */
  function readingPage(page: number) {
    const part = parts.find((p) => pageNumber(p.locator) === page);
    if (part) setCurrent(part.id);
  }
  const step = (by: number) => setHit((h) => (total ? (h + by + total) % total : 0));

  const citeCount = (p: Page) => p.chunks.reduce((n, c) => n + c.cited, 0);
  const currentPart = parts.find((p) => p.id === current) ?? parts[0];
  const canOriginal = !!original && (original.available || original.fetchable) && !failed;
  const openAt = parts.find((p) => p.id === start?.documentId) ?? parts[0];
  const quoteOn = (p: Page) => (start?.quote && start.documentId === p.part.id ? start.quote : null);
  const anyCited = pages.some((p) => p.chunks.some((c) => c.cited));
  const markedCount = marked ? marked.filter(Boolean).length : null;
  const unmarked = mode === "original" && marked !== null && markedCount !== null && markedCount < marked.length;
  const likeCount = similar ? similar.filter(Boolean).length : 0;
  // The original or the extracted text: in the tools on a wide screen; on a phone above the text, out of the bar that stays in view.
  const modeSwitch = canOriginal && (
    <div className="fm-segment fm-book-mode" role="group" aria-label={L("보기 방식", "View")}>
      <button type="button" aria-pressed={mode === "original"} onClick={() => choose("original")}>{L("원본", "Original")}</button>
      <button type="button" aria-pressed={mode === "text"} onClick={() => choose("text")}>{L("추출한 글", "Extracted text")}</button>
    </div>
  );

  const contents = (
    <nav className="fm-book-toc" aria-label={L("목차", "Contents")}>
      <h3>{L(`목차, ${parts.length}${printed ? "쪽" : "개"}`, `Contents, ${parts.length} ${printed ? (parts.length === 1 ? "page" : "pages") : (parts.length === 1 ? "part" : "parts")}`)}</h3>
      <ol>
        {pages.map((p) => {
          const n = citeCount(p);
          return (
            <li key={p.part.id}>
              <button type="button" aria-current={p.part.id === currentPart?.id || undefined} onClick={() => goTo(p.part.id)}>
                <b>{p.part.label}</b>
                <span lang={korean(p.text)}>{p.doc ? tocLabel(p.text, printed) : ""}</span>
                {n > 0 && <em title={L(`답변 인용 ${n}회`, `Cited ${n}×`)}>AI {n}</em>}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );

  return (
    <article className="fm-book" aria-labelledby="fm-book-title" style={{ ["--book-size" as string]: `${size}px` }}>
      <header className="fm-book-head">
        <button type="button" className="fm-back" onClick={onBack}><FarmIcon name="back" />{L("자료 목록", "All guides")}</button>
        <div className="fm-book-titles">
          <small className="fm-book-kindlabel">{kindLabel}</small>
          <h2 id="fm-book-title" lang={korean(title)}>{title}</h2>
          <p lang={korean(meta)}>{meta}</p>
        </div>
        {sourceLink && (
          <a className="fm-book-source" href={sourceLink.href} target="_blank" rel="noreferrer">
            {sourceLink.file ? L("원문 파일", "Source file") : L("원문 사이트", "Source site")}<FarmIcon name="external" />
          </a>
        )}
      </header>
      <div className="fm-book-layout">
        {wide && contents}
        <div className="fm-book-main">
          {!wide && <details className="fm-book-infobox"><summary>{L("자료 정보와 쓰임", "About this guide")}</summary>{info}</details>}
          {!wide && modeSwitch}
          <div className="fm-book-tools">
            {!wide && parts.length > 1 && (
              <label className="fm-book-jump">
                <FarmIcon name="list" />
                <span className="fm-visually-hidden">{L("쪽으로 가기", "Go to a page")}</span>
                <select value={currentPart?.id ?? ""} onChange={(e) => goTo(e.target.value)}>
                  {pages.map((p) => <option key={p.part.id} value={p.part.id}>{[p.part.label, p.doc ? tocLabel(p.text, printed, 18) : ""].filter(Boolean).join(" ")}{citeCount(p) ? ` (AI ${citeCount(p)})` : ""}</option>)}
                </select>
              </label>
            )}
            <label className="fm-book-find">
              <FarmIcon name="search" />
              <span className="fm-visually-hidden">{L("이 자료에서 찾기", "Find in this guide")}</span>
              <input type="search" value={query} placeholder={L("이 자료에서 찾기", "Find in this guide")} onChange={(e) => { setQuery(e.target.value); setHit(0); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} />
              {query.trim() && <small role="status">{total ? `${hit + 1}/${total}` : L("없음", "None")}</small>}
            </label>
            {query.trim() && total > 1 && (
              <span className="fm-book-findnav">
                <button type="button" aria-label={L("이전 찾은 곳", "Previous match")} onClick={() => step(-1)}><FarmIcon name="up" /></button>
                <button type="button" aria-label={L("다음 찾은 곳", "Next match")} onClick={() => step(1)}><FarmIcon name="down" /></button>
              </span>
            )}
            <span className="fm-book-size" role="group" aria-label={L("글자 크기", "Text size")}>
              <button type="button" disabled={mode === "original" ? zoom === ZOOMS[0] : size === SIZES[0]} aria-label={L("작게", "Smaller")} onClick={() => resize(-1)}>{L("가", "A")}<sup>−</sup></button>
              <button type="button" disabled={mode === "original" ? zoom === ZOOMS[ZOOMS.length - 1] : size === SIZES[SIZES.length - 1]} aria-label={L("크게", "Larger")} onClick={() => resize(1)}>{L("가", "A")}<sup>+</sup></button>
            </span>
            {wide && modeSwitch}
          </div>
          {anyCited && mode === "text" && <p className="fm-book-legend"><i aria-hidden="true" />{L("왼쪽 선: AI 답변이 인용한 곳", "Line on the left: where AI answers cited this guide")}</p>}
          {anyCited && mode === "original" && !unmarked && <p className="fm-book-legend is-original"><i aria-hidden="true" />{L("색칠: AI 답변이 인용한 곳", "Tinted: where AI answers cited this guide")}</p>}
          {unmarked && marked && (
            <p className="fm-book-failed" role="status">
              {!markedCount && likeCount === marked.length
                ? L("이 자료는 원문을 요약해 담아 AI 답변이 인용한 글과 같은 글은 원본에 없습니다. 같은 내용을 담은 원문 문장을 점선으로 표시했습니다.", "This guide was kept as a summary, so the words AI answers cited are not in the original. The original sentences that say the same are underlined with dashes.")
                : <>
                  {markedCount
                    ? L(`AI 답변이 인용한 곳 ${marked.length}곳 중 ${markedCount}곳을 원본에서 찾아 색칠했습니다. 나머지는 원본의 글과 달라 찾지 못했습니다.`, `${markedCount} of the ${marked.length} places AI answers cited were found in the original and tinted. The rest read differently in the original.`)
                    : L("AI 답변이 인용한 글이 원본의 글과 달라 원본에서 찾지 못했습니다(요약이나 번역으로 담긴 자료 등).", "The text AI answers cited reads differently in the original, so it could not be found there (a guide kept as a summary or a translation, for example).")}{" "}
                  {likeCount > 0 && L(`그중 ${likeCount}곳은 같은 내용을 담은 원문 문장을 점선으로 표시했습니다.`, `For ${likeCount} of them, the original sentences that say the same are underlined with dashes.`)}
                </>}{" "}
              <button type="button" className="fm-link-button" onClick={() => choose("text")}>{L("추출한 글에서 보기", "See it in the extracted text")}</button>
            </p>
          )}
          {mode === "original" && original?.origin === "local_changed" && <p className="fm-book-failed" role="status">{L("이 원본은 자료를 모은 뒤 다시 받은 파일이라 일부가 다를 수 있습니다.", "This original was downloaded again after the guide was collected, so parts of it may differ.")}</p>}
          {failed && mode === "text" && <p className="fm-book-failed" role="status">{L(`원본을 열지 못해 추출한 글로 보여 줍니다. ${failed}`, `The original could not be opened, so the extracted text is shown. ${failed}`)}</p>}
          <div className={`fm-book-paper ${mode === "original" ? "is-original" : ""}`} ref={textRef}>
            {(state === "loading" || waiting) && <p className="fm-hint" role="status">{L("자료를 펼치는 중…", "Opening the guide…")}</p>}
            {state === "error" && mode === "text" && <p role="alert">{L("자료의 글을 불러오지 못했습니다.", "Could not load the guide's text.")}</p>}
            {state !== "loading" && mode === "original" && original && openAt && (
              <Suspense fallback={<p className="fm-hint" role="status">{L("원본 보기를 준비하는 중…", "Preparing the original…")}</p>}>
                <OriginalViewer
                  farmId={farmId}
                  documentId={openAt.id}
                  status={original}
                  sourceUrl={sourceLink && !sourceLink.file ? sourceLink.href : null}
                  highlights={highlights}
                  focusPage={pageNumber(openAt.locator) ?? original.page ?? null}
                  jump={jump}
                  zoom={zoom}
                  query={query}
                  hit={hit}
                  onFound={setOriginalFound}
                  onPage={readingPage}
                  onMarked={(located, like) => { setMarked(located); setSimilar(like ?? null); }}
                  onFail={(reason) => { setFailed(reason); setMode("text"); }}
                />
              </Suspense>
            )}
            {state === "ready" && mode === "text" && !waiting && pages.map((p, i) => (
              <BookPage
                key={p.part.id}
                page={p}
                quote={quoteOn(p)}
                found={found[i]}
                hit={hit}
                citations={citations}
                count={citeCount(p)}
                onOpenAnswer={onOpenAnswer}
                placeOf={placeOf}
              />
            ))}
          </div>
        </div>
        {wide && <aside className="fm-book-info" aria-label={L("자료 정보와 쓰임", "About this guide")}>{info}</aside>}
      </div>
    </article>
  );
}

function BookPage({ page, quote, found, hit, citations, count, onOpenAnswer, placeOf }: {
  page: Page;
  quote: string | null;
  found: { start: number; end: number; index: number }[];
  hit: number;
  citations: PassageCitations | null;
  count: number;
  onOpenAnswer: (asked: AskedPlace) => void;
  placeOf: (asked: AskedPlace) => string | null;
}) {
  const marks: Mark[] = [
    ...(page.head ? [{ ...page.head, kind: "runhead" as const }] : []),
    ...found.map((f) => ({ start: f.start, end: f.end, kind: f.index === hit ? ("findnow" as const) : ("find" as const) })),
  ];
  const quoted = quote ? findSpan(page.text, quote) : null;
  if (quoted) marks.push({ ...quoted, kind: "quote" });
  // The questions that cited this page, newest first, one line each.
  const answers = useMemo(() => {
    const all = page.chunks.flatMap((c) => citations?.chunks[c.id]?.answers ?? []);
    const seen = new Set<string>();
    return all
      .sort((a, b) => (b.asked_at ?? "").localeCompare(a.asked_at ?? ""))
      .filter((a) => { const key = a.response_id ?? `${a.question}:${a.asked_at}`; if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, 5);
  }, [page, citations]);
  const findAt = (at: number) => found.find((f) => f.start <= at && at < f.end)?.index;
  const segs = segments(page.text, marks);
  // A stretch of the page as shown, its paragraph breaks kept as gaps and its marks as marks.
  const stretch = (from: number, to: number) => segs.filter((s) => s.end > from && s.start < to).map((s) => {
    const a = Math.max(s.start, from), b = Math.min(s.end, to);
    const pieces = page.display.slice(a, b).split("\n");
    const content = pieces.flatMap((piece, k) => (k === 0 ? [piece] : [<span key={`g${k}`} className="fm-book-gap" aria-hidden="true" />, piece]));
    if (!s.kind) return <span key={a}>{content}</span>;
    const at = s.kind === "find" || s.kind === "findnow" ? findAt(a) : undefined;
    return <mark key={a} className={`fm-mark-${s.kind}`} data-find={at}>{content}</mark>;
  });
  return (
    <section id={pageId(page.part.id)} className="fm-book-page" data-doc={page.part.id} aria-label={page.part.label}>
      <h3 className="fm-book-pagehead">
        <b>{page.part.label}</b>
        {count > 0 && <em><AiMark />{L(`인용 ${count}회`, `cited ${count}×`)}</em>}
      </h3>
      {!page.doc ? <p className="fm-hint">{L("이 쪽의 글을 불러오지 못했습니다.", "Could not load this page's text.")}</p>
        : !page.text.trim() ? <p className="fm-hint">{L("이 쪽에서 추출한 글이 없습니다. 그림이나 스캔한 쪽일 수 있습니다.", "No text was extracted from this page. It may be a picture or a scan.")}</p>
          : (
            <div className="fm-book-text" lang={korean(page.text)}>
              {page.chunks.map((c) => (
                <div key={c.id} className={`fm-book-chunk ${c.cited ? "is-cited" : ""}`} title={c.cited ? L(`AI 답변 ${c.cited}개가 인용한 곳`, `Cited by ${c.cited} AI ${c.cited === 1 ? "answer" : "answers"}`) : undefined}>
                  {c.cited > 0 && <span className="fm-visually-hidden">{L("AI 답변이 인용한 부분: ", "Cited by AI answers: ")}</span>}
                  {stretch(c.start, c.end)}
                </div>
              ))}
            </div>
          )}
      {answers.length > 0 && (
        <details className="fm-book-cites">
          <summary><AiMark />{L(`이 쪽을 인용한 답변 ${answers.length}개`, `${answers.length} ${answers.length === 1 ? "answer" : "answers"} cited this page`)}</summary>
          <ul>
            {answers.map((a) => (
              <li key={a.response_id ?? `${a.question}:${a.asked_at}`}>
                <button type="button" onClick={() => onOpenAnswer(askedPlace(a))}>
                  <strong lang={korean(a.question)}>{a.question}</strong>
                  <small>{[a.asked_at ? shortStamp(a.asked_at) : null, placeOf(askedPlace(a)) ?? L("농장 전체", "Whole farm")].filter(Boolean).join(", ")}</small>
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

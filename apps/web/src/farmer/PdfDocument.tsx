import { useCallback, useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { TextItem, TextStyle } from "pdfjs-dist/types/src/display/api";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { L } from "./i18n";
import { findInPieces, locateInPieces, mainRun, rangeParts } from "./original-view";
import type { PieceRange } from "./original-view";
import type { Highlight, Jump } from "./original-types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// Character maps (Korean and other CJK fonts), standard fonts, image decoders and colour profiles,
// served with the app (vite.config.ts) so a PDF reads the same without the internet.
const pdfjsData = (folder: string) => new URL(`${import.meta.env.BASE_URL}pdfjs/${folder}/`, window.location.href).href;
const PDFJS_OPTIONS = {
  cMapUrl: pdfjsData("cmaps"),
  cMapPacked: true,
  standardFontDataUrl: pdfjsData("standard_fonts"),
  wasmUrl: pdfjsData("wasm"),
  iccUrl: pdfjsData("iccs"),
};

// The last few files read, kept parsed: stepping from one cited page to the next opens the view again on the
// same file (a whole handbook of 25 MB), which then takes no new parsing. Keyed by the cached bytes of the file.
const parsedDocs = new Map<ArrayBuffer, ReturnType<typeof pdfjs.getDocument>>();
function openPdf(bytes: ArrayBuffer) {
  const kept = parsedDocs.get(bytes);
  if (kept) {
    parsedDocs.delete(bytes);
    parsedDocs.set(bytes, kept);
    return kept;
  }
  // pdf.js takes the bytes over; the cached buffer stays whole for the next view.
  const task = pdfjs.getDocument({ ...PDFJS_OPTIONS, data: new Uint8Array(bytes.slice(0)) });
  task.promise.catch(() => parsedDocs.delete(bytes));
  parsedDocs.set(bytes, task);
  while (parsedDocs.size > 3) {
    const [oldest, old] = parsedDocs.entries().next().value!;
    parsedDocs.delete(oldest);
    void old.destroy();
  }
  return task;
}

type Box = { left: number; top: number; width: number; height: number; kind: "cited" | "quote" | "find" | "hit" };
type Match = { page: number; range: PieceRange };
type PageText = { items: TextItem[]; styles: Record<string, TextStyle> };

/**
 * A PDF read as it was printed: every page in order, drawn when it comes near
 * the screen and let go when it is far, so a book of hundreds of pages stays
 * light. The passages the AI used are boxed where the page prints them; words
 * looked for are found on every page and boxed too.
 */
export function PdfDocument({ bytes, highlights, focusPage, jump, zoom, query, hit, onFound, onPage, onMarked }: {
  bytes: ArrayBuffer;
  highlights: Highlight[];
  /** The page to open at. */
  focusPage: number | null;
  jump: Jump | null;
  zoom: number;
  query: string;
  hit: number;
  onFound?: (count: number) => void;
  onPage?: (page: number) => void;
  onMarked?: (located: boolean[]) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [ratio, setRatio] = useState(1.414);
  const [width, setWidth] = useState(0);
  const [matches, setMatches] = useState<Match[]>([]);
  // The page whose marked passage should come into view once it is drawn (opened at, or turned to).
  const [reveal, setReveal] = useState<{ page: number; nonce: number } | null>(null);
  // The box that scrolls the pages (the reader's body, the library), or null for the window: pages are drawn ahead within it.
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const texts = useRef(new Map<number, Promise<PageText>>());
  const id = useRef(`fm-pdf-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    let live = true;
    texts.current = new Map();
    openPdf(bytes).promise
      .then(async (doc) => {
        const first = await doc.getPage(1);
        const base = first.getViewport({ scale: 1 });
        if (!live) return;
        setRatio(base.height / base.width);
        setPdf(doc);
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    // The parsed file stays kept for the next view (see openPdf); only this view's work stops.
    return () => { live = false; };
  }, [bytes]);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    setRoot(scrollRootOf(el.parentElement));
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, []);

  // Each page's text is read once and kept, for boxes and for looking words up.
  const textOf = useCallback((page: number): Promise<PageText> => {
    if (!pdf) return Promise.resolve({ items: [], styles: {} });
    if (!texts.current.has(page)) {
      texts.current.set(page, pdf.getPage(page).then((p) => p.getTextContent()).then((c) => ({ items: c.items.filter((i): i is TextItem => "str" in i), styles: c.styles })));
    }
    return texts.current.get(page)!;
  }, [pdf]);
  const toPage = (page: number) => document.getElementById(`${id}-${page}`)?.scrollIntoView({ block: "start" });

  // Which passages the original holds: each looked for on its page, or on every page when its page is not known.
  const highlightKey = highlights.map((h) => `${h.kind}:${h.page ?? ""}:${h.text.slice(0, 32)}`).join("|");
  useEffect(() => {
    if (!pdf || !onMarked) return;
    let live = true;
    void (async () => {
      const located: boolean[] = [];
      for (const h of highlights) {
        const pages = h.page ? (h.page <= pdf.numPages ? [h.page] : []) : Array.from({ length: pdf.numPages }, (_, i) => i + 1);
        let seen = false;
        for (const page of pages) {
          const { items } = await textOf(page);
          if (!live) return;
          if (locateInPieces(items.map((i) => i.str), h.text)) { seen = true; break; }
        }
        located.push(seen);
      }
      if (live) onMarked(located);
    })().catch(() => undefined);
    return () => { live = false; };
  }, [pdf, highlightKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Words looked for, on every page in order.
  useEffect(() => {
    if (!pdf) return;
    const wanted = query.trim();
    if (!wanted) { setMatches([]); onFound?.(0); return; }
    let live = true;
    void (async () => {
      const found: Match[] = [];
      for (let page = 1; page <= pdf.numPages && found.length < 500; page += 1) {
        const { items } = await textOf(page);
        if (!live) return;
        for (const range of findInPieces(items.map((i) => i.str), wanted)) found.push({ page, range });
      }
      if (live) { setMatches(found); onFound?.(found.length); }
    })().catch(() => undefined);
    return () => { live = false; };
  }, [pdf, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pdf || !focusPage) return;
    requestAnimationFrame(() => toPage(focusPage));
    setReveal({ page: focusPage, nonce: Date.now() });
  }, [pdf]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pdf || !jump?.page) return;
    toPage(jump.page);
    setReveal({ page: jump.page, nonce: jump.nonce });
  }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const m = matches[hit]; if (m) toPage(m.page); }, [hit, matches]); // eslint-disable-line react-hooks/exhaustive-deps
  // The page being read: the one crossing the upper part of the screen.
  useEffect(() => {
    if (!pdf || !onPage) return;
    const observer = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      const page = Number(seen[0]?.target.getAttribute("data-page"));
      if (page) onPage(page);
    }, { root, rootMargin: "-20% 0px -70% 0px" });
    holder.current?.querySelectorAll(".fm-pdfsheet").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pdf, width, root]); // eslint-disable-line react-hooks/exhaustive-deps

  const sheetWidth = Math.max(240, Math.floor(width * zoom));
  return (
    <div className="fm-pdfdoc" ref={holder}>
      {error && <p role="alert">{L(`원본 PDF를 열지 못했습니다. ${error}`, `Could not open the original PDF. ${error}`)}</p>}
      {!pdf && !error && <p className="fm-hint" role="status">{L("원본 PDF를 펼치는 중…", "Opening the original PDF…")}</p>}
      {pdf && width > 0 && Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((page) => (
        <PdfSheet
          key={page}
          id={`${id}-${page}`}
          pdf={pdf}
          page={page}
          width={sheetWidth}
          ratio={ratio}
          highlights={highlights.filter((h) => !h.page || h.page === page)}
          matches={matches.flatMap((m, i) => (m.page === page ? [{ range: m.range, current: i === hit }] : []))}
          reveal={reveal?.page === page ? reveal.nonce : null}
          root={root}
          textOf={textOf}
        />
      ))}
    </div>
  );
}

/** The nearest box that scrolls (overflow auto or scroll), or null when the window does. */
function scrollRootOf(el: HTMLElement | null): HTMLElement | null {
  for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/** One printed page: a placeholder of its size until it is near, then the page with its boxes. */
function PdfSheet({ id, pdf, page, width, ratio, highlights, matches, reveal, root, textOf }: {
  id: string;
  pdf: PDFDocumentProxy;
  page: number;
  width: number;
  ratio: number;
  highlights: Highlight[];
  matches: { range: PieceRange; current: boolean }[];
  /** A request (by its nonce) to bring this page's marked passage into view once drawn. */
  reveal: number | null;
  /** The box the pages scroll in: "near" is measured in it, so the pages above and below are drawn before they show. */
  root: HTMLElement | null;
  textOf: (page: number) => Promise<PageText>;
}) {
  const revealed = useRef<number | null>(null);
  const [near, setNear] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const [height, setHeight] = useState(Math.round(width * ratio));
  const [boxes, setBoxes] = useState<Box[]>([]);
  const sheet = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const matchKey = matches.map((m) => `${m.range.start.piece}:${m.range.start.offset}:${m.current ? 1 : 0}`).join(",");
  const highlightKey = highlights.map((h) => `${h.kind}:${h.text.slice(0, 24)}`).join("|");

  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: "1600px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!near) {
      // Far from the screen: the drawing is let go.
      const el = canvas.current;
      if (el) { el.width = 0; el.height = 0; }
      setDrawn(false);
      return;
    }
    let live = true;
    let task: ReturnType<PDFPageProxy["render"]> | null = null;
    void (async () => {
      const p = await pdf.getPage(page);
      if (!live || !canvas.current) return;
      const base = p.getViewport({ scale: 1 });
      const viewport = p.getViewport({ scale: width / base.width });
      const ratioPx = Math.min(2, window.devicePixelRatio || 1);
      const el = canvas.current;
      el.width = Math.floor(viewport.width * ratioPx);
      el.height = Math.floor(viewport.height * ratioPx);
      el.style.width = `${Math.floor(viewport.width)}px`;
      el.style.height = `${Math.floor(viewport.height)}px`;
      setHeight(Math.floor(viewport.height));
      task = p.render({ canvas: el, viewport, transform: ratioPx === 1 ? undefined : [ratioPx, 0, 0, ratioPx, 0, 0] });
      const done = await task.promise.then(() => true, () => false);
      if (live && done) setDrawn(true);
      const { items, styles } = await textOf(page);
      if (!live) return;
      const pieces = items.map((i) => i.str);
      // A piece of a text item is boxed by its share of the item's width.
      const boxOf = (piece: number, from: number, to: number, kind: Box["kind"]): Box => {
        const item = items[piece];
        const t = pdfjs.Util.transform(viewport.transform, item.transform);
        const size = Math.hypot(t[2], t[3]);
        const style = styles[item.fontName];
        const ascent = style?.ascent && style.ascent > 0.5 ? style.ascent : 0.9;
        const descent = style?.descent && style.descent < 0 ? style.descent : -0.2;
        const full = item.width * viewport.scale;
        const share = item.str.length ? full / item.str.length : full;
        return { left: t[4] + share * from, top: t[5] - size * ascent, width: share * (to - from), height: size * (ascent - descent), kind };
      };
      const out: Box[] = [];
      for (const h of highlights) {
        const found = locateInPieces(pieces, h.text);
        if (found) for (const part of rangeParts(pieces, found)) out.push(boxOf(part.piece, part.from, part.to, h.kind === "quote" ? "quote" : "cited"));
      }
      for (const m of matches) for (const part of rangeParts(pieces, m.range)) out.push(boxOf(part.piece, part.from, part.to, m.current ? "hit" : "find"));
      setBoxes(out);
    })().catch(() => undefined);
    return () => { live = false; task?.cancel(); };
  }, [near, width, pdf, page, highlightKey, matchKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // The current found word comes into view once boxed; the passage opened at, at its body: the
  // largest run of its lines (it can also cover a chapter banner above and a running head at the foot).
  // A long passage starts just under the top of the view, a short one sits in the middle.
  useEffect(() => {
    const hitBox = sheet.current?.querySelector<HTMLElement>(".fm-pdf-box.is-hit");
    if (hitBox) { hitBox.scrollIntoView({ block: "center" }); return; }
    if (reveal === null || revealed.current === reveal || !boxes.length) return;
    const quoted = boxes.filter((b) => b.kind === "quote");
    const pool = quoted.length ? quoted : boxes.filter((b) => b.kind === "cited");
    const run = mainRun(pool);
    const target = run ? sheet.current?.querySelector<HTMLElement>(`[data-box="${boxes.indexOf(pool[run.index])}"]`) : null;
    if (run && target) {
      revealed.current = reveal;
      const view = root?.clientHeight ?? window.innerHeight;
      target.scrollIntoView({ block: run.bottom - run.top > view * 0.4 ? "start" : "center" });
    }
  }, [boxes, reveal]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div id={id} className={`fm-pdfsheet ${drawn ? "" : "is-waiting"}`} data-page={page} ref={sheet} style={{ width, height }}>
      <canvas ref={canvas} aria-label={L(`원본 ${page}쪽`, `Original page ${page}`)} />
      {!drawn && <span className="fm-pdfsheet-wait" aria-hidden="true">{L(`${page}쪽을 그리는 중…`, `Drawing page ${page}…`)}</span>}
      {near && boxes.map((b, i) => <span key={i} data-box={i} className={`fm-pdf-box is-${b.kind}`} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />)}
      <span className="fm-pdfsheet-no" aria-hidden="true">{page}</span>
    </div>
  );
}

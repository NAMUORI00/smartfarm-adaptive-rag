import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { FarmId } from "../types";
import { originalArchive, originalFile } from "./assist-api";
import type { ArchiveInfo, OriginalFile, OriginalStatus } from "./assist-api";
import { findSpans } from "./book-text";
import { findSpan, segments } from "./doc-reader";
import type { Mark } from "./doc-reader";
import { L } from "./i18n";
import { decodeText, findInPieces, locateInPieces, markdownDocument, rangeParts, similarInPieces } from "./original-view";
import type { PieceRange } from "./original-view";
import type { Highlight, Jump } from "./original-types";

const PdfDocument = lazy(() => import("./PdfDocument").then((m) => ({ default: m.PdfDocument })));
const isWebPage = (type: string | null | undefined) => !!type && /^(text\/html|application\/xhtml\+xml)/i.test(type);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type ViewerProps = {
  farmId: FarmId;
  documentId: string;
  status: OriginalStatus;
  /** Where the document was published: a web page's pictures and styles load from there. */
  sourceUrl: string | null;
  highlights: Highlight[];
  /** Where to open: a PDF page. */
  focusPage?: number | null;
  jump?: Jump | null;
  zoom?: number;
  query?: string;
  hit?: number;
  onFound?: (count: number) => void;
  onPage?: (page: number) => void;
  /**
   * Which of the highlights the original holds and are marked, in their order (a summary or translation is not found),
   * and which of those not found were marked as the same content in other words (a guide kept as a summary).
   */
  onMarked?: (located: boolean[], similar?: boolean[]) => void;
  /** The original could not be shown: the reader offers the extracted text instead. */
  onFail?: (reason: string) => void;
};

/**
 * A guide's original file, drawn by what it is: a PDF page by page, a web page
 * as it was published (in a sandboxed frame, no scripts), a JATS article set as
 * an article, a Word document with its own layout, a Markdown document (a
 * farm's own procedure) set as an article, a text file as it is. The
 * passages the AI used are marked in it, words can be looked for in it, and a
 * page or passage can be brought into view.
 */
export function OriginalViewer(props: ViewerProps) {
  const { farmId, documentId, status } = props;
  const [file, setFile] = useState<OriginalFile | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setFile(null);
    setError("");
    // A web page opens as its archive (styles, pictures and fonts inside it); the page as collected only when that cannot be made.
    const load = async (): Promise<OriginalFile> => {
      if (isWebPage(status.media_type)) {
        try {
          return await originalArchive(farmId, documentId, status.sha256);
        } catch {
          /* the page as collected */
        }
      }
      const raw = await originalFile(farmId, documentId, status.sha256);
      if (!status.media_type && isWebPage(raw.type)) return originalArchive(farmId, documentId, status.sha256).catch(() => raw);
      return raw;
    };
    load()
      .then((f) => { if (live) setFile(f); })
      .catch((e) => {
        if (!live) return;
        const reason = e instanceof Error ? e.message : String(e);
        setError(reason);
        props.onFail?.(reason);
      });
    return () => { live = false; };
  }, [farmId, documentId, status.sha256]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <p role="alert" className="fm-orig-fail">{L(`원본 파일을 열지 못했습니다. ${error}`, `Could not open the original file. ${error}`)}</p>;
  if (!file) {
    // A large file (a whole handbook) takes a few seconds over a slow line: its size is said.
    const mb = status.size ? Math.round(status.size / 1048576) : 0;
    return (
      <p className="fm-hint" role="status">
        {!status.available && status.fetchable
          ? L("원문 주소에서 원본을 받는 중…", "Fetching the original from where it was published…")
          : isWebPage(status.media_type) && status.archived === false
            ? L("웹 페이지를 보관본으로 만드는 중… 처음 한 번만 걸립니다(최대 30초).", "Making the web page's archive copy… This happens once (up to 30 seconds).")
            : mb >= 5 ? L(`원본 파일(${mb}MB)을 받는 중…`, `Downloading the original file (${mb} MB)…`) : L("원본 파일을 여는 중…", "Opening the original file…")}
      </p>
    );
  }
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type === "application/pdf") {
    return (
      <Suspense fallback={<p className="fm-hint" role="status">{L("원본 PDF를 펼치는 중…", "Opening the original PDF…")}</p>}>
        <PdfDocument bytes={file.bytes} highlights={props.highlights} focusPage={props.focusPage ?? null} jump={props.jump ?? null} zoom={props.zoom ?? 1} query={props.query ?? ""} hit={props.hit ?? 0} onFound={props.onFound} onPage={props.onPage} onMarked={props.onMarked} />
      </Suspense>
    );
  }
  if (type === "text/html" || type === "application/xhtml+xml") {
    return (
      <>
        {file.archive && <ArchiveNote archive={file.archive} />}
        <HtmlFrame {...props} html={decodeText(file.bytes)} />
      </>
    );
  }
  if (type === "application/jats+xml") return <HtmlFrame {...props} html={jatsToHtml(decodeText(file.bytes))} article />;
  if (type === "text/markdown") return <HtmlFrame {...props} html={markdownToHtml(decodeText(file.bytes))} article />;
  if (type === DOCX) return <DocxView {...props} bytes={file.bytes} />;
  if (type.startsWith("image/")) return <ImageView bytes={file.bytes} type={type} highlights={props.highlights} onMarked={props.onMarked} />;
  return <TextView {...props} text={decodeText(file.bytes)} />;
}

/** One line on what the archive is: the page as collected that day, and where its pictures and styles came from. */
function ArchiveNote({ archive }: { archive: ArchiveInfo }) {
  const day = archive.capturedAt ? archive.capturedAt.slice(0, 10).replace(/-/g, ".") : null;
  const parts = [
    day ? L(`${day} 수집 당시의 웹 페이지 보관본`, `Archived copy of the web page as collected on ${day}`) : L("웹 페이지 보관본", "Archived copy of the web page"),
    archive.fromWayback ? L(`그림·스타일 ${archive.fromWayback}개는 인터넷 아카이브에서 가져옴`, `${archive.fromWayback} pictures or styles from the Internet Archive`) : null,
    archive.missing ? L(`보관하지 못한 그림 ${archive.missing}개는 설명 글로 표시`, `${archive.missing} pictures could not be kept and show their description`) : null,
  ].filter(Boolean);
  return <p className="fm-orig-archive" title={L("스크립트 없이, 그림·스타일·글꼴을 문서 안에 담아 보입니다.", "Shown without scripts, with its pictures, styles and fonts inside it.")}>{parts.join(". ")}</p>;
}

// ------------------------------------------------------------------ marking text in a page's DOM

/** The text nodes under a root, in reading order (not those of styles or scripts). */
function textNodes(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(node.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const out: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text);
  return out;
}

/** Wraps a found range in marks, one per text node it covers. */
function wrap(nodes: Text[], found: PieceRange, className: string, index?: number): HTMLElement[] {
  const marks: HTMLElement[] = [];
  // From the last node back, so an earlier node's offsets stay as they were measured.
  for (const part of rangeParts(nodes.map((n) => n.data), found).reverse()) {
    const node = nodes[part.piece];
    const doc = node.ownerDocument;
    const range = doc.createRange();
    range.setStart(node, part.from);
    range.setEnd(node, part.to);
    const mark = doc.createElement("mark");
    mark.className = className;
    if (index !== undefined) mark.dataset.find = String(index);
    range.surroundContents(mark);
    marks.unshift(mark);
  }
  return marks;
}

function unwrap(root: ParentNode, selector: string) {
  root.querySelectorAll(selector).forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  });
}

/**
 * Marks the passages the AI used; returns the mark to open at (the passage opened from, else the first) and which were found.
 * A passage not found as written (a guide kept as a summary) is marked, apart, on the source sentences that say the same.
 */
function markPassages(root: ParentNode & Node, highlights: Highlight[]): { target: HTMLElement | null; located: boolean[]; similar: boolean[] } {
  unwrap(root, "mark.fm-o");
  let first: HTMLElement | null = null;
  let quote: HTMLElement | null = null;
  const located: boolean[] = [];
  const similar: boolean[] = [];
  for (const h of highlights) {
    // The nodes are taken again for each passage: marking the last one split some of them.
    const nodes = textNodes(root);
    const texts = nodes.map((n) => n.data);
    const found = locateInPieces(texts, h.text);
    located.push(!!found);
    let marks: HTMLElement[] = [];
    if (found) {
      marks = wrap(nodes, found, h.kind === "quote" ? "fm-o fm-o-quote" : "fm-o");
      similar.push(false);
    } else {
      const like = similarInPieces(texts, h.text);
      similar.push(like.length > 0);
      // From the last back: each wrap only splits nodes after the ones still to come.
      for (let i = like.length - 1; i >= 0; i -= 1) marks = [...wrap(nodes, like[i], h.kind === "quote" ? "fm-o fm-o-like fm-o-quote" : "fm-o fm-o-like"), ...marks];
    }
    first ??= marks[0] ?? null;
    if (h.kind === "quote") quote ??= marks[0] ?? null;
  }
  return { target: quote ?? first, located, similar };
}

/** Marks every place the words appear; returns how many. */
function markFound(root: ParentNode & Node, query: string): number {
  unwrap(root, "mark.fm-o-find");
  const wanted = query.trim();
  if (!wanted) return 0;
  const nodes = textNodes(root);
  const found = findInPieces(nodes.map((n) => n.data), wanted);
  // From the last back: each wrap only splits nodes after the ones still to come.
  for (let i = found.length - 1; i >= 0; i -= 1) wrap(nodes, found[i], "fm-o-find", i);
  return found.length;
}

function showHit(root: ParentNode, hit: number) {
  root.querySelectorAll("mark.fm-o-find.is-hit").forEach((m) => m.classList.remove("is-hit"));
  const marks = [...root.querySelectorAll<HTMLElement>(`mark.fm-o-find[data-find="${hit}"]`)];
  marks.forEach((m) => m.classList.add("is-hit"));
  marks[0]?.scrollIntoView({ block: "center" });
}

/** Brings a passage into view without marking it (a section chosen in the contents). */
function reveal(root: ParentNode & Node, text: string) {
  const nodes = textNodes(root);
  const found = locateInPieces(nodes.map((n) => n.data), text.slice(0, 160));
  if (found) nodes[found.start.piece].parentElement?.scrollIntoView({ block: "start" });
}

// ------------------------------------------------------------------ a web page or an article

// The page's own look is kept; only the marks are ours (fixed colours: the page keeps its own theme).
const FRAME_STYLE = `
mark.fm-o{background:rgba(78,106,134,.2);box-shadow:inset 0 -2px 0 rgba(78,106,134,.85);color:inherit;border-radius:2px}
mark.fm-o-quote{background:rgba(78,106,134,.36);box-shadow:inset 0 -2px 0 #3d5670}
mark.fm-o-like{background:rgba(78,106,134,.08);box-shadow:none;text-decoration:underline dashed rgba(61,86,112,.9);text-decoration-thickness:2px;text-underline-offset:4px}
mark.fm-o-like.fm-o-quote{background:rgba(78,106,134,.16)}
mark.fm-o-find{background:#f6eedf;box-shadow:inset 0 -2px 0 #8f5c12;color:inherit}
mark.fm-o-find.is-hit{background:#8f5c12;color:#fff}
`;
const ARTICLE_STYLE = `
body.fm-article{max-width:760px;margin:0 auto;padding:28px 24px 48px;font:17px/1.75 "Pretendard","Malgun Gothic",system-ui,sans-serif;color:#25302b;background:#fbfbf9;word-break:keep-all;overflow-wrap:anywhere}
.fm-article h1{font-size:24px;line-height:1.35;margin:4px 0 8px}
.fm-article h2{font-size:19px;margin:26px 0 8px}
.fm-article h3{font-size:17px;margin:20px 0 6px}
.fm-article .journal,.fm-article .authors{color:#5e6b64;font-size:15px;margin:0}
.fm-article .abstract{padding:12px 16px;border-left:3px solid #c4cac1;background:#f4f5f1}
.fm-article figure{margin:14px 0;padding:10px 12px;border:1px solid #dde1da;font-size:15px}
.fm-article ol{padding-left:22px;font-size:15px}
.fm-article ul{padding-left:22px}
.fm-article blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid #c4cac1;color:#3c4842}
.fm-article pre{white-space:pre-wrap;padding:10px 12px;background:#f4f5f1;font-size:15px}
`;

/** A published page made safe to show: no scripts, frames or objects, links open apart, pictures and styles from where it was published. */
function prepareHtml(html: string, base: string | null, article: boolean): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script, noscript, iframe, frame, frameset, object, embed, applet, base, meta[http-equiv], link:not([rel~='stylesheet' i])").forEach((n) => n.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || (/^(href|src|action|formaction|xlink:href|srcdoc)$/i.test(attr.name) && /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value))) el.removeAttribute(attr.name);
    }
  }
  const head = doc.head;
  const policy = doc.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", "default-src 'none'; img-src https: http: data:; style-src https: http: 'unsafe-inline'; font-src https: http: data:; media-src https: http:");
  head.prepend(policy);
  if (base && /^https?:/i.test(base)) {
    const b = doc.createElement("base");
    b.href = base;
    b.target = "_blank";
    policy.after(b);
  }
  const style = doc.createElement("style");
  style.textContent = FRAME_STYLE + (article ? ARTICLE_STYLE : "");
  head.append(style);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A JATS article (as journals deposit them) set as a readable article: title, authors, abstract, sections, figures, references. */
function jatsToHtml(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) return `<!doctype html><html><head></head><body class="fm-article"><pre>${escapeHtml(xml)}</pre></body></html>`;
  const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  const one = (selector: string, within: ParentNode = doc) => within.querySelector(selector);
  const block = (el: Element): string => {
    switch (el.localName) {
      case "sec": case "boxed-text": case "app": return `<section>${[...el.children].map(block).join("")}</section>`;
      case "title": return `<h2>${escapeHtml(text(el))}</h2>`;
      case "p": return `<p>${escapeHtml(text(el))}</p>`;
      case "list": return `<ul>${[...el.children].filter((c) => c.localName === "list-item").map((li) => `<li>${escapeHtml(text(li))}</li>`).join("")}</ul>`;
      case "fig": case "table-wrap": return `<figure><figcaption><b>${escapeHtml(text(one("label", el)))}</b> ${escapeHtml(text(one("caption", el)))}</figcaption></figure>`;
      case "disp-quote": return `<blockquote>${escapeHtml(text(el))}</blockquote>`;
      case "label": case "caption": case "table": case "graphic": case "xref": return "";
      default: return el.children.length ? [...el.children].map(block).join("") : (text(el) ? `<p>${escapeHtml(text(el))}</p>` : "");
    }
  };
  const meta = one("article-meta");
  const title = text(one("title-group article-title", meta ?? doc) ?? one("article-title"));
  const journal = text(one("journal-title"));
  const year = text(one("pub-date year", meta ?? doc));
  const authors = [...(meta ?? doc).querySelectorAll("contrib[contrib-type='author'] name")].map((n) => [text(one("given-names", n)), text(one("surname", n))].filter(Boolean).join(" ")).join(", ");
  const abstract = one("abstract", meta ?? doc);
  const body = one("body");
  const refs = [...doc.querySelectorAll("ref-list ref")].map((r) => `<li>${escapeHtml(text(r))}</li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body class="fm-article">`
    + `<header><p class="journal">${escapeHtml([journal, year].filter(Boolean).join(", "))}</p><h1>${escapeHtml(title)}</h1><p class="authors">${escapeHtml(authors)}</p></header>`
    + (abstract ? `<section class="abstract"><h2>Abstract</h2>${[...abstract.children].map(block).join("") || `<p>${escapeHtml(text(abstract))}</p>`}</section>` : "")
    + (body ? [...body.children].map(block).join("") : "")
    + (refs ? `<section><h2>References</h2><ol>${refs}</ol></section>` : "")
    + "</body></html>";
}

/** A Markdown document (a farm's own procedure) set as an article: its title and issuer from the front matter, then its text. */
function markdownToHtml(source: string): string {
  const { meta, blocks } = markdownDocument(source);
  const title = meta.display_title || meta.title || "";
  const byline = [meta.issuer, meta.document_type, meta.version].filter(Boolean).join(", ");
  const body = blocks.map((b) => {
    switch (b.kind) {
      case "heading": return `<h${Math.min(3, b.level + 1)}>${escapeHtml(b.text)}</h${Math.min(3, b.level + 1)}>`;
      case "list": return `<${b.ordered ? "ol" : "ul"}>${b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</${b.ordered ? "ol" : "ul"}>`;
      case "quote": return `<blockquote>${escapeHtml(b.text)}</blockquote>`;
      case "code": return `<pre>${escapeHtml(b.text)}</pre>`;
      default: return `<p>${escapeHtml(b.text)}</p>`;
    }
  }).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body class="fm-article">`
    + (title || byline ? `<header>${byline ? `<p class="journal">${escapeHtml(byline)}</p>` : ""}${title ? `<h1>${escapeHtml(title)}</h1>` : ""}</header>` : "")
    + body
    + "</body></html>";
}

function HtmlFrame({ html, sourceUrl, highlights, jump, zoom = 1, query = "", hit = 0, onFound, onMarked, article = false }: ViewerProps & { html: string; article?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [loads, setLoads] = useState(0);
  const srcDoc = useMemo(() => prepareHtml(html, sourceUrl, article), [html, sourceUrl, article]);
  const body = () => frame.current?.contentDocument?.body ?? null;
  const highlightKey = highlights.map((h) => `${h.kind}:${h.text.slice(0, 32)}`).join("|");

  useEffect(() => {
    const b = body();
    if (!loads || !b) return;
    const { target, located, similar } = markPassages(b, highlights);
    target?.scrollIntoView({ block: "center" });
    onMarked?.(located, similar);
  }, [loads, highlightKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const b = body();
    if (!loads || !b) return;
    onFound?.(markFound(b, query));
  }, [loads, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const b = body();
    if (loads && b && query.trim()) showHit(b, hit);
  }, [loads, hit, query]);
  useEffect(() => {
    const b = body();
    if (loads && b && jump?.text) reveal(b, jump.text);
  }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const d = frame.current?.contentDocument;
    if (loads && d) d.documentElement.style.setProperty("zoom", String(zoom));
  }, [loads, zoom]);
  return (
    <iframe
      ref={frame}
      className={`fm-orig-frame ${article ? "is-article" : ""}`}
      title={L("원본 문서", "Original document")}
      // No scripts, no forms, no top navigation; links open in a new tab.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={() => setLoads((n) => n + 1)}
    />
  );
}

// ------------------------------------------------------------------ a Word document

function DocxView({ bytes, highlights, jump, zoom = 1, query = "", hit = 0, onFound, onMarked, onFail }: ViewerProps & { bytes: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(0);
  const [error, setError] = useState("");
  // A page a little wider than the column is drawn smaller to fit; in a narrow column (a phone) its text flows to the column instead.
  const [fit, setFit] = useState<{ scale: number; reflow: boolean }>({ scale: 1, reflow: false });
  const highlightKey = highlights.map((h) => `${h.kind}:${h.text.slice(0, 32)}`).join("|");
  useEffect(() => {
    let live = true;
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    import("docx-preview")
      .then(({ renderAsync }) => renderAsync(bytes.slice(0), el, undefined, { className: "fm-docx", inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true, experimental: false }))
      .then(() => { if (live) setDrawn((n) => n + 1); })
      .catch((e) => {
        if (!live) return;
        const reason = e instanceof Error ? e.message : String(e);
        setError(reason);
        onFail?.(reason);
      });
    return () => { live = false; };
  }, [bytes]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = host.current;
    if (!drawn || !el) return;
    const measure = () => {
      // The page's own width, as the document sets it (in points), and the desk around it.
      const width = el.querySelector<HTMLElement>("section.fm-docx")?.style.width ?? "";
      const value = parseFloat(width);
      const natural = value > 0 ? (width.endsWith("pt") ? (value * 96) / 72 : value) + 32 : 0;
      const scale = natural ? Math.min(1, el.clientWidth / natural) : 1;
      setFit(scale >= 0.8 ? { scale, reflow: false } : { scale: 1, reflow: true });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [drawn]);
  useEffect(() => {
    if (!drawn || !host.current) return;
    const { target, located, similar } = markPassages(host.current, highlights);
    target?.scrollIntoView({ block: "center" });
    onMarked?.(located, similar);
  }, [drawn, highlightKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (drawn && host.current) onFound?.(markFound(host.current, query)); }, [drawn, query]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (drawn && host.current && query.trim()) showHit(host.current, hit); }, [drawn, hit, query]);
  useEffect(() => { if (drawn && host.current && jump?.text) reveal(host.current, jump.text); }, [jump?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {error && <p role="alert">{L(`Word 문서를 그리지 못했습니다. ${error}`, `Could not draw the Word document. ${error}`)}</p>}
      {!drawn && !error && <p className="fm-hint" role="status">{L("Word 문서를 펼치는 중…", "Opening the Word document…")}</p>}
      <div className={`fm-orig-docx ${fit.reflow ? "is-reflow" : ""}`} ref={host} style={{ ["--docx-zoom" as string]: String(fit.scale * zoom) }} />
    </>
  );
}

// ------------------------------------------------------------------ text and pictures

function TextView({ text, highlights, query = "", hit = 0, onFound, onMarked }: ViewerProps & { text: string }) {
  const found = useMemo(() => findSpans(text, query.trim() ? query : ""), [text, query]);
  useEffect(() => { onFound?.(found.length); }, [found.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const marks: Mark[] = [];
  const located: boolean[] = [];
  for (const h of highlights) {
    const span = findSpan(text, h.text);
    located.push(!!span);
    if (span) marks.push({ ...span, kind: h.kind === "quote" ? "quote" : "read" });
  }
  const locatedKey = located.join(",");
  useEffect(() => { onMarked?.(located); }, [locatedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  found.forEach((f, i) => marks.push({ ...f, kind: i === hit ? "findnow" : "find" }));
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>(query.trim() ? "mark.fm-mark-findnow" : "mark.fm-mark-quote, mark.fm-mark-read")?.scrollIntoView({ block: "center" });
  }, [hit, query, highlights.length]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <pre className="fm-orig-text" ref={box}>
      {segments(text, marks).map((s, i) => (s.kind ? <mark key={i} className={`fm-mark-${s.kind}`}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </pre>
  );
}

function ImageView({ bytes, type, highlights, onMarked }: { bytes: ArrayBuffer; type: string; highlights: Highlight[]; onMarked?: (located: boolean[]) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  // A picture holds no text to mark: its extracted text is a description of it.
  useEffect(() => { onMarked?.(highlights.map(() => false)); }, [highlights.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const made = URL.createObjectURL(new Blob([bytes], { type }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [bytes, type]);
  return url ? <img className="fm-orig-image" src={url} alt={L("원본 이미지", "Original image")} /> : null;
}

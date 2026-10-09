import { L } from "./i18n.ts";
import { readableLocator } from "./readable-excerpt.ts";

/**
 * The evidence reader's text work, kept pure so it can be tested.
 *
 * A cited passage is found again inside its document: the advisor read a
 * whitespace-collapsed excerpt (the head of one stored chunk, at most 560
 * characters, sometimes ending in "…" or an added "."), and a quoted guide
 * sentence may have lost a page header or a cut word. Search therefore ignores
 * whitespace and those marks, and falls back to the sentence's head and tail.
 */
export type Span = { start: number; end: number };
/**
 * What a stretch of text is marked as. The evidence reader marks what the AI
 * read, the rest of its passage and a quoted sentence; the library's reader
 * also marks searched words (the current one apart) and a printed page's
 * running head.
 */
export type MarkKind = "read" | "retrieved" | "quote" | "find" | "findnow" | "runhead";
export type Mark = Span & { kind: MarkKind };
export type Segment = { text: string; kind: MarkKind | null; start: number; end: number };

/** The text with each whitespace run as one space, and for every kept character its index in the original. */
export function collapse(text: string): { text: string; index: number[] } {
  let out = "";
  const index: number[] = [];
  let space = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!space) { out += " "; index.push(i); space = true; }
      continue;
    }
    out += ch;
    index.push(i);
    space = false;
  }
  if (out.endsWith(" ")) { out = out.slice(0, -1); index.pop(); }
  return { text: out, index };
}

const trimMarks = (text: string) => text.replace(/^…\s*/, "").replace(/\s*…$/, "").trim();

/** Where `needle` sits in `text`, whitespace and the server's added marks aside. */
export function findSpan(text: string, needle: string | null | undefined): Span | null {
  if (!needle) return null;
  const hay = collapse(text);
  const wanted = trimMarks(collapse(needle).text);
  if (!wanted) return null;
  const at = (part: string, from = 0) => hay.text.indexOf(part, from);
  const span = (start: number, length: number): Span => ({ start: hay.index[start], end: hay.index[start + length - 1] + 1 });
  let found = at(wanted);
  if (found >= 0) return span(found, wanted.length);
  const bare = wanted.replace(/[.。]$/, "");
  found = bare && bare !== wanted ? at(bare) : -1;
  if (found >= 0) return span(found, bare.length);
  // A sentence the server trimmed (a page header, a cut word): anchor on its head and its tail.
  if (bare.length >= 24) {
    const head = bare.slice(0, 14);
    const tail = bare.slice(-10);
    const h = at(head);
    if (h >= 0) {
      const t = at(tail, h + head.length);
      if (t >= 0 && t + tail.length - h <= bare.length * 1.4) return { start: hay.index[h], end: hay.index[t + tail.length - 1] + 1 };
    }
  }
  return null;
}

/**
 * The text cut at its marks. Where marks overlap the stronger one shows: a
 * searched word over a running head over a quoted sentence over the part read
 * over the rest of the chunk.
 */
export function segments(text: string, marks: Mark[]): Segment[] {
  const rank: Record<MarkKind, number> = { findnow: 6, find: 5, runhead: 4, quote: 3, read: 2, retrieved: 1 };
  const clamp = (n: number) => Math.max(0, Math.min(text.length, n));
  const points = [...new Set([0, text.length, ...marks.flatMap((m) => [clamp(m.start), clamp(m.end)])])].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1];
    if (a === b) continue;
    const kind = marks
      .filter((m) => clamp(m.start) <= a && clamp(m.end) >= b)
      .sort((x, y) => rank[y.kind] - rank[x.kind])[0]?.kind ?? null;
    const previous = out[out.length - 1];
    if (previous && previous.kind === kind) { previous.text += text.slice(a, b); previous.end = b; }
    else out.push({ text: text.slice(a, b), kind, start: a, end: b });
  }
  return out;
}

/** A file download or a PDF: a browser cannot jump to a sentence in it. */
export function isFileUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith(".pdf") || path.includes("filedownload");
  } catch {
    return false;
  }
}

const fragment = (text: string) => encodeURIComponent(text).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");

/**
 * The source page with the passage highlighted by the browser (a text fragment,
 * `#:~:text=`). Long passages are named by their first and last words. A PDF or
 * file download gets no fragment; a page that changed simply opens unmarked.
 */
export function textFragmentUrl(url: string | null | undefined, passage: string | null | undefined): string | null {
  if (!url || !/^https?:/i.test(url)) return null;
  let target: URL;
  try { target = new URL(url); } catch { return null; }
  target.hash = "";
  const plain = target.toString();
  if (isFileUrl(url)) return plain;
  const text = trimMarks(collapse(passage ?? "").text).replace(/[.。]$/, "");
  if (!text) return plain;
  const words = text.split(" ");
  const named = words.length <= 8 ? fragment(text) : `${fragment(words.slice(0, 4).join(" "))},${fragment(words.slice(-4).join(" "))}`;
  return `${plain}#:~:text=${named}`;
}

/** "34쪽", "34, 36쪽" or a section name: where in its source a cited group of passages sits. */
export function passagePlaces(locators: (string | null | undefined)[]): string | null {
  const pages = new Set<number>();
  let other: string | null = null;
  for (const raw of locators) {
    const page = raw?.match(/(\d+)\s*쪽|p\.\s*(\d+)/i);
    if (page) pages.add(Number(page[1] ?? page[2]));
    else if (raw && !other && /섹션|절|section/i.test(raw)) other = raw;
  }
  if (pages.size) {
    const list = [...pages].sort((a, b) => a - b).join(", ");
    return L(`${list}쪽`, `p. ${list}`);
  }
  return other ? readableLocator(other) : null;
}

/** The page a locator names ("34쪽"), for the original PDF. */
export function pageNumber(locator: string | null | undefined): number | null {
  const page = locator?.match(/(\d+)\s*쪽/);
  return page ? Number(page[1]) : null;
}

/**
 * Pages of one printed guide share a key: the guide's address without its page
 * part ("...FileDownload.do?ebookCode=57", which also tells two books behind one
 * download address apart), else the source group without its page range.
 */
export function bookKey(doc: { id: string; sourceGroupId?: string | null; sourceUrl?: string | null }): string {
  if (doc.sourceUrl && /^https?:/i.test(doc.sourceUrl)) {
    try {
      const url = new URL(doc.sourceUrl);
      for (const name of [...url.searchParams.keys()]) if (/^page(?:number|no)?$/i.test(name)) url.searchParams.delete(name);
      url.hash = "";
      return `url:${url.toString()}`;
    } catch { /* not an address */ }
  }
  const group = doc.sourceGroupId?.replace(/#pages:\d+(?:-\d+)?$/, "");
  return group || doc.id;
}

/**
 * Which text pieces of a PDF page carry a passage. A PDF splits its words into
 * pieces and spaces them its own way, so the page and the passage are both
 * compared with every space removed; a sentence the server trimmed is anchored
 * on its head and tail. Returns the first and last piece, or null.
 */
export function locateInItems(items: string[], passage: string | null | undefined): { first: number; last: number } | null {
  if (!passage) return null;
  let text = "";
  const owner: number[] = [];
  items.forEach((item, i) => {
    for (let k = 0; k < item.length; k += 1) {
      if (/\s/.test(item[k])) continue;
      text += item[k];
      owner.push(i);
    }
  });
  const wanted = trimMarks(passage).replace(/\s+/g, "").replace(/[.。]$/, "");
  if (!wanted || !text) return null;
  const at = text.indexOf(wanted);
  if (at >= 0) return { first: owner[at], last: owner[at + wanted.length - 1] };
  if (wanted.length >= 24) {
    const head = wanted.slice(0, 14);
    const tail = wanted.slice(-10);
    const h = text.indexOf(head);
    if (h >= 0) {
      const t = text.indexOf(tail, h + head.length);
      if (t >= 0 && t + tail.length - h <= wanted.length * 1.4) return { first: owner[h], last: owner[t + tail.length - 1] };
    }
  }
  return null;
}

/** An answer's text with its source numbers split out: "…적온입니다 [1]." → ["…적온입니다", 1, "."]. */
export function splitMarkers(text: string): (string | number)[] {
  const out: (string | number)[] = [];
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,2})\](?!\()/g)) {
    const at = match.index ?? 0;
    // The number sits against the word it supports, as a footnote mark does.
    if (at > last) out.push(text.slice(last, at).replace(/[ \t]+$/, ""));
    out.push(Number(match[1]));
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

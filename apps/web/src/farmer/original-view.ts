/**
 * Reading an original file, kept pure so it can be tested: where a passage the
 * AI used sits among the pieces of text a viewer draws (a web page's text
 * nodes, a PDF page's text items, a Word document's runs), where searched
 * words sit, and how a web page's or article's bytes are decoded.
 *
 * The passages come from the text the library extracted and cut into search
 * passages, so they are found again spaces aside: extraction joins and breaks
 * lines its own way. A passage whose middle differs is anchored on its head
 * and tail; one whose tail cannot be found is marked by its head alone.
 */

export type PiecePoint = { piece: number; offset: number };
export type PieceRange = { start: PiecePoint; end: PiecePoint };

const SPACE = /[\s\u2060\u200b\u00ad]/;

/** The pieces' letters with the spaces taken out, and where each letter came from. */
function letters(pieces: string[], fold = false) {
  let text = "";
  const at: PiecePoint[] = [];
  pieces.forEach((piece, i) => {
    for (let k = 0; k < piece.length; k += 1) {
      const ch = piece[k];
      if (SPACE.test(ch)) continue;
      text += fold ? ch.toLowerCase() : ch;
      at.push({ piece: i, offset: k });
    }
  });
  return { text, at };
}

const bare = (passage: string) => passage.replace(/^…\s*/, "").replace(/\s*…$/, "").replace(/[\s\u2060\u200b\u00ad]+/g, "").replace(/[.。]$/, "");

/** From the first letter to just after the last, as a range over the pieces. */
function range(at: PiecePoint[], first: number, last: number): PieceRange {
  const end = at[last];
  return { start: at[first], end: { piece: end.piece, offset: end.offset + 1 } };
}

/** Where a passage sits across the pieces, spaces aside; null when it cannot be found. */
export function locateInPieces(pieces: string[], passage: string | null | undefined): PieceRange | null {
  if (!passage) return null;
  const wanted = bare(passage);
  if (!wanted) return null;
  const { text, at } = letters(pieces);
  if (!text) return null;
  const found = text.indexOf(wanted);
  if (found >= 0) return range(at, found, found + wanted.length - 1);
  if (wanted.length >= 24) {
    // A long passage: its head and tail anchor it even where the middle was extracted differently.
    const head = wanted.slice(0, 16);
    const tail = wanted.slice(-12);
    const h = text.indexOf(head);
    if (h >= 0) {
      const t = text.indexOf(tail, h + head.length);
      if (t >= 0 && t + tail.length - h <= wanted.length * 1.5) return range(at, h, t + tail.length - 1);
      // Only its beginning is found: mark the beginning, as long as it is unmistakable.
      for (const size of [80, 48, 28]) {
        if (wanted.length < size) continue;
        const start = text.indexOf(wanted.slice(0, size));
        if (start >= 0) return range(at, start, start + size - 1);
      }
    }
  }
  return null;
}

/** Every place the searched words appear across the pieces, spaces and case aside. */
export function findInPieces(pieces: string[], query: string, limit = 500): PieceRange[] {
  const wanted = bare(query).toLowerCase();
  if (!wanted) return [];
  const { text, at } = letters(pieces, true);
  const out: PieceRange[] = [];
  for (let found = text.indexOf(wanted); found >= 0 && out.length < limit; found = text.indexOf(wanted, found + wanted.length)) {
    out.push(range(at, found, found + wanted.length - 1));
  }
  return out;
}

// Letters that carry content: Hangul, kana and kanji, Latin letters and digits (punctuation and symbols aside).
const CONTENT = /[\p{L}\p{N}]/u;
/** A run of letters as its two-letter pieces, punctuation skipped: a summary and its source share many of them. */
function bigrams(text: string): Set<string> {
  const kept = [...text].filter((ch) => CONTENT.test(ch)).map((ch) => ch.toLowerCase());
  const out = new Set<string>();
  for (let i = 0; i + 1 < kept.length; i += 1) out.add(kept[i] + kept[i + 1]);
  return out;
}
/** Numbers of two digits or more ("1.8", "15"), the facts a summary carries over word for word. */
const facts = (text: string) => new Set((text.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.replace(".", "").length >= 2));

/**
 * Where a guide kept as a summary says the same as its source: for each
 * sentence of the cited passage, the source sentence that shares the most of
 * its letter pairs, when it shares enough of them (and its two-digit numbers,
 * when it has any). The words differ, so these are marked apart from a passage
 * found as it is written. Returns the ranges in reading order.
 */
export function similarInPieces(pieces: string[], passage: string | null | undefined): PieceRange[] {
  if (!passage) return [];
  const { text, at } = letters(pieces);
  if (!text) return [];
  // The source's sentences, over its letters (spaces already out): a full stop ends one unless a digit follows ("1.8").
  const sentences: { start: number; end: number; pairs: Set<string>; facts: Set<string> }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if ((/[.!?。！？]/.test(text[i]) && !/\d/.test(text[i + 1] ?? "")) || i === text.length - 1 || i - start >= 400) {
      const piece = text.slice(start, i + 1);
      if (bigrams(piece).size >= 6) sentences.push({ start, end: i, pairs: bigrams(piece), facts: facts(piece) });
      start = i + 1;
    }
  }
  const wanted = passage.split(/(?<=[.!?。！？])(?!\d)|\n+/).map((s) => s.trim()).filter(Boolean);
  const chosen = new Map<number, PieceRange>();
  for (const sentence of wanted) {
    const pairs = bigrams(sentence);
    if (pairs.size < 8) continue;
    const numbers = facts(sentence);
    let best: { index: number; score: number; shared: number } | null = null;
    sentences.forEach((s, index) => {
      let shared = 0;
      for (const p of pairs) if (s.pairs.has(p)) shared += 1;
      // Out of the cited sentence's pairs, and not rewarding a very long source sentence for its length alone.
      const score = shared / Math.max(pairs.size, Math.min(s.pairs.size, pairs.size * 2) * 0.75);
      if (!best || score > best.score) best = { index, score, shared };
    });
    const pick = best as { index: number; score: number; shared: number } | null;
    if (!pick || pick.score < 0.34 || pick.shared < 8) continue;
    const source = sentences[pick.index];
    if (numbers.size && ![...numbers].some((n) => source.facts.has(n))) continue;
    chosen.set(pick.index, range(at, source.start, source.end));
  }
  return [...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

/** The pieces a range covers, each with the part of it that is covered. */
export function rangeParts(pieces: string[], found: PieceRange): { piece: number; from: number; to: number }[] {
  const out: { piece: number; from: number; to: number }[] = [];
  for (let i = found.start.piece; i <= found.end.piece; i += 1) {
    const from = i === found.start.piece ? found.start.offset : 0;
    const to = i === found.end.piece ? found.end.offset : pieces[i].length;
    if (to > from && pieces[i].slice(from, to).trim()) out.push({ piece: i, from, to });
  }
  return out;
}

const LATIN1 = new TextDecoder("latin1");

/**
 * The character set a web page or article was written in: its byte order mark,
 * else what its own head declares (a meta tag, an XML declaration), else UTF-8.
 * The type the server sends is not trusted for this: the server does not know it.
 */
export function charsetOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = LATIN1.decode(bytes.subarray(0, 8192));
  const declared = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w:.-]+)/i)?.[1] ?? head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w:.-]+)["']/i)?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared.toLowerCase()).encoding;
    } catch {
      /* an unknown label: fall through */
    }
  }
  return "utf-8";
}

/** A web page's or article's text. An undeclared Korean page that is not UTF-8 is read as EUC-KR. */
export function decodeText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const charset = charsetOf(bytes);
  const text = new TextDecoder(charset).decode(bytes);
  if (charset !== "utf-8") return text;
  const broken = (text.match(/\ufffd/g) ?? []).length;
  if (broken > Math.max(4, text.length / 500)) {
    const korean = new TextDecoder("euc-kr").decode(bytes);
    if ((korean.match(/\ufffd/g) ?? []).length < broken) return korean;
  }
  return text;
}

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string };

/** A Markdown line's words without its inline markup: emphasis, code ticks and link targets. */
const plainInline = (line: string) =>
  line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/(\*\*|__|`)(.+?)\1/g, "$2").replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?=[^*\w]|$)/g, "$1$2");

/**
 * A Markdown document (a farm's own procedure, written for this system) as its
 * front matter and its blocks: headings, paragraphs, lists, quotes and code. The
 * lines of a paragraph are joined as Markdown joins them.
 */
export function markdownDocument(source: string): { meta: Record<string, string>; blocks: MarkdownBlock[] } {
  const meta: Record<string, string> = {};
  let body = source.replace(/^﻿/, "");
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (front) {
    for (const line of front[1].split(/\r?\n/)) {
      const at = line.indexOf(":");
      if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    body = body.slice(front[0].length);
  }
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    if (list) blocks.push({ kind: "list", ...list });
    paragraph = [];
    list = null;
  };
  for (const raw of body.split(/\r?\n/)) {
    if (code) {
      if (/^\s*```/.test(raw)) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else code.push(raw);
      continue;
    }
    const line = raw.trim();
    if (/^```/.test(line)) { flush(); code = []; continue; }
    if (!line) { flush(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (heading) { flush(); blocks.push({ kind: "heading", level: heading[1].length, text: plainInline(heading[2]) }); continue; }
    const item = line.match(/^(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      const ordered = !item[1];
      if (paragraph.length || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push(plainInline(item[3]));
      continue;
    }
    if (line.startsWith(">")) { flush(); blocks.push({ kind: "quote", text: plainInline(line.replace(/^>\s?/, "")) }); continue; }
    // A line under a list item carries it on.
    if (list && /^\s+/.test(raw)) { list.items[list.items.length - 1] += ` ${plainInline(line)}`; continue; }
    if (list) flush();
    paragraph.push(plainInline(line));
  }
  if (code) blocks.push({ kind: "code", text: (code as string[]).join("\n") });
  flush();
  return { meta, blocks };
}

/**
 * Where a passage reads on a printed page: the start of the largest run of its
 * lines. A passage can also cover a chapter banner above it and a running head
 * at the foot; those are short runs set apart by a wide gap, so the reader is
 * brought to the body instead. Returns the index of the run's first box and the
 * run's extent, or null when there is nothing to show.
 */
export function mainRun(boxes: { top: number; height: number }[]): { index: number; top: number; bottom: number } | null {
  if (!boxes.length) return null;
  const heights = boxes.map((b) => b.height).filter((h) => h > 0).sort((a, b) => a - b);
  const line = heights.length ? heights[Math.floor(heights.length / 2)] : 12;
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].top - boxes[b].top);
  const runs: { first: number; top: number; bottom: number; count: number }[] = [];
  for (const i of order) {
    const b = boxes[i];
    const last = runs[runs.length - 1];
    // A paragraph break stays in the run; a gap of several lines starts a new one.
    if (last && b.top - last.bottom <= line * 4) {
      last.bottom = Math.max(last.bottom, b.top + b.height);
      last.count += 1;
    } else {
      runs.push({ first: i, top: b.top, bottom: b.top + b.height, count: 1 });
    }
  }
  const best = runs.reduce((a, b) => (b.count > a.count ? b : a));
  return { index: best.first, top: best.top, bottom: best.bottom };
}

import type { KnowledgeDocument } from "../types.ts";
import { L } from "./i18n.ts";
import { pageNumber } from "./doc-reader.ts";
import { readableLocator } from "./readable-excerpt.ts";

/**
 * The library's reading room, kept pure so it can be tested: the pages of one
 * guide in order, a printed page's text re-flowed for reading, the running head
 * a PDF prints at the top of each page, a short name for each page in the
 * table of contents, words found in the text, and the guides read lately.
 *
 * Every function that changes text keeps its length, so the places the AI
 * cited (offsets into the stored passage) still fall on the same letters.
 */

export type BookPart = { id: string; label: string; order: number; locator: string | null };

const sectionNumber = (locator: string | null | undefined) => {
  const m = locator?.match(/섹션\s*(\d+)|section\s*(\d+)/i);
  return m ? Number(m[1] ?? m[2]) : null;
};

/** The pages or sections of one guide, in reading order, each with its place ("34쪽", "섹션 3"). */
export function bookParts(documentIds: string[], documents: Pick<KnowledgeDocument, "id" | "title" | "sourceLocator">[]): BookPart[] {
  return documentIds
    .map((id) => documents.find((d) => d.id === id))
    .filter((d): d is Pick<KnowledgeDocument, "id" | "title" | "sourceLocator"> => !!d)
    .map((d) => {
      const locator = d.sourceLocator ?? null;
      const order = pageNumber(locator) ?? pageNumber(d.title) ?? sectionNumber(locator) ?? sectionNumber(d.title) ?? Number.MAX_SAFE_INTEGER;
      return { id: d.id, locator, order, label: locator ? readableLocator(locator) : L("본문", "Text") };
    })
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

const HANGUL = /[ㄱ-ㆎ가-힣]/;
// A line that starts something new: a chapter, a numbered or lettered heading, a list mark, a table or figure.
const STARTS_ANEW = /^(?:제\s*\d+\s*[장절편]|[가-하]\.\s|\(\d+\)|\d+\)|\d+\.\s|\d{2}\s+\S|[○●◦▪■□◆◇※•\-–—]|[①-⑳]|<\s*[표그]|〈\s*[표그]|\[\s*[표그]|그림\s*\d|표\s*\d)/;
const ENDS_SENTENCE = /[.!?。」』"”’)]$/;
/** Joins two halves of a word split at a printed line end, invisibly and without letting the word break there. */
export const WORD_JOIN = "\u2060";
// A line that ends in one of these particles or endings most likely ends a word ("…을", "…하며", "…해야").
const ENDS_WORD = /[을를은는며야]$/;

/**
 * A printed page read as paragraphs. A PDF breaks every printed line, often in
 * the middle of a Korean word ("산\n림이"); those breaks are joined (Hangul to
 * Hangul without a space unless the line ends in a particle, anything else with
 * one) while a break after a short line, a finished sentence that stops early,
 * or before a heading or list mark stays a paragraph break. The result has the
 * same length as the text.
 */
export function reflowText(text: string): string {
  const lines = text.split("\n");
  if (lines.length < 3) return text;
  const lengths = lines.map((l) => l.trim().length).filter((n) => n >= 12).sort((a, b) => a - b);
  if (lengths.length < 3) return text;
  // A full printed line: most body lines run this long.
  const full = lengths[Math.floor(lengths.length * 0.75)];
  const out = text.split("");
  let offset = 0;
  for (let i = 0; i < lines.length - 1; i += 1) {
    const at = offset + lines[i].length;
    offset = at + 1;
    const cur = lines[i].trim();
    const next = lines[i + 1].trim();
    const paragraph = !cur || !next || STARTS_ANEW.test(next) || cur.length < full * 0.6 || (ENDS_SENTENCE.test(cur) && cur.length < full * 0.92)
      || (next.length <= 16 && !ENDS_SENTENCE.test(next) && cur.length < full * 0.85);
    if (paragraph) continue;
    out[at] = HANGUL.test(cur[cur.length - 1]) && HANGUL.test(next[0]) && !ENDS_WORD.test(cur) ? WORD_JOIN : " ";
  }
  return out.join("");
}

/** The running head or page number a PDF prints first on a page ("36", "제2장 고추냉이  35"), as a span. */
export function runningHead(text: string): { start: number; end: number } | null {
  const end = text.indexOf("\n");
  const first = (end < 0 ? text : text.slice(0, end)).trim();
  if (!first) return null;
  if (/^\d{1,3}$/.test(first) || /^제\s*\d+\s*장\s+\S.*\s\d{1,3}$/.test(first)) {
    const start = text.indexOf(first);
    return { start, end: start + first.length };
  }
  return null;
}

// Web pages bring their menus along; they do not name a section.
const BOILERPLATE = /skip to main content|thank you for visiting|you are using a browser|cookie|javascript|서브메뉴|본문영역|바로가기|상세보기|로그인|메뉴/i;

/**
 * A short name for a page in the contents. A printed page is named by its
 * first heading, else its first real line; a web section by its first real
 * line, since its short lines are mostly menus.
 */
export function tocLabel(text: string, printed = true, max = 26): string {
  const head = printed ? runningHead(text) : null;
  const lines = (head ? text.slice(head.end) : text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.replace(/\s/g, "").length >= (printed ? 3 : 8) && !/^\d+$/.test(l) && !BOILERPLATE.test(l) && (l.match(/[<>|]/g) ?? []).length < 2);
  const heading = printed ? lines.find((l) => l.length <= 24 && !ENDS_SENTENCE.test(l) && (STARTS_ANEW.test(l) || l.length <= 16)) : undefined;
  const pick = heading ?? lines[0] ?? "";
  const clean = pick.replace(/\s+/g, " ").replace(/\s_\s*\d+$/, "");
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Every place the searched words appear, in order; spaces in the search match any spacing, even none. */
export function findSpans(text: string, query: string): { start: number; end: number }[] {
  const words = query.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length || words.join("").length < 1) return [];
  const pattern = new RegExp(words.join(`[\\s${WORD_JOIN}]*`), "gi");
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(pattern)) {
    if (!m[0].length) continue;
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

/** A guide read lately: where the reader was, to carry on from there. */
export type ReadingMark = { entryId: string; documentId: string; title: string; part: string; at: string };

/** The newest reading first; one mark per guide; the four latest kept. */
export function rememberReading(history: ReadingMark[], mark: ReadingMark, keep = 4): ReadingMark[] {
  return [mark, ...history.filter((h) => h.entryId !== mark.entryId)].slice(0, keep);
}

import type { FarmId, KnowledgeDocument, KnowledgeRetrievalState } from "../types.ts";
import { groupKnowledgeSources, knowledgeSourceSummary } from "../source-library.ts";
import { isKnowledgeSourceOwnedByFarm, knowledgeApplicability, knowledgeCategory, knowledgeSourceRetrievalState } from "../knowledge-view.ts";
import { bookKey, pageNumber } from "./doc-reader.ts";
import { L } from "./i18n.ts";

export type LibraryEntry = {
  /** The source group, or for a printed guide stored page by page, the guide. */
  id: string;
  title: string;
  issuer: string | null;
  year: number | null;
  type: string | null;
  pages: string | null;
  parts: number;
  url: string | null;
  scope: "public" | "private" | "synthetic";
  category: ReturnType<typeof knowledgeCategory>;
  /** The kind of source the advisor's composition counts ("peer_reviewed", "official_agronomy", …). */
  evidenceClass: string | null;
  /** Whether answers may use it: active, paused, or waiting for a person to check it. */
  state: KnowledgeRetrievalState;
  /** Pages of a guide that answers do not use while the rest are used. */
  pausedParts: number;
  /** Indexing: ready, still working, or failed. */
  status: "ready" | "working" | "failed";
  /** This farm added it, so it may be removed here. */
  owned: boolean;
  applicability: string[];
  documentIds: string[];
  /** Every source group the entry covers; answer use is changed group by group. */
  groupIds: string[];
  /** The stored summary, for a title that does not say what the document is. */
  summary: string;
  updatedAt: string | null;
};
export type LibraryFilter = { state: "all" | KnowledgeRetrievalState; scope: "all" | "public" | "private"; query: string; kind?: string };

const STATE_ORDER: Record<KnowledgeRetrievalState, number> = { needs_review: 0, active: 1, paused: 2 };

const KIND_NAMES: Record<string, [string, string]> = {
  peer_reviewed: ["학술 논문", "Research papers"],
  official_agronomy: ["공식 재배 자료", "Official guides"],
  public_reference: ["공개 참고 자료", "Public references"],
  farm_sop: ["농장 운영 절차", "Farm procedures"],
  simulated: ["운영 정책", "Operating policy"],
};
/** The kind of a guide, named the same way on the first page and in the library. */
export const kindName = (kind: string | null | undefined) => L(...(KIND_NAMES[kind ?? ""] ?? ["기타 자료", "Other"]));

/**
 * The growing guides as the farmer manages them: one row per document (not per
 * page), newest decisions first — documents waiting for a check, then the
 * farm's own, then the rest by title.
 */
export function libraryEntries(documents: KnowledgeDocument[], farmId: FarmId): LibraryEntry[] {
  return groupKnowledgeSources(documents)
    .map((g) => {
      const rep = g.representative;
      const status = g.documents.some((d) => d.status === "failed") ? "failed" : g.documents.every((d) => d.status === "ready") ? "ready" : "working";
      const state = knowledgeSourceRetrievalState(g.documents);
      return {
        id: rep.sourceGroupId || g.id,
        // A web page stored section by section keeps its first section's name ("… · 섹션 1"): the guide is the whole page.
        title: g.documents.length > 1 ? g.title.replace(/\s*[·|-]\s*(?:섹션|section)\s*\d+\s*$/iu, "").trim() || g.title : g.title,
        issuer: rep.issuer,
        year: rep.publishedYear,
        type: rep.documentType,
        pages: g.pageLabel,
        parts: g.documents.length,
        url: g.sourceUrl && /^https?:/.test(g.sourceUrl) ? g.sourceUrl : null,
        scope: rep.scope,
        category: knowledgeCategory(rep),
        evidenceClass: rep.evidenceClass,
        state,
        pausedParts: state === "active" ? 0 : g.documents.filter((d) => d.retrievalState === "paused").length,
        status,
        owned: isKnowledgeSourceOwnedByFarm(g.documents, farmId),
        applicability: knowledgeApplicability(rep),
        documentIds: g.documentIds,
        groupIds: [rep.sourceGroupId || g.id],
        summary: knowledgeSourceSummary(g),
        updatedAt: g.documents.map((d) => d.updatedAt).filter((v): v is string => !!v).sort().pop() ?? null,
      } satisfies LibraryEntry;
    })
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || Number(b.owned) - Number(a.owned) || a.title.localeCompare(b.title, "ko"));
}

const pageRange = (pages: number[]) => {
  if (!pages.length) return null;
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const first = sorted[0], last = sorted[sorted.length - 1];
  return first === last ? `${first}쪽` : `${first}–${last}쪽`;
};

/** The name most of a guide's pages carry (a page's name can come from its running head instead). */
function commonTitle(members: LibraryEntry[]): string {
  const weight = new Map<string, number>();
  for (const m of members) weight.set(m.title, (weight.get(m.title) ?? 0) + m.parts);
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? members[0].title;
}

/**
 * A printed guide the library stores page by page ("고추냉이 재배 기술 자료",
 * 34쪽, 35쪽, 36쪽) becomes one row with its page range. Pages belong together
 * when they share the guide's address (or group) and issuer; the pages' own
 * names may differ, and the row takes the name most of them carry.
 */
export function libraryBooks(entries: LibraryEntry[]): LibraryEntry[] {
  const books = new Map<string, LibraryEntry[]>();
  for (const e of entries) {
    const key = `${bookKey({ id: e.id, sourceGroupId: e.id, sourceUrl: e.url })}|${e.issuer ?? ""}`;
    books.set(key, [...(books.get(key) ?? []), e]);
  }
  return [...books.entries()].map(([key, members]) => {
    if (members.length === 1) return members[0];
    const title = commonTitle(members);
    const first = members.find((m) => m.title === title) ?? members[0];
    const states = members.map((m) => m.state);
    const pages = members.flatMap((m) => [...(m.pages?.matchAll(/\d+/g) ?? [])].map((x) => Number(x[0])));
    return {
      ...first,
      id: `book:${key}`,
      title,
      pages: pageRange(pages) ?? first.pages,
      parts: members.reduce((n, m) => n + m.parts, 0),
      state: states.includes("needs_review") ? "needs_review" : states.includes("active") ? "active" : "paused",
      pausedParts: members.reduce((n, m) => n + (m.state === "paused" ? m.parts : m.pausedParts), 0),
      status: members.some((m) => m.status === "failed") ? "failed" : members.every((m) => m.status === "ready") ? "ready" : "working",
      owned: members.every((m) => m.owned),
      documentIds: members.flatMap((m) => m.documentIds),
      groupIds: members.flatMap((m) => m.groupIds),
      summary: first.summary,
      updatedAt: members.map((m) => m.updatedAt).filter((v): v is string => !!v).sort().pop() ?? null,
    } satisfies LibraryEntry;
  });
}

export function libraryCounts(entries: LibraryEntry[]) {
  return {
    all: entries.length,
    active: entries.filter((e) => e.state === "active").length,
    needs_review: entries.filter((e) => e.state === "needs_review").length,
    paused: entries.filter((e) => e.state === "paused").length,
    private: entries.filter((e) => e.scope === "private").length,
  };
}

export function filterLibrary(entries: LibraryEntry[], filter: LibraryFilter): LibraryEntry[] {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) =>
    (filter.state === "all" || e.state === filter.state)
    && (filter.scope === "all" || (filter.scope === "private" ? e.scope === "private" : e.scope !== "private"))
    && (!filter.kind || filter.kind === "all" || (e.evidenceClass ?? "") === filter.kind)
    && words.every((w) => [e.title, e.issuer, e.type, e.summary, ...e.applicability].some((f) => f?.toLowerCase().includes(w))),
  );
}

/** What the server counted for a document, summed over an entry's pages. */
export type DocumentStats = { chars: number; chunks: number; cultivation_terms: number; cited: number; last_cited_at: string | null };
export type EntryStats = { chars: number; chunks: number; cultivationTerms: number; cited: number; lastCitedAt: string | null; emptyParts: number };
export function entryStats(entry: Pick<LibraryEntry, "documentIds">, stats: Record<string, DocumentStats> | null | undefined): EntryStats {
  const rows = entry.documentIds.map((id) => stats?.[id]).filter((r): r is DocumentStats => !!r);
  return {
    chars: rows.reduce((n, r) => n + r.chars, 0),
    chunks: rows.reduce((n, r) => n + r.chunks, 0),
    cultivationTerms: rows.reduce((n, r) => Math.max(n, r.cultivation_terms), 0),
    cited: rows.reduce((n, r) => n + r.cited, 0),
    lastCitedAt: rows.map((r) => r.last_cited_at).filter((v): v is string => !!v).sort().pop() ?? null,
    emptyParts: rows.filter((r) => r.chars === 0).length,
  };
}

/** Text was extracted, but it carries almost no growing-practice words (a festival notice, a pharmacology paper). */
export const thinOnCultivation = (s: EntryStats) => s.chars >= 200 && s.cultivationTerms <= 1;

/** A PDF whose pages gave almost no text: probably scanned, and not read as text. */
export const scanSuspect = (entry: Pick<LibraryEntry, "type" | "parts">, s: EntryStats) => /pdf/i.test(entry.type ?? "") && s.chars / Math.max(1, entry.parts) < 120;

export type LibrarySort = "suggested" | "cited" | "recent" | "name";
/** Suggested: waiting for a check, the farm's own, the most cited; or by citations, by date added, by name. */
export function sortLibrary(entries: LibraryEntry[], sort: LibrarySort, statsOf: (e: LibraryEntry) => EntryStats): LibraryEntry[] {
  const byName = (a: LibraryEntry, b: LibraryEntry) => a.title.localeCompare(b.title, "ko");
  const list = [...entries];
  if (sort === "name") return list.sort(byName);
  if (sort === "recent") return list.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || byName(a, b));
  if (sort === "cited") return list.sort((a, b) => statsOf(b).cited - statsOf(a).cited || (statsOf(b).lastCitedAt ?? "").localeCompare(statsOf(a).lastCitedAt ?? "") || byName(a, b));
  return list.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || Number(b.owned) - Number(a.owned) || statsOf(b).cited - statsOf(a).cited || byName(a, b));
}

/** The entry a document belongs to. */
export const entryOf = (entries: LibraryEntry[], documentId: string | null | undefined) => (documentId ? entries.find((e) => e.documentIds.includes(documentId)) ?? null : null);

/** A page of the entry to open first: the lowest page, or the first document. */
export function firstDocument(entry: LibraryEntry, documents: KnowledgeDocument[]): string {
  const pages = entry.documentIds
    .map((id) => documents.find((d) => d.id === id))
    .filter((d): d is KnowledgeDocument => !!d)
    .sort((a, b) => (pageNumber(a.sourceLocator) ?? 0) - (pageNumber(b.sourceLocator) ?? 0));
  return pages[0]?.id ?? entry.documentIds[0];
}

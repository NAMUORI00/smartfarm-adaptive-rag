import test from "node:test";
import assert from "node:assert/strict";
import { entryOf, entryStats, filterLibrary, libraryBooks, libraryCounts, libraryEntries, scanSuspect, sortLibrary, thinOnCultivation } from "./farmer/library-entries.ts";
import type { KnowledgeDocument } from "./types.ts";

const doc = (over: Partial<KnowledgeDocument>): KnowledgeDocument => ({
  id: "d1", sourceGroupId: "g1", farmId: null, title: "고추냉이 재배 기술 자료 · 34쪽", scope: "public", version: "v1",
  retrievalState: "active", status: "ready", updatedAt: null, chunkCount: 3, vectorCount: 3, qdrantVectorCount: null, indexBackend: null,
  graphNodeCount: null, graphEdgeCount: null, sourceName: null, checksum: null, tags: [], summary: "", issuer: "농촌진흥청", publishedYear: 2019,
  documentType: "재배 기술서", sourceUrl: "https://example.org/a", summaryProvider: "extractive", isResearchArchive: false, sourceLocator: "34쪽",
  crop: "wasabi", cultivationSystem: null, evidenceClass: "official_agronomy", growthStage: null, embeddingModel: null, ...over,
});

const docs = [
  doc({}),
  doc({ id: "d2", title: "고추냉이 재배 기술 자료 · 35쪽", sourceLocator: "35쪽" }),
  doc({ id: "d3", sourceGroupId: "g2", farmId: "farm-wasabi-a", title: "GAP 인증 기준", scope: "private", retrievalState: "needs_review", issuer: null, sourceUrl: null, sourceLocator: null, evidenceClass: null }),
  doc({ id: "d4", sourceGroupId: "g3", title: "시즈오카 물와사비", retrievalState: "paused", issuer: "시즈오카현", sourceLocator: null }),
];

test("pages of one document are one row, and rows waiting for a check come first", () => {
  const entries = libraryEntries(docs, "farm-wasabi-a");
  assert.equal(entries.length, 3);
  assert.equal(entries[0].id, "g2");
  assert.equal(entries[0].state, "needs_review");
  assert.equal(entries[0].owned, true);
  const guide = entries.find((e) => e.id === "g1")!;
  assert.equal(guide.title, "고추냉이 재배 기술 자료");
  assert.equal(guide.pages, "34–35쪽");
  assert.equal(guide.parts, 2);
  assert.equal(guide.owned, false);
});

test("counts and filters follow the answer-use state, the scope and the words typed", () => {
  const entries = libraryEntries(docs, "farm-wasabi-a");
  assert.deepEqual(libraryCounts(entries), { all: 3, active: 1, needs_review: 1, paused: 1, private: 1 });
  assert.deepEqual(filterLibrary(entries, { state: "all", scope: "private", query: "" }).map((e) => e.id), ["g2"]);
  assert.deepEqual(filterLibrary(entries, { state: "paused", scope: "all", query: "" }).map((e) => e.id), ["g3"]);
  assert.deepEqual(filterLibrary(entries, { state: "all", scope: "all", query: "농촌진흥청 재배" }).map((e) => e.id), ["g1"]);
});

test("pages of a printed guide stored one by one become one row with their page range", () => {
  const url = (page: number) => `https://www.nongsaro.go.kr/down.do?ebookCode=57&pageNumber=${page}`;
  const page = (n: number, state: "active" | "paused" = "active") => doc({
    id: `p${n}`, sourceGroupId: `source-group:public:reference:url:https://www.nongsaro.go.kr/down.do#pages:${n}-${n}`,
    title: `고추냉이 재배 기술 자료 · ${n}쪽`, sourceLocator: `${n}쪽`, sourceUrl: url(n), retrievalState: state,
  });
  const books = libraryBooks(libraryEntries([page(34), page(35, "paused"), page(36)], "farm-wasabi-a"));
  assert.equal(books.length, 1);
  assert.equal(new Set(books.map((b) => b.id)).size, books.length);
  assert.equal(books[0].title, "고추냉이 재배 기술 자료");
  assert.equal(books[0].pages, "34–36쪽");
  assert.deepEqual(books[0].documentIds.sort(), ["p34", "p35", "p36"]);
  assert.equal(books[0].groupIds.length, 3);
  // Two pages used, one not: the guide is used, with one page set aside.
  assert.equal(books[0].state, "active");
  assert.equal(books[0].pausedParts, 1);
});

test("counts per guide add up its pages; a guide with no growing words and a near-empty PDF are named", () => {
  const entry = { documentIds: ["a", "b"], type: "PDF 문서", parts: 2 };
  const stats = {
    a: { chars: 900, chunks: 2, cultivation_terms: 1, cited: 2, last_cited_at: "2026-09-28T01:00:00Z" },
    b: { chars: 0, chunks: 0, cultivation_terms: 0, cited: 1, last_cited_at: "2026-09-29T01:00:00Z" },
  };
  const s = entryStats(entry, stats);
  assert.deepEqual(s, { chars: 900, chunks: 2, cultivationTerms: 1, cited: 3, lastCitedAt: "2026-09-29T01:00:00Z", emptyParts: 1 });
  assert.equal(thinOnCultivation(s), true);
  assert.equal(thinOnCultivation({ ...s, cultivationTerms: 4 }), false);
  assert.equal(scanSuspect(entry, { ...s, chars: 150 }), true);
  assert.equal(scanSuspect({ ...entry, type: "웹 문서" }, { ...s, chars: 150 }), false);
});

test("the list sorts by citations, by date added or by name, and filters by kind", () => {
  const entries = libraryEntries(docs, "farm-wasabi-a");
  const cited: Record<string, number> = { g1: 1, g2: 0, g3: 5 };
  const statsOf = (e: { id: string }) => ({ chars: 1, chunks: 1, cultivationTerms: 3, cited: cited[e.id] ?? 0, lastCitedAt: null, emptyParts: 0 });
  assert.deepEqual(sortLibrary(entries, "cited", statsOf).map((e) => e.id), ["g3", "g1", "g2"]);
  assert.deepEqual(sortLibrary(entries, "suggested", statsOf).map((e) => e.id)[0], "g2");
  assert.deepEqual(filterLibrary(entries, { state: "all", scope: "all", query: "", kind: "official_agronomy" }).map((e) => e.id).sort(), ["g1", "g3"]);
  assert.equal(entryOf(entries, "d2")?.id, "g1");
});

test("pages named after their running head stay in their guide, and two books behind one download address stay apart", () => {
  const page = (n: number, code: number, title: string) => doc({
    id: `b${code}p${n}`, sourceGroupId: `source-group:public:reference:url:https://www.nongsaro.go.kr/down.do#pages:${n}-${n}`,
    title: `${title} · ${n}쪽`, sourceLocator: `${n}쪽`, sourceUrl: `https://www.nongsaro.go.kr/down.do?ebookCode=${code}&pageNumber=${n}`,
    issuer: "농촌진흥청 농사로",
  });
  const books = libraryBooks(libraryEntries([
    page(34, 57, "고추냉이 재배 기술 자료"), page(35, 57, "고추냉이 재배 기술 자료"), page(37, 57, "농촌진흥청 농사로 재배 기술 자료"),
    page(10, 58, "딸기 재배 기술 자료"), page(11, 58, "딸기 재배 기술 자료"),
  ], "farm-wasabi-a"));
  assert.equal(books.length, 2);
  // Every row has its own key, however the pages were named.
  assert.equal(new Set(books.map((b) => b.id)).size, 2);
  const wasabi = books.find((b) => b.documentIds.includes("b57p34"))!;
  assert.equal(wasabi.title, "고추냉이 재배 기술 자료");
  assert.equal(wasabi.pages, "34–37쪽");
  assert.deepEqual(wasabi.documentIds.sort(), ["b57p34", "b57p35", "b57p37"]);
  assert.equal(books.find((b) => b.documentIds.includes("b58p10"))!.pages, "10–11쪽");
});

test("a web page stored section by section is named without its first section", () => {
  const section = (n: number) => doc({ id: `s${n}`, sourceGroupId: "source:rda-news", title: `고추냉이 공개 농업 자료 · 섹션 ${n}`, sourceLocator: `섹션 ${n}`, sourceUrl: "https://example.org/news" });
  const [page] = libraryEntries([section(1), section(2), section(3)], "farm-wasabi-a");
  assert.equal(page.title, "고추냉이 공개 농업 자료");
  // One section alone keeps its whole name.
  assert.equal(libraryEntries([section(1)], "farm-wasabi-a")[0].title, "고추냉이 공개 농업 자료 · 섹션 1");
});

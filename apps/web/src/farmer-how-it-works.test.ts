import test from "node:test";
import assert from "node:assert/strict";
import { answerLines, channelCounts, graphUsed, pickKnowledgeTurn, quotedSource, rankedSources, readable, reviewTally, routeWeights } from "./farmer/how-it-works.ts";
import type { AdvisorTurn, Evidence } from "./types.ts";

const ev = (over: Partial<Evidence>): Evidence => ({
  id: "e", sourceId: "s", sourceKind: "public_knowledge", sourceGroupId: null, documentId: null, source: "고추냉이 재배 기술 자료 · 39쪽", category: "공개",
  excerpt: "잎이 황변하면서 고사한다.", score: 0.0135, locator: "39쪽", path: "Dense", selected: true, issuer: null, publishedYear: null, documentType: null,
  sourceUrl: null, summary: null, sourceLocator: null, crop: null, cultivationSystem: null, evidenceClass: null, growthStage: null, embeddingModel: null, ...over,
});
const turn = (over: Partial<AdvisorTurn>): AdvisorTurn => ({
  id: "t", userMessage: { id: "u", role: "user", content: "온도 센서 고장 점검 방법", createdAt: "" } as AdvisorTurn["userMessage"],
  assistantMessage: { id: "a", role: "assistant", content: "## 판단\n- 센서 하나만 급격히 오르면 센서 점검을 우선한다. (고추냉이 A동 근권·관수 대응 SOP)\n- 잎이 황변하면서 고사한다. (고추냉이 재배 기술 자료)", createdAt: "" } as AdvisorTurn["assistantMessage"],
  evidence: [ev({ id: "1" }), ev({ id: "2", source: "고추냉이 A동 근권·관수 대응 SOP", sourceKind: "private_knowledge", score: 0.0164 }), ev({ id: "3", source: "현장 사례" }), ev({ id: "4", sourceKind: "private_simulation", source: "1구역 최신 근권 온도", score: 0.9 })],
  execution: { provider: "local", privacy: "local_only" }, retrieval: { runId: null, backend: null, candidateCount: 2145, returnedCount: 5, queryScope: null, channels: ["dense: 2145", "sparse: 15", "graph: 15"], route: { mode: "qact", path: ["dense", "sparse", "graph"], weights: { dense: 0.3, sparse: 0.3, graph: 0.4 }, reason: null, profileState: "valid", graphReason: null } },
  responseId: "r", controlDrafts: [], toolTrace: null, agentRun: null, queryContext: null, status: "complete", error: null, ...over,
});

test("the player replays the newest answer that cited published guides, preferring a routed one", () => {
  const plain = turn({ id: "plain", retrieval: { ...turn({}).retrieval, route: undefined } });
  const routed = turn({ id: "routed" });
  const small = turn({ id: "small", evidence: [ev({})] });
  assert.equal(pickKnowledgeTurn([routed, plain, small])?.id, "routed");
  assert.equal(pickKnowledgeTurn([plain])?.id, "plain");
  assert.equal(pickKnowledgeTurn([small]), null);
});

test("candidates per method and the weights come from the record", () => {
  const t = turn({});
  assert.deepEqual(channelCounts(t.retrieval), { dense: 2145, sparse: 15, graph: 15 });
  const w = routeWeights(t.retrieval.route);
  assert.ok(Math.abs(w.graph - 0.4) < 1e-9 && Math.abs(w.dense + w.sparse + w.graph - 1) < 1e-9);
  assert.equal(graphUsed(t.retrieval.route), true);
  assert.equal(graphUsed({ ...t.retrieval.route!, graphReason: "graph_evidence_absent" }), false);
  assert.equal(graphUsed({ ...t.retrieval.route!, graphReason: "graph_not_requested" }), false);
  assert.equal(graphUsed({ ...t.retrieval.route!, graphReason: "source_span_verified_graph_relation_passed" }), true);
  assert.deepEqual(routeWeights(undefined), { dense: 1, sparse: 0, graph: 0 });
});

test("sources are ranked by fused score and answer lines point at the source they quote", () => {
  const { documents, readings } = rankedSources(turn({}).evidence);
  assert.equal(documents[0].source, "고추냉이 A동 근권·관수 대응 SOP");
  assert.equal(readings.length, 1);
  const lines = answerLines(turn({}).assistantMessage!.content);
  assert.equal(lines[0], "판단");
  assert.equal(quotedSource(lines[1], documents), 0);
  assert.equal(quotedSource(lines[2], documents), documents.findIndex((d) => d.source.startsWith("고추냉이 재배 기술 자료")));
});

test("the review tally counts rechecked and rewritten parts", () => {
  const run = { units: [{ id: "state" }, { id: "action" }, { id: "evidence" }], rechecked_units: ["state", "evidence"], text_changed_units: ["state"] } as never;
  assert.deepEqual(reviewTally(run), { total: 3, rechecked: 2, rewritten: 1 });
});

test("server numbers and times read as a person reads them", () => {
  assert.equal(readable("재배실 온도 64.9992°C, 관측 시각: 2026-09-28T06:55:45+00:00", () => "2026.09.28 15:55"), "재배실 온도 65°C, 관측 시각: 2026.09.28 15:55");
  assert.equal(readable("근권 온도 17.9992 °C", (x) => x), "근권 온도 18 °C");
});

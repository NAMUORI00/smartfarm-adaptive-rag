import test from "node:test";
import assert from "node:assert/strict";
import { answerRevision, retrievalSummary, revisionSummary, revisionTally, sourcesLine, unitLabel } from "./farmer/answer-diff.ts";
import type { AdvisorTurn } from "./types.ts";
import { setLang } from "./farmer/i18n.ts";

function turn(responseId: string, review: Partial<NonNullable<AdvisorTurn["stateReview"]>> | null, extra: Partial<AdvisorTurn> = {}): AdvisorTurn {
  return {
    id: responseId, responseId, status: "complete", error: null, controlDrafts: [], toolTrace: null, agentRun: null, queryContext: null,
    userMessage: { id: "u", role: "user", content: "q", createdAt: "" },
    assistantMessage: { id: "a", role: "assistant", content: "answer", createdAt: "" },
    evidence: [], execution: { provider: "local", privacy: "local_only", requestedModel: null, requestedServiceTier: null, model: null, serviceTier: null, fallbackReason: null },
    retrieval: { runId: null, backend: null, candidateCount: null, returnedCount: null, queryScope: null, channels: [] },
    stateReview: review ? { mode: "selective", status: "current", baseline_revision: 1, previous_response_id: null, refresh_count: 0, units: [], ...review } : null,
    ...extra,
  } as AdvisorTurn;
}
const units = (state: string, action: string) => [
  { id: "state", text: state, evidence_ids: [] },
  { id: "action", text: action, evidence_ids: [] },
  { id: "evidence", text: "관측 2026-09-21T10:24:32Z", evidence_ids: ["e1"] },
];

test("server-declared rechecked units are separated from units whose wording changed", () => {
  const first = turn("r1", { units: units("정상", "허용 가능") });
  const second = turn("r2", { status: "updated", previous_response_id: "r1", refresh_count: 1, changed_units: ["state", "action"], units: units("22°C 점검 필요", "허용 가능") });
  const rev = answerRevision(second, [first, second])!;
  assert.deepEqual(rev.changed, ["state", "action"]);
  assert.deepEqual(rev.textChanged, ["state"]);
  assert.equal(rev.units[0].before, "정상");
  assert.equal(rev.units[1].rechecked, true);
  assert.equal(rev.units[1].textChanged, false);
  assert.equal(revisionSummary(rev), "상태 변경으로 3개 항목 중 2개를 재확인하고 1개를 수정했습니다.");
});

test("rechecked units with identical wording are reported honestly", () => {
  const first = turn("r1", { units: units("정상", "허용 가능") });
  const second = turn("r2", { status: "updated", previous_response_id: "r1", refresh_count: 1, changed_units: ["action"], units: units("정상", "허용 가능") });
  const rev = answerRevision(second, [first, second])!;
  assert.deepEqual(rev.textChanged, []);
  assert.equal(revisionSummary(rev), "상태 변경으로 3개 항목 중 1개를 재확인했습니다. 수정 사항은 없습니다.");
  assert.equal(revisionTally(rev), "재확인 1 / 수정 없음 / 1회차");
});

test("the sources line names at most two titles and counts the rest", () => {
  assert.equal(sourcesLine([]), "근거: 관측만 사용");
  assert.equal(sourcesLine(["고추냉이 재배 기준"]), "근거: 고추냉이 재배 기준");
  assert.equal(sourcesLine(["a", "b", "c", "d"]), "근거: a, b 외 2");
});

test("without a declaration, differing text marks the unit as rechecked and changed", () => {
  const first = turn("r1", { units: units("정상", "허용 가능") });
  const second = turn("r2", { status: "updated", previous_response_id: "r1", refresh_count: 1, units: units("점검 필요", "다시 확인") });
  const rev = answerRevision(second, [first, second])!;
  assert.deepEqual(rev.changed, ["state", "action"]);
  assert.deepEqual(rev.textChanged, ["state", "action"]);
});

test("a missing previous turn keeps the server verdict and leaves before empty", () => {
  const second = turn("r2", { status: "updated", previous_response_id: "r1", refresh_count: 1, changed_units: ["all"], units: units("a", "b") });
  const rev = answerRevision(second, [second])!;
  assert.equal(rev.units[0].before, null);
  assert.equal(rev.changed.length, 3);
  assert.equal(rev.textChanged.length, 0);
  assert.equal(answerRevision(turn("r3", { units: units("a", "b") }), []), null);
  assert.equal(answerRevision(turn("r4", null), []), null);
});

test("a second change asks for a fresh question instead of another rewrite", () => {
  const rev = answerRevision(turn("r5", { status: "needs_confirmation", previous_response_id: "r4", refresh_count: 2, units: units("a", "b") }), [])!;
  assert.match(revisionSummary(rev), /새 질문이 필요/);
});

test("retrieval summary speaks in farmer words and accepts both channel formats", () => {
  const withSources = turn("r6", null, {
    evidence: [{ id: "e1" }, { id: "e2" }] as AdvisorTurn["evidence"],
    retrieval: { runId: null, backend: null, candidateCount: null, returnedCount: null, queryScope: null, channels: ["dense: 5", "graph: 1"] },
    assistantMessage: { id: "a", role: "assistant", content: "x", createdAt: "", searchPath: ["Dense", "Sparse"] },
  });
  assert.equal(retrievalSummary(withSources), "자료 2개, 의미 검색 + 낱말 검색 + 관계 근거");
  assert.equal(retrievalSummary(turn("r7", null)), "참고 자료 없음. 관측만 사용");
  const diagnostics = turn("r8", null, { evidence: [{ id: "e1" }] as AdvisorTurn["evidence"], retrieval: { runId: null, backend: null, candidateCount: null, returnedCount: null, queryScope: null, channels: [], researchDiagnosticsOnly: true } });
  assert.match(retrievalSummary(diagnostics), /검색 품질 검토 중/);
  assert.equal(unitLabel("evidence"), "관측 근거");
});

test("in English the answer meta lines are English", () => {
  setLang("en");
  try {
    const first = turn("r1", { units: units("정상", "허용 가능") });
    const second = turn("r2", { status: "updated", previous_response_id: "r1", refresh_count: 1, changed_units: ["state", "action"], units: units("22°C 점검 필요", "허용 가능") });
    const rev = answerRevision(second, [first, second])!;
    assert.equal(revisionSummary(rev), "After the status change, 2 of 3 parts were rechecked and 1 revised.");
    assert.equal(revisionTally(rev), "2 rechecked / 1 revised / round 1");
    assert.equal(unitLabel("state"), "Status");
    assert.equal(sourcesLine(["a", "b", "c"]), "Sources: a, b and 1 more");
    assert.equal(retrievalSummary(turn("r7", null)), "No sources. Readings only");
  } finally {
    setLang("ko");
  }
});

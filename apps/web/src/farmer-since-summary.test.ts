import test from "node:test";
import assert from "node:assert/strict";
import { sinceSummary } from "./farmer/since-summary.ts";

const zoneLabel = (id?: string | null) => (id === "zone-a" ? "A구역" : id === "zone-b" ? "B구역" : "농장");
const at = (hoursAgo: number) => new Date(Date.UTC(2026, 8, 22, 8) - hoursAgo * 3600000).toISOString();
const since = at(10);

test("records after the last visit are counted and listed newest first", () => {
  const out = sinceSummary({
    alerts: [{ title: "근권 온도 경보", occurredAt: at(2), zoneId: "zone-a", severity: "critical" }, { title: "오래된 경보", occurredAt: at(20), zoneId: "zone-a", severity: "warning" }],
    approvals: [{ device: "근권 냉각기", createdAtIso: at(1), zoneId: "zone-b", requestedValue: "냉각 켜기" }],
    turns: [{ recordedAt: at(0.5), stateReview: { status: "updated", previous_response_id: "r1", refresh_count: 1, units: [], mode: "selective" } as never }, { recordedAt: at(3), stateReview: null }],
    patrol: [{ title: "출입구 접근", created_at: at(4), status: "resolved" }],
  }, since, zoneLabel);
  assert.deepEqual(out.counts, { alerts: 1, controls: 1, rechecks: 1, camera: 1 });
  assert.equal(out.text, "경보 1건, 설비 변경 1건, 답변 재확인 1회, 카메라 기록 1건");
  assert.deepEqual(out.items.map((i) => i.kind), ["recheck", "control", "alert", "camera"]);
  assert.equal(out.items[2].text, "A구역 근권 온도, 위험");
  assert.equal(out.items[1].text, "B구역 근권 냉각기: 냉각 켜기");
  assert.equal(out.items[0].text, "상담 답변: 바뀐 부분 다시 확인");
  assert.equal(out.items[3].text, "카메라: 출입구 접근, 확인 완료");
});

test("a rechecked answer is named by the place it was asked about", () => {
  const out = sinceSummary({
    alerts: [], approvals: [], patrol: [],
    turns: [{ recordedAt: at(1), stateReview: { status: "needs_confirmation", previous_response_id: "r1", refresh_count: 2, units: [], mode: "selective" } as never, queryContext: { bedId: "bed-15" } as never }],
  }, since, zoneLabel, 8, (t) => (t.queryContext?.bedId === "bed-15" ? "15번 베드" : null));
  assert.equal(out.items[0].text, "15번 베드 답변: 상태가 바뀌어 새 질문 필요");
});

test("nothing new is said plainly", () => {
  const out = sinceSummary({ alerts: [], approvals: [], turns: [], patrol: [] }, since, zoneLabel);
  assert.equal(out.total, 0);
  assert.equal(out.text, "새 기록 없음");
});

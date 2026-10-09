import test from "node:test";
import assert from "node:assert/strict";
import {
  cameraCards,
  cameraDisplayName,
  cameraSummary,
  openPatrolCount,
  patrolHistoryLabel,
  patrolStatusLabel,
  researchDecision,
  videoErrorMessage,
} from "./farmer/camera-state.ts";
import { setLang } from "./farmer/i18n.ts";

const bed = (id: string, zone_id: string, camera_ids: string[]) => ({ id, label: id, zone_id, position: { x: 0, y: 0, z: 0 }, tiers: [], camera_ids });

test("an unregistered farm says so instead of showing example cameras", () => {
  assert.equal(cameraSummary({ cameras: [], beds: [bed("bed-01", "zone-a", [])] }).text, "현재 농장 카메라 미연결");
  assert.equal(cameraSummary(null).registered, 0);
  assert.deepEqual(cameraCards({ cameras: [], beds: [bed("bed-01", "zone-a", [])] }), []);
});

test("registered cameras list their beds and can be filtered by zone", () => {
  const layout = { cameras: [{ id: "cam-1" }, { id: "cam-9" }], beds: [bed("bed-01", "zone-a", ["cam-1"]), bed("bed-10", "zone-b", ["cam-2"])] };
  const all = cameraCards(layout);
  assert.deepEqual(all.map((c) => c.id), ["cam-1", "cam-9", "cam-2"]);
  assert.deepEqual(all[0].bedLabels, ["bed-01"]);
  assert.deepEqual(cameraCards(layout, "zone-b").map((c) => c.id), ["cam-9", "cam-2"]);
  assert.equal(cameraSummary(layout).text, "카메라 3대 등록. 실시간 화면 미연결");
});

test("a release hold is shown before the model's own answer", () => {
  assert.equal(researchDecision({ decision: "abstain", release_hold_reason: null, stages: { release: { released: false, hold_reason: "policy_not_validated" } } }).kind, "held");
  assert.equal(researchDecision({ decision: "answer", release_hold_reason: "confidence_below_threshold", stages: {} }).kind, "held");
  assert.equal(researchDecision({ decision: "answer", release_hold_reason: null, stages: { release: { released: true } } }).kind, "answer");
  assert.equal(researchDecision({ decision: "abstain", release_hold_reason: null, stages: { release: { released: false, hold_reason: "model_abstained" } } }).kind, "abstain");
  assert.equal(researchDecision({ decision: "unavailable", release_hold_reason: null, stages: {} }).kind, "failed");
  assert.equal(researchDecision({ decision: "unavailable", release_hold_reason: null, stages: {} }).title, "영상 확인을 완료하지 못했습니다");
  assert.equal(researchDecision({ decision: "abstain", release_hold_reason: null, stages: { release: { released: false, hold_reason: "model_abstained" } } }).title, "판단하지 않음 (기권)");
  assert.equal(cameraDisplayName("research-c2", ["research-c1", "research-c2"]), "카메라 2");
  assert.equal(cameraDisplayName("unknown", ["research-c1"]), "unknown");
  assert.equal(cameraDisplayName(null, []), "카메라 미확인");
});

test("patrol wording never turns an open event into a resolved one", () => {
  assert.equal(patrolStatusLabel("new"), "확인 필요");
  assert.equal(patrolStatusLabel("reviewing"), "현장 확인 중");
  assert.equal(patrolStatusLabel("resolved"), "확인 완료");
  assert.equal(openPatrolCount([{ status: "new" }, { status: "reviewing" }, { status: "resolved" }]), 2);
  assert.equal(patrolHistoryLabel("AI 화면 확인: abstain"), "영상 근거 부족");
  assert.match(patrolHistoryLabel("침입 의심 시연 이벤트 발생 · 자동 탐지 아님"), /자동 탐지 아님/);
  setLang("en");
  try {
    assert.equal(patrolHistoryLabel("AI 카메라 판독: 다시 보임"), "AI camera reading: seen again");
    assert.equal(patrolHistoryLabel("현장 조치 완료"), "Handled");
  } finally {
    setLang("ko");
  }
});

test("video errors explain permission and conflict without claiming a change happened", () => {
  assert.match(videoErrorMessage("영상 서비스 요청을 완료하지 못했습니다 (403)."), /권한/);
  assert.match(videoErrorMessage("영상 서비스 요청을 완료하지 못했습니다 (409)."), /진행 중/);
  assert.equal(videoErrorMessage("연결 실패"), "연결 실패");
  assert.equal(videoErrorMessage(undefined), "");
});

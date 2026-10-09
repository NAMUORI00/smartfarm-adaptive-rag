import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cameraFinding, cameraCounts, liveMultiview, liveQuestion, multiviewDecision } from "./farmer/demo-cameras.ts";
import type { LiveCameraAnswer } from "./farmer/assist-api.ts";
import type { DemoCameraManifest } from "./farmer/demo-cameras.ts";

const manifest = JSON.parse(readFileSync(new URL("../public/demo-cameras/manifest.json", import.meta.url), "utf8")) as DemoCameraManifest;

test("the example camera set is labelled as examples with generated frames and a precomputed analysis", () => {
  assert.equal(manifest.kind, "example");
  assert.equal(manifest.images.synthetic, true);
  assert.equal(manifest.analysis.precomputed, true);
  assert.equal(manifest.cameras.length, 4);
});

test("a finding needs an answered alert question; abstentions never raise one", () => {
  const byId = Object.fromEntries(manifest.cameras.map((c) => [c.id, c]));
  assert.ok(cameraFinding(byId["cam-a2"]));
  assert.ok(cameraFinding(byId["cam-e1"]));
  assert.equal(cameraFinding(byId["cam-a1"]), null);
  const abstained = { ...byId["cam-a2"], questions: byId["cam-a2"].questions.map((q) => ({ ...q, decision: "abstain" as const })) };
  assert.equal(cameraFinding(abstained), null);
  // Every camera abstains on at least one question a still frame cannot settle.
  for (const c of manifest.cameras) assert.ok(cameraCounts(c).abstained >= 1, c.id);
});

test("the same question put to two cameras rests on the one that shows it", () => {
  const [m] = manifest.multiview ?? [];
  assert.ok(m);
  const { candidates, chosen } = multiviewDecision(m, manifest.cameras);
  assert.equal(candidates.length, 2);
  // The aisle view holds back; the close-up answers with a box, and only it is used.
  assert.equal(candidates.find((c) => c.camera.id === "cam-a1")?.question.decision, "abstain");
  assert.equal(chosen?.camera.id, "cam-a2");
  assert.ok(chosen?.question.box);
  // Nobody answering means no chosen view and no answer.
  const none = multiviewDecision({ ...m, candidates: [{ camera_id: "cam-a1", question_id: "q3" }, { camera_id: "cam-b1", question_id: "q3" }] }, manifest.cameras);
  assert.equal(none.chosen, null);
});

const live = (over: Partial<LiveCameraAnswer>): LiveCameraAnswer => ({
  decision: "answer", present: true, answer: "예, 잎 가장자리가 노랗습니다.", reason: "앞쪽 잎 가장자리가 노랗습니다.", confidence: 0.9,
  box: [0.5, 0.5, 0.2, 0.2], camera_id: "cam-a2", question: "", model: "openai/gpt-5.6-luna", elapsed_ms: 3000, analyzed_at: "2026-09-28T05:00:00Z", ...over,
});

test("a reading made now replaces the saved verdict, and raises a finding only when the condition was seen", () => {
  const q = manifest.cameras.find((c) => c.id === "cam-a2")!.questions[0];
  const seen = liveQuestion(q, live({}));
  assert.equal(seen.answer_ko, "예, 잎 가장자리가 노랗습니다.");
  assert.equal(seen.alert, true);
  assert.equal(liveQuestion(q, live({ present: false, answer: "아니요, 황변은 보이지 않습니다." })).alert, false);
  const held = liveQuestion(q, live({ decision: "abstain", present: null, answer: null, box: null }));
  assert.equal(held.alert, false);
  assert.equal(held.box, null);
});

test("the multi-camera question read now rests on the camera that answered", () => {
  const [m] = manifest.multiview ?? [];
  const results = { "cam-a1": live({ camera_id: "cam-a1", decision: "abstain", present: null, answer: null, box: null }), "cam-a2": live({}) };
  const { candidates, chosen } = liveMultiview(m, manifest.cameras, results);
  assert.equal(candidates.length, 2);
  assert.equal(chosen?.camera.id, "cam-a2");
  assert.equal(candidates[0].question.question_ko, m.question_ko);
  // Until both cameras reply, only the replied ones are listed and nothing is chosen from the missing one.
  assert.equal(liveMultiview(m, manifest.cameras, { "cam-a1": results["cam-a1"] }).chosen, null);
});

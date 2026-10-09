import { assetUrl } from "./asset-url.ts";
import { L } from "./i18n.ts";
import type { LiveCameraAnswer } from "./assist-api.ts";

/**
 * Example cameras. This farm has no camera installed, so the console carries a
 * small set of generated greenhouse scenes. The AI reads them when asked
 * (answer where the frame shows it, abstain where it cannot); the reading saved
 * with the set is only shown, named as such, when the AI cannot be reached.
 * They are always labelled as examples; nothing here is presented as a live
 * feed of this farm.
 */
export type DemoQuestion = {
  id: string;
  question_ko: string;
  question_en: string;
  decision: "answer" | "abstain";
  answer_ko: string | null;
  answer_en: string | null;
  reason_ko: string;
  reason_en: string;
  confidence: number;
  box: [number, number, number, number] | null;
  /** A finding a person should look at (yellowing, a boundary crossing), when answered. */
  alert?: boolean;
  /** A few words naming the finding, for the brief and the plan. */
  finding_ko?: string;
  finding_en?: string;
  /** A question for the advisor, phrased so the growing guides can be searched. */
  ask_ko?: string;
};
export type DemoCamera = {
  id: string;
  label_ko: string;
  label_en: string;
  zone_id: string;
  bed_id: string | null;
  col: number;
  row: number;
  angle: number;
  image: string;
  summary_ko: string;
  summary_en: string;
  questions: DemoQuestion[];
};
/** One question put to several cameras: the view that shows the evidence is used, the rest abstain. */
export type DemoMultiview = {
  id: string;
  zone_id: string;
  question_ko: string;
  question_en: string;
  candidates: { camera_id: string; question_id: string }[];
};
export type DemoCameraManifest = {
  kind: "example";
  note_ko: string;
  note_en: string;
  images: { generator: string; created_at: string; synthetic: boolean };
  analysis: { analyzer: string; created_at: string; precomputed: boolean };
  cameras: DemoCamera[];
  multiview?: DemoMultiview[];
};

/** The camera page's focus that opens it at the question put to two cameras. */
export const MULTIVIEW_FOCUS = "multiview";

export const cameraLabel = (c: DemoCamera) => L(c.label_ko, c.label_en);
export const questionText = (q: DemoQuestion) => L(q.question_ko, q.question_en);
export const answerText = (q: DemoQuestion) => (q.decision === "answer" ? L(q.answer_ko ?? "", q.answer_en ?? "") : L(q.reason_ko, q.reason_en));

/** The first finding the analysis actually answered; abstentions never raise one. */
export function cameraFinding(c: DemoCamera): DemoQuestion | null {
  return c.questions.find((q) => q.alert && q.decision === "answer") ?? null;
}

export function cameraCounts(c: DemoCamera) {
  const answered = c.questions.filter((q) => q.decision === "answer").length;
  return { answered, abstained: c.questions.length - answered };
}

export type MultiviewCandidate = { camera: DemoCamera; question: DemoQuestion; chosen: boolean };
/**
 * The saved per-camera decisions for one question, and which view the answer
 * rests on: the most confident camera that answered. When none answered, no
 * view is chosen and the question is left unanswered — the whole point is to
 * answer only from a frame that shows it.
 */
export function multiviewDecision(m: DemoMultiview, cameras: DemoCamera[]): { candidates: MultiviewCandidate[]; chosen: MultiviewCandidate | null } {
  const found = m.candidates.flatMap(({ camera_id, question_id }) => {
    const camera = cameras.find((c) => c.id === camera_id);
    const question = camera?.questions.find((q) => q.id === question_id);
    return camera && question ? [{ camera, question, chosen: false }] : [];
  });
  return chooseEvidence(found);
}

/** The answer rests on the most confident camera that answered; none answering means no answer. */
function chooseEvidence(found: MultiviewCandidate[]): { candidates: MultiviewCandidate[]; chosen: MultiviewCandidate | null } {
  const best = found.filter((c) => c.question.decision === "answer").sort((a, b) => b.question.confidence - a.question.confidence)[0] ?? null;
  const candidates = found.map((c) => ({ ...c, chosen: c === best }));
  return { candidates, chosen: candidates.find((c) => c.chosen) ?? null };
}

/**
 * A reading made just now, in the shape the screen already draws. The verdict,
 * words, confidence and region are the model's; the question keeps its own
 * finding name and advisor question, raised only when the model saw the condition.
 */
export function liveQuestion(q: DemoQuestion, live: LiveCameraAnswer): DemoQuestion {
  return {
    ...q,
    decision: live.decision,
    answer_ko: live.answer,
    answer_en: live.answer,
    reason_ko: live.reason,
    reason_en: live.reason,
    confidence: live.confidence,
    box: live.box,
    alert: live.decision === "answer" && live.present === true && !!q.finding_ko,
  };
}

/** The multi-camera question read just now: each camera's live verdict, and the view the answer rests on. */
export function liveMultiview(m: DemoMultiview, cameras: DemoCamera[], results: Record<string, LiveCameraAnswer>): { candidates: MultiviewCandidate[]; chosen: MultiviewCandidate | null } {
  const found = m.candidates.flatMap(({ camera_id, question_id }) => {
    const camera = cameras.find((c) => c.id === camera_id);
    const saved = camera?.questions.find((q) => q.id === question_id);
    const live = results[camera_id];
    if (!camera || !saved || !live) return [];
    const question = liveQuestion({ ...saved, question_ko: m.question_ko, question_en: m.question_en }, live);
    return [{ camera, question, chosen: false }];
  });
  return chooseEvidence(found);
}

let cache: Promise<DemoCameraManifest | null> | null = null;
/** The example camera set shipped with the console; null when it is missing. */
export function loadDemoCameras(): Promise<DemoCameraManifest | null> {
  cache ??= fetch(assetUrl("/demo-cameras/manifest.json"))
    .then((r) => (r.ok ? (r.json() as Promise<DemoCameraManifest>) : null))
    .then((m) => (m ? { ...m, cameras: m.cameras.map((c) => ({ ...c, image: assetUrl(c.image) })) } : null))
    .catch(() => null);
  return cache;
}

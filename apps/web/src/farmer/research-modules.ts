/**
 * Where each research module runs in this console. The console shows these
 * as tags on the exact screen spot (when "연구 모듈 보기" is on) and as the
 * "연구 모듈" map. Results live in the thesis; here the point is where the
 * code plugs into daily farm work and what it just did, so no screen names a
 * thesis chapter or a venue.
 */
import { L } from "./i18n.ts";

export type ModuleId = "rag" | "qact" | "sr" | "gate" | "video";

export type ResearchModule = {
  id: ModuleId;
  /** Short name on the tag. */
  name: string;
  /** The farm problem it answers, one sentence. */
  problem: string;
  /** What it does on this screen, one sentence. */
  does: string;
  /** Where to look for it in the dashboard. */
  where: string;
  /** Files and functions that run here. */
  code: string[];
};

type Pair = [ko: string, en: string];
type ModuleText = { name: Pair; problem: Pair; does: Pair; where: Pair; code: Pair[] };

const TEXT: Record<ModuleId, ModuleText> = {
  rag: {
    name: ["출처 있는 재배 상담", "Cited cultivation advice"],
    problem: ["재배 매뉴얼을 뒤지지 않고 지금 이 베드에 맞는 답을 얻고 싶다.", "Growers want an answer that fits this bed now, without searching the cultivation manuals."],
    does: ["선택한 베드의 관측과 재배 자료를 함께 읽고, 답 아래에 번호로 출처를 붙입니다.", "Reads the selected bed's readings together with cultivation references and numbers the sources under the answer."],
    where: ["AI 상담 → 답 아래 번호 근거 → 자세히", "AI advisor → numbered sources under the answer → Details"],
    code: [
      ["POST /v1/advisor/questions (상담 API, 비공개 저장소)", "POST /v1/advisor/questions (advisor API, private repository)"],
      ["services/api/app/knowledge.py, 자료 색인·검색", "services/api/app/knowledge.py, reference indexing and search"],
    ],
  },
  qact: {
    name: ["질문별 검색 방법 고르기", "Per-question retrieval routing"],
    problem: ["질문마다 맞는 자료 찾기 방법이 달라, 늘 같은 방식으로 찾으면 엉뚱한 자료가 섞인다.", "Each question suits a different search method; searching the same way every time mixes in unrelated material."],
    does: ["질문을 보고 의미 검색·낱말 검색·관계 근거 중 어느 것을 쓸지 정하고, 믿을 수 없으면 기본 방법으로 돌아갑니다.", "Chooses semantic search, keyword search or relation evidence for each question, and falls back to the default method when the choice cannot be trusted."],
    where: ["AI 상담 → 답의 자세히 → 답변이 만들어진 과정", "AI advisor → Details → How this answer was made"],
    code: [
      ["services/api/app/research_retrieval_algorithm.py, dense_first_adaptive_route()", "services/api/app/research_retrieval_algorithm.py, dense_first_adaptive_route()"],
      ["services/api/app/research_retrieval.py, 정책 파일 검증", "services/api/app/research_retrieval.py, policy file verification"],
    ],
  },
  sr: {
    name: ["값이 바뀐 부분만 다시 확인", "Recheck only what changed"],
    problem: ["상담한 뒤 센서 값이 바뀌면, 예전 답을 믿고 설비를 움직이는 실수가 생긴다.", "When sensor values change after advice is given, acting on the old answer can move equipment the wrong way."],
    does: ["답을 상태 설명·행동 안내·관측 근거로 나누고, 바뀐 값에 기대는 부분만 다시 씁니다. 계속 바뀌면 새로 물어보라고 합니다.", "Splits the answer into state, action and evidence, and rewrites only the parts that depend on changed values. If values keep changing, it asks for a new question."],
    where: ["AI 상담 → 답 위 다시 확인 안내와 수정 전 보기, 답 아래 재확인", "AI advisor → the recheck note and Show previous above the answer, Recheck below it"],
    code: [
      ["github.com/NAMUORI00/smartfarm-state-revalidation (연구용 실행 엔진과 평가)", "github.com/NAMUORI00/smartfarm-state-revalidation (research engine and evaluation)"],
      ["services/api/app/answer_review_core.py, declare_review(), affected_units()", "services/api/app/answer_review_core.py, declare_review(), affected_units()"],
      ["POST /v1/advisor/sessions/{id}/recheck (재확인 API, 비공개 저장소)", "POST /v1/advisor/sessions/{id}/recheck (recheck API, private repository)"],
    ],
  },
  gate: {
    name: ["허용 직전 다시 확인", "Recheck before approval"],
    problem: ["변경을 확인하는 사이에 상태가 바뀌면, 이미 맞지 않는 명령이 실행될 수 있다.", "If conditions change while a change is being reviewed, a command that no longer fits can still run."],
    does: ["'변경 허용'을 누르는 순간 장치·경보 상태를 다시 읽고, 달라졌으면 실행하지 않고 다시 확인하게 합니다.", "Rereads device and alert state the moment 'Approve change' is pressed; if anything differs, the command does not run and the change must be reviewed again."],
    where: ["설비 → 변경 내용 확인 → 변경 허용", "Equipment → Review change → Approve change"],
    code: [
      ["apps/web/src/farmer/workspace-state.ts, deviceRevision()", "apps/web/src/farmer/workspace-state.ts, deviceRevision()"],
      ["services/farm-mcp/app/service.py, approve_control()", "services/farm-mcp/app/service.py, approve_control()"],
    ],
  },
  video: {
    name: ["보이는 것만 답하는 카메라 확인", "Camera answers from visible evidence"],
    problem: ["카메라가 여러 대여도 근거가 안 보이는 화면으로 추측해 답하면 오히려 위험하다.", "Even with several cameras, guessing from a view that does not show the evidence is worse than no answer."],
    does: ["근거가 보이는 카메라를 먼저 고르고, 보이면 답하고 안 보이면 기권합니다. 공개 기준을 못 넘으면 결론을 감춥니다.", "Picks the camera that shows the evidence, answers if it is visible and abstains if not. If the release threshold is not met, the conclusion is withheld."],
    where: ["카메라 → 연구 모델: 여러 카메라에서 근거 고르기", "Cameras → Research model: choosing the evidence among cameras"],
    code: [
      ["github.com/NAMUORI00/multiview-selective-vqa, src/mvevirag (시점 선택과 응답·기권)", "github.com/NAMUORI00/multiview-selective-vqa, src/mvevirag (view selection, answer or abstain)"],
      ["대시보드 연결과 공개 기준 보정 (비공개 저장소)", "Dashboard connection and release calibration (private repository)"],
    ],
  },
};

function moduleOf(id: ModuleId): ResearchModule {
  const t = TEXT[id];
  const m = { id } as ResearchModule;
  for (const key of ["name", "problem", "does", "where"] as const) {
    Object.defineProperty(m, key, { enumerable: true, get: () => L(t[key][0], t[key][1]) });
  }
  Object.defineProperty(m, "code", { enumerable: true, get: () => t.code.map(([ko, en]) => L(ko, en)) });
  return m;
}

/** Each field reads the current language when accessed, so `MODULES.qact.name` follows a language change. */
export const MODULES: Record<ModuleId, ResearchModule> = {
  rag: moduleOf("rag"),
  qact: moduleOf("qact"),
  sr: moduleOf("sr"),
  gate: moduleOf("gate"),
  video: moduleOf("video"),
};

/** Korean method identifiers returned in `routeText().methods`; other screens compare against these. */
export const ROUTE_METHODS = ["의미 검색", "낱말 검색", "관계 근거"] as const;

/** The display label of a method identifier from `routeText().methods`, in the current language. */
export function methodLabel(id: string): string {
  switch (id) {
    case "의미 검색": return L(id, "Semantic search");
    case "낱말 검색": return L(id, "Keyword search");
    case "관계 근거": return L(id, "Relation evidence");
    default: return id;
  }
}

/**
 * "이렇게 찾았어요": the retrieval route of one answer, in farmer words.
 * `methods` keeps the Korean identifiers of ROUTE_METHODS in every language,
 * because callers compare against them; show them with `methodLabel`. `note` is translated.
 */
export function routeText(route: { mode: string | null; path: string[]; reason: string | null; profileState: string | null } | undefined, fallbackPath: string[]): { methods: string[]; note: string } {
  const words: Record<string, string> = { dense: "의미 검색", sparse: "낱말 검색", graph: "관계 근거" };
  const path = (route?.path?.length ? route.path : fallbackPath).map((p) => p.toLowerCase());
  const methods = ["dense", "sparse", "graph"].filter((p) => path.includes(p)).map((p) => words[p]);
  if (!route) return { methods, note: "" };
  if (route.mode?.includes("fallback") || (route.profileState && route.profileState !== "valid")) {
    return { methods, note: L("검색 방법 고르기 설정을 확인할 수 없어 기본 방법으로 찾았습니다.", "The routing policy could not be verified, so the default method was used.") };
  }
  return { methods, note: methods.length > 1 ? L("이 질문에 맞게 방법을 섞어 찾았습니다.", "Methods were combined to suit this question.") : L("이 질문은 한 가지 방법이 가장 맞아 그것만 썼습니다.", "One method fit this question best, so only that one was used.") };
}

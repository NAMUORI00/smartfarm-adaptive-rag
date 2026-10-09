import { FarmIcon } from "./FarmIcon";
import type { IconName } from "./FarmIcon";
import { MODULES } from "./research-modules";
import { ModuleDiagram } from "./ModuleDiagram";
import type { ModuleId } from "./research-modules";
import { L } from "./i18n";

type Go = "plan" | "bed" | "advisor" | "devices" | "camera";

/** A farmer's day, step by step, with the research module that runs at each step. Built at render so it follows the language. */
const flow = (): { id: string; step: string; icon: IconName; what: string; modules: ModuleId[]; go: Go }[] => [
  { id: "plan", step: L("출근해서 약도 보기", "Check the farm plan on arrival"), icon: "map", what: L("문제 있는 구역·베드·설비가 약도에 표시됩니다.", "Zones, beds and equipment that need attention are marked on the plan."), modules: [], go: "plan" },
  { id: "bed", step: L("베드 상태 확인", "Check bed status"), icon: "sensor", what: L("고른 베드만 3D로 보고 센서 값과 기준을 봅니다.", "View the chosen bed in 3D with its sensor values and target ranges."), modules: [], go: "bed" },
  { id: "ask", step: L("농장 상담에 묻기", "Ask the farm advisor"), icon: "advisor", what: L("관측과 재배 자료로 답하고 출처를 붙입니다.", "Answers from readings and cultivation references, with sources cited."), modules: ["rag", "qact"], go: "advisor" },
  { id: "recheck", step: L("값이 바뀌면 답 다시 확인", "Recheck the answer when values change"), icon: "compare", what: L("바뀐 값에 기대는 부분만 다시 씁니다.", "Only the parts that depend on changed values are rewritten."), modules: ["sr"], go: "advisor" },
  { id: "approve", step: L("설비 조절 허용", "Approve an equipment change"), icon: "controls", what: L("허용 직전 상태를 다시 읽고, 달라졌으면 멈춥니다.", "State is reread just before approval; if it has changed, the command stops."), modules: ["gate"], go: "devices" },
  { id: "camera", step: L("카메라로 현장 확인", "Check the site by camera"), icon: "camera", what: L("근거가 보이는 화면만으로 답하고, 없으면 기권합니다.", "Answers only from views that show the evidence, and abstains otherwise."), modules: ["video"], go: "camera" },
];

export function ModuleMap({ onBack, onGo, showTags, onToggleTags }: {
  onBack: () => void;
  onGo: (target: Go) => void;
  showTags: boolean;
  onToggleTags: () => void;
}) {
  return (
    <div className="fm-research-view" aria-label={L("연구 모듈", "Research modules")}>
      <div className="fm-camera-bar">
        <button type="button" onClick={onBack}>{L("배치도로", "Back to plan")}</button>
        <p className="fm-camera-status"><strong>{L("업무 단계별 적용 모듈", "Modules by work step")}</strong></p>
        <label className="fm-inline-check">
          <input type="checkbox" checked={showTags} onChange={onToggleTags} />
          {L("화면에 모듈 위치 표시", "Show module locations on screen")}
        </label>
      </div>
      <ol className="fm-flow">
        {flow().map((f, i) => (
          <li key={f.id} className={f.modules.length ? "has-module" : ""}>
            <span className="fm-flow-index">{i + 1}</span>
            <div className="fm-flow-body">
              <h3><FarmIcon name={f.icon} />{f.step}</h3>
              <p>{f.what}</p>
              {f.modules.map((id) => {
                const m = MODULES[id];
                return (
                  <div className="fm-flow-module" key={id}>
                    <div className="fm-flow-module-head"><strong>{m.name}</strong></div>
                    <p className="fm-flow-problem">{m.problem}</p>
                    <ModuleDiagram id={id} />
                    <p>{m.does}</p>
                    <p className="fm-module-code">{m.code.map((c) => <code key={c}>{c}</code>)}</p>
                  </div>
                );
              })}
            </div>
            <button type="button" className="fm-flow-go" onClick={() => onGo(f.go)}>
              {L("화면에서 보기", "View on screen")} <FarmIcon name="chevron" />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

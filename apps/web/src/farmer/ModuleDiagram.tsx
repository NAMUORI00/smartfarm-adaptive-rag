import type { ModuleId } from "./research-modules";
import { methodLabel, ROUTE_METHODS } from "./research-modules";
import { L } from "./i18n";

/**
 * How each module works, drawn as a few boxes and arrows a visitor reads in
 * seconds. Illustrations of the mechanism, not measurements. When a live
 * trace is passed (the methods this answer used, the parts it rechecked),
 * the drawing lights those parts.
 */
export type DiagramLive = {
  methods?: string[];
  changedUnits?: string[];
  chosenCamera?: number | null;
  outcome?: "answer" | "abstain" | "held" | null;
};

const Arrow = () => <span className="fm-dg-arrow" aria-hidden="true">→</span>;

export function ModuleDiagram({ id, live }: { id: ModuleId; live?: DiagramLive }) {
  // Without a live trace the drawing is an example of how it works, and says so.
  const caption = <p className="fm-dg-caption">{live ? L("이번에 실제로 한 일", "What it actually did this time") : L("작동 예시", "How it works, example")}</p>;
  return <div className="fm-dg-wrap">{caption}<Diagram id={id} live={live ?? {}} /></div>;
}

function Diagram({ id, live }: { id: ModuleId; live: DiagramLive }) {
  switch (id) {
    case "rag":
      return (
        <div className="fm-dg" role="img" aria-label={L("베드 관측과 재배 자료를 함께 읽어 출처가 붙은 답을 만든다", "Reads bed readings with cultivation references and writes an answer with cited sources")}>
          <div className="fm-dg-col">
            <span className="fm-dg-box">{L("이 베드의 관측", "This bed's readings")}</span>
            <span className="fm-dg-box">{L("재배 자료", "Cultivation references")}</span>
          </div>
          <Arrow />
          <span className="fm-dg-box is-key">{L("답 쓰기", "Write answer")}</span>
          <Arrow />
          <span className="fm-dg-box is-out">{L("답", "Answer")} <i className="fm-dg-cite">1</i><i className="fm-dg-cite">2</i></span>
        </div>
      );
    case "qact": {
      const used: string[] = live.methods ?? [ROUTE_METHODS[0], ROUTE_METHODS[1]];
      return (
        <div className="fm-dg" role="img" aria-label={L(`질문을 보고 검색 방법을 고른다: ${used.join(", ")}`, `Chooses search methods for the question: ${used.map(methodLabel).join(", ")}`)}>
          <span className="fm-dg-box">{L("질문", "Question")}</span>
          <Arrow />
          <span className="fm-dg-box is-key">{L("방법 고르기", "Choose method")}</span>
          <Arrow />
          <div className="fm-dg-col">
            {ROUTE_METHODS.map((m) => (
              <span key={m} className={`fm-dg-box is-small ${used.includes(m) ? "is-on" : "is-off"}`}>{methodLabel(m)}</span>
            ))}
          </div>
          <Arrow />
          <span className="fm-dg-box is-out">{L("자료", "References")}</span>
        </div>
      );
    }
    case "sr": {
      const changed = live.changedUnits ?? ["action"];
      return (
        <div className="fm-dg" role="img" aria-label={L("센서 값이 바뀌면 그 값에 기대는 부분만 다시 쓴다", "When a sensor value changes, only the parts that depend on it are rewritten")}>
          <span className="fm-dg-box is-warn">{L("센서 값 바뀜", "Sensor value changed")}</span>
          <Arrow />
          <div className="fm-dg-units">
            {[["state", L("상태 설명", "State")], ["action", L("행동 안내", "Action")], ["evidence", L("관측 근거", "Evidence")]].map(([k, label]) => (
              <span key={k} className={`fm-dg-box is-small ${changed.includes(k) ? "is-on" : "is-off"}`}>{label}{changed.includes(k) ? L(" / 다시 씀", " / rewritten") : L(" / 그대로", " / unchanged")}</span>
            ))}
          </div>
        </div>
      );
    }
    case "gate":
      return (
        <div className="fm-dg" role="img" aria-label={L("변경 내용을 확인하고 허용하는 순간 상태를 다시 읽어, 같으면 실행하고 다르면 멈춘다", "After the change is reviewed, state is reread at the moment of approval: the command runs if nothing changed and stops if it did")}>
          <span className="fm-dg-box">{L("변경 내용 확인", "Review change")}</span>
          <Arrow />
          <span className="fm-dg-box is-key">{L("허용 순간 다시 읽기", "Reread at approval")}</span>
          <Arrow />
          <div className="fm-dg-col">
            <span className="fm-dg-box is-small is-on">{L("같으면, 실행", "If same, run")}</span>
            <span className="fm-dg-box is-small is-warn">{L("다르면, 멈춤", "If different, stop")}</span>
          </div>
        </div>
      );
    case "video": {
      const chosen = live.chosenCamera ?? 0;
      const outcome = live.outcome ?? null;
      return (
        <div className="fm-dg" role="img" aria-label={L("근거가 보이는 카메라를 골라, 보이면 답하고 없으면 기권하며, 공개 기준을 넘지 못하면 결론을 감춘다", "Picks the camera that shows the evidence, answers if it is visible, abstains if not, and withholds the conclusion below the release threshold")}>
          <div className="fm-dg-col">
            {[0, 1].map((i) => (
              <span key={i} className={`fm-dg-box is-small ${i === chosen ? "is-on" : "is-off"}`}>{L("카메라", "Camera")} {i + 1}{i === chosen ? L(", 선택", ", selected") : ""}</span>
            ))}
          </div>
          <Arrow />
          <div className="fm-dg-col">
            <span className={`fm-dg-box is-small ${outcome === "answer" ? "is-on" : ""}`}>{L("보이면, 답", "If visible, answer")}</span>
            <span className={`fm-dg-box is-small ${outcome === "abstain" ? "is-warn" : ""}`}>{L("없으면, 기권", "If not, abstain")}</span>
          </div>
          <Arrow />
          <span className={`fm-dg-box ${outcome === "held" ? "is-warn" : "is-key"}`}>{L("공개 기준, 못 넘으면 감춤", "Release threshold, withheld if not met")}</span>
        </div>
      );
    }
  }
}

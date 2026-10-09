import { ReplayNote } from "./ReplayNote";
import { useEffect, useState } from "react";
import type { useFarmRuntime } from "./useFarmRuntime";
import type { StartIntent } from "./FarmerWorkspace";
import { Prefs, usePrefs } from "./Prefs";
import { L } from "./i18n";
import { knowledgeComposition } from "./assist-api";
import type { KnowledgeComposition } from "./assist-api";
import { ArchitectureFigure } from "./ArchitectureFigure";
import { LandingResearch } from "./LandingFlows";
import { studyTargets } from "./flow-model";
import { pickKnowledgeTurn } from "./how-it-works";
import { systemName } from "./study-refs";

type Runtime = ReturnType<typeof useFarmRuntime>;

/**
 * The landing page, one of two parts beside the working dashboard. Figure 1
 * shows the whole system; below it the three studies are explained in order,
 * each where it works in the farm system and run on a farm example (real
 * records or a run made now). Working with the farm happens in the dashboard;
 * the top bar keeps only the way there.
 */
export function Landing({ runtime, onEnter, onResearch }: { runtime: Runtime; onEnter: (intent?: StartIntent) => void; onResearch: () => void }) {
  const { resolved } = usePrefs();
  const [composition, setComposition] = useState<KnowledgeComposition | null>(null);
  useEffect(() => { void knowledgeComposition(runtime.farmId).then(setComposition).catch(() => undefined); }, [runtime.farmId]);
  // Where each study is at work in the dashboard, so a visitor can open the real case.
  const targets = studyTargets({
    askedAt: pickKnowledgeTurn(runtime.turns)?.queryContext,
    metrics: runtime.snapshot?.metrics ?? [],
    actuators: runtime.snapshot?.actuators ?? [],
    firstZone: runtime.layout?.zones[0]?.id ?? null,
  });
  return (
    <main className="farmer-workspace fm-landing" data-theme={resolved}>
      <header className="fm-lp-gnb">
        <strong className="fm-lp-logo">{L("스마트팜 운영 콘솔", "Smart Farm Console")}</strong>
        <Prefs />
        <button className="fm-primary" onClick={() => onEnter()}>{L("대시보드", "Dashboard")}</button>
      </header>

      <section className="fm-lp-top" aria-labelledby="lp-title">
        <div className="fm-lp-top-text">
          <h1 id="lp-title">{systemName()}</h1>
          <p className="fm-lp-key">{L("센서 값은 판단으로, 질문은 근거 있는 답변으로, 사람이 허용한 조작만 설비로.", "Readings become judgements, questions become grounded answers, and only operations a person allows reach the equipment.")}</p>
        </div>
        <ArchitectureFigure onEnter={onEnter} />
      </section>

      <LandingResearch runtime={runtime} composition={composition} targets={targets} onEnter={onEnter} />

      <footer className="fm-lp-foot">
        <ReplayNote />
        <span>{L("센서 값은 구역 공용입니다. 카메라 화면은 생성한 예시 영상·이미지와 공개 연구 영상입니다. 설비는 사람이 허용해야 움직입니다.", "Sensor values are shared per zone. Camera views are generated example videos and images and public research footage. Equipment moves only when a person allows it.")}</span>
        <button type="button" className="fm-lp-foot-link" onClick={onResearch}>{L("연구 모듈 지도", "Research module map")}</button>
      </footer>
    </main>
  );
}

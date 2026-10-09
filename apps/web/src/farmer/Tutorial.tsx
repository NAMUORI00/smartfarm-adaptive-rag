import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { L } from "./i18n";

/**
 * First-visit tour. Each step lights up one real thing on the screen and says
 * one line about it; everything else is dimmed. Each step tries its selectors
 * in order (the drawing, then the phone list); a step with nothing on screen
 * is left out (no alert today, no alert step).
 */
export type TourStep = { id: string; targets: string[]; title: string; text: string };

export const TOUR_KEY = "farmer.tutorialDone";

export function tourSteps(): TourStep[] {
  return [
    {
      id: "plan",
      targets: [".fm-plan svg", ".fm-plan-list"],
      title: L("이 그림이 우리 농장입니다", "This drawing is your farm"),
      text: L("색으로 상태를 봅니다. 붉은 구역은 확인할 곳입니다.", "Colour shows the state. A red zone needs a look."),
    },
    {
      id: "brief",
      targets: [".fm-brief-panel", ".fm-brief:not(.is-compact)"],
      title: L("AI가 먼저 볼 곳을 골라 둡니다", "The AI picks where to look first"),
      text: L("번호는 배치도의 자리와 같습니다. 왜 그런지와 할 일을 함께 보여줍니다.", "Numbers match the spots on the drawing. Each says why, and what to do."),
    },
    {
      id: "work",
      targets: [".fm-brief-panel .fm-tabs"],
      title: L("오늘 작업과 인수인계", "Today's work and handover"),
      text: L("걷는 순서대로 짠 작업표와 교대할 때 넘길 메모도 여기 있습니다.", "A work list in walking order, and a note to hand over at shift change, are here too."),
    },
    {
      id: "bed",
      targets: [".fm-pb.is-planted", ".fm-plan-list-beds button.is-planted", ".fm-pb", ".fm-plan-list-beds button"],
      title: L("베드를 누르세요", "Tap a bed"),
      text: L("잎 하나가 작물이 있는 단 하나입니다. 누르면 3D로 자세히 봅니다.", "Each leaf is a planted tier. Tap to see the bed in 3D."),
    },
    {
      id: "device",
      targets: [".fm-pd-ventilation_fan.is-on", ".fm-pd.is-on", ".fm-pd", ".fm-plan-list-device"],
      title: L("설비 그림을 누르세요", "Tap a device"),
      text: L("초록은 가동, 주황은 점검입니다. 누르면 상태를 보고 조절합니다.", "Green is running, amber needs a check. Tap to see and adjust it."),
    },
    {
      id: "alert",
      targets: [".fm-alert-chip"],
      title: L("확인할 일", "Things to check"),
      text: L("경보 수입니다. 누르면 가장 급한 곳으로 갑니다.", "The number of alerts. Tap to go to the most urgent one."),
    },
    {
      id: "camera",
      targets: [".fm-header .fm-icon-btn[aria-label='카메라'], .fm-header .fm-icon-btn[aria-label='Cameras']"],
      title: L("카메라", "Cameras"),
      text: L("카메라 화면과 분석 결과를 봅니다.", "See the cameras and what they found."),
    },
    {
      id: "library",
      targets: [".fm-header .fm-lib-icon"],
      title: L("자료실", "Library"),
      text: L("재배 자료를 쪽 순서대로 읽습니다. AI 상담이 인용한 곳은 왼쪽 선으로 보입니다.", "Read the growing guides page by page. Where the AI advisor cited them, a line runs down the left."),
    },
    {
      id: "advisor",
      targets: [".fm-fab"],
      title: L("궁금하면 AI 상담", "Ask the AI anytime"),
      text: L("센서 값과 재배 자료를 함께 읽고 출처와 함께 답합니다. 값이 바뀌면 답도 고쳐 씁니다.", "Answers from your readings and the growing guides, with sources, and rewrites the answer when values change."),
    },
  ];
}

type Rect = { top: number; left: number; width: number; height: number };

function findTarget(targets: string[]): HTMLElement | SVGElement | null {
  for (const selector of targets) {
    for (const el of document.querySelectorAll<HTMLElement | SVGElement>(selector)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) return el;
    }
  }
  return null;
}

export function Tutorial({ onClose }: { onClose: () => void }) {
  // Only the steps whose target is on screen now (no alert today: no alert step). Ids are kept so the wording follows a language change.
  const [ids] = useState(() => tourSteps().filter((s) => s.id === "plan" || findTarget(s.targets)).map((s) => s.id));
  const steps = tourSteps().filter((s) => ids.includes(s.id));
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const step = steps[index];
  const last = index === steps.length - 1;

  // Follow the target: layout can shift (fonts, data arriving, resize).
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const el = findTarget(step.targets);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect((prev) => (prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5 && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5 ? prev : { top: r.top, left: r.left, width: r.width, height: r.height }));
      } else setRect(null);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id]);
  useEffect(() => { nextRef.current?.focus(); }, [index]);

  function finish() {
    try { localStorage.setItem(TOUR_KEY, "true"); } catch { /* storage unavailable */ }
    onClose();
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.stopPropagation(); finish(); }
    else if (e.key === "ArrowRight") setIndex((i) => Math.min(steps.length - 1, i + 1));
    else if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
  }

  // The card sits below the target when there is room, otherwise above; centred without a target.
  const pad = 8;
  const cardW = Math.min(340, window.innerWidth - 32);
  const cardH = cardRef.current?.offsetHeight ?? 170;
  let cardStyle: React.CSSProperties;
  if (rect) {
    const below = rect.top + rect.height + pad + 12 + cardH < window.innerHeight;
    const left = Math.min(Math.max(16, rect.left + rect.width / 2 - cardW / 2), window.innerWidth - cardW - 16);
    const top = below ? rect.top + rect.height + pad + 12 : Math.max(16, rect.top - pad - 12 - cardH);
    cardStyle = { left, top, width: cardW };
  } else {
    cardStyle = { left: (window.innerWidth - cardW) / 2, top: Math.max(16, (window.innerHeight - cardH) / 2), width: cardW };
  }

  return (
    <div className="fm-tour" role="dialog" aria-modal="true" aria-labelledby="fm-tour-title" onKeyDown={onKey}>
      {rect ? (
        <div
          className="fm-tour-spot"
          style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
          aria-hidden="true"
        />
      ) : (
        <div className="fm-tour-dim" aria-hidden="true" />
      )}
      <div className="fm-tour-card" ref={cardRef} style={cardStyle}>
        <p className="fm-tour-count">{index + 1} / {steps.length}</p>
        <h2 id="fm-tour-title">{step.title}</h2>
        <p>{step.text}</p>
        <div className="fm-tour-actions">
          <button type="button" className="fm-tour-skip" onClick={finish}>{L("건너뛰기", "Skip")}</button>
          {index > 0 && <button type="button" onClick={() => setIndex(index - 1)}>{L("이전", "Back")}</button>}
          <button type="button" ref={nextRef} className="fm-primary" onClick={() => (last ? finish() : setIndex(index + 1))}>
            {last ? L("시작하기", "Start") : L("다음", "Next")}
          </button>
        </div>
        <ol className="fm-tour-dots" aria-hidden="true">
          {steps.map((s, i) => <li key={s.id} className={i === index ? "is-on" : ""} />)}
        </ol>
      </div>
    </div>
  );
}

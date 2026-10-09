import type { KeyboardEvent } from "react";
import type { StartIntent } from "./FarmerWorkspace";
import { FarmIcon, iconPath } from "./FarmIcon";
import type { IconName } from "./FarmIcon";
import { getLang, L } from "./i18n";
import type { Lane } from "./flow-model";
import { laneName } from "./flow-model";
import { LaneMark } from "./FlowLanes";
import { STUDIES, studyDesign, studyReference, systemName } from "./study-refs";
import type { StudyNo } from "./study-refs";

/*
 * Figure 1: the whole system as four layers — the farmer's screen, the AI
 * models, the operations server, and the site with the sources it reads — the
 * lanes the flows on the page are drawn across. The system has one fixed name;
 * each of its three AI functions carries one study's detailed design, cited
 * under the figure as references [1]–[3]. The arrows between layers say what
 * passes. The screen row opens the dashboard at that feature; a function box
 * takes the reader to its explanation further down the page. The boxes name
 * what the system is made of, not this farm's counts or the demonstration's
 * example data; the flows below show the real records and say where example
 * data is used.
 */

type Box = { x: number; w: number; title: string; sub: string; dashed?: boolean };
type Entry = { x: number; w: number; icon: IconName; title: string; go: StartIntent | undefined };
/** `kind`: what does the work — a language model, a vision model, or rules. `design`: the study it carries. */
type Study = { no: StudyNo; x: number; w: number; title: string; role: string; kind: string; design: string };
type Arrow = { x: number; from: number; to: number; label: string; side: "left" | "right"; both?: boolean; ai?: boolean };

const W = 1200;
const H = 584;
const BAND: Record<Lane, [number, number]> = { screen: [4, 96], ai: [150, 168], server: [368, 80], field: [498, 80] };
const COL = [[112, 455], [479, 822], [846, 1188]] as const;
const LANE_ICON: Record<Exclude<Lane, "ai">, IconName> = { screen: "screen", server: "server", field: "sensor" };
const LANE_LINES: Record<Lane, [string[], string[]]> = {
  screen: [["농부 화면"], ["Farmer's", "screen"]],
  ai: [["AI 모델"], ["AI", "models"]],
  server: [["운영 서버"], ["Operations", "server"]],
  // Growing guides are not on site: the bottom layer is the site and the sources the system reads.
  field: [["현장과 자료"], ["Site and", "sources"]],
};
/** The figure's own name for a layer (the flows keep "농장 현장" for the bottom one). */
const figureLane = (lane: Lane) => (lane === "field" ? L("현장과 자료", "Site and sources") : laneName(lane));
/**
 * Down the page to a study's explanation (its section keeps clear of the top
 * bar). The flows above it can still grow while their records arrive, so the
 * section is followed until it stays at the top; the reader's own scrolling or
 * a key ends the follow at once.
 */
function showStudy(no: StudyNo) {
  const el = document.getElementById(`lp-r${no}`);
  if (!el) return;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const go = () => el.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  go();
  const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
  const inputs = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  let done = false;
  const stop = () => { done = true; };
  let finished = false;
  const cleanup = () => { finished = true; for (const type of inputs) window.removeEventListener(type, stop); };
  // From the next frame: the Enter or click that asked for the scroll is not the reader taking over.
  requestAnimationFrame(() => { if (!finished) for (const type of inputs) window.addEventListener(type, stop, { passive: true }); });
  const until = performance.now() + 4000;
  let last = Number.NaN, calm = 0;
  const follow = () => {
    const top = el.getBoundingClientRect().top;
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    calm = Math.abs(top - last) < 0.5 ? calm + 1 : 0;
    last = top;
    if (done || performance.now() > until || (calm >= 8 && (Math.abs(top - margin) <= 2 || atBottom))) { cleanup(); return; }
    // At rest but not at the top: the page grew under the scroll, so go the rest of the way.
    if (calm >= 8) { go(); calm = 0; }
    requestAnimationFrame(follow);
  };
  requestAnimationFrame(follow);
}
/** Width of a study's model tag: three Latin letters fit the narrowest. */
const tagWidth = (text: string) => Math.max(38, Math.round([...text].length * (/[가-힣]/.test(text) ? 14 : 8.5) + 12));

export function ArchitectureFigure({ onEnter }: { onEnter: (intent?: StartIntent) => void }) {
  const entries: Entry[] = [
    { x: 112, w: 166, icon: "advisor", title: L("AI 상담", "AI advisor"), go: { kind: "chat" } },
    { x: 289, w: 166, icon: "book", title: L("자료실", "Library"), go: { kind: "library" } },
    { x: 543, w: 216, icon: "camera", title: L("카메라", "Cameras"), go: { kind: "camera" } },
    { x: 910, w: 214, icon: "map", title: L("배치도", "Farm plan"), go: undefined },
  ];
  const studies: Study[] = [
    { no: 1, x: COL[0][0], w: COL[0][1] - COL[0][0], title: L("LLM RAG 상담", "LLM RAG advisor"), role: L("재배 자료를 찾아 근거와 함께 답변", "Answers with sources from the guides"), kind: "LLM", design: studyDesign(1) },
    { no: 2, x: COL[1][0], w: COL[1][1] - COL[1][0], title: L("카메라 관제", "Camera monitoring"), role: L("근거가 보이는 화면만 골라 판독", "Reads only the view that shows it"), kind: "VLM", design: studyDesign(2) },
    { no: 3, x: COL[2][0], w: COL[2][1] - COL[2][0], title: L("센서 불일치 확인", "Sensor mismatch checks"), role: L("어긋난 값과 답변을 다시 확인", "Rechecks mismatched values and answers"), kind: L("규칙", "Rules"), design: studyDesign(3) },
  ];
  // Boxes centred under each study's arrows (283, 651, 1017).
  const server: Box[] = [
    { x: 138, w: 290, title: L("재배 자료 저장소", "Guide library"), sub: L("재배 문헌 색인과 근거 검색", "indexed guides, grounded search") },
    { x: 506, w: 290, title: L("영상 기록", "Video records"), sub: L("촬영 화면, AI 판독 결과", "frames, AI readings") },
    { x: 872, w: 290, title: L("운영 기록과 설비 제어", "Records and control"), sub: L("수신, 품질 검사, 허용, 실행", "intake, checks, approval, commands") },
  ];
  const field: Box[] = [
    { x: 138, w: 290, title: L("재배 문헌", "Growing guides"), sub: L("재배 매뉴얼, 기술 자료, 농장 작업 기준", "manuals, technical guides, farm SOPs"), dashed: true },
    { x: 506, w: 290, title: L("재배실 카메라", "Greenhouse cameras"), sub: L("베드와 통로 촬영", "beds and aisles") },
    { x: 872, w: 290, title: L("센서와 설비", "Sensors and equipment"), sub: L("환경 센서, 냉난방과 관수 설비", "climate sensors, control equipment") },
  ];
  // Between the layers: what goes up (toward the person) and down (toward the site).
  const arrows: Arrow[] = [
    { x: 283, from: 504, to: 442, label: L("색인", "indexed"), side: "right" },
    { x: 651, from: 504, to: 442, label: L("영상", "frames"), side: "right" },
    { x: 995, from: 504, to: 442, label: L("센서 값", "readings"), side: "left" },
    { x: 1039, from: 442, to: 504, label: L("제어 명령", "control commands"), side: "right" },
    { x: 283, from: 374, to: 310, label: L("찾은 자료", "passages found"), side: "right" },
    { x: 651, from: 374, to: 310, label: L("판독할 화면", "views"), side: "right" },
    { x: 995, from: 374, to: 310, label: L("센서 상태", "sensor state"), side: "left" },
    { x: 1039, from: 374, to: 310, label: L("허용 시점 재확인", "recheck"), side: "right", both: true, ai: true },
    { x: 180, from: 158, to: 88, label: L("근거 있는 답변", "answer"), side: "left", ai: true },
    { x: 212, from: 88, to: 158, label: L("질문", "question"), side: "right" },
    { x: 629, from: 158, to: 88, label: L("판독 결과", "reading"), side: "left", ai: true },
    { x: 673, from: 88, to: 158, label: L("질문", "question"), side: "right" },
    { x: 995, from: 158, to: 88, label: L("알림", "alerts"), side: "left", ai: true },
    { x: 1039, from: 88, to: 158, label: L("허용", "approval"), side: "right" },
  ];
  const lang = getLang() === "ko" ? 0 : 1;
  const open = (go: StartIntent | undefined) => () => onEnter(go);
  const key = (go: StartIntent | undefined) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onEnter(go); }
  };
  return (
    <figure className="fm-arch" aria-labelledby="fm-arch-cap">
      <svg className="fm-arch-svg" viewBox={`0 0 ${W} ${H}`} role="group" aria-labelledby="fm-arch-title">
        <title id="fm-arch-title">{L(`${systemName()}의 전체 구조와 세부 설계`, `Overall architecture and detailed designs of the ${systemName()}`)}</title>
        <defs>
          <marker id="fm-arch-head" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" className="fm-arch-headfill" /></marker>
          <marker id="fm-arch-head-ai" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8Z" className="fm-arch-headfill is-ai" /></marker>
        </defs>
        {(Object.keys(BAND) as Lane[]).map((lane) => {
          const [y, h] = BAND[lane];
          const lines = LANE_LINES[lane][lang];
          const cy = y + h / 2;
          const top = cy - (lines.length > 1 ? 30 : 22);
          return (
            <g key={lane} className={`fm-arch-lane is-${lane}`} aria-hidden="true">
              <rect className="fm-arch-band" x={104} y={y} width={W - 108} height={h} rx={8} />
              <rect className="fm-arch-lanebox" x={4} y={y} width={92} height={h} rx={8} />
              {lane === "ai"
                ? <g className="fm-arch-aimark"><rect x={35} y={top} width={30} height={20} rx={3} /><text x={50} y={top + 14}>AI</text></g>
                : <path className="fm-arch-icon" d={iconPath(LANE_ICON[lane])} transform={`translate(38 ${top - 2})`} />}
              {lines.map((line, i) => <text key={line} className="fm-arch-lanetext" x={50} y={top + 40 + i * 17}>{line}</text>)}
            </g>
          );
        })}
        {entries.map((e) => (
          <g key={e.title} className="fm-arch-entry" role="button" tabIndex={0} aria-label={L(`${e.title} 열기`, `Open ${e.title}`)} onClick={open(e.go)} onKeyDown={key(e.go)}>
            <rect x={e.x} y={22} width={e.w} height={60} rx={6} />
            <path className="fm-arch-entryicon" d={iconPath(e.icon)} transform={`translate(${e.x + 16} 40)`} />
            <text className="fm-arch-entrytitle" x={e.x + 50} y={57}>{e.title}</text>
            <path className="fm-arch-entrygo" d={iconPath("chevron")} transform={`translate(${e.x + e.w - 32} 40)`} />
          </g>
        ))}
        {studies.map((st) => (
          <g key={st.no} className="fm-arch-study" role="button" tabIndex={0} aria-label={L(`${st.title}, 세부 설계 [${st.no}] ${st.design}, 아래 설명으로 이동`, `${st.title}, design [${st.no}] ${st.design}, go to its explanation`)} onClick={() => showStudy(st.no)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); showStudy(st.no); } }}>
            <rect className="fm-arch-studybox" x={st.x} y={164} width={st.w} height={140} rx={8} />
            <circle className="fm-arch-badge" cx={st.x + 26} cy={192} r={13} />
            <text className="fm-arch-badgetext" x={st.x + 26} y={197}>{st.no}</text>
            <text className="fm-arch-studytitle" x={st.x + 48} y={198}>{st.title}</text>
            <g className="fm-arch-kind">
              <rect x={st.x + st.w - 14 - tagWidth(st.kind)} y={181} width={tagWidth(st.kind)} height={22} rx={3} />
              <text x={st.x + st.w - 14 - tagWidth(st.kind) / 2} y={196}>{st.kind}</text>
            </g>
            <text className="fm-arch-role" x={st.x + 20} y={226}>{st.role}</text>
            <line className="fm-arch-rule" x1={st.x + 16} x2={st.x + st.w - 16} y1={242} y2={242} />
            <text className="fm-arch-designlabel" x={st.x + 20} y={265}>{L(`세부 설계 [${st.no}]`, `Design [${st.no}]`)}</text>
            <text className="fm-arch-more" x={st.x + st.w - 16} y={265}>{L("아래에서 설명 보기 ↓", "Explained below ↓")}</text>
            <text className="fm-arch-design" x={st.x + 20} y={289}>{st.design}</text>
          </g>
        ))}
        {server.map((b) => <Node key={b.title} b={b} y={376} h={64} />)}
        {field.map((b) => <Node key={b.title} b={b} y={506} h={64} />)}
        {arrows.map((a) => {
          const up = a.to < a.from;
          return (
            <g key={`${a.x}-${a.from}`} className={`fm-arch-arrow ${a.ai ? "is-ai" : ""} ${up ? "is-up" : "is-down"}`} aria-hidden="true">
              <line x1={a.x} y1={a.from} x2={a.x} y2={a.to} markerEnd={`url(#fm-arch-head${a.ai ? "-ai" : ""})`} markerStart={a.both ? `url(#fm-arch-head${a.ai ? "-ai" : ""})` : undefined} />
              <text className="fm-arch-label" x={a.side === "right" ? a.x + 8 : a.x - 8} y={(a.from + a.to) / 2 + 5} textAnchor={a.side === "right" ? "start" : "end"}>{a.label}</text>
            </g>
          );
        })}
      </svg>
      <ArchitectureStack entries={entries} server={server} field={field} studies={studies} onEnter={onEnter} />
      <figcaption id="fm-arch-cap">
        <b>{L("그림 1.", "Figure 1.")}</b> {L(`${systemName()}의 전체 구조. 세 AI 기능은 참고 문헌 [1], [2], [3]의 연구를 각각 세부 설계로 구현했습니다. 맨 위 줄을 누르면 대시보드의 그 기능이, 기능 상자를 누르면 아래의 설명이 열립니다.`, `Overall architecture of the ${systemName()}. Each of the three AI functions implements the design of one study, references [1], [2] and [3]. The top row opens that feature in the dashboard; a function box takes you to its explanation below.`)}
      </figcaption>
      <StudyReferences />
    </figure>
  );
}

/** The studies the figure's detailed designs come from, cited as a figure's sources are. */
export function StudyReferences() {
  return (
    <section className="fm-arch-refs" aria-labelledby="fm-arch-refs-title">
      <h3 id="fm-arch-refs-title">{L("참고 문헌", "References")}</h3>
      <ol>
        {STUDIES.map((no) => {
          const r = studyReference(no);
          return (
            <li key={no} id={`fm-ref-${no}`}>
              <span className="fm-ref-no">[{no}]</span>
              <span>
                {r.authors}, “<cite lang={getLang() === "ko" ? undefined : r.titleLang}>{r.title}</cite>”, {r.venue}.
                {r.doi && <> <a href={`https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">doi:{r.doi}</a></>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Node({ b, y, h }: { b: Box; y: number; h: number }) {
  return (
    <g className={`fm-arch-node ${b.dashed ? "is-external" : ""}`}>
      <rect x={b.x} y={y} width={b.w} height={h} rx={6} />
      <text className="fm-arch-title" x={b.x + 14} y={y + 26}>{b.title}</text>
      <text className="fm-arch-sub" x={b.x + 14} y={y + 47}>{b.sub}</text>
    </g>
  );
}

/** The same figure for a narrower screen: the layers stacked, top to bottom, with what passes between them. */
function ArchitectureStack({ entries, server, field, studies, onEnter }: { entries: Entry[]; server: Box[]; field: Box[]; studies: Study[]; onEnter: (intent?: StartIntent) => void }) {
  const between: [string, string][] = [
    [L("근거 있는 답변, 판독 결과, 알림", "answers, readings, alerts"), L("질문, 허용", "questions, approvals")],
    [L("찾은 자료, 판독할 화면, 센서 상태", "passages found, views, sensor state"), L("허용 시점 재확인", "recheck at approval")],
    [L("색인, 영상, 센서 값", "indexing, frames, readings"), L("제어 명령", "control commands")],
  ];
  const layer = (lane: Lane, boxes: Box[]) => (
    <section className={`fm-arch-layer is-${lane}`}>
      <h3><LaneMark lane={lane} />{figureLane(lane)}</h3>
      <ul>{boxes.map((b) => <li key={b.title} className={b.dashed ? "is-external" : ""}><b>{b.title}</b><small>{b.sub}</small></li>)}</ul>
    </section>
  );
  const pass = ([up, down]: [string, string]) => <p className="fm-arch-pass"><span>↑ {up}</span><span>↓ {down}</span></p>;
  return (
    <div className="fm-arch-stack">
      <section className="fm-arch-layer is-screen">
        <h3><LaneMark lane="screen" />{laneName("screen")}</h3>
        <div className="fm-arch-entries">
          {entries.map((e) => <button key={e.title} type="button" onClick={() => onEnter(e.go)}><FarmIcon name={e.icon} />{e.title}<FarmIcon name="chevron" /></button>)}
        </div>
      </section>
      {pass(between[0])}
      <section className="fm-arch-layer is-ai">
        <h3><LaneMark lane="ai" />{laneName("ai")}</h3>
        <ol className="fm-arch-studies">
          {studies.map((st) => (
            <li key={st.no}>
              <button type="button" onClick={() => showStudy(st.no)} aria-label={L(`${st.title}, 세부 설계 [${st.no}] ${st.design}, 아래 설명으로 이동`, `${st.title}, design [${st.no}] ${st.design}, go to its explanation`)}>
                <b>{st.no}</b>{st.title}<em>{st.kind}</em><FarmIcon name="chevron" />
              </button>
              <small>{st.role}</small>
              <small className="fm-arch-designline"><span>{L(`세부 설계 [${st.no}]`, `Design [${st.no}]`)}</span> {st.design}</small>
            </li>
          ))}
        </ol>
      </section>
      {pass(between[1])}
      {layer("server", server)}
      {pass(between[2])}
      {layer("field", field)}
    </div>
  );
}

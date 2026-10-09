import { useEffect, useRef, useState } from "react";
import type { useFarmRuntime } from "./useFarmRuntime";
import type { FarmLayout } from "../farm-spatial";
import type { Metric } from "../types";
import { AuthenticatedMedia } from "../AuthenticatedMedia";
import { analyzeResearchVideo, askCamera, getResearchVideoCatalog, listResearchVideoAnalyses, researchEvidencePath } from "../video-api";
import type { ResearchEvidenceSet, ResearchVideoAnalysis } from "../video-api";
import { analyzeDemoCamera, answerReviewBaseline, answerReviewRun } from "./assist-api";
import type { KnowledgeComposition, LiveCameraAnswer } from "./assist-api";
import { cameraDisplayName, researchDecision } from "./camera-state";
import { buildBrief } from "./ai-brief";
import type { BriefItem } from "./ai-brief";
import { backendText, getLang, L, place, prose, term } from "./i18n";
import { kindName } from "./library-entries";
import { answerLines, CHANNELS, channelCounts, channelName, graphUsed, pickKnowledgeTurn, quotedSource, rankedSources, readable, reviewTally, routeWeights } from "./how-it-works";
import type { Channel, ReviewRun } from "./how-it-works";
import { crossPartners, gapText, pickControlCase, readingEvidence, sensorPass } from "./flow-model";
import { FlowBoard } from "./FlowLanes";
import type { FlowEdge, FlowNode } from "./FlowLanes";
import type { DemoTarget } from "./flow-model";
import type { StartIntent } from "./FarmerWorkspace";
import { ResearchSection } from "./ResearchSection";
import { bandGauge, keyReadings } from "./sensor-links";
import { readingValue } from "./SensorReadings";
import { deviceShortLabel } from "./stage-cues";
import { latestObservedAt } from "./workspace-state";
import { shortStamp, stamp } from "./time-format";
import { cameraLabel, liveMultiview, loadDemoCameras, multiviewDecision } from "./demo-cameras";
import type { DemoCamera, DemoCameraManifest } from "./demo-cameras";
import { FeedImage, FeedVideo } from "./FeedMedia";
import { useCameraFeeds } from "./useCameraFeeds";

type Runtime = ReturnType<typeof useFarmRuntime>;

const count = (n: number) => n.toLocaleString(getLang() === "ko" ? "ko-KR" : "en-US");
// Server sentences read in the screen's language where they are known; the rest stays as written.
const said = (text: string) => readable(text.split("\n").map((line) => prose(line)).join("\n"), (iso) => stamp(iso));
const inKorean = (text: string) => (getLang() !== "ko" && /[가-힣]/.test(text) ? "ko" : undefined);

/** "16:49:20" in farm time: the reading's own time, to the second, to show it arrives every two seconds. */
function clockOf(iso: string | null | undefined): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "-";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(t));
}

/** "고추냉이 재배 기술 자료 · 31쪽" → the title, and "31쪽" (in English "p. 31"). */
const pageless = (source: string) => source.replace(/\s*·\s*\d+쪽$/, "");
function pageOf(source: string): string | null {
  const m = /·\s*(\d+)쪽$/.exec(source);
  return m ? L(`${m[1]}쪽`, `p. ${m[1]}`) : null;
}

/** A reading as a small tile: name, value, unit. A doubtful one is marked, not hidden. */
function Val({ m, doubt = false }: { m: Metric; doubt?: boolean }) {
  return (
    <span className={`fm-fl-val ${doubt ? "is-doubt" : ""}`}>
      <small>{term(m.label)}</small>
      <b>{readingValue(m).text}<i>{m.unit}</i></b>
    </span>
  );
}

/**
 * The three studies, in order, each shown where it works in the farm system
 * and run on a farm example: LLM RAG advice, camera monitoring, and sensor
 * state mismatches. Every flow is drawn from real records or a run made now.
 */
export function LandingResearch({ runtime, composition, targets, onEnter }: {
  runtime: Runtime;
  composition: KnowledgeComposition | null;
  /** Where each study works in the dashboard. */
  targets: Record<1 | 2 | 3, DemoTarget>;
  onEnter: (intent?: StartIntent) => void;
}) {
  return (
    <div className="fm-studies">
      <ResearchSection
        id="lp-r1"
        no={1}
        title={L("LLM RAG 상담", "LLM RAG advisor")}
        role={L("재배 질문에 맞는 방식으로 자료를 찾고, 현재 센서 값과 함께 출처를 밝혀 답합니다.", "It searches the cultivation guides in the way each question needs and answers with its sources and the current readings.")}
        modules={["rag", "qact"]}
        onDemo={() => onEnter(targets[1])}
        pages={[{ key: "ask", label: L("질문에서 답변까지", "From question to answer"), render: () => <AskFlow runtime={runtime} composition={composition} /> }]}
      />
      <ResearchSection
        id="lp-r2"
        no={2}
        title={L("카메라 관제", "Camera monitoring")}
        role={L("여러 카메라 가운데 근거가 보이는 화면을 골라 판독하고, 근거가 보이지 않으면 답하지 않습니다.", "Among several cameras it reads the view that shows the evidence, and gives no answer when none does.")}
        modules={["video"]}
        onDemo={() => onEnter(targets[2])}
        pages={[
          { key: "farm", label: L("농장 예시(생성 이미지)", "Farm example (generated)"), render: () => <FarmCameraFlow runtime={runtime} /> },
          { key: "dataset", label: L("공개 데이터셋", "Public dataset"), render: () => <DatasetCameraFlow runtime={runtime} /> },
        ]}
      />
      <ResearchSection
        id="lp-r3"
        no={3}
        title={L("센서 불일치 확인", "Sensor mismatch checks")}
        role={L("센서 값이 서로 맞지 않거나, 답변 뒤 값이 바뀌거나, 설비를 조작하는 순간 상태가 달라지면 그 지점만 다시 확인합니다.", "When sensors disagree, readings change after an answer, or the state moves as equipment is operated, only that point is checked again.")}
        modules={["sr", "gate"]}
        onDemo={() => onEnter(targets[3])}
        pages={[
          { key: "sensors", label: L("센서 간 불일치", "Sensors disagree"), render: () => <SensorFlow runtime={runtime} /> },
          { key: "answer", label: L("답변 뒤 값 변화", "Readings change"), render: () => <ChangeFlow runtime={runtime} /> },
          { key: "control", label: L("설비 조작", "Operating equipment"), render: () => <ControlFlow runtime={runtime} /> },
        ]}
      />
    </div>
  );
}

// -------------------------------------------------------------------- study 1: a question

/** What each search method looks through in the library. */
const CHANNEL_INDEX: Record<Channel, [string, string]> = {
  dense: ["조각의 의미 벡터", "passage meaning vectors"],
  sparse: ["조각의 낱말 색인", "passage word index"],
  graph: ["자료에서 뽑은 관계", "relations drawn from the guides"],
};

/** The guide library the advisor searches: guides cut into pages and passages, by kind of source. */
function Library({ c }: { c: KnowledgeComposition | null }) {
  if (!c) return <p className="fm-fl-note">{L("자료 구성을 불러오는 중…", "Loading the library…")}</p>;
  return (
    <div className="fm-fl-lib">
      <ol className="fm-fl-lib-steps">
        <li><b>{count(c.guides)}</b><small>{L("자료", "guides")}</small></li>
        <li><b>{count(c.documents)}</b><small>{L("쪽/절", "pages")}</small></li>
        <li><b>{count(c.chunks)}</b><small>{L("검색 조각", "passages")}</small></li>
      </ol>
      <span className="fm-fl-lib-bar" aria-hidden="true">
        {c.by_kind.map((k, i) => <i key={k.evidence_class} className={`is-k${Math.min(i, 4)}`} style={{ flexGrow: Math.max(k.guides, 1) }} />)}
      </span>
      <ul className="fm-fl-lib-kinds">
        {c.by_kind.map((k, i) => (
          <li key={k.evidence_class}><i className={`is-k${Math.min(i, 4)}`} aria-hidden="true" /><span>{kindName(k.evidence_class)}</span><b>{count(k.guides)}</b></li>
        ))}
      </ul>
      {c.graph_edges > 0 && <small className="fm-fl-note">{L(`자료에서 뽑은 관계 ${count(c.graph_edges)}개`, `${count(c.graph_edges)} relations drawn from the guides`)}</small>}
    </div>
  );
}

function AskFlow({ runtime, composition }: { runtime: Runtime; composition: KnowledgeComposition | null }) {
  const turn = pickKnowledgeTurn(runtime.turns);
  // The saved answers arrive a few seconds after the page; say "loading" until then, not "none".
  const [waited, setWaited] = useState(false);
  useEffect(() => { const id = window.setTimeout(() => setWaited(true), 10000); return () => window.clearTimeout(id); }, []);
  const route = turn?.retrieval.route;
  const weights = routeWeights(route);
  const counts = turn ? channelCounts(turn.retrieval) : {};
  const { documents, readings } = turn ? rankedSources(turn.evidence) : { documents: [], readings: [] };
  const top = documents.slice(0, 3);
  const maxScore = Math.max(...top.map((d) => d.score), 1e-9);
  // The same reading from two zones is named with its zone ("상대 습도, A구역").
  const zoneOf = (source: string) => { const n = source.match(/(\d+)\s*구역/)?.[1]; const id = n === "1" ? "zone-a" : n === "2" ? "zone-b" : null; return id ? place(runtime.layout?.zones.find((z) => z.id === id)?.label ?? "") : null; };
  const values = readings
    .map((e) => { const v = readingEvidence(e.source, e.excerpt); return v ? { ...v, zone: zoneOf(e.source) } : null; })
    .filter((v): v is NonNullable<typeof v> => !!v);
  // The answer's own sentences, the ones naming a source first; headings are left out.
  const lines = answerLines(turn?.assistantMessage?.content ?? "", 80)
    .map((raw) => readable(raw, (iso) => stamp(iso)))
    .filter((line) => line.length > 12)
    .map((line) => ({ line, cite: quotedSource(line, top) }));
  const shown = [...lines.filter((l) => l.cite !== null), ...lines.filter((l) => l.cite === null)].slice(0, 2);
  const cited = [...new Set(shown.map((l) => l.cite).filter((c): c is number => c !== null))].sort();
  // Whether a language model wrote the answer; the page names the kind of model, not the product.
  const byModel = !!turn?.execution.model;
  const question = prose(turn?.userMessage?.content ?? "");
  const nodes: FlowNode[] = [
    { id: "q", lane: "screen", col: 1, title: L("질문 입력", "Question"), body: <p className="fm-fl-bubble is-me" lang={inKorean(question)}>{question}</p> },
    {
      id: "how", lane: "ai", col: 2, title: L("검색 방식 결정", "Choosing the search"),
      research: "qact", role: L("질문마다 세 방식의 비중을 정함", "Weights three methods per question"),
      body: (
        <ul className="fm-fl-bars">
          {CHANNELS.map((c) => (
            <li key={c}>
              <span>{channelName(c)}</span>
              <i><b style={{ width: `${Math.round(weights[c] * 100)}%` }} /></i>
              <em>{weights[c].toFixed(1)}</em>
            </li>
          ))}
        </ul>
      ),
    },
    { id: "store", lane: "server", col: 3, title: L("재배 자료 저장소", "Guide library"), body: <Library c={composition} /> },
    {
      id: "find", lane: "ai", col: 3, title: L("자료 검색", "Searching"),
      body: (
        <ul className="fm-fl-counts">
          {CHANNELS.map((c) => (
            <li key={c} className={c === "graph" && !graphUsed(route) ? "is-off" : ""}>
              <span><em>{channelName(c)}</em><small>{L(...CHANNEL_INDEX[c])}</small></span><b>{counts[c] !== undefined ? count(counts[c]!) : "-"}</b>
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: "rank", lane: "ai", col: 4, title: L("검색 결과 통합", "Merging the results"),
      body: (
        <ol className="fm-fl-rank">
          {top.map((d, i) => (
            <li key={d.id}>
              <b>{i + 1}</b>
              <span title={d.source} lang={inKorean(d.source)}>{pageless(d.source)}</span>
              {pageOf(d.source) && <small>{pageOf(d.source)}</small>}
              <i><u style={{ width: `${Math.round((d.score / maxScore) * 100)}%` }} /></i>
            </li>
          ))}
        </ol>
      ),
    },
    {
      id: "now", lane: "field", col: 5, title: L("현재 센서 값", "Current readings"),
      body: (
        <ul className="fm-fl-readings">
          {values.slice(0, 4).map((v, i) => (
            <li key={`${v.name}:${v.zone ?? i}`} className={v.doubtful ? "is-doubt" : ""}>
              <small>{term(v.name)}{v.zone && values.filter((x) => x.name === v.name).length > 1 ? `, ${v.zone}` : ""}</small><b>{v.value}</b>{v.doubtful && <em>{L("판단 제외", "Left out")}</em>}
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: "write", lane: "ai", col: 5, title: L("답변 생성", "Writing the answer"),
      research: "rag", role: L("찾은 자료와 현재 값만 근거로 씀", "Grounded only in the guides and readings"),
      body: (
        <>
          <p className="fm-fl-model"><span className="fm-fl-kind">{byModel ? "LLM" : L("원문 발췌", "Quoted")}</span></p>
          <p className="fm-fl-note">{byModel ? L("대규모 언어 모델이 자료와 센서 값을 읽고 작성", "A large language model reads the guides and readings") : L("농장 자료가 있어 외부 모델로 보내지 않고 원문을 옮김", "Farm records inside: quoted, not sent to an outside model")}</p>
        </>
      ),
    },
    {
      id: "ans", lane: "screen", col: 6, title: L("답변과 출처", "Answer and sources"),
      body: (
        <>
          <div className="fm-fl-bubble is-ai" lang={shown.some((l) => /[가-힣]/.test(l.line)) && getLang() !== "ko" ? "ko" : undefined}>
            {shown.map((l, i) => <p key={i}>{l.cite !== null && <i className="fm-fl-cite">{l.cite + 1}</i>}{l.line.replace(/\s*\([^)]*\)\s*$/, "")}</p>)}
          </div>
          {getLang() !== "ko" && shown.some((l) => /[가-힣]/.test(l.line)) && <p className="fm-fl-note">Written in Korean</p>}
          {cited.length > 0 && (
            <ol className="fm-fl-sources">
              {cited.map((c) => <li key={c}><b>{c + 1}</b><span lang={inKorean(top[c].source)}>{pageless(top[c].source)}</span>{pageOf(top[c].source) && <small>{pageOf(top[c].source)}</small>}</li>)}
            </ol>
          )}
        </>
      ),
    },
  ];
  const edges: FlowEdge[] = [
    { from: "q", to: "how", label: L("질문", "Question") },
    { from: "how", to: "find", label: CHANNELS.map((c) => weights[c].toFixed(1)).join(" / ") },
    { from: "store", to: "find", label: composition ? L(`조각 ${count(composition.chunks)}`, `${count(composition.chunks)} passages`) : null },
    { from: "find", to: "rank", label: turn ? L(`후보 ${count(turn.retrieval.candidateCount ?? 0)}`, `${count(turn.retrieval.candidateCount ?? 0)} candidates`) : null },
    { from: "rank", to: "write", label: turn ? L(`자료 ${turn.retrieval.returnedCount ?? top.length}`, `${turn.retrieval.returnedCount ?? top.length} guides`) : null },
    { from: "now", to: "write", label: L(`관측 ${values.length}`, `${values.length} readings`) },
    { from: "write", to: "ans", label: L("답변", "Answer") },
  ];
  return (
    <FlowBoard
      title={L("질문에서 답변까지", "From a question to an answer")}
      source={null}
      nodes={nodes}
      edges={edges}
      columns={[0.9, 1.05, 1.8, 1.3, 1.1, 1.45]}
      resetKey={turn?.id ?? "none"}
      empty={turn ? undefined : (
        <p className="fm-hint" role="status">
          {waited
            ? L("아직 재배 자료를 인용한 상담 기록이 없습니다. 대시보드에서 AI 상담에 질문하면 이 흐름으로 보여줍니다.", "No answer citing the growing guides yet. Ask the AI advisor in the dashboard and it is drawn here.")
            : L("상담 기록을 불러오는 중…", "Loading the advisor records…")}
        </p>
      )}
    />
  );
}

// -------------------------------------------------------------------- study 2: cameras

/** One reading of both example cameras made now; kept for the page session. */
type CameraRun = { status: "running" | "done"; results: Record<string, LiveCameraAnswer>; errors: Record<string, string>; startedAt: number; finishedAt?: number };
let farmRun: CameraRun | null = null;
/** Where a camera is registered, e.g. "A구역 4번 베드 근접": the zone is given, never read off the frame. */
const cameraPlace = (c: DemoCamera, zoneLabel: (id?: string | null) => string) => {
  const zone = zoneLabel(c.zone_id);
  const label = cameraLabel(c);
  return label.includes(zone) ? label : `${zone} ${label}`;
};

/**
 * The farm example: one question put to two greenhouse cameras, each read now
 * by a vision-language model. With camera feeds the cameras play what they
 * sent and the latest frame is read; without, the example stills are. The
 * answer rests only on the view that shows it; the other view abstains or is
 * set aside.
 */
function FarmCameraFlow({ runtime }: { runtime: Runtime }) {
  const [manifest, setManifest] = useState<DemoCameraManifest | null>(null);
  const feeds = useCameraFeeds(runtime.farmId);
  const feedOf = (id: string) => feeds.live?.find((f) => f.id === id && f.latest) ?? null;
  const [run, setRun] = useState<CameraRun | null>(farmRun);
  const box = useRef<HTMLDivElement>(null);
  const zoneLabel = (id?: string | null) => place(runtime.layout?.zones.find((z) => z.id === id)?.label ?? L("농장", "Farm"));
  useEffect(() => { void loadDemoCameras().then(setManifest); }, []);
  const m = manifest?.multiview?.[0] ?? null;
  const cameras = manifest?.cameras ?? [];
  const saved = m ? multiviewDecision(m, cameras) : null;
  async function read() {
    if (!m || !saved) return;
    const started: CameraRun = { status: "running", results: {}, errors: {}, startedAt: Date.now() };
    farmRun = started;
    setRun(started);
    const set = (next: (r: CameraRun) => CameraRun) => setRun((r) => { const value = next(r ?? started); farmRun = value; return value; });
    const lang = getLang();
    await Promise.all(saved.candidates.map(async ({ camera }) => {
      try {
        const question = lang === "en" ? m.question_en : m.question_ko;
        const result = feedOf(camera.id)
          ? await askCamera(runtime.farmId, { camera_id: camera.id, question, lang, location: cameraPlace(camera, zoneLabel) })
          : await analyzeDemoCamera(runtime.farmId, camera, question, lang, cameraPlace(camera, zoneLabel));
        set((r) => ({ ...r, results: { ...r.results, [camera.id]: result } }));
      } catch (e) {
        set((r) => ({ ...r, errors: { ...r.errors, [camera.id]: e instanceof Error ? e.message : String(e) } }));
      }
    }));
    set((r) => ({ ...r, status: "done", finishedAt: Date.now() }));
  }
  // Read once, when the page first comes into view in this session (after the feeds answer, so a live frame is read).
  useEffect(() => {
    const el = box.current;
    if (!el || !m || farmRun || (!feeds.list && !feeds.error)) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting) && !farmRun) { io.disconnect(); void read(); } }, { threshold: 0, rootMargin: "0px 0px -35% 0px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.id, !!feeds.list || !!feeds.error]);
  const done = run?.status === "done";
  const streamed = !!m && m.candidates.every((c) => feedOf(c.camera_id));
  const frameOf = (camera: DemoCamera) => (run?.results[camera.id] as { frame_url?: string } | undefined)?.frame_url ?? null;
  const failed = done && Object.keys(run!.results).length === 0;
  const live = m && run && done && !failed ? liveMultiview(m, cameras, run.results) : null;
  const view = live && live.candidates.length ? live : failed ? saved : null;
  const chosen = view?.chosen ?? null;
  const pct = (c: number) => `${Math.round(c * 100)}%`;
  const nodes: FlowNode[] = m && view ? [
    { id: "q", lane: "screen", col: 1, title: L("질문", "Question"), body: <p className="fm-fl-bubble is-me">{L(m.question_ko, m.question_en)}</p> },
    {
      id: "cams", lane: "field", col: 2, title: L("온실 카메라 2대", "Two greenhouse cameras"),
      body: (
        <div className="fm-fl-thumbs">
          {view.candidates.map(({ camera }) => (
            <figure key={camera.id} className={chosen?.camera.id === camera.id ? "is-chosen" : ""}>
              {streamed ? <FeedVideo farmId={runtime.farmId} path={feedOf(camera.id)?.latest?.video_url ?? null} label={cameraLabel(camera)} /> : <img src={camera.image} alt="" loading="lazy" />}
              <figcaption>{cameraLabel(camera)}</figcaption>
            </figure>
          ))}
          <small className="fm-fl-note">{streamed ? L("예시 영상(생성), 카메라 스트림으로 받음", "Example video (generated), received as camera streams") : L("예시 이미지(생성)", "Example images (generated)")}</small>
        </div>
      ),
    },
    {
      id: "read", lane: "ai", col: 3, title: L("화면별 판독", "Reading each view"),
      research: "video", role: L("보이면 답하고, 안 보이면 기권", "Answers if visible, abstains if not"),
      body: (
        <>
          <p className="fm-fl-model"><span className="fm-fl-kind">VLM</span></p>
          <ul className="fm-fl-verdicts">
            {view.candidates.map(({ camera, question }) => (
              <li key={camera.id} className={question.decision === "answer" ? "is-answer" : "is-abstain"}>
                <span>{cameraLabel(camera)}</span>
                <b>{question.decision === "answer" ? L(`답함 ${pct(question.confidence)}`, `Answers ${pct(question.confidence)}`) : L("기권", "Abstains")}</b>
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      id: "pick", lane: "ai", col: 4, title: L("근거 화면 선택", "Choosing the evidence"),
      research: "video", role: L("근거가 보이는 화면만 사용", "Uses only the view that shows it"),
      body: chosen ? (
        <figure className="fm-fl-evidence">
          <span>
            {frameOf(chosen.camera) ? <FeedImage farmId={runtime.farmId} path={frameOf(chosen.camera)!} alt="" /> : <img src={chosen.camera.image} alt="" loading="lazy" />}
            {chosen.question.box && <u style={{ left: `${chosen.question.box[0] * 100}%`, top: `${chosen.question.box[1] * 100}%`, width: `${chosen.question.box[2] * 100}%`, height: `${chosen.question.box[3] * 100}%` }} aria-hidden="true" />}
          </span>
          <figcaption>{L(`${cameraLabel(chosen.camera)} 화면`, `${cameraLabel(chosen.camera)} view`)}</figcaption>
        </figure>
      ) : <p className="fm-fl-verdict is-attention">{L("근거가 보이는 화면 없음", "No view shows it")}</p>,
    },
    {
      id: "out", lane: "screen", col: 5, title: L("답변", "The answer"),
      body: chosen ? (
        <>
          <div className="fm-fl-bubble is-ai" lang={inKorean(L(chosen.question.answer_ko ?? "", chosen.question.answer_en ?? ""))}><p>{L(chosen.question.answer_ko ?? "", chosen.question.answer_en ?? "")}</p></div>
          <p className="fm-fl-note">{L(`근거: ${cameraLabel(chosen.camera)}, 확신도 ${pct(chosen.question.confidence)}`, `Evidence: ${cameraLabel(chosen.camera)}, confidence ${pct(chosen.question.confidence)}`)}</p>
        </>
      ) : <p className="fm-fl-outcome is-abstain">{L("답하지 않음", "No answer")}</p>,
    },
  ] : [];
  const edges: FlowEdge[] = [
    { from: "q", to: "read", label: L("질문", "Question") },
    { from: "cams", to: "read", label: L("화면 2장", "2 frames") },
    { from: "read", to: "pick", label: null },
    { from: "pick", to: "out", label: chosen ? L("답변", "Answer") : L("기권", "Abstain") },
  ];
  return (
    <div ref={box}>
      <FlowBoard
        title={streamed ? L("생성 영상으로 본 온실 카메라 판독", "Greenhouse cameras, on generated video") : L("생성 이미지로 본 온실 카메라 판독", "Greenhouse cameras, on generated images")}
        source={failed ? <span className="fm-fl-error" role="status">{L("판독 모델에 연결하지 못해 미리 저장한 판독을 보여줍니다.", "The reading model was unreachable; a saved reading is shown.")}</span> : null}
        tools={m ? <button type="button" className="fm-fl-run" disabled={run?.status === "running"} onClick={() => void read()}>{run?.status === "running" ? L("판독 중…", "Reading…") : L("다시 판독", "Read again")}</button> : null}
        nodes={nodes}
        edges={edges}
        columns={[1.05, 1.45, 1.25, 1.35, 1.35]}
        resetKey={run?.finishedAt ? String(run.finishedAt) : failed ? "saved" : "none"}
        empty={view ? undefined : (
          <p className="fm-hint" role="status">{!manifest ? L("예시 카메라를 불러오는 중…", "Loading the example cameras…") : L("두 카메라 화면을 지금 판독하는 중…", "Reading both camera views now…")}</p>
        )}
      />
    </div>
  );
}

/**
 * The research model on public multi-view CCTV data: a trained selector scores
 * the views, the model reads the chosen one, and the release bar decides
 * whether its conclusion may be shown.
 */
function DatasetCameraFlow({ runtime }: { runtime: Runtime }) {
  const farmId = runtime.farmId;
  const [sample, setSample] = useState<ResearchEvidenceSet | null>(null);
  const [record, setRecord] = useState<ResearchVideoAnalysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    void Promise.all([
      getResearchVideoCatalog(farmId, ctrl.signal).then((c) => setSample(c.evidence_sets[0] ?? null)).catch(() => undefined),
      listResearchVideoAnalyses(farmId, ctrl.signal).then((rows) => setRecord(rows[0] ?? null)).catch(() => undefined),
    ]).finally(() => setLoaded(true));
    return () => ctrl.abort();
  }, [farmId]);
  async function runNow() {
    if (!sample) return;
    setBusy(true); setError("");
    try {
      const result = await analyzeResearchVideo(farmId, sample, AbortSignal.timeout(60000));
      if (result.decision === "unavailable") setError(L("연구 모델 서버에 연결하지 못해 마지막 실행 기록을 보여줍니다.", "The research model server is not reachable; the last run is shown."));
      else setRecord(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }
  const candidates = record?.stages.selection?.candidates ?? [];
  const chosen = record?.selected_camera_id ?? candidates[0]?.camera_id ?? null;
  const answer = record?.stages.answer;
  const release = record?.stages.release;
  const decision = record ? researchDecision(record) : null;
  const name = (camera: string | null) => cameraDisplayName(camera, sample?.camera_ids ?? []);
  const threshold = typeof release?.threshold === "number" ? release.threshold : null;
  const confidence = answer?.confidence ?? null;
  const question = prose(sample?.question ?? "");
  const nodes: FlowNode[] = sample && record ? [
    { id: "q", lane: "screen", col: 1, title: L("질문", "Question"), body: <p className="fm-fl-bubble is-me" lang={inKorean(question)}>{question}</p> },
    {
      id: "cams", lane: "field", col: 2, title: L(`카메라 ${sample.camera_ids.length}대`, `${sample.camera_ids.length} cameras`),
      body: (
        <div className="fm-fl-thumbs">
          {sample.camera_ids.map((camera) => (
            <figure key={camera} className={camera === chosen ? "is-chosen" : ""}>
              <AuthenticatedMedia farmId={farmId} path={researchEvidencePath(sample.id, camera)} image />
              <figcaption>{name(camera)}</figcaption>
            </figure>
          ))}
          <small className="fm-fl-note">{L("공개 다시점 CCTV 영상", "Public multi-view CCTV")}</small>
        </div>
      ),
    },
    {
      id: "pick", lane: "ai", col: 3, title: L("근거 화면 선택", "Choosing the view"),
      research: "video", role: L("학습한 선택 모델이 화면마다 점수를 매김", "A trained selector scores each view"),
      body: (
        <ul className="fm-fl-bars">
          {sample.camera_ids.map((camera) => {
            const c = candidates.find((x) => x.camera_id === camera);
            return (
              <li key={camera} className={camera === chosen ? "is-on" : ""}>
                <span>{name(camera)}</span>
                <i><b style={{ width: c ? `${Math.round(c.availability * 100)}%` : "0%" }} /></i>
                <em>{c ? c.availability.toFixed(2) : "-"}</em>
              </li>
            );
          })}
        </ul>
      ),
    },
    {
      id: "look", lane: "ai", col: 4, title: L("확대 영역 판독", "Reading the region"),
      body: (
        <>
          {record.frame_urls[1] && <figure className="fm-fl-roi"><AuthenticatedMedia farmId={farmId} path={record.frame_urls[1]} image /></figure>}
          <p className="fm-fl-verdict">
            <span className="fm-fl-kind">VLM</span>
            {answer?.decision === "answer" ? L("답할 수 있음", "Can answer") : answer?.decision === "abstain" ? L("판단할 수 없어 기권", "Cannot tell, abstains") : L("판단 없음", "No decision")}
            {confidence !== null && <b>{confidence.toFixed(3)}</b>}
          </p>
        </>
      ),
    },
    {
      id: "gate", lane: "server", col: 5, title: L("공개 기준 확인", "Release check"),
      research: "video", role: L("확신이 기준에 못 미치면 결론을 숨김", "Withholds the conclusion below the bar"),
      body: confidence !== null && threshold !== null ? (
        <div className="fm-fl-gate">
          <span className="fm-fl-meter" aria-hidden="true"><b style={{ width: `${Math.round(confidence * 100)}%` }} /><u style={{ left: `${Math.min(100, threshold * 100)}%` }} /></span>
          <p><span>{L("확신도", "Confidence")} <b>{confidence.toFixed(3)}</b></span><span>{L("공개 기준", "Release bar")} <b>{threshold.toFixed(4)}</b></span></p>
          {release?.validated === false && <small>{L("기준 검증 전", "Bar not yet validated")}</small>}
        </div>
      ) : <p className="fm-fl-note">{L("공개 기준 없음", "No release bar")}</p>,
    },
    {
      id: "out", lane: "screen", col: 6, title: L("결과", "Result"),
      body: decision ? (
        <>
          <p className={`fm-fl-outcome is-${decision.kind}`}>{decision.title}</p>
          <p className="fm-fl-note">{release?.released ? L("답변을 보여줌", "The answer is shown") : L("근거 화면만 보여줌", "Only the evidence frames are shown")}</p>
        </>
      ) : null,
    },
  ] : [];
  const edges: FlowEdge[] = [
    { from: "q", to: "pick", label: L("질문", "Question") },
    { from: "cams", to: "pick", label: L(`화면 ${sample?.camera_ids.length ?? 0}장`, `${sample?.camera_ids.length ?? 0} frames`) },
    { from: "pick", to: "look", label: name(chosen) },
    { from: "look", to: "gate", label: confidence !== null ? confidence.toFixed(3) : null },
    { from: "gate", to: "out", label: release ? (release.released ? L("공개", "Shown") : L("보류", "Held")) : null },
  ];
  return (
    <FlowBoard
      title={L("공개 다시점 CCTV 데이터로 검증한 연구 모델", "The research model on public multi-view CCTV")}
      source={error ? <span className="fm-fl-error" role="status">{error}</span> : null}
      tools={sample ? <button type="button" className="fm-fl-run" disabled={busy} onClick={() => void runNow()}>{busy ? L("판독 중…", "Reading…") : L("다시 판독", "Read again")}</button> : null}
      nodes={nodes}
      edges={edges}
      columns={[1.05, 1.35, 1.1, 1.2, 1.15, 1.05]}
      resetKey={record?.id ?? "none"}
      empty={sample && record ? undefined : (
        <p className="fm-hint" role="status">
          {loaded ? L("연구 모델 실행 기록이 없습니다. 카메라 화면에서 판독을 실행하면 이 흐름으로 보여줍니다.", "No research model run yet. Run one on the camera screen and it is drawn here.") : L("연구 모델 기록을 불러오는 중…", "Loading the research model record…")}
        </p>
      )}
    />
  );
}

// -------------------------------------------------------------------- study 3: sensor state mismatches

/** Sensors that disagree: the doubtful value is left out, and the place is pinned. */
function SensorFlow({ runtime }: { runtime: Runtime }) {
  const { snapshot, layout, strategies, cycles, turns, connected } = runtime;
  const thresholds = strategies?.versions.find((v) => v.versionId === strategies.activeVersionId)?.thresholds ?? [];
  const metrics = snapshot?.metrics ?? [];
  const alerts = (snapshot?.alerts ?? []).filter((a) => a.status !== "resolved");
  const zoneLabel = (id?: string | null) => place(layout?.zones.find((z) => z.id === id)?.label ?? L("농장", "Farm"));
  const brief = buildBrief({ connected, alerts, metrics, thresholds, actuators: snapshot?.actuators ?? [], pending: [], cycles, beds: layout?.beds ?? [], zoneLabel, cameras: [], turns });
  // The zone the AI brief puts first; otherwise the first zone.
  const top = brief.find((i) => i.anchor && i.sources.includes("sensor")) ?? null;
  const zoneId = top?.anchor?.zoneId ?? alerts.find((a) => a.zoneId)?.zoneId ?? layout?.zones[0]?.id ?? "zone-a";
  const hasRange = (key: string) => thresholds.some((t) => t.metric === key);
  const pass = sensorPass(metrics, zoneId, hasRange);
  const zoneMetrics = metrics.filter((m) => m.zoneId === zoneId);
  const shown = keyReadings(zoneMetrics);
  const doubt = pass.doubtful[0] ?? null;
  const partners = doubt ? crossPartners(metrics, zoneId, doubt.key) : [];
  // The gauge: the first key reading that passed the check and has a farm range.
  const gauged = shown.find((m) => !pass.doubtful.includes(m) && hasRange(m.key)) ?? null;
  const range = gauged ? thresholds.find((t) => t.metric === gauged.key) ?? null : null;
  const gauge = gauged && range ? bandGauge(readingValue(gauged).number ?? Number.NaN, range.lower, range.upper) : null;
  const zone = zoneLabel(zoneId);
  const sensorItem = !!top && top.id.endsWith(":sensor");
  const nodes: FlowNode[] = [
    {
      id: "in", lane: "field", col: 1, title: L(`센서 측정, ${zone}`, `Sensors, ${zone}`),
      body: (
        <>
          <div className="fm-fl-vals">{shown.map((m) => <Val key={m.key} m={m} doubt={pass.doubtful.includes(m)} />)}</div>
          {pass.total > shown.length && <small className="fm-fl-more">{L(`외 ${pass.total - shown.length}개`, `+${pass.total - shown.length} more`)}</small>}
        </>
      ),
    },
    {
      id: "recv", lane: "server", col: 2, title: L("2초 주기 수신", "Received every 2 s"),
      body: <p className="fm-fl-clock"><i className="fm-fl-pulse" aria-hidden="true" /><b>{clockOf(latestObservedAt(zoneMetrics))}</b></p>,
    },
    {
      id: "quality", lane: "server", col: 3, title: L("품질 검사", "Quality check"),
      body: (
        <>
          <div className="fm-fl-seg" aria-hidden="true">
            <i className="is-ok" style={{ flexGrow: Math.max(pass.good, 0.01) }} />
            {pass.doubtful.length > 0 && <i className="is-warn" style={{ flexGrow: pass.doubtful.length }} />}
          </div>
          <p className="fm-fl-legend">
            <span className="is-ok">{L(`정상 ${pass.good}`, `${pass.good} good`)}</span>
            {pass.doubtful.length > 0 && <span className="is-warn">{L(`의심 ${pass.doubtful.length}`, `${pass.doubtful.length} doubtful`)}</span>}
          </p>
          {doubt && <p className="fm-fl-out"><Val m={doubt} doubt /><em>{L("판단 제외", "Left out")}</em></p>}
        </>
      ),
    },
    {
      id: "range", lane: "server", col: 4, title: L("기준 범위 비교", "Range check"),
      body: (
        <>
          {gauged && gauge && range && (
            <div className="fm-fl-gauge">
              <p><small>{term(gauged.label)}</small><b>{readingValue(gauged).text}<i>{gauged.unit}</i></b></p>
              <span className={`fm-fl-range ${gauge.outside ? "is-out" : ""}`} aria-hidden="true">
                <u style={{ left: `${gauge.bandStart}%`, width: `${Math.max(2, gauge.bandEnd - gauge.bandStart)}%` }} />
                <i style={{ left: `${gauge.needle}%` }} />
              </span>
              <small>{L(`기준 ${range.lower ?? "-"}–${range.upper ?? "-"}`, `Range ${range.lower ?? "-"}–${range.upper ?? "-"}`)}</small>
            </div>
          )}
          <dl className="fm-fl-stats">
            <div><dt>{L("기준 안", "In range")}</dt><dd>{pass.inRange}</dd></div>
            <div><dt>{L("벗어남", "Out of range")}</dt><dd className={pass.outside.length ? "is-warn" : ""}>{pass.outside.length}</dd></div>
            <div><dt>{L("기준 없음", "No range")}</dt><dd>{pass.noRange}</dd></div>
          </dl>
        </>
      ),
    },
    {
      id: "judge", lane: "ai", col: 5, title: sensorItem ? L("센서 교차 확인", "Cross-checking sensors") : L("우선 확인 판단", "What to check first"),
      body: top ? (
        <>
          {sensorItem && doubt && partners.length > 0 && (
            <div className="fm-fl-cross">
              <Val m={doubt} doubt />
              <p className="fm-fl-neq"><b aria-hidden="true">≠</b>{L("같은 구역 다른 센서", "Other sensors, same zone")}</p>
              {partners.map((m) => <Val key={m.key} m={m} />)}
            </div>
          )}
          <p className={`fm-fl-verdict is-${top.tone}`}>{top.what}</p>
          <p className="fm-fl-chip">{sensorItem ? L("이 값으로는 설비를 조작하지 않음", "No equipment is operated on this value") : top.todo}</p>
        </>
      ) : <p className="fm-fl-verdict is-ok">{L("이상 없음", "All clear")}</p>,
    },
    { id: "plan", lane: "screen", col: 6, title: L("배치도 표시", "Shown on the plan"), body: layout ? <MiniPlan layout={layout} zoneId={zoneId} zone={zone} item={top} /> : null },
  ];
  const edges: FlowEdge[] = [
    { from: "in", to: "recv", label: L(`${pass.total}개`, `${pass.total} values`) },
    { from: "recv", to: "quality" },
    { from: "quality", to: "range", label: L(`정상 ${pass.good}`, `${pass.good} good`) },
    ...(pass.doubtful.length ? [{ from: "quality", to: "judge", label: L(`의심 ${pass.doubtful.length}`, `${pass.doubtful.length} doubtful`) }] : []),
    { from: "range", to: "judge", label: L(`벗어남 ${pass.outside.length}`, `${pass.outside.length} out`) },
    { from: "judge", to: "plan", label: top ? L("알림 1", "Alert 1") : L("이상 없음", "All clear") },
  ];
  return (
    <FlowBoard
      title={L("센서 값이 서로 맞지 않을 때", "When sensors disagree")}
      source={connected ? null : <span className="fm-fl-error" role="status">{L("수신 확인 필요", "Check the connection")}</span>}
      nodes={nodes}
      edges={edges}
      columns={[1.15, 1, 1.05, 1.2, 1.4, 1.1]}
      resetKey={`${zoneId}:${pass.doubtful.length}:${top?.id ?? ""}`}
      empty={snapshot ? undefined : <p className="fm-hint" role="status">{L("관측을 받는 중…", "Receiving readings…")}</p>}
    />
  );
}

/** The plan in miniature, from the real bed positions: the zone the judgement concerns and its pin. */
function MiniPlan({ layout, zoneId, zone, item }: { layout: FarmLayout; zoneId: string; zone: string; item: BriefItem | null }) {
  const xs = [...new Set(layout.beds.map((b) => b.position.x))].sort((a, b) => a - b);
  const zs = [...new Set(layout.beds.map((b) => b.position.z))].sort((a, b) => a - b);
  const W = 22, H = 14, G = 5;
  const at = (b: FarmLayout["beds"][number]) => ({ x: G + xs.indexOf(b.position.x) * (W + G), y: G + zs.indexOf(b.position.z) * (H + G) });
  const width = G + xs.length * (W + G), height = G + zs.length * (H + G);
  const anchorBed = item?.anchor?.kind === "bed" ? layout.beds.find((b) => item.anchor?.kind === "bed" && b.id === item.anchor.bedId) : null;
  const spots = (anchorBed ? [anchorBed] : layout.beds.filter((b) => b.zone_id === zoneId)).map(at);
  const pin = spots.length ? { x: spots.reduce((s, p) => s + p.x, 0) / spots.length + W / 2, y: spots.reduce((s, p) => s + p.y, 0) / spots.length + H / 2 } : null;
  const tone = item?.tone === "danger" ? "is-danger" : item ? "is-warn" : "is-ok";
  return (
    <figure className="fm-fl-plan">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={item ? L(`${zone}에 번호 1`, `Pin 1 on ${zone}`) : L("표시할 곳 없음", "Nothing to pin")}>
        {layout.beds.map((b) => {
          const p = at(b);
          return <rect key={b.id} x={p.x} y={p.y} width={W} height={H} rx={2} className={item && b.zone_id === zoneId ? `is-zone ${tone}` : ""} />;
        })}
        {item && pin && (
          <g className={`fm-fl-pin ${tone}`}>
            <circle className="fm-fl-pin-ring" cx={pin.x} cy={pin.y} r={9} />
            <circle cx={pin.x} cy={pin.y} r={6} />
          </g>
        )}
      </svg>
      <figcaption>{item ? <><b className={`fm-fl-pinno ${tone}`}>1</b>{zone}</> : L("이상 없음", "All clear")}</figcaption>
    </figure>
  );
}

const UNIT_NAMES: Record<string, [string, string]> = { state: ["상태", "State"], action: ["행동", "Action"], evidence: ["근거", "Evidence"] };
const unitName = (id: string) => L(...(UNIT_NAMES[id] ?? [id, id]));

/** Readings that change after an answer: only the parts resting on the changed value are rewritten. */
function ChangeFlow({ runtime }: { runtime: Runtime }) {
  const farmId = runtime.farmId;
  const zoneLabel = (id: string) => place(runtime.layout?.zones.find((z) => z.id === id)?.label ?? id);
  const [baseline, setBaseline] = useState<string | null>(null);
  const [temperature, setTemperature] = useState<number | null>(null);
  const [run, setRun] = useState<ReviewRun | null>(null);
  const [other, setOther] = useState<ReviewRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function execute(id: string, value: number) {
    setBusy(true); setError("");
    try {
      const [same, elsewhere] = await Promise.all([
        answerReviewRun(farmId, { baseline_id: id, target_zone: "zone-a", changed_zone: "zone-a", temperature: value, sensor_status: "warning" }),
        answerReviewRun(farmId, { baseline_id: id, target_zone: "zone-a", changed_zone: "zone-b", temperature: value, sensor_status: "warning" }),
      ]);
      setRun(same); setOther(elsewhere);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }
  useEffect(() => {
    let alive = true;
    void answerReviewBaseline(farmId).then((b) => {
      if (!alive) return;
      setBaseline(b.baseline_id);
      const a = b.readings.find((r) => r.zone_id === "zone-a");
      const next = Math.round(Number(a?.value ?? 16) + 4);
      setTemperature(next);
      void execute(b.baseline_id, next);
    }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId]);
  const tally = run ? reviewTally(run) : null;
  const otherTally = other ? reviewTally(other) : null;
  const before = run ? Number(run.previous_temperature.toFixed(1)) : null;
  const units = run?.units ?? [];
  const nodes: FlowNode[] = [
    {
      id: "ans", lane: "screen", col: 1, title: L("저장된 답변", "A saved answer"),
      body: (
        <>
          <p className="fm-fl-bubble is-me">{L("현재 근권 온도 상태를 확인해줘", "Check the current root-zone temperature")}</p>
          <ul className="fm-fl-units">
            {units.map((u) => <li key={u.id}><b>{unitName(u.id)}</b><span lang={inKorean(said(u.before))}>{said(u.before)}</span></li>)}
          </ul>
        </>
      ),
    },
    {
      id: "val", lane: "field", col: 2, title: L("센서 값 변화", "A reading changes"),
      body: run ? (
        <p className="fm-fl-change">
          <small>{zoneLabel("zone-a")} {L("근권 온도", "root-zone temp.")}</small>
          <b>{before} <span aria-hidden="true">→</span> {run.input.temperature}<i>°C</i></b>
          <em className="fm-badge is-warn">{L("주의", "Check")}</em>
          <small className="fm-fl-note">{L("예시로 바꾼 값", "An example change")}</small>
        </p>
      ) : null,
    },
    {
      id: "deps", lane: "server", col: 3, title: L("영향받는 부분 확인", "Finding the parts affected"),
      research: "sr", role: L("바뀐 값에 기대는 부분만 찾음", "Finds only the parts resting on it"),
      body: (
        <ul className="fm-fl-units is-deps">
          {units.map((u) => <li key={u.id} className={u.rechecked ? "is-on" : "is-off"}><b>{unitName(u.id)}</b><span>{u.rechecked ? L("다시 확인", "Recheck") : L("그대로", "Keep")}</span></li>)}
        </ul>
      ),
    },
    {
      id: "rewrite", lane: "server", col: 4, title: L("해당 부분만 수정", "Rewriting only those"),
      research: "sr", role: L("그 부분만 다시 작성", "Rewrites just those parts"),
      body: (
        <ul className="fm-fl-units is-diff">
          {units.map((u) => (
            <li key={u.id} className={u.text_changed ? "is-changed" : "is-kept"}>
              <b>{unitName(u.id)}</b>
              {u.text_changed
                ? <span lang={inKorean(said(u.after))}><del>{said(u.before)}</del><ins>{said(u.after)}</ins></span>
                : <span>{u.rechecked ? L("확인했고 문구 같음", "Checked, same words") : L("그대로", "Kept")}</span>}
            </li>
          ))}
        </ul>
      ),
    },
    {
      id: "out", lane: "screen", col: 5, title: L("갱신된 답변", "The updated answer"),
      body: tally ? (
        <>
          <p className="fm-fl-tally"><b>{tally.rewritten}</b><span>/ {tally.total}</span></p>
          <p className="fm-fl-tally-note">{L("부분만 수정", "parts rewritten")}</p>
          {otherTally && <p className="fm-fl-contrast">{L(`${zoneLabel("zone-b")} 값이 바뀌었다면`, `Had ${zoneLabel("zone-b")} changed`)}<b>{otherTally.rewritten} / {otherTally.total}</b></p>}
        </>
      ) : null,
    },
  ];
  const edges: FlowEdge[] = [
    { from: "ans", to: "deps", label: tally ? L(`${tally.total}부분`, `${tally.total} parts`) : null },
    { from: "val", to: "deps", label: run ? `${before} → ${run.input.temperature} °C` : null },
    { from: "deps", to: "rewrite", label: tally ? L(`${tally.rechecked}부분`, `${tally.rechecked} parts`) : null },
    { from: "rewrite", to: "out", label: tally ? L(`수정 ${tally.rewritten}`, `${tally.rewritten} rewritten`) : null },
  ];
  return (
    <FlowBoard
      title={L("답변 뒤 센서 값이 바뀔 때", "When readings change after an answer")}
      source={null}
      tools={
        <>
          <label className="fm-fl-temp">
            <span>{L("새 근권 온도", "New root-zone temp.")}</span>
            <input type="number" min={-10} max={60} step={1} value={temperature ?? ""} onChange={(e) => setTemperature(Number(e.target.value))} />
            <span>°C</span>
          </label>
          <button type="button" className="fm-fl-run" disabled={busy || !baseline || temperature === null} onClick={() => baseline && temperature !== null && void execute(baseline, temperature)}>{busy ? L("확인 중…", "Checking…") : L("이 값으로 확인", "Check with this value")}</button>
        </>
      }
      nodes={nodes}
      edges={edges}
      columns={[1.5, 1, 1.25, 1.65, 1]}
      resetKey={run ? `${run.executed_at}:${run.input.temperature}` : "none"}
      empty={run ? undefined : <p className="fm-hint" role="status">{error ? `${L("관측 서비스에 연결되면 지금 실행합니다.", "Runs once the reading service is reachable.")} ${error}` : L("최신 관측을 복사해 실행하는 중…", "Copying the latest readings and running…")}</p>}
    />
  );
}

const OUTCOMES: Record<string, [string, string]> = {
  device_applied: ["장치에 반영", "Applied on the device"],
  resolved: ["반영, 경보 해소", "Applied, alert cleared"],
  recovery_pending: ["반영, 회복 확인 중", "Applied, recovery pending"],
  unrecovered: ["반영, 회복 안 됨", "Applied, not recovered"],
  device_pending: ["장치 응답 대기", "Waiting for the device"],
  mismatch: ["요청과 다름", "Differs from the request"],
  unavailable: ["확인 불가", "Could not check"],
};

function requestedText(target: string, value: string | number | boolean): string {
  if (target === "air_temperature_sensor_reset") return L("재보정", "Recalibrate");
  if (typeof value === "number") return `${Math.round(value)}%`;
  if (typeof value === "boolean") return value ? L("켜기", "On") : L("끄기", "Off");
  return term(String(value));
}

/** Operating equipment: only a change a person allows goes out, after the state is read again at that moment. */
function ControlFlow({ runtime }: { runtime: Runtime }) {
  const picked = pickControlCase(runtime.cases);
  const zoneLabel = (id?: string | null) => place(runtime.layout?.zones.find((z) => z.id === id)?.label ?? L("농장", "Farm"));
  const item = picked?.item;
  const action = picked?.action;
  const device = action ? deviceShortLabel(action.target, action.target) : "";
  // Only the first sentence of the alert: the situation, not the advice after it.
  // Translated whole (the known sentences are matched in full), then cut to the first sentence.
  const situation = item ? backendText(item.title).split(/(?<=[.])\s+/)[0] : "";
  const byRule = !!action?.aiJudgmentSummary;
  const plus = (from?: string | null, to?: string | null) => { const g = gapText(from, to); return g ? `+${g}` : null; };
  const nodes: FlowNode[] = item && action ? [
    {
      id: "alert", lane: "server", col: 1, title: L("경보 발생", "An alert"),
      body: (
        <>
          <p className="fm-fl-alert" lang={inKorean(situation)}>{situation}</p>
          <small className="fm-fl-when">{zoneLabel(item.zoneId)}, {shortStamp(item.openedAt)}</small>
        </>
      ),
    },
    {
      id: "draft", lane: byRule ? "server" : "screen", col: 2, title: L("조정안", "The proposed change"),
      body: (
        <>
          <p className="fm-fl-device"><b>{device}</b><span>{requestedText(action.target, action.requestedValue)}</span></p>
          <small className="fm-fl-when">{byRule ? L("경보에 맞춰 만든 조정안", "Drafted for the alert") : L("사람이 직접 고른 조작", "Chosen by a person")}</small>
        </>
      ),
    },
    {
      id: "allow", lane: "screen", col: 3, title: L("사람의 허용", "A person allows"),
      body: <p className="fm-fl-stamp"><b>{L("허용", "Allowed")}</b><small>{shortStamp(action.approvedAt)}</small></p>,
    },
    {
      id: "gate", lane: "server", col: 4, title: L("허용 시점 상태 재확인", "State reread at approval"),
      research: "gate", role: L("그 순간 상태를 다시 읽고, 달라졌으면 멈춤", "Stops if the state has moved"),
      body: <p className="fm-fl-steps"><span>{L("상태 그대로", "Unchanged")}</span><span aria-hidden="true">→</span><b>{L("명령 전송", "Command sent")}</b></p>,
    },
    {
      id: "device", lane: "field", col: 5, title: L("장치 반영", "The device applies"),
      body: (
        <p className="fm-fl-stamp">
          <b>{L(...(OUTCOMES[action.verification?.outcome ?? ""] ?? ["확인됨", "Confirmed"]))}</b>
          <small>{shortStamp(action.verification?.checkedAt ?? action.executedAt)}</small>
        </p>
      ),
    },
    {
      id: "done", lane: "server", col: 6, title: L("회복 확인과 기록", "Recovery and the record"),
      body: (
        <p className="fm-fl-stamp is-ok">
          <b>{L("회복", "Recovered")}{plus(action.executedAt, item.resolvedAt) && <em>{plus(action.executedAt, item.resolvedAt)}</em>}</b>
          <small>{shortStamp(item.resolvedAt)}</small>
        </p>
      ),
    },
  ] : [];
  const edges: FlowEdge[] = [
    { from: "alert", to: "draft" },
    { from: "draft", to: "allow", label: L("변경 내용", "The change") },
    { from: "allow", to: "gate", label: L("허용", "Allowed") },
    { from: "gate", to: "device", label: plus(action?.approvedAt, action?.executedAt) },
    { from: "device", to: "done", label: plus(action?.executedAt, action?.verification?.checkedAt) },
  ];
  return (
    <FlowBoard
      title={L("설비를 조작할 때", "When equipment is operated")}
      source={null}
      nodes={nodes}
      edges={edges}
      columns={[1.35, 1.05, 1, 1.15, 1.1, 1.1]}
      resetKey={action?.proposalId ?? "none"}
      empty={item ? undefined : <p className="fm-hint" role="status">{L("아직 허용해서 회복까지 확인한 설비 조작 기록이 없습니다.", "No allowed change has been followed to recovery yet.")}</p>}
    />
  );
}

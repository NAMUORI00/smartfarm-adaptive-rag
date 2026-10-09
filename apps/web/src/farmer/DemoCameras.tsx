import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { FarmId } from "../types";
import { getLang, L } from "./i18n";
import { AiMark } from "./AiBrief";
import { analyzeDemoCamera } from "./assist-api";
import type { LiveCameraAnswer } from "./assist-api";
import { answerText, cameraFinding, cameraLabel, liveMultiview, liveQuestion, loadDemoCameras, MULTIVIEW_FOCUS, multiviewDecision, questionText } from "./demo-cameras";
import type { DemoCamera, DemoCameraManifest, DemoMultiview, DemoQuestion } from "./demo-cameras";
import { shortStamp } from "./time-format";

/** One reading made now: results arrive one question at a time. */
type Run = { status: "running" | "done"; results: Record<string, LiveCameraAnswer>; errors: Record<string, string>; startedAt: number; finishedAt?: number };
// Kept for the page session, so leaving the camera page and coming back keeps what was read.
const cameraRuns: Record<string, Run> = {};
const multiviewRuns: Record<string, Run> = {};
const feedMultiviewRuns: Record<string, Run> = {};

const seconds = (ms: number) => L(`${(ms / 1000).toFixed(1)}초`, `${(ms / 1000).toFixed(1)} s`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Where a camera is registered, e.g. "A구역 4번 베드 근접": the zone is given, never read off the frame. */
const cameraPlace = (c: DemoCamera, zoneLabel: (id?: string | null) => string) => {
  const zone = zoneLabel(c.zone_id);
  const label = cameraLabel(c);
  return label.includes(zone) ? label : `${zone} ${label}`;
};

/** "지금 실행, 14:12, 4.3초, AI 에이전트": when, how long, and that the AI agent read it. */
function RunMeta({ run }: { run: Run }) {
  if (run.status !== "done" || !run.finishedAt) return null;
  return (
    <small className="fm-live-meta">
      <span className="fm-badge is-ok">{L("지금 실행", "Run now")}</span>
      {shortStamp(new Date(run.finishedAt).toISOString())}, {seconds(run.finishedAt - run.startedAt)}, {L("AI 에이전트", "AI agent")}
    </small>
  );
}

/**
 * Farm cameras, shown with example scenes because this farm has none
 * installed yet. "AI 화면 판독" sends the frame to the AI now and shows, per
 * question as each reply arrives, an answer with the region it rests on or an
 * abstention with the reason the frame cannot settle it. The analysis saved in
 * advance is only offered when the AI cannot be reached, and is named as such.
 */
export function DemoCameras({ farmId, focus, onAsk, zoneLabel }: {
  farmId: FarmId;
  /** The registered zone name, sent with each frame so the AI does not try to read the location off it. */
  zoneLabel: (id?: string | null) => string;
  focus?: string | null;
  onAsk: (question: string, zoneId: string, bedId?: string | null) => void;
}) {
  const [manifest, setManifest] = useState<DemoCameraManifest | null>(null);
  // "multiview" opens the page at the question put to two cameras rather than at one camera.
  const [selected, setSelected] = useState<string | null>(focus && focus !== MULTIVIEW_FOCUS ? focus : null);
  const [runs, setRuns] = useState<Record<string, Run>>(() => ({ ...cameraRuns }));
  const [replay, setReplay] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadDemoCameras().then(setManifest); }, []);
  useEffect(() => { if (focus && focus !== MULTIVIEW_FOCUS) setSelected(focus); }, [focus]);
  useEffect(() => {
    if (focus !== MULTIVIEW_FOCUS || !manifest) return;
    const id = requestAnimationFrame(() => document.querySelector(".fm-mv")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    return () => cancelAnimationFrame(id);
  }, [focus, manifest]);
  if (!manifest) return null;
  const camera = manifest.cameras.find((c) => c.id === selected) ?? manifest.cameras[0];
  const run = runs[camera.id];
  const update = (id: string, next: (r: Run) => Run) => setRuns((all) => { const value = next(all[id]); cameraRuns[id] = value; return { ...all, [id]: value }; });

  async function read(c: DemoCamera) {
    setBusy(true);
    setReplay((r) => ({ ...r, [c.id]: false }));
    const started: Run = { status: "running", results: {}, errors: {}, startedAt: Date.now() };
    cameraRuns[c.id] = started;
    setRuns((all) => ({ ...all, [c.id]: started }));
    const lang = getLang();
    await Promise.all(c.questions.map(async (q) => {
      try {
        const result = await analyzeDemoCamera(farmId, c, lang === "en" ? q.question_en : q.question_ko, lang, cameraPlace(c, zoneLabel));
        update(c.id, (r) => ({ ...r, results: { ...r.results, [q.id]: result } }));
      } catch (e) {
        update(c.id, (r) => ({ ...r, errors: { ...r.errors, [q.id]: errorText(e) } }));
      }
    }));
    update(c.id, (r) => ({ ...r, status: "done", finishedAt: Date.now() }));
    setBusy(false);
  }

  // What each question shows: the live reading, the saved one when asked for, or nothing yet.
  const shown = (c: DemoCamera, q: DemoQuestion): DemoQuestion | null => {
    const live = runs[c.id]?.results[q.id];
    if (live) return liveQuestion(q, live);
    return replay[c.id] ? q : null;
  };
  const failedAll = !!run && run.status === "done" && Object.keys(run.results).length === 0;
  const results = camera.questions.map((q) => shown(camera, q));

  return (
    <section className="fm-camera-section fm-demo-cams" aria-labelledby="fm-demo-title">
      <div className="fm-camera-head">
        <div>
          <h2 id="fm-demo-title">{L("농장 카메라", "Farm cameras")}</h2>
          <p className="fm-demo-note" title={L(manifest.note_ko, manifest.note_en)}><span className="fm-badge is-info">{L("예시 영상", "Example")}</span></p>
        </div>
      </div>
      <div className="fm-demo-grid" role="list">
        {manifest.cameras.map((c) => {
          const r = runs[c.id];
          const live = r && Object.keys(r.results).length > 0;
          const finding = live ? c.questions.some((q) => shown(c, q)?.alert) : !!cameraFinding(c);
          return (
            <button
              type="button"
              role="listitem"
              key={c.id}
              className={`fm-demo-card ${c.id === camera.id ? "is-selected" : ""}`}
              aria-pressed={c.id === camera.id}
              onClick={() => setSelected(c.id)}
            >
              <img src={c.image} alt="" loading="lazy" />
              <span className="fm-demo-card-meta">
                <strong>{cameraLabel(c)}</strong>
              </span>
              {r?.status === "running" ? (
                <em className="fm-badge is-info">{L("판독 중", "Reading")}</em>
              ) : (
                <em className={`fm-badge ${finding ? "is-warn" : "is-ok"}`} title={live ? L("방금 판독한 결과", "Read just now") : L(`${manifest.analysis.created_at} 사전 판독 결과`, `Read in advance on ${manifest.analysis.created_at}`)}>
                  {finding ? L("확인 필요", "Check") : L("특이 사항 없음", "Nothing unusual")}{live ? "" : L(", 사전 판독", ", earlier")}
                </em>
              )}
            </button>
          );
        })}
      </div>

      {(manifest.multiview ?? []).map((m) => <Multiview key={m.id} farmId={farmId} m={m} cameras={manifest.cameras} onOpen={setSelected} busy={busy} setBusy={setBusy} zoneLabel={zoneLabel} />)}

      <div className="fm-demo-detail">
        <figure className="fm-demo-frame">
          <img src={camera.image} alt={L(`${cameraLabel(camera)} 예시 화면`, `${cameraLabel(camera)} example frame`)} />
          <span className="fm-demo-tag">{camera.id.toUpperCase()}</span>
          {results.map((q, i) => q && q.decision === "answer" && q.box && (
            <span
              key={q.id}
              className={`fm-demo-box ${q.alert ? "is-alert" : ""}`}
              style={{ left: `${q.box[0] * 100}%`, top: `${q.box[1] * 100}%`, width: `${q.box[2] * 100}%`, height: `${q.box[3] * 100}%` }}
              aria-hidden="true"
            >
              <b>{i + 1}</b>
            </span>
          ))}
          {run?.status === "running" && <span className="fm-demo-scan fm-live-running" aria-hidden="true" />}
        </figure>
        <div className="fm-demo-result">
          <div className="fm-demo-result-head">
            <strong><AiMark title={L("AI가 이 화면을 지금 판독합니다", "The AI reads this frame now")} />{cameraLabel(camera)}</strong>
            <button className="fm-primary" disabled={busy} onClick={() => void read(camera)}>
              {run?.status === "running" ? L("AI 판독 중…", "AI reading…") : run ? L("다시 판독", "Read again") : L("AI 화면 판독", "AI frame reading")}
            </button>
          </div>
          {run?.status === "running" && (
            <p className="fm-live-progress" role="status">
              {L(`화면을 AI에 보내 질문 ${camera.questions.length}개를 판독하는 중. ${Object.keys(run.results).length}개 완료`, `Reading ${camera.questions.length} questions from this frame. ${Object.keys(run.results).length} done`)}
            </p>
          )}
          {run && <RunMeta run={run} />}
          <ul className={`fm-demo-questions ${!run && !replay[camera.id] ? "is-idle" : ""}`}>
            {camera.questions.map((base, i) => {
              const q = results[i];
              const error = run?.errors[base.id];
              const pending = run?.status === "running" && !q && !error;
              return (
                <li key={base.id} className={q ? (q.decision === "answer" ? (q.alert ? "is-alert" : "is-answer") : "is-abstain") : ""}>
                  <span className="fm-demo-qhead">
                    <b>{i + 1}</b>
                    {q && <span className={`fm-badge ${q.decision === "answer" ? (q.alert ? "is-warn" : "is-ok") : "is-info"}`}>{q.decision === "answer" ? L("답함", "Answered") : L("판단 보류", "Abstained")}</span>}
                    {pending && <span className="fm-badge is-info">{L("판독 중", "Reading")}</span>}
                    {error && !q && <span className="fm-badge is-danger">{L("판독 실패", "Failed")}</span>}
                    <strong>{questionText(base)}</strong>
                  </span>
                  {q && <span className="fm-demo-answer">{answerText(q)}</span>}
                  {error && !q && <span className="fm-demo-answer">{error}</span>}
                  {q?.decision === "answer" && <small>{L(`확신도 ${Math.round(q.confidence * 100)}% (모델이 밝힌 값)`, `Confidence ${Math.round(q.confidence * 100)}% (as stated by the model)`)}</small>}
                  {q?.alert && q.decision === "answer" && (
                    <button className="fm-demo-ask" title={L(q.ask_ko ?? "", "Searches the growing guides for this")} onClick={() => onAsk(q.ask_ko ?? `${camera.label_ko} 카메라에서 본 "${q.finding_ko ?? q.answer_ko ?? ""}" 확인 방법`, camera.zone_id, camera.bed_id)}>
                      {L("AI에게 원인 묻기", "Ask the AI why")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          {failedAll && !replay[camera.id] && (
            <p className="fm-live-fallback" role="alert">
              {L("AI 판독에 연결하지 못했습니다.", "Could not reach the AI reader.")}{" "}
              <button type="button" className="fm-link-button" onClick={() => setReplay((r) => ({ ...r, [camera.id]: true }))}>{L(`${manifest.analysis.created_at} 사전 판독 기록 보기`, `Show the reading saved on ${manifest.analysis.created_at}`)}</button>
            </p>
          )}
          <small className="fm-demo-cite">
            {replay[camera.id] && !Object.keys(run?.results ?? {}).length
              ? L(`화면은 생성 이미지, 판독은 ${manifest.analysis.created_at}에 미리 실행해 저장한 기록입니다.`, `Frames are generated images; this reading was saved on ${manifest.analysis.created_at}.`)
              : L("화면은 생성한 예시 이미지이고, 판독은 버튼을 누를 때 AI가 지금 실행합니다. 화면만으로 알 수 없는 것은 판단을 보류합니다.", "Frames are generated example images; the AI reads them when you press the button. What a frame cannot show is left unanswered.")}
          </small>
        </div>
      </div>
    </section>
  );
}

/**
 * The same question put to two cameras, read now: each view answers or holds
 * back, and the answer rests only on a view that shows it. By default the views
 * are the example stills; camera feeds pass their own reader and frames (the
 * latest frame each camera sent), and then no saved reading stands in.
 */
export function Multiview({ farmId, m, cameras, onOpen, busy, setBusy, zoneLabel, read: readOne, frameOf }: {
  farmId: FarmId; m: DemoMultiview; cameras: DemoCamera[]; onOpen: (id: string) => void; busy: boolean; setBusy: (v: boolean) => void; zoneLabel: (id?: string | null) => string;
  read?: (camera: DemoCamera, question: string, lang: string, location: string) => Promise<LiveCameraAnswer>;
  frameOf?: (camera: DemoCamera, result: LiveCameraAnswer | undefined) => ReactNode;
}) {
  const runs = readOne ? feedMultiviewRuns : multiviewRuns;
  const [run, setRun] = useState<Run | null>(runs[m.id] ?? null);
  const [replay, setReplay] = useState(false);
  const saved = multiviewDecision(m, cameras);
  if (saved.candidates.length < 2) return null;
  const live = run ? liveMultiview(m, cameras, run.results) : null;
  const view = replay && !live?.candidates.length ? saved : live;
  const done = run?.status === "done" || replay;
  const set = (next: (r: Run) => Run) => setRun((r) => { const value = next(r!); runs[m.id] = value; return value; });

  async function read() {
    setBusy(true);
    setReplay(false);
    const started: Run = { status: "running", results: {}, errors: {}, startedAt: Date.now() };
    runs[m.id] = started;
    setRun(started);
    const lang = getLang();
    await Promise.all(saved.candidates.map(async ({ camera }) => {
      try {
        const question = lang === "en" ? m.question_en : m.question_ko;
        const result = await (readOne ?? ((c, q, l, at) => analyzeDemoCamera(farmId, c, q, l, at)))(camera, question, lang, cameraPlace(camera, zoneLabel));
        set((r) => ({ ...r, results: { ...r.results, [camera.id]: result } }));
      } catch (e) {
        set((r) => ({ ...r, errors: { ...r.errors, [camera.id]: errorText(e) } }));
      }
    }));
    set((r) => ({ ...r, status: "done", finishedAt: Date.now() }));
    setBusy(false);
  }
  const failedAll = run?.status === "done" && Object.keys(run.results).length === 0;
  return (
    <section className="fm-mv" aria-labelledby={`fm-mv-${m.id}`}>
      <header className="fm-mv-head">
        <h3 id={`fm-mv-${m.id}`}><AiMark title={L("AI가 카메라마다 지금 판독하고 근거가 보이는 화면을 고릅니다", "The AI reads each camera now and picks the frame that shows the evidence")} />{L("여러 카메라에서 근거 고르기", "Choosing the evidence among cameras")}</h3>
        <p><strong>{L(m.question_ko, m.question_en)}</strong></p>
        <button className="fm-primary" onClick={() => void read()} disabled={busy}>
          {run?.status === "running" ? L("판독 중…", "Reading…") : run ? L("다시 판독", "Read again") : L("두 카메라 판독", "Read both cameras")}
        </button>
      </header>
      <ol className="fm-mv-list">
        {saved.candidates.map(({ camera }) => {
          const c = view?.candidates.find((x) => x.camera.id === camera.id) ?? null;
          const pending = run?.status === "running" && !c && !run.errors[camera.id];
          const error = run?.errors[camera.id];
          return (
            <li key={camera.id} className={c && done ? (c.chosen ? "is-chosen" : c.question.decision === "answer" ? "is-answer" : "is-abstain") : ""}>
              <button type="button" className="fm-mv-frame" onClick={() => onOpen(camera.id)} aria-label={L(`${cameraLabel(camera)} 화면 크게 보기`, `Open ${cameraLabel(camera)}`)}>
                {frameOf ? frameOf(camera, run?.results[camera.id]) : <img src={camera.image} alt="" loading="lazy" />}
                {c && c.question.decision === "answer" && c.question.box && (
                  <span className={`fm-demo-box ${c.question.alert ? "is-alert" : ""}`} style={{ left: `${c.question.box[0] * 100}%`, top: `${c.question.box[1] * 100}%`, width: `${c.question.box[2] * 100}%`, height: `${c.question.box[3] * 100}%` }} aria-hidden="true" />
                )}
                {pending && <span className="fm-demo-scan fm-live-running" aria-hidden="true" />}
              </button>
              <p className="fm-mv-cam">
                <strong>{cameraLabel(camera)}</strong>
                {pending && <span className="fm-badge is-info">{L("판독 중", "Reading")}</span>}
                {error && !c && <span className="fm-badge is-danger">{L("판독 실패", "Failed")}</span>}
                {c && <span className={`fm-badge ${done && c.chosen ? "is-ok" : c.question.decision === "answer" ? "is-info" : "is-off"}`}>{done && c.chosen ? L("근거로 채택", "Used as evidence") : c.question.decision === "answer" ? L("답함", "Answered") : L("판단 보류", "Abstained")}</span>}
              </p>
              {c && <small>{answerText(c.question)}{c.question.decision === "answer" ? L(` 확신도 ${Math.round(c.question.confidence * 100)}%`, ` Confidence ${Math.round(c.question.confidence * 100)}%`) : ""}</small>}
              {error && !c && <small>{error}</small>}
            </li>
          );
        })}
      </ol>
      {done && view && (() => {
        const chosen = view.chosen;
        // Say what the other views did: held back, or answered with less confidence.
        const others = view.candidates.filter((c) => !c.chosen);
        const answeredOthers = others.filter((c) => c.question.decision === "answer");
        return (
          <p className="fm-mv-result" role="status">
            {chosen
              ? L(
                  `답: ${(chosen.question.answer_ko ?? "").replace(/^예[,.]\s*/, "")} 근거 화면은 ${chosen.camera.label_ko} 하나입니다. ${answeredOthers.length ? `${answeredOthers.map((c) => c.camera.label_ko).join(", ")}도 답했지만 확신도가 더 낮아 근거로 쓰지 않았습니다.` : "판단을 보류한 카메라는 쓰지 않았습니다."}`,
                  `Answer: ${(chosen.question.answer_en ?? "").replace(/^Yes[,.]\s*/i, "")} The evidence is the ${chosen.camera.label_en} frame alone. ${answeredOthers.length ? `${answeredOthers.map((c) => c.camera.label_en).join(", ")} also answered, with lower confidence, so it was not used.` : "Cameras that held back were not used."}`,
                )
              : L("어느 카메라에도 근거가 보이지 않아 답하지 않았습니다.", "No camera showed it, so there is no answer.")}
          </p>
        );
      })()}
      {run && !replay && <RunMeta run={run} />}
      {replay && <small className="fm-live-meta"><span className="fm-badge is-info">{L("사전 판독 기록", "Saved reading")}</span>{L("미리 실행해 저장한 결과", "Run in advance and saved")}</small>}
      {failedAll && !replay && (
        <p className="fm-live-fallback" role="alert">
          {L("AI 판독에 연결하지 못했습니다.", "Could not reach the AI reader.")}{" "}
          {!readOne && <button type="button" className="fm-link-button" onClick={() => setReplay(true)}>{L("사전 판독 기록 보기", "Show the saved reading")}</button>}
        </p>
      )}
    </section>
  );
}

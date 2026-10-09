import { useEffect, useState } from "react";
import { AuthenticatedMedia } from "../AuthenticatedMedia";
import { PatrolBrief } from "../PatrolBrief";
import { PatrolProgress } from "../PatrolProgress";
import type { FarmLayout } from "../farm-spatial";
import { shortStamp, stamp as formatSensorUpdateTime } from "./time-format";
import { AiMark } from "./AiBrief";
import type { FarmId } from "../types";
import {
  analyzeResearchVideo,
  getResearchVideoCatalog,
  listResearchVideoAnalyses,
  patrolRequest,
} from "../video-api";
import { researchEvidencePath } from "../video-api";
import type { PatrolEvent, ResearchVideoAnalysis, ResearchVideoCatalog } from "../video-api";
import { useVideoSession, useVideoValue } from "../video-context";
import type { VideoRequest } from "../video-session";
import { ExampleVideos } from "./ExampleVideos";
import { ModuleTag } from "./ModuleTag";
import {
  cameraCards,
  cameraDisplayName,
  openPatrolCount,
  patrolHistoryLabel,
  patrolStatusLabel,
  researchDecision,
  videoErrorMessage,
} from "./camera-state";
import type { PatrolRuntime } from "./usePatrolEvents";
import { L, place, prose } from "./i18n";
import { DemoCameras } from "./DemoCameras";
import { CameraFeeds } from "./CameraFeeds";
import { eventText, eventTitle, isCameraEvent, outcomesFor } from "./camera-feeds";
import { loadDemoCameras } from "./demo-cameras";
import type { DemoCameraManifest } from "./demo-cameras";
import { FeedImage, FeedVideo } from "./FeedMedia";
import type { CameraFeedsRuntime } from "./useCameraFeeds";


/**
 * Centre column in camera mode. The farm's cameras lead: each plays what it
 * sent last with the AI's reading of it, received and read by the server
 * without anyone asking (example stills when no camera feed is set up). Records
 * that need a person follow, then the research model on public footage and the
 * reference clips.
 */
export function CameraView({ farmId, layout, selectedZone, zoneLabel, patrol, feeds, focusCamera, onAsk }: {
  farmId: FarmId;
  layout: FarmLayout | null;
  selectedZone: string | null;
  zoneLabel: (id?: string | null) => string;
  patrol: PatrolRuntime;
  feeds: CameraFeedsRuntime;
  focusCamera?: string | null;
  onAsk: (question: string, zoneId: string, bedId?: string | null) => void;
}) {
  const cards = cameraCards(layout, selectedZone);
  const open = openPatrolCount(patrol.events);
  const [manifest, setManifest] = useState<DemoCameraManifest | null>(null);
  useEffect(() => { void loadDemoCameras().then(setManifest); }, []);
  const patrolSection = <PatrolSection farmId={farmId} patrol={patrol} zoneLabel={zoneLabel} />;
  return (
    <div className="fm-camera" aria-label={L("카메라 화면", "Camera view")}>
      {cards.length > 0 && (
        <div className="fm-camera-grid" aria-label={L("등록된 카메라", "Registered cameras")}>
          {cards.map((card) => (
            <div className="fm-camera-card" key={card.id}>
              <strong>{card.id}</strong>
              <small>{card.bedLabels.length ? L(`등록 베드: ${card.bedLabels.join(", ")}`, `Beds: ${card.bedLabels.map(place).join(", ")}`) : L("베드 연결 미등록", "No bed linked")}. {L("실시간 화면 미연결", "Live view not connected")}</small>
            </div>
          ))}
        </div>
      )}
      {feeds.live?.length
        ? <CameraFeeds farmId={farmId} feeds={feeds} patrol={patrol} focus={focusCamera} onAsk={onAsk} zoneLabel={zoneLabel} manifest={manifest} />
        : <DemoCameras farmId={farmId} focus={focusCamera} onAsk={onAsk} zoneLabel={zoneLabel} />}
      {open > 0 && patrolSection}
      {/* The research model, run live on public multi-view footage. */}
      <ResearchSection farmId={farmId} />
      {open === 0 && patrolSection}
      <details className="fm-camera-section fm-camera-fold">
        <summary>{L("참고 영상 (학습용)", "Reference videos (for learning)")}</summary>
        <ExampleVideos farmId={farmId} />
      </details>
    </div>
  );
}

/**
 * The camera research run live on public multi-view CCTV: the same two frames
 * every time, read now by the research model. The card shows what actually
 * happens, in order: both frames, the frozen selector's evidence score for
 * each, the model's verdict on the chosen one, and the release policy. The
 * last real run is offered only when the model server cannot be reached.
 */
function ResearchSection({ farmId }: { farmId: FarmId }) {
  const session = useVideoSession();
  const [catalogState] = useVideoValue<VideoRequest<ResearchVideoCatalog>>("research.catalog", { status: "idle" });
  const [analysis] = useVideoValue<VideoRequest<ResearchVideoAnalysis>>("research.analysis", { status: "idle" });
  const [selectedId, setId] = useVideoValue("research.selected", "");
  useEffect(() => {
    void session.run("research.catalog", (signal) => getResearchVideoCatalog(farmId, signal));
  }, [farmId, session]);
  const catalog = catalogState.value;
  const id = catalog?.evidence_sets.some((s) => s.id === selectedId) ? selectedId : catalog?.evidence_sets[0]?.id || "";
  const sample = catalog?.evidence_sets.find((s) => s.id === id);
  // Offered only when the model cannot be reached: the latest real run, named as a record.
  const [recent, setRecent] = useState<(ResearchVideoAnalysis & { created_at?: string }) | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    listResearchVideoAnalyses(farmId, controller.signal).then((rows) => setRecent(rows[0] ?? null)).catch(() => setRecent(null));
    return () => controller.abort();
  }, [farmId]);
  const busy = analysis.status === "loading";
  const fresh = analysis.value && analysis.value.decision !== "unavailable" ? analysis.value : null;
  const unreachable = !busy && analysis.value?.decision === "unavailable";
  const result = fresh ?? (showRecord ? recent : null);
  const record = !fresh && !!result;
  // The run returns in about a second; its stages are then shown one after another.
  const [revealed, setRevealed] = useState(0);
  useEffect(() => {
    if (!result) { setRevealed(0); return; }
    setRevealed(1);
    const timers = [2, 3, 4].map((n, i) => window.setTimeout(() => setRevealed(n), 450 * (i + 1)));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [result?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const canAnalyze = catalog?.inference_ready ?? catalog?.ready ?? false;
  const error = videoErrorMessage(analysis.error || catalogState.error);
  const decision = result ? researchDecision(result) : null;
  const candidates = result?.stages.selection?.candidates ?? [];
  const selectedCamera = result?.selected_camera_id ?? candidates.find((c) => c.view_id === result?.stages.selection?.view_id)?.camera_id ?? null;
  const answer = result?.stages.answer;
  const release = result?.stages.release;
  const name = (camera: string | null) => (sample ? cameraDisplayName(camera, sample.camera_ids) : camera ?? "");
  function analyze() {
    setShowRecord(false);
    if (sample && canAnalyze) void session.run("research.analysis", (signal) => analyzeResearchVideo(farmId, sample, signal), true);
  }
  const holdText = () => {
    const hold = release?.hold_reason;
    if (release?.released) return L(`답: ${result?.answer ?? ""}`, `Answer: ${result?.answer ?? ""}`);
    if (hold === "model_abstained") return L("모델이 이 화면만으로는 판단할 수 없다고 해서 답하지 않았습니다.", "The model said this frame cannot settle it, so there is no answer.");
    if (hold === "confidence_below_threshold") return L("확신도가 공개 기준보다 낮아 답을 공개하지 않았습니다.", "The confidence is below the release threshold, so the answer is withheld.");
    return L("공개 기준이 아직 검증되지 않아 모델의 답은 공개하지 않습니다. 근거 화면만 보여줍니다.", "The release policy is not validated yet, so the model's answer is withheld; only the evidence frames are shown.");
  };
  return (
    <section className="fm-mv fm-research" aria-labelledby="fm-research-title" aria-busy={busy}>
      <header className="fm-mv-head">
        <h3 id="fm-research-title"><AiMark title={L("연구 모델이 두 카메라 중 근거가 보이는 화면을 고르고 판독합니다", "The research model picks the camera that shows the evidence and reads it")} />{L("연구 모델: 여러 카메라에서 근거 고르기", "Research model: choosing the evidence among cameras")}</h3>
        {sample && <p><strong>{prose(sample.question)}</strong><small>{prose(sample.source_label)}, {sample.recorded_at ? formatSensorUpdateTime(sample.recorded_at) : L("촬영 시각 미확인", "capture time unknown")}. {L("이 농장 영상이 아닙니다.", "Not this farm's footage.")}</small></p>}
        <button className="fm-primary" disabled={busy || !canAnalyze || !sample} onClick={analyze}>
          {busy ? L("판독 중…", "Reading…") : fresh ? L("다시 판독", "Read again") : L("두 카메라 판독", "Read both cameras")}
        </button>
      </header>
      {catalog && catalog.evidence_sets.length > 1 && (
        <label className="fm-research-pick">
          {L("확인할 영상", "Video to check")}
          <select value={id} disabled={busy} onChange={(e) => { setId(e.target.value); session.cancel("research.analysis"); }}>
            {catalog.evidence_sets.map((s) => <option key={s.id} value={s.id}>{prose(s.title)}</option>)}
          </select>
        </label>
      )}
      {catalogState.status === "loading" && <p role="status">{L("연구 모델 연결 확인 중…", "Checking the research model…")}</p>}
      {sample && (
        <ol className="fm-mv-list">
          {sample.camera_ids.map((camera) => {
            const candidate = candidates.find((c) => c.camera_id === camera);
            const chosen = !!result && selectedCamera === camera;
            const scored = !!candidate && revealed >= 2;
            return (
              <li key={camera} className={scored ? (chosen ? "is-chosen" : "is-abstain") : ""}>
                <div className="fm-mv-frame">
                  <AuthenticatedMedia farmId={farmId} path={researchEvidencePath(sample.id, camera)} image />
                  {busy && <span className="fm-demo-scan fm-live-running" aria-hidden="true" />}
                  {chosen && revealed >= 3 && result?.frame_urls[1] && (
                    <figure className="fm-mv-roi">
                      <AuthenticatedMedia farmId={farmId} path={result.frame_urls[1]} image />
                      <figcaption>{L("판독한 확대 영역", "Zoomed area read")}</figcaption>
                    </figure>
                  )}
                </div>
                <p className="fm-mv-cam">
                  <strong>{name(camera)}</strong>
                  {busy && <span className="fm-badge is-info">{L("판독 중", "Reading")}</span>}
                  {scored && <span className={`fm-badge ${chosen ? "is-ok" : "is-off"}`}>{chosen ? L("근거로 채택", "Used as evidence") : L("덜 보임", "Shows less")}</span>}
                </p>
                {scored && (
                  <div className="fm-cam-score">
                    <i className="fm-bar" aria-hidden="true"><b style={{ width: `${Math.round(Math.max(0, Math.min(1, candidate!.availability)) * 100)}%` }} /></i>
                    <span>{L("근거가 보일 가능성", "Chance the evidence shows")} {candidate!.availability.toFixed(3)}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {(busy || result) && (
        <ol className="fm-live-steps" aria-label={L("처리 순서", "Processing steps")}>
          <li className={busy ? "is-current" : "is-done"}>
            <b>1</b><span>{L("두 카메라 화면 받기", "Take both camera frames")}</span>
          </li>
          <li className={revealed >= 2 ? "is-done" : busy ? "is-current" : ""}>
            <b>2</b><span>{L("근거가 보이는 화면 고르기", "Pick the frame that shows the evidence")}</span>
            {revealed >= 2 && selectedCamera && <em>{L(`${name(selectedCamera)}, 가능성 ${(result?.stages.selection?.availability ?? candidates[0]?.availability ?? 0).toFixed(3)}`, `${name(selectedCamera)}, ${(result?.stages.selection?.availability ?? candidates[0]?.availability ?? 0).toFixed(3)}`)}</em>}
          </li>
          <li className={revealed >= 3 ? "is-done" : ""}>
            <b>3</b><span>{L("연구 모델 판독", "Research model reads it")}</span>
            {revealed >= 3 && answer && <em>{answer.decision === "answer" ? L(`답할 수 있음, 확신도 ${(answer.confidence ?? 0).toFixed(3)}`, `Can answer, confidence ${(answer.confidence ?? 0).toFixed(3)}`) : L("판단 보류", "Abstains")}</em>}
          </li>
          <li className={revealed >= 4 ? "is-done" : ""}>
            <b>4</b><span>{L("공개 기준 검사", "Release check")}</span>
            {revealed >= 4 && release && <em>{release.released ? L("공개", "Released") : L(`보류${typeof release.threshold === "number" ? `, 기준 ${release.threshold.toFixed(4)}` : ""}${release.validated === false ? ", 기준 검증 전" : ""}`, `Withheld${typeof release.threshold === "number" ? `, threshold ${release.threshold.toFixed(4)}` : ""}${release.validated === false ? ", policy not validated" : ""}`)}</em>}
          </li>
        </ol>
      )}
      {result && decision && revealed >= 4 && (
        <p className={`fm-mv-result is-${decision.kind}`} role="status">
          <strong>{decision.title}. </strong>{holdText()}
        </p>
      )}
      {result && revealed >= 4 && (
        <small className="fm-live-meta">
          {record ? (
            <><span className="fm-badge is-info">{L("실행 기록", "Recorded run")}</span>{result.created_at ? formatSensorUpdateTime(result.created_at) : ""}</>
          ) : (
            <><span className="fm-badge is-ok">{L("지금 실행", "Run now")}</span>{result.created_at ? shortStamp(result.created_at) : ""}{typeof result.elapsed_ms === "number" ? `, ${L(`${(result.elapsed_ms / 1000).toFixed(1)}초`, `${(result.elapsed_ms / 1000).toFixed(1)} s`)}` : ""}</>
          )}
        </small>
      )}
      {unreachable && (
        <p className="fm-live-fallback" role="alert">
          {L("연구 모델 서버에 연결하지 못했습니다.", "Could not reach the research model server.")}{" "}
          {recent && !showRecord && <button type="button" className="fm-link-button" onClick={() => setShowRecord(true)}>{L(`마지막 실제 실행 보기${recent.created_at ? ` (${shortStamp(recent.created_at)})` : ""}`, `Show the last real run${recent.created_at ? ` (${shortStamp(recent.created_at)})` : ""}`)}</button>}{" "}
          <button type="button" className="fm-link-button" onClick={() => { session.cancel("research.analysis"); void session.run("research.catalog", (signal) => getResearchVideoCatalog(farmId, signal), true); }}>{L("연결 다시 확인", "Check again")}</button>
        </p>
      )}
      {catalog && !canAnalyze && !unreachable && <p className="fm-hint">{L("연구 모델 연결을 확인하는 중입니다. 확인되지 않은 결과는 보여주지 않습니다.", "Checking the research model connection. Unconfirmed results are not shown.")}</p>}
      {catalog && !catalog.evidence_sets.length && <p className="fm-camera-empty">{L("등록된 연구 영상이 없습니다.", "No research videos registered.")}</p>}
      {error && <p role="alert">{error}</p>}
      <small className="fm-demo-cite">{L("공개 연구 영상(AIHub 다각도 CCTV)과 고정 질문입니다. 농장 상담이나 설비 조절의 근거로 쓰지 않습니다.", "Public research footage (AIHub multi-view CCTV) with a fixed question. Not used as grounds for farm advice or equipment control.")}</small>
      <ModuleTag
        id="video"
        diagram={result && decision ? {
          chosenCamera: selectedCamera && sample ? sample.camera_ids.indexOf(selectedCamera) : null,
          outcome: decision.kind === "failed" ? null : decision.kind,
        } : undefined}
        live={
          result && sample && decision
            ? L(`${name(selectedCamera)}를 근거 화면으로 골랐고, 판단은 "${decision.title}"입니다.`, `Picked ${name(selectedCamera)} as the evidence view. The decision is "${decision.title}".`)
            : L("버튼을 누르면 후보 카메라마다 근거가 보이는지 점수를 매겨 하나를 고릅니다.", "Press the button to score how well each candidate camera shows the evidence and pick one.")
        }
      />
    </section>
  );
}

function PatrolSection({ farmId, patrol, zoneLabel }: { farmId: FarmId; patrol: PatrolRuntime; zoneLabel: (id?: string | null) => string }) {
  const session = useVideoSession();
  const [mutation] = useVideoValue<VideoRequest<PatrolEvent>>("events.mutation", { status: "idle" });
  const [openId, setOpenId] = useState<string | null>(null);
  const busy = mutation.status === "loading";
  const disabled = patrol.error?.includes("(404)") ?? false;
  const error = videoErrorMessage(mutation.error) || (disabled ? "" : videoErrorMessage(patrol.error));
  const current = patrol.events.find((e) => e.id === openId) ?? null;
  const open = openPatrolCount(patrol.events);
  function change(event: PatrolEvent, operation: "brief" | "resolve", body: object) {
    return session.run("events.mutation", async (signal) => {
      const updated = await patrolRequest(farmId, `/${event.id}/${operation}`, body, signal);
      if (!signal.aborted) {
        const latest = session.read<VideoRequest<PatrolEvent[]>>("events.catalog")?.value ?? [];
        session.write("events.catalog", { status: "ready", value: [updated, ...latest.filter((e) => e.id !== updated.id)] });
        setOpenId(updated.id);
      }
      return updated;
    }, true);
  }
  void zoneLabel;
  const nothing = disabled || (patrol.status === "ready" && !patrol.events.length);
  if (nothing) {
    return (
      <details className="fm-camera-section fm-camera-fold" id="fm-patrol">
        <summary>{L("카메라 확인 기록 0건", "0 camera check records")}</summary>
        <p className="fm-note">
          {disabled ? L("영상 관제 기능이 꺼져 있습니다. 녹화 자료와 분석 모델을 연결하면 사건 기록이 여기에 표시됩니다.", "Video monitoring is off. Connect recordings and an analysis model to see event records here.") : L("확인할 카메라 기록이 없습니다. 접수된 사건마다 브리핑을 읽고 현장 확인 결과를 남깁니다.", "No camera records to check. For each event, read the briefing and record what you found on site.")}
        </p>
        {!disabled && (
          <button type="button" disabled={busy || patrol.status === "loading"} onClick={() => void patrol.reload()}>
            {L("새로고침", "Refresh")}
          </button>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    );
  }
  return (
    <section className="fm-camera-section fm-patrol" id="fm-patrol" aria-labelledby="fm-patrol-title">
      <div className="fm-camera-head">
        <div>
          <small className="fm-eyebrow">{L("관제 기록", "Monitoring records")}</small>
          <h2 id="fm-patrol-title">{L("카메라 확인 기록", "Camera check records")}{open ? L(` (확인 필요 ${open}건)`, ` (${open} to check)`) : ""}</h2>
        </div>
        {!disabled && (
          <button type="button" disabled={busy || patrol.status === "loading"} onClick={() => void patrol.reload()}>
            {L("새로고침", "Refresh")}
          </button>
        )}
      </div>
      {patrol.status === "loading" && !patrol.events.length && <p role="status">{L("기록 확인 중…", "Checking records…")}</p>}
      {patrol.events.length > 0 && (
        <div className="fm-patrol-list">
          {patrol.events.map((event) => (
            <div key={event.id}>
              <button
                type="button"
                className={`fm-patrol-row ${event.status}`}
                aria-expanded={openId === event.id}
                onClick={() => setOpenId(openId === event.id ? null : event.id)}
              >
                <strong>{eventTitle(event)}</strong>
                <span>{event.camera_id}, {L("접수", "received")} {formatSensorUpdateTime(event.created_at)}, {isCameraEvent(event) ? (event.synthetic ? L("AI 카메라 판독, 예시 영상", "AI camera reading, example video") : L("AI 카메라 판독", "AI camera reading")) : event.source === "test_event" ? L("검증용 기록", "test record") : L("녹화 검토", "recording review")}</span>
                <em>{patrolStatusLabel(event.status)}</em>
              </button>
              {current?.id === event.id && isCameraEvent(current) && (
                <div className="fm-patrol-detail">
                  {current.analysis?.video_url && <FeedVideo farmId={farmId} path={current.analysis.video_url} controls label={eventTitle(current)} />}
                  <h3>{L("AI 판독", "AI reading")}</h3>
                  <p>{eventText(current)}</p>
                  {current.analysis && current.analysis.frame_urls.length > 0 && (
                    <div className="fm-frames fm-frames-three">
                      {current.analysis.frame_urls.map((path, i) => <figure key={path}><FeedImage farmId={farmId} path={path} alt={L(`근거 화면 ${i + 1}`, `Evidence frame ${i + 1}`)} /></figure>)}
                    </div>
                  )}
                  {current.status !== "resolved" && (
                    <div className="fm-patrol-actions">
                      {outcomesFor(current.check_id).map((o) => <button key={o.outcome} type="button" disabled={busy} onClick={() => void change(current, "resolve", { outcome: o.outcome })}>{o.label}</button>)}
                    </div>
                  )}
                  <h4>{L("처리 기록", "Handling log")}</h4>
                  <ol>
                    {current.history.map((h, index) => (
                      <li key={index}><time dateTime={h.at}>{formatSensorUpdateTime(h.at)}</time>: {patrolHistoryLabel(h.label)}</li>
                    ))}
                  </ol>
                </div>
              )}
              {current?.id === event.id && !isCameraEvent(current) && (
                <div className="fm-patrol-detail">
                  <p className="fm-note">{L(`녹화 구간 ${current.start_seconds}–${current.end_seconds}초. 지정 구간에 연결한 테스트 입력이며 감시 영역 진입을 측정한 결과가 아닙니다.`, `Recording segment ${current.start_seconds}–${current.end_seconds} s. A test input linked to a chosen segment, not a measured entry into the monitored area.`)}</p>
                  <AuthenticatedMedia key={current.id} farmId={farmId} path={`/v1/video/media/${current.clip_id}`} startSeconds={current.start_seconds} endSeconds={current.end_seconds} />
                  <h3>{L("브리핑", "Briefing")}</h3>
                  <PatrolProgress event={current} />
                  <PatrolBrief content={current.analysis?.answer ?? L("브리핑을 요청하면 확인 결과가 여기에 표시됩니다.", "Request a briefing to see the check result here.")} />
                  {current.analysis && (
                    <small className="fm-note">
                      {current.analysis.decision === "answer" ? L("화면 근거 있음", "Frame evidence found") : current.analysis.decision === "abstain" ? L("근거 부족", "Not enough evidence") : L("분석 불가", "Analysis unavailable")}. {L("신원·출입 권한은 사람이 확인합니다.", "A person verifies identity and access rights.")}
                    </small>
                  )}
                  {current.analysis && current.analysis.frame_urls.length > 0 && (
                    <details>
                      <summary>{L("근거 화면 보기", "Show evidence frames")}</summary>
                      <div className="fm-frames fm-frames-three">
                        {current.analysis.frame_urls.map((path) => <AuthenticatedMedia key={path} farmId={farmId} path={path} image />)}
                      </div>
                    </details>
                  )}
                  {current.status !== "resolved" && (
                    <div className="fm-patrol-actions">
                      <button type="button" disabled={busy} onClick={() => void change(current, "brief", {})}>{L("브리핑 요청", "Request briefing")}</button>
                      <button type="button" disabled={busy} onClick={() => void change(current, "resolve", { outcome: "reviewing" })}>{L("현장 확인 중", "Checking on site")}</button>
                      <button type="button" disabled={busy} onClick={() => void change(current, "resolve", { outcome: "authorized" })}>{L("허가된 출입", "Authorized entry")}</button>
                      <button type="button" disabled={busy} onClick={() => void change(current, "resolve", { outcome: "false_alarm" })}>{L("오탐", "False alarm")}</button>
                      <button type="button" disabled={busy} onClick={() => void change(current, "resolve", { outcome: "handled" })}>{L("현장 조치 완료", "Handled on site")}</button>
                    </div>
                  )}
                  <h4>{L("처리 기록", "Handling log")}</h4>
                  <ol>
                    {current.history.map((h, index) => (
                      <li key={index}><time dateTime={h.at}>{formatSensorUpdateTime(h.at)}</time>: {patrolHistoryLabel(h.label)}</li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>{L("이 기록 설명", "About these records")}</summary>
        <p>{L("접수된 사건마다 브리핑을 읽고 현장 확인 결과를 남깁니다. 사람이 화면에서 사라져도 확인 전에는 경고를 유지하고, 자동 신고나 장치 제어는 하지 않습니다.", "For each event, read the briefing and record what you found on site. The warning stays until checked even if the person leaves the frame. Nothing is reported or controlled automatically.")}</p>
      </details>
    </section>
  );
}

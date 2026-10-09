import { useEffect, useState } from "react";
import type { FarmId } from "../types";
import { askCamera, getCameraSegments, patrolRequest } from "../video-api";
import type { CameraFeed, CameraSegment, PatrolEvent } from "../video-api";
import { AiMark } from "./AiBrief";
import { videoErrorMessage } from "./camera-state";
import { checkBadge, checkTitle, eventText, eventTitle, feedHeadline, feedTitle, openCameraEvents, outcomesFor, readingNote, rowText } from "./camera-feeds";
import { MULTIVIEW_FOCUS } from "./demo-cameras";
import type { DemoCameraManifest } from "./demo-cameras";
import { Multiview } from "./DemoCameras";
import { FeedImage, FeedVideo } from "./FeedMedia";
import { L } from "./i18n";
import { shortStamp, stamp } from "./time-format";
import type { CameraFeedsRuntime } from "./useCameraFeeds";
import type { PatrolRuntime } from "./usePatrolEvents";

const box = (b: number[]) => ({ left: `${b[0] * 100}%`, top: `${b[1] * 100}%`, width: `${b[2] * 100}%`, height: `${b[3] * 100}%` });

/**
 * The farm's cameras as a monitoring service shows them: every camera plays
 * what it sent last, and under it the AI's one line about it. Nobody asks
 * anything here: the server receives each camera every few minutes and the AI
 * reads a segment when the scene changed. What a person should look at is a
 * record with its evidence frames, closed with one button.
 */
export function CameraFeeds({ farmId, feeds, patrol, focus, onAsk, zoneLabel, manifest }: {
  farmId: FarmId;
  feeds: CameraFeedsRuntime;
  patrol: PatrolRuntime;
  focus?: string | null;
  onAsk: (question: string, zoneId: string, bedId?: string | null) => void;
  zoneLabel: (id?: string | null) => string;
  manifest: DemoCameraManifest | null;
}) {
  const cameras = feeds.live ?? [];
  const [selected, setSelected] = useState<string | null>(focus && focus !== MULTIVIEW_FOCUS ? focus : null);
  const [history, setHistory] = useState<CameraSegment[] | null>(null);
  const [picked, setPicked] = useState<CameraSegment | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const camera = cameras.find((c) => c.id === selected) ?? cameras[0];
  useEffect(() => { if (focus && focus !== MULTIVIEW_FOCUS) setSelected(focus); }, [focus]);
  useEffect(() => { setHistory(null); setPicked(null); }, [camera?.id]);
  useEffect(() => {
    if (focus !== MULTIVIEW_FOCUS) return;
    const id = requestAnimationFrame(() => document.querySelector(".fm-mv")?.scrollIntoView({ block: "start", behavior: "smooth" }));
    return () => cancelAnimationFrame(id);
  }, [focus]);
  if (!camera) return null;
  const shown = picked ?? camera.latest;
  const reading = shown?.reading ?? null;
  const rows = reading && (reading.status === "read" || reading.status === "unchanged") ? reading.checks : [];
  const headline = feedHeadline(picked ? { ...camera, latest: picked, open_events: 0 } : camera);
  const records = openCameraEvents(patrol.events).filter((e) => e.camera_id === camera.id);
  const synthetic = cameras.some((c) => c.synthetic);
  const minutes = Math.max(1, Math.round((feeds.list?.interval_seconds ?? 120) / 60));
  const seconds = feeds.list?.segment_seconds ?? 10;

  async function close(event: PatrolEvent, outcome: string) {
    setBusy(true);
    setError("");
    try {
      await patrolRequest(farmId, `/${event.id}/resolve`, { outcome });
      await Promise.all([patrol.reload(), feeds.reload()]);
    } catch (e) {
      setError(videoErrorMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }
  async function loadHistory() {
    if (history) return;
    try {
      setHistory(await getCameraSegments(farmId, camera.id, AbortSignal.timeout(10000)));
    } catch (e) {
      setError(videoErrorMessage(e instanceof Error ? e.message : String(e)));
    }
  }
  const latestOf = (id: string) => cameras.find((c) => c.id === id)?.latest ?? null;
  const multiview = (manifest?.multiview ?? []).filter((m) => m.candidates.every((c) => latestOf(c.camera_id)));

  return (
    <section className="fm-camera-section fm-demo-cams fm-feeds" aria-labelledby="fm-feeds-title">
      <div className="fm-camera-head">
        <div>
          <h2 id="fm-feeds-title">{L("농장 카메라", "Farm cameras")}</h2>
          <p className="fm-demo-note">
            {synthetic && (
              <span className="fm-badge is-info" title={L("이 농장에는 카메라가 없어, 예시 카메라 사진을 첫 장면으로 영상 생성 AI가 만든 장면을 카메라처럼 스트림으로 보내고 이 시스템이 받아 판독합니다. 이 농장의 실제 녹화가 아닙니다.", "This farm has no cameras: scenes a video generation AI made from the example camera stills are streamed like cameras, and this system receives and reads them. They are not recordings from this farm.")}>
                {L("예시 영상(생성)", "Example video (generated)")}
              </span>
            )}
            <span>{L(`${cameras.length}대, ${minutes}분마다 ${seconds}초씩 받아 장면이 바뀌면 AI가 판독`, `${cameras.length} cameras; ${seconds} s received every ${minutes} min, read by the AI when the scene changes`)}</span>
          </p>
        </div>
      </div>
      <div className="fm-demo-grid fm-feed-grid" role="list">
        {cameras.map((c) => {
          const h = feedHeadline(c);
          return (
            <button type="button" role="listitem" key={c.id} className={`fm-demo-card fm-feed-card ${c.id === camera.id ? "is-selected" : ""}`} aria-pressed={c.id === camera.id} onClick={() => setSelected(c.id)}>
              <span className="fm-feed-thumb">
                <FeedVideo farmId={farmId} path={c.latest?.video_url ?? null} label={feedTitle(c)} />
                <em className={`fm-badge is-${h.tone}`}>{h.label}</em>
                {c.latest && <time className="fm-feed-time" dateTime={c.latest.recorded_at}>{shortStamp(c.latest.recorded_at)}</time>}
              </span>
              <span className="fm-demo-card-meta">
                <strong>{feedTitle(c)}</strong>
                <small title={h.text}>{h.text}</small>
              </span>
            </button>
          );
        })}
      </div>


      <div className="fm-demo-detail">
        <figure className="fm-demo-frame fm-feed-frame">
          <FeedVideo farmId={farmId} path={shown?.video_url ?? null} controls label={feedTitle(camera)} />
          <span className="fm-demo-tag">{camera.id.toUpperCase()}</span>
          {shown && <figcaption className="fm-feed-caption">{L(`${stamp(shown.recorded_at)} 녹화 ${Math.round(shown.duration_seconds)}초`, `Recorded ${stamp(shown.recorded_at)}, ${Math.round(shown.duration_seconds)} s`)}{picked ? L(", 지난 녹화", ", earlier segment") : ""}</figcaption>}
        </figure>
        <div className="fm-demo-result">
          <div className="fm-demo-result-head">
            <strong><AiMark title={L("받은 영상을 AI가 판독합니다", "The AI reads what the camera sent")} />{feedTitle(camera)}</strong>
            <span className={`fm-badge is-${headline.tone}`}>{headline.label}</span>
          </div>
          {!rows.length && <p className="fm-feed-line">{headline.text}</p>}
          {reading && <small className="fm-live-meta">{readingNote(reading)}{reading.model ? L(", AI 에이전트", ", AI agent") : ""}</small>}
          {rows.length > 0 && (
            <ul className="fm-demo-questions">
              {rows.map((row) => {
                const badge = checkBadge(row);
                return (
                  <li key={row.id} className={row.needs_check ? "is-alert" : row.decision === "abstain" ? "is-abstain" : "is-answer"}>
                    <span className="fm-demo-qhead"><span className={`fm-badge is-${badge.tone}`}>{badge.label}</span><strong>{checkTitle(row.id)}</strong></span>
                    <span className="fm-demo-answer">{rowText(row)}</span>
                    {row.decision === "answer" && row.confidence !== null && <small>{L(`확신도 ${Math.round(row.confidence * 100)}% (모델이 밝힌 값)`, `Confidence ${Math.round(row.confidence * 100)}% (as stated by the model)`)}</small>}
                  </li>
                );
              })}
            </ul>
          )}

          {records.map((event) => (
            <article key={event.id} className="fm-feed-record">
              <header>
                <strong>{eventTitle(event)}</strong>
                <small>{L(`${shortStamp(event.created_at)} AI가 남긴 기록`, `Raised by the AI at ${shortStamp(event.created_at)}`)}</small>
              </header>
              {!rows.some((r) => rowText(r) === eventText(event)) && <p>{eventText(event)}</p>}
              {event.analysis && event.analysis.frame_urls.length > 0 && (
                <div className="fm-feed-evidence">
                  {event.analysis.frame_urls.slice(0, 3).map((path, i) => (
                    <figure key={path}>
                      <span className="fm-feed-shot">
                        <FeedImage farmId={farmId} path={path} alt={L(`근거 화면 ${i + 1}`, `Evidence frame ${i + 1}`)} />
                        {i === 0 && event.analysis?.box && <span className="fm-demo-box is-alert" style={box(event.analysis.box)} aria-hidden="true" />}
                      </span>
                      <figcaption>{L(`${(event.analysis?.frame_times?.[i] ?? 0).toFixed(1)}초`, `${(event.analysis?.frame_times?.[i] ?? 0).toFixed(1)} s`)}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
              <div className="fm-feed-actions">
                {outcomesFor(event.check_id).map((o, i) => (
                  <button key={o.outcome} className={i === 0 ? "fm-primary" : undefined} disabled={busy} onClick={() => void close(event, o.outcome)}>{o.label}</button>
                ))}
                {event.ask && camera.zone_id && <button disabled={busy} onClick={() => onAsk(event.ask!, camera.zone_id!, camera.bed_id)}>{L("AI에게 묻기", "Ask the AI")}</button>}
              </div>
            </article>
          ))}
          {error && <p role="alert">{error}</p>}

          <details className="fm-feed-history" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void loadHistory(); }}>
            <summary>{L("최근 녹화", "Recent segments")}</summary>
            {!history && <p role="status">{L("불러오는 중", "Loading")}</p>}
            {history && (
              <ol>
                {history.slice(0, 12).map((s) => {
                  const h = feedHeadline({ state: "receiving", latest: s, open_events: 0 });
                  const current = (picked?.id ?? camera.latest?.id) === s.id;
                  return (
                    <li key={s.id}>
                      <button aria-pressed={current} onClick={() => setPicked(s.id === camera.latest?.id ? null : s)}>
                        <time dateTime={s.recorded_at}>{shortStamp(s.recorded_at)}</time>
                        <span className={`fm-badge is-${h.tone}`}>{s.reading?.status === "unchanged" ? L("변화 없음", "No change") : h.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </details>
          <small className="fm-demo-cite">
            {camera.synthetic
              ? L("예시 영상(생성). 예시 카메라 사진을 첫 장면으로 영상 생성 AI가 만든 장면을 카메라 스트림으로 받아 판독합니다. 이 농장의 실제 녹화가 아닙니다.", "Example video (generated). A scene a video generation AI made from an example camera still, received as a camera stream and read. Not a recording from this farm.")
              : L("이 카메라의 녹화를 받아 판독합니다. 보이지 않는다고 이상이 없다고 판단할 수 없습니다.", "Segments from this camera are received and read. Not seeing something does not mean nothing is wrong.")}
          </small>
        </div>
      </div>

      {manifest && multiview.map((m) => (
        <Multiview
          key={m.id}
          farmId={farmId}
          m={m}
          cameras={manifest.cameras}
          onOpen={setSelected}
          busy={busy}
          setBusy={setBusy}
          zoneLabel={zoneLabel}
          read={(c, question, lang, location) => askCamera(farmId, { camera_id: c.id, question, lang, location })}
          frameOf={(c, result) => {
            const latest = latestOf(c.id);
            const path = (result as { frame_url?: string } | undefined)?.frame_url ?? latest?.frames[Math.floor((latest?.frames.length ?? 1) / 2)]?.url;
            return path ? <FeedImage farmId={farmId} path={path} alt="" /> : null;
          }}
        />
      ))}
    </section>
  );
}

/** A camera that watches the bed in the open panel: its live picture and the AI's one line. */
export function BedCamera({ farmId, feed, onOpen }: { farmId: FarmId; feed: CameraFeed; onOpen: () => void }) {
  const h = feedHeadline(feed);
  return (
    <button type="button" className={`fm-bed-camera is-${h.tone}`} onClick={onOpen} aria-label={L(`${feedTitle(feed)} 카메라 화면 보기`, `Open the ${feedTitle(feed)} camera`)}>
      <span className="fm-feed-thumb">
        <FeedVideo farmId={farmId} path={feed.latest?.video_url ?? null} label={feedTitle(feed)} />
        {feed.synthetic && <em className="fm-badge is-info">{L("예시 영상", "Example")}</em>}
      </span>
      <span>
        <strong><AiMark />{feedTitle(feed)}</strong>
        <span className={`fm-badge is-${h.tone}`}>{h.label}</span>
        <small>{h.text}</small>
      </span>
    </button>
  );
}

import { L } from "../farmer/i18n";
import { findPost, requestKey, seriesIndex, shiftTimes } from "./replay-core";
import type { ReplayEntry, ReplayManifest } from "./replay-core";

/**
 * The recorded-replay demo: a static build (VITE_DEMO_STATIC=1) that answers
 * every API request in the browser from what the API answered while the
 * dashboard was recorded (demo-data/, written by tools/demo/capture.cjs).
 *
 * - Reads come back with their recorded times moved to now; the responses the
 *   dashboard polls are a recorded sequence played in a loop, so values move.
 * - A question, a camera question or a research run that was asked while
 *   recording gets its recorded answer; anything else is said to be outside
 *   the recording.
 * - A device change, closing a camera record and marking an alert seen are
 *   kept in this browser only; every other write is refused with a notice.
 *
 * Nothing reaches a server or an AI model, and no key is in the build.
 */

export type ReplayInfo = { capturedAt: string; sourceCommit: string };
declare global {
  interface Window { __smartfarmReplay?: ReplayInfo }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const refuse = () => json({ detail: L("공개 데모는 기록된 운영 데이터를 재생하며, 저장하거나 설비에 명령을 보내지 않습니다.", "This public demo replays recorded operation data; it saves nothing and sends no command to any device.") }, 403);
const notRecorded = () => json({ detail: L("공개 데모의 기록에 없는 요청입니다.", "This request is not in the demo's recording.") }, 404);
const notAsked = (advisor: boolean) => json({
  detail: advisor
    ? L("공개 데모는 실제 AI에 연결되어 있지 않아, 기록해 둔 추천 질문에만 답합니다. 입력창 위의 추천 질문을 눌러 보세요.", "This public demo is not connected to an AI model and answers only its recorded suggested questions. Try one of the suggestions above the input.")
    : L("공개 데모는 실제 AI에 연결되어 있지 않아, 기록해 둔 실행만 재생합니다.", "This public demo is not connected to an AI model and replays only recorded runs."),
}, 409);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export async function installReplay(): Promise<ReplayInfo | null> {
  const root = `${import.meta.env.BASE_URL}demo-data/`;
  const native = window.fetch.bind(window);
  const manifest: ReplayManifest | null = await native(`${root}manifest.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!manifest) return null;
  const apiPath = new URL(`${(import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "")}/`, window.location.href).pathname;
  const opened = Date.now();
  const captured = Date.parse(manifest.captured_at);
  const texts = new Map<string, Promise<string>>();
  const read = (file: string) => {
    if (!texts.has(file)) texts.set(file, native(root + file).then((r) => { if (!r.ok) throw new Error(file); return r.text(); }));
    return texts.get(file)!;
  };

  // What was done in this browser on top of the recording.
  const asked = new Set<string>(manifest.advisor?.base_turns ?? []);
  const resolved = new Map<string, { outcome: string; at: string; cameraId: string }>();
  const acknowledged = new Map<string, string>();
  const controls: Json[] = [];

  const shifted = async (entry: ReplayEntry, recordedAt = captured) => {
    const text = await read(entry.file);
    const kind = entry.shift ?? "time";
    return kind === "none" ? text : shiftTimes(text, Date.now() - recordedAt, kind === "time+date");
  };

  /** The browser's own changes laid over a recorded response. */
  function overlay(path: string, data: Json): Json {
    if (path === "/v1/dashboard/snapshot" && Array.isArray(data.actuator_states)) {
      for (const c of controls) {
        const device = data.actuator_states.find((a: Json) => a.target === c.target && a.zone_id === c.zone_id);
        if (!device) continue;
        Object.assign(device, { desired_value: c.value, reported_value: c.value, effective_value: c.value, state: c.value === false || c.value === 0 ? "off" : "on" });
      }
    }
    if (path === "/v1/control-proposals" && Array.isArray(data.proposals)) data.proposals = [...controls].reverse().concat(data.proposals);
    if (path === "/v1/video/events" && Array.isArray(data.events)) {
      for (const e of data.events) {
        const r = resolved.get(e.id);
        if (r) Object.assign(e, { status: "resolved", outcome: r.outcome, history: [...(e.history ?? []), { at: r.at, label: { authorized: "허가된 출입", false_alarm: "오탐", handled: "현장 조치 완료", reviewing: "현장 확인 중" }[r.outcome] ?? r.outcome }] });
      }
    }
    if (path === "/v1/video/cameras" && Array.isArray(data.cameras)) {
      for (const c of data.cameras) c.open_events = Math.max(0, (c.open_events ?? 0) - [...resolved.values()].filter((r) => r.cameraId === c.id).length);
    }
    if (path === "/v1/operations/cases" && Array.isArray(data.cases)) {
      for (const c of data.cases) if (acknowledged.has(c.incident_id)) c.acknowledged_at = acknowledged.get(c.incident_id);
    }
    if (manifest!.advisor && path === manifest!.advisor.session_key && Array.isArray(data.turns)) {
      data.turns = data.turns.filter((t: Json) => asked.has(String(t.client_turn_id ?? t.id)));
      data.turn_count = data.turns.length;
    }
    return data;
  }

  async function get(path: string, search: string): Promise<Response> {
    const key = requestKey(path, search);
    const series = manifest!.series[key];
    if (series) {
      const i = seriesIndex(Date.now() - opened, series.interval_ms, series.files.length);
      const text = await shifted({ file: series.files[i], shift: series.shift }, Date.parse(series.times[i]));
      return json(overlay(path, JSON.parse(text)));
    }
    const pattern = manifest!.patterns?.find((x) => new RegExp(x.re).test(path));
    const empty = manifest!.fallback?.[path];
    const entry = manifest!.get[key] ?? manifest!.get[path] ?? (pattern ? { file: pattern.file, type: pattern.type, shift: "none" as const } : empty ? { file: empty, shift: "none" as const } : null);
    if (!entry) return notRecorded();
    if (entry.type && !entry.type.includes("json")) {
      const blob = await native(root + entry.file).then((r) => r.blob());
      return new Response(blob, { status: entry.status ?? 200, headers: { "Content-Type": entry.type } });
    }
    const text = await shifted(entry);
    return json(overlay(path, JSON.parse(text)), entry.status ?? 200);
  }

  async function write(method: string, path: string, search: string, body: Json | null): Promise<Response> {
    // A device change: applied in this browser, in the shape of a recorded execution.
    if (method === "POST" && path === "/v1/control-proposals" && body && manifest!.control_template) {
      const template = JSON.parse(await read(manifest!.control_template)) as Json;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const value = body.value;
      const proposal = {
        ...template, id, action: body.action, target: body.target, zone_id: body.zone_id ?? null, value, rationale: body.rationale ?? template.rationale,
        status: "approved", created_at: now, approved_at: now, origin: body.origin ?? null, alert_id: body.alert_id ?? null,
        execution: { ...template.execution, status: "applied_to_simulator", zone_id: body.zone_id ?? null, executed_at: now, execution_id: `demo-${id}`, failure_reason: null },
        verification: { ...template.verification, status: "verified", outcome: "device_applied", checked_at: now, requested_value: value, target_state: value === false || value === 0 ? "off" : "on" },
      };
      controls.push(proposal);
      return json(proposal);
    }
    const resolve = path.match(/^\/v1\/video\/events\/([A-Za-z0-9]+)\/resolve$/);
    if (method === "POST" && resolve && body) {
      const events = JSON.parse(await shifted(manifest!.get["/v1/video/events"] ?? { file: "", shift: "none" }).catch(() => '{"events":[]}')) as Json;
      const event = (events.events ?? []).find((e: Json) => e.id === resolve[1]);
      if (!event) return notRecorded();
      resolved.set(event.id, { outcome: String(body.outcome), at: new Date().toISOString(), cameraId: String(event.camera_id) });
      return json(overlay("/v1/video/events", { events: [event] }).events[0]);
    }
    const ack = path.match(/^\/v1\/operations\/cases\/([^/]+)\/acknowledge$/);
    if (method === "POST" && ack) {
      acknowledged.set(decodeURIComponent(ack[1]), new Date().toISOString());
      return json({ incident_id: decodeURIComponent(ack[1]), acknowledged_at: acknowledged.get(decodeURIComponent(ack[1])) });
    }
    if (method === "POST" && path === "/v1/advisor/sessions") {
      const list = JSON.parse(await shifted(manifest!.get["/v1/advisor/sessions"])) as Json;
      return json(list.sessions?.[0] ?? {});
    }
    // A run recorded with the same request: its recorded answer.
    const recorded = findPost(manifest!.posts, method, path, body);
    if (recorded) {
      const text = await shifted({ file: recorded.file, shift: recorded.shift }, Date.parse(recorded.recorded_at));
      const data = JSON.parse(text) as Json;
      // The recorded turn this question made joins the conversation the dashboard reads.
      const turn = (recorded.body as Json | null)?.client_turn_id;
      if (path === "/v1/advisor/questions" && turn) asked.add(String(turn));
      return json(data, recorded.status);
    }
    const replayable = ["/v1/advisor/questions", "/v1/video/cameras/ask", "/v1/research/answer-review/run", "/v1/research/answer-review/baseline", "/v1/video/research/analyses", "/v1/controls/preview"];
    if (method === "POST" && (replayable.includes(path) || /^\/v1\/advisor\/sessions\/[^/]+\/recheck$/.test(path))) return notAsked(path === "/v1/advisor/questions");
    void search;
    return refuse();
  }

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(apiPath)) return native(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const path = `/${url.pathname.slice(apiPath.length)}`;
    let body: Json | null = null;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body) as Json; } catch { body = null; }
    }
    try {
      return method === "GET" ? await get(path, url.search) : await write(method, path, url.search, body);
    } catch {
      return notRecorded();
    }
  };
  const info = { capturedAt: manifest.captured_at, sourceCommit: manifest.source_commit };
  window.__smartfarmReplay = info;
  return info;
}

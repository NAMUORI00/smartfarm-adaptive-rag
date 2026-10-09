/**
 * The recorded-replay demo (a static build for GitHub Pages): what the API
 * answered while the dashboard was used, played back in the browser. These are
 * the pure parts: how a request is named, how recorded times are moved to now,
 * which frame of a recorded sequence is current, and how a question is matched.
 */

/** When a recorded answer's times are moved to now: never, its timestamps, or its dates too. */
export type ShiftKind = "none" | "time" | "time+date";

export type ReplayEntry = { file: string; shift?: ShiftKind; type?: string; status?: number };
export type ReplaySeries = { files: string[]; times: string[]; interval_ms: number; shift?: ShiftKind };
export type ReplayPost = { method: string; path: string; body: Record<string, unknown> | null; file: string; status: number; shift?: ShiftKind; recorded_at: string };

export type ReplayManifest = {
  version: 1;
  captured_at: string;
  source_commit: string;
  farm_id: string;
  /** GET responses by request key (`requestKey`). */
  get: Record<string, ReplayEntry>;
  /** Responses the dashboard polls, recorded as a sequence and played in a loop. */
  series: Record<string, ReplaySeries>;
  /** Writes made while recording, with what the server answered. */
  posts: ReplayPost[];
  advisor: {
    /** The conversation the dashboard reads (its newest session). */
    session_key: string;
    /** Turns (client_turn_id) shown from the start; the others appear when their question is asked. */
    base_turns: string[];
  } | null;
  /** A real control execution used as the shape of the ones made in the browser. */
  control_template: string | null;
  /** An empty answer for a path whose query the recording cannot know (a search typed in the demo). */
  fallback?: Record<string, string>;
  /** Files served for every path matching a pattern (a placeholder for frames not redistributed). */
  patterns?: { re: string; file: string; type: string }[];
};

/** A request's name: its path and its query, sorted, without empty values. */
export function requestKey(path: string, search: string | URLSearchParams = ""): string {
  const params = new URLSearchParams(search);
  const pairs = [...params.entries()].filter(([, v]) => v !== "").sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  const query = new URLSearchParams(pairs).toString();
  return query ? `${path}?${query}` : path;
}

const ISO_TIME = /"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))"/g;
const ISO_DATE = /"(\d{4}-\d{2}-\d{2})"/g;
const DAY = 86_400_000;

/** Every timestamp value in a JSON text moved by `deltaMs`; with `dates`, date-only values move by whole days. */
export function shiftTimes(text: string, deltaMs: number, dates = false): string {
  if (!deltaMs) return text;
  let out = text.replace(ISO_TIME, (whole, iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? `"${new Date(t + deltaMs).toISOString()}"` : whole;
  });
  const days = Math.round(deltaMs / DAY);
  if (dates && days) {
    out = out.replace(ISO_DATE, (whole, day: string) => {
      const t = Date.parse(`${day}T00:00:00Z`);
      return Number.isFinite(t) ? `"${new Date(t + days * DAY).toISOString().slice(0, 10)}"` : whole;
    });
  }
  return out;
}

/** The frame of a looping recorded sequence that is current `elapsedMs` after the page opened. */
export function seriesIndex(elapsedMs: number, intervalMs: number, count: number): number {
  if (count <= 0) return -1;
  return Math.floor(Math.max(0, elapsedMs) / Math.max(1, intervalMs)) % count;
}

/** A question as typed or as a suggestion sends it, for matching: spaces and end punctuation do not count. */
export function normalizeQuestion(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().replace(/[?.!。？]+$/, "").toLowerCase();
}

/** Fields of a request body that change on every request (ids, idempotency) and are not part of what was asked. */
const VOLATILE = new Set(["request_id", "client_request_id", "client_turn_id", "idempotency_key", "requested_at"]);

/** A body's stable form: keys sorted, volatile fields dropped, questions normalized. */
export function stableBody(body: unknown): string {
  const walk = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => !VOLATILE.has(k))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, walk(v, k)]),
      );
    }
    if (typeof value === "string" && (key === "question" || key === "query")) return normalizeQuestion(value);
    return value;
  };
  return JSON.stringify(walk(body ?? null));
}

/** The recorded write that answers this one: the same path and the same stable body. */
export function findPost(posts: ReplayPost[], method: string, path: string, body: unknown): ReplayPost | null {
  const wanted = stableBody(body);
  return posts.find((p) => p.method === method && p.path === path && stableBody(p.body) === wanted) ?? null;
}

import { farmRequest } from "../farm-spatial";
import type { ControlTarget, FarmId } from "../types";
import type { ReviewRun } from "./how-it-works";
import type { HarvestPeriod } from "./harvest-periods";

/**
 * The farmer-assist endpoints: read-only helpers around the advisor and the
 * device boundary. Every answer that interprets something carries
 * `reference_only`, and the screen shows it as reference.
 */
/** A sentence copied from a guide; `source_id` is its document, and with `chunk_id` the reader opens it in place. */
export type Passage = { sentence: string; source_id: string; document_id?: string; chunk_id?: string | null; title: string; location: string | null; source_url: string | null };
/** "고추냉이 재배 기술 자료 · 42쪽": the page is named once, when the title does not already carry it. */
export const passageSource = (p: Pick<Passage, "title" | "location">) => (p.location && !p.title.includes(p.location) ? `${p.title}, ${p.location}` : p.title);

export type ControlPreview = {
  target: ControlTarget;
  zone_id: string;
  device_label: string;
  action_label: string;
  target_value: number | boolean;
  unit: string | null;
  current: { requested: unknown; reported: unknown; effective: unknown; health: string | null } | null;
  expected_effects: string[];
  related_metrics: { key: string; label: string; value: number | string; unit: string; status: string; quality?: string }[];
  requires_operator_approval: true;
  execution_performed: false;
};
export type MetricReference = { metric: string; label: string; query: string; passages: Passage[]; routing_mode: string | null; reference_only: true };
export type RecordDraft = {
  draft: { kind: "harvest" | "observation" | null; bed_id: string | null; tier: number | null; weight_kg: number | null; removed_count: number | null; growth_percent: number | null; note: string | null };
  missing: string[];
  message: string | null;
  parser: "local" | "llm";
  reference_only: true;
};
export type DiseaseWatch = {
  zones: { zone_id: string; conditions: { id: string; metric: string; label: string; hours: number; threshold: number; observed_max: number; passages: Passage[] }[] }[];
  window_hours: number;
  reference_only: true;
};
export type PhotoCheck = {
  decision: "answer" | "abstain";
  findings: { text: string; confidence: number }[];
  abstentions: { question: string; reason: string }[];
  /** The symptom words the guides were searched with ("황변"), for a short follow-up question. */
  symptoms?: string[];
  passages: Passage[];
  model: string | null;
  reference_only: true;
};
export type HarvestGuide = {
  cycle_id: string;
  planted_on: string | null;
  harvest_part?: string | null;
  /** Every period a sentence states, dated from planting; `for_harvest` when it can be read as this cycle's harvest time. */
  passages: (Passage & { periods?: HarvestPeriod[]; for_harvest?: boolean })[];
  reference_only: true;
};
export type WeatherForecast =
  | { configured: false }
  | { configured: true; available: false; reason?: string; location?: FarmLocation }
  | { configured: true; available: true; label: string; latitude: number; longitude: number; location?: FarmLocation; days: { date: string; t_max: number | null; t_min: number | null; precip_mm: number | null; rh_max: number | null }[]; source: string; fetched_at: string; reference_only: true };
export type FarmLocation = { label: string; latitude: number; longitude: number };

const base = () => (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
const headers = (farmId: FarmId) => ({ "X-Demo-Token": import.meta.env.VITE_DEMO_TOKEN ?? "demo-admin", "X-Farm-Context": farmId });

async function send<T>(farmId: FarmId, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${base()}${path}`, { ...init, headers: { ...headers(farmId), ...(init.headers ?? {}) } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const detail = typeof error.detail === "string" ? error.detail : `HTTP ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status });
  }
  return response.json() as Promise<T>;
}

export const previewControl = (farmId: FarmId, body: { target: ControlTarget; zone_id: string; value: number | boolean }, signal?: AbortSignal) =>
  farmRequest<ControlPreview>(farmId, "/v1/controls/preview", body, signal);
export const metricReference = (farmId: FarmId, metric: string, signal?: AbortSignal) =>
  farmRequest<MetricReference>(farmId, `/v1/knowledge/metric-reference?metric=${encodeURIComponent(metric)}`, undefined, signal);
export const parseRecord = (farmId: FarmId, body: { text: string; bed_id?: string; tier?: number; allow_remote?: boolean }) =>
  farmRequest<RecordDraft>(farmId, "/v1/cultivation/parse", body);
export const diseaseWatch = (farmId: FarmId, signal?: AbortSignal) =>
  farmRequest<DiseaseWatch>(farmId, "/v1/advisor/disease-watch", undefined, signal);
export const harvestGuide = (farmId: FarmId, cycleId: string, signal?: AbortSignal) =>
  farmRequest<HarvestGuide>(farmId, `/v1/knowledge/harvest-guide?cycle_id=${encodeURIComponent(cycleId)}`, undefined, signal);
export const weatherForecast = (farmId: FarmId, signal?: AbortSignal) =>
  farmRequest<WeatherForecast>(farmId, "/v1/weather/forecast", undefined, signal);
export const saveFarmLocation = (farmId: FarmId, location: FarmLocation) =>
  send<unknown>(farmId, "/v1/system/farm-location", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(location) });
export const getAiPrivacy = (farmId: FarmId) => farmRequest<{ allow_private_remote: boolean }>(farmId, "/v1/system/ai-privacy");
export const setAiPrivacy = (farmId: FarmId, allow: boolean) =>
  send<{ allow_private_remote: boolean }>(farmId, "/v1/system/ai-privacy", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allow_private_remote: allow }) });
export function photoCheck(farmId: FarmId, image: File, extra: { zone_id?: string | null; bed_id?: string | null; note?: string }) {
  const form = new FormData();
  form.append("image", image);
  form.append("consent", "true");
  if (extra.zone_id) form.append("zone_id", extra.zone_id);
  if (extra.bed_id) form.append("bed_id", extra.bed_id);
  if (extra.note) form.append("note", extra.note);
  return send<PhotoCheck>(farmId, "/v1/advisor/photo-check", { method: "POST", body: form });
}
/** One example camera frame read now by the AI: an answer from what it shows, or an abstention with the reason. */
export type LiveCameraAnswer = {
  decision: "answer" | "abstain";
  /** Whether the asked-about condition is in the frame (answers only). */
  present: boolean | null;
  answer: string | null;
  reason: string;
  confidence: number;
  box: [number, number, number, number] | null;
  camera_id: string;
  question: string;
  model: string;
  elapsed_ms: number;
  analyzed_at: string;
};
const frames = new Map<string, Promise<Blob>>();
/** The shipped example frame, sent as is: the server reads only those exact files. */
export async function analyzeDemoCamera(farmId: FarmId, camera: { id: string; image: string }, question: string, lang: string, location?: string, signal?: AbortSignal) {
  if (!frames.has(camera.image)) {
    frames.set(camera.image, fetch(camera.image).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.blob(); }));
  }
  const image = await frames.get(camera.image)!.catch((e) => { frames.delete(camera.image); throw e; });
  const form = new FormData();
  form.append("image", image, `${camera.id}.jpg`);
  form.append("camera_id", camera.id);
  form.append("question", question);
  form.append("lang", lang);
  if (location) form.append("location", location);
  return send<LiveCameraAnswer>(farmId, "/v1/video/demo-cameras/analyze", { method: "POST", body: form, signal });
}

/** What the advisor searches, counted: guides, their pages or sections, passages and relations, by kind of source. */
export type KnowledgeComposition = {
  guides: number;
  documents: number;
  chunks: number;
  vectors: number;
  graph_nodes: number;
  graph_edges: number;
  by_kind: { evidence_class: string; guides: number; documents: number; chunks: number }[];
};
export const knowledgeComposition = (farmId: FarmId) => send<KnowledgeComposition>(farmId, "/v1/knowledge/composition", {});

/** The answer-review rules run on a read-only copy of the live readings: nothing on the farm changes. */
export type ReviewBaseline = { baseline_id: string; question: string; captured_at: string; readings: { key: string; label: string; value: number | string; unit: string; status: string; zone_id?: string | null }[] };
export const answerReviewBaseline = (farmId: FarmId) => send<ReviewBaseline>(farmId, "/v1/research/answer-review/baseline", { method: "POST" });
export const answerReviewRun = (farmId: FarmId, body: { baseline_id: string; target_zone: string; changed_zone: string; temperature: number; sensor_status: "normal" | "warning" | "critical" }) =>
  send<ReviewRun>(farmId, "/v1/research/answer-review/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
/** One guide as stored: its passages in order, with where each sits in the extracted text. */
export type KnowledgeChunk = { id: string; ordinal: number; text: string; location: { start_char: number; end_char: number } };
export type KnowledgeDocumentDetail = {
  id: string;
  title: string;
  issuer: string | null;
  published_year: number | null;
  document_type: string | null;
  source_url: string | null;
  source_locator: string | null;
  source_group_id: string;
  scope: "public" | "private" | "synthetic_demo";
  retrieval_state: "active" | "paused" | "needs_review";
  summary: string | null;
  chunk_count: number;
  chunks: KnowledgeChunk[];
};
const documents = new Map<string, Promise<KnowledgeDocumentDetail>>();
/** A document's text, fetched once per page view; a failed read is tried again next time. */
export function knowledgeDocument(farmId: FarmId, documentId: string): Promise<KnowledgeDocumentDetail> {
  const key = `${farmId}:${documentId}`;
  if (!documents.has(key)) {
    documents.set(key, send<KnowledgeDocumentDetail>(farmId, `/v1/knowledge/documents/${encodeURIComponent(documentId)}`, {}).catch((error) => { documents.delete(key); throw error; }));
  }
  return documents.get(key)!;
}
/** Forget cached texts after the library changed a document. */
export const forgetKnowledgeDocuments = () => documents.clear();

const idsQuery = (ids: string[]) => ids.map((id) => `document_id=${encodeURIComponent(id)}`).join("&");
/**
 * Every page of one guide in one request, for the reading room. Pages already
 * read are taken from the cache, and pages read here are kept for the evidence
 * reader too.
 */
export async function bookTexts(farmId: FarmId, ids: string[]): Promise<KnowledgeDocumentDetail[]> {
  const missing = ids.filter((id) => !documents.has(`${farmId}:${id}`));
  if (missing.length) {
    const read = send<{ documents: KnowledgeDocumentDetail[] }>(farmId, `/v1/knowledge/texts?${idsQuery(missing)}`, {});
    for (const id of missing) {
      const one = read.then((r) => {
        const doc = r.documents.find((d) => d.id === id);
        if (!doc) throw Object.assign(new Error("not found"), { status: 404 });
        return doc;
      });
      documents.set(`${farmId}:${id}`, one);
      one.catch(() => documents.delete(`${farmId}:${id}`));
    }
  }
  const settled = await Promise.allSettled(ids.map((id) => documents.get(`${farmId}:${id}`)!));
  return settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
}

/** One answer that cited a passage: its question, when, and the place it was asked about. */
export type CitingAnswer = { question: string; asked_at: string | null; response_id: string | null; bed_id: string | null; tier: number | null; zone_scope_mode: "all" | "focused"; selected_zone_ids: string[] };
export type PassageCitations = {
  chunks: Record<string, { document_id: string; count: number; last_at: string | null; answers: CitingAnswer[] }>;
  /** Across the whole guide: the latest answers that cited it, and how many did. */
  answers: CitingAnswer[];
  answer_count: number;
  turns_scanned: number;
};
/** Where this person's answers cited the given guides, passage by passage. */
export const documentCitations = (farmId: FarmId, ids: string[]) =>
  send<PassageCitations>(farmId, `/v1/knowledge/citations?${idsQuery(ids)}`, {});

/** Whether answers use the pinned research retrieval policy, which any change to the documents turns off. */
export type RetrievalPolicy = { state: string; profile_id: string | null; research_policy: boolean; snapshot_matches: boolean | null; active: boolean; changes_fall_back: boolean };
export const retrievalPolicy = (farmId: FarmId) => send<RetrievalPolicy>(farmId, "/v1/knowledge/retrieval-policy", {});

/** Per document: extracted text, growing-practice words found, and how often this person's answers cited it. */
export type LibraryDocumentStats = { chars: number; chunks: number; cultivation_terms: number; cited: number; last_cited_at: string | null };
export type LibraryStats = { documents: Record<string, LibraryDocumentStats>; turns_scanned: number };
export const libraryStats = (farmId: FarmId) => send<LibraryStats>(farmId, "/v1/knowledge/library-stats", {});

/** Sentences that carry every searched word, as written in the guides. */
export type PassageHit = { sentence: string; document_id: string; chunk_id: string; source_group_id: string | null; title: string; location: string | null; issuer: string | null; retrieval_state: string | null; scope: string | null };
export const searchPassages = (farmId: FarmId, q: string, signal?: AbortSignal) =>
  send<{ query: string; passages: PassageHit[]; count: number }>(farmId, `/v1/knowledge/passages?q=${encodeURIComponent(q)}`, { signal });

/** "This passage did not fit the question": kept for retrieval evaluation, nothing else changes. */
export type EvidenceFeedback = { response_id: string | null; document_id: string; chunk_id: string | null; reason: "irrelevant"; created_at: string };
export const sendEvidenceFeedback = (farmId: FarmId, body: { document_id: string; chunk_id?: string | null; response_id?: string | null }) =>
  send<{ id: string; recorded_at: string }>(farmId, "/v1/advisor/evidence-feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, reason: "irrelevant" }) });
export const evidenceFeedback = (farmId: FarmId, responseId?: string | null) =>
  send<{ feedback: EvidenceFeedback[] }>(farmId, `/v1/advisor/evidence-feedback${responseId ? `?response_id=${encodeURIComponent(responseId)}` : ""}`, {});

/** The file a guide was extracted from: kept at upload, or fetched once from a public PDF's own address. */
/**
 * Where a guide's original file is: kept at upload or fetched before, on this
 * machine among the collected sources ("local"; "local_changed" when a web page
 * there was downloaded again after collection and still holds the guide's
 * text), or still to be fetched from the address it was published at. `page`
 * is the page of a PDF this document is.
 */
export type OriginalStatus = {
  document_id: string; available: boolean; fetchable: boolean; media_type: string | null; size: number | null; sha256?: string | null;
  origin: "upload" | "source_url" | "local" | "local_changed" | null; stored_at: string | null; page?: number | null; reason: string | null;
  /** A web page: whether its archive (the page with its styles, pictures and fonts inside it) is made. */
  archived?: boolean | null;
};
export const originalStatus = (farmId: FarmId, documentId: string) =>
  send<OriginalStatus>(farmId, `/v1/knowledge/documents/${encodeURIComponent(documentId)}/original/status`, {});
/** A web page's archive: when the page was collected, and where its styles, pictures and fonts came from. */
export type ArchiveInfo = { capturedAt: string | null; kept: number; fromWayback: number; missing: number; incomplete: boolean };
/** An original's bytes and what the server found it to be; a web page's archive says so. */
export type OriginalFile = { bytes: ArrayBuffer; type: string; archive?: ArchiveInfo };
// Every page of a printed guide shares one file: kept once per file, not once per page.
const originals = new Map<string, Promise<OriginalFile>>();
export function originalFile(farmId: FarmId, documentId: string, sha256?: string | null): Promise<OriginalFile> {
  const key = sha256 ? `sha:${sha256}` : `${farmId}:${documentId}`;
  if (!originals.has(key)) {
    const file = (async () => {
      const response = await fetch(`${base()}/v1/knowledge/documents/${encodeURIComponent(documentId)}/original`, { headers: headers(farmId) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw Object.assign(new Error(typeof error.detail === "string" ? error.detail : `HTTP ${response.status}`), { status: response.status });
      }
      // A file fetched for the first time is known by its fingerprint from then on.
      const fingerprint = response.headers.get("X-Original-Sha256");
      const read = response.arrayBuffer().then((bytes) => ({ bytes, type: response.headers.get("Content-Type") ?? "application/octet-stream" }));
      if (fingerprint && !originals.has(`sha:${fingerprint}`)) originals.set(`sha:${fingerprint}`, read);
      return read;
    })().catch((error) => { originals.delete(key); throw error; });
    originals.set(key, file);
  }
  return originals.get(key)!;
}

// A web page's archive, kept per page file (two sections of one page share it).
const archives = new Map<string, Promise<OriginalFile>>();
/**
 * A web page original as one self-contained file, as a web archive keeps it: its
 * stylesheets, pictures and fonts inside it, fetched once by the server from the
 * page's site or the Internet Archive. The first opening makes it (some seconds).
 */
export function originalArchive(farmId: FarmId, documentId: string, sha256?: string | null): Promise<OriginalFile> {
  const key = sha256 ? `archive:${sha256}` : `archive:${farmId}:${documentId}`;
  if (!archives.has(key)) {
    const file = (async () => {
      const response = await fetch(`${base()}/v1/knowledge/documents/${encodeURIComponent(documentId)}/original/archive`, { headers: headers(farmId) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw Object.assign(new Error(typeof error.detail === "string" ? error.detail : `HTTP ${response.status}`), { status: response.status });
      }
      const count = (name: string) => Number(response.headers.get(name) ?? 0) || 0;
      const archive: ArchiveInfo = {
        capturedAt: response.headers.get("X-Archive-Captured-At") || null,
        kept: count("X-Archive-Kept"),
        fromWayback: count("X-Archive-From-Wayback"),
        missing: count("X-Archive-Missing"),
        incomplete: response.headers.get("X-Archive-Incomplete") === "true",
      };
      // One made while some resources could not be asked for is asked for again next time.
      if (archive.incomplete) setTimeout(() => archives.delete(key), 60_000);
      return { bytes: await response.arrayBuffer(), type: response.headers.get("Content-Type") ?? "text/html", archive };
    })().catch((error) => { archives.delete(key); throw error; });
    archives.set(key, file);
  }
  return archives.get(key)!;
}

/** Which guides each reading's reference box quotes, for the library: one request, kept by the server until a guide changes. */
export type MetricReferenceSources = { metrics: { metric: string; label: string; passages: { document_id: string; chunk_id: string | null; location: string | null; sentence: string }[] }[]; cached: boolean };
export const metricReferenceSources = (farmId: FarmId) => send<MetricReferenceSources>(farmId, "/v1/knowledge/metric-reference/sources", {});

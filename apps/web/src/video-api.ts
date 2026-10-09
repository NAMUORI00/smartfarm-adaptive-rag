import type { FarmId } from './types'

export type VideoClip = { id: string; title: string; camera_id: string; event_id: string; duration_seconds: number; media_url: string; source_label: string; title_en?: string | null; synthetic?: boolean | null; zone_id?: string | null; bed_id?: string | null }
export type VideoCatalog = { enabled: boolean; clips: VideoClip[]; reason?: string }
export type VideoAnalysis = { id: string; decision: 'answer' | 'abstain' | 'unavailable'; answer: string; clip_id: string; start_seconds: number; end_seconds: number; frame_urls: string[]; model?: string }
export type VideoQuestion = { clip_id: string; question: string; start_seconds: number; end_seconds: number; answer_language?: 'ko' | 'en' }
export type ResearchEvidenceSet = { id: string; title: string; question: string; source_label: string; recorded_at: string | null; camera_ids: string[] }
export type ResearchVideoCatalog = { ready: boolean; inference_ready?: boolean; reasons: string[]; evidence_sets: ResearchEvidenceSet[] }
export type ResearchViewCandidate = { view_id: string; camera_id: string | null; availability: number }
export type ResearchVideoAnalysis = { id: string; decision: 'answer' | 'abstain' | 'unavailable'; answer: string; frame_urls: string[]; release_hold_reason?: string | null; selected_camera_id?: string | null; selected_view_id?: string | null; created_at?: string; elapsed_ms?: number; model?: string; research_model_executed?: boolean; stages: { release?: { released?: boolean; hold_reason?: string | null; policy_version?: string; threshold?: number | null; validated?: boolean }; answer?: { decision?: string; confidence?: number }; selection?: { view_id?: string; availability?: number; candidates?: ResearchViewCandidate[] } } }
/** A candidate camera's registered frame, shown before a run. */
export const researchEvidencePath = (evidenceId: string, cameraId: string) => `/v1/video/research/evidence/${encodeURIComponent(evidenceId)}/${encodeURIComponent(cameraId)}`
const base = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')

async function videoFetch(path: string, farm: FarmId, signal: AbortSignal, body?: object) {
  // Only accept this service's paths; never forward credentials to external media hosts.
  const relative = path.startsWith(`${base}/v1/video/`) ? path.slice(base.length) : path
  if (!relative.startsWith('/v1/video/') || relative.includes('..') || relative.includes('\\')) throw new Error('허용되지 않은 영상 주소입니다.')
  const response = await fetch(`${base}${relative}`, {
    signal, method: body ? 'POST' : 'GET',
    headers: { 'X-Demo-Token': import.meta.env.VITE_DEMO_TOKEN ?? 'demo-admin', 'X-Farm-Context': farm, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`영상 서비스 요청을 완료하지 못했습니다 (${response.status}).`)
  return response
}

export async function getVideoCatalog(farm: FarmId, signal: AbortSignal): Promise<VideoCatalog> { return (await videoFetch('/v1/video/catalog', farm, signal)).json() }
export async function analyzeVideo(farm: FarmId, request: VideoQuestion, signal: AbortSignal): Promise<VideoAnalysis> { return (await videoFetch('/v1/video/analyses', farm, signal, request)).json() }
export async function loadVideoMedia(farm: FarmId, path: string, signal: AbortSignal): Promise<Blob> { return (await videoFetch(path, farm, signal)).blob() }
export async function getResearchVideoCatalog(farm: FarmId, signal: AbortSignal): Promise<ResearchVideoCatalog> { return (await videoFetch('/v1/video/research/catalog', farm, signal)).json() }
/** The farm's saved runs where the research model actually ran, newest first. */
export async function listResearchVideoAnalyses(farm: FarmId, signal: AbortSignal): Promise<(ResearchVideoAnalysis & { created_at?: string })[]> { return (await (await videoFetch('/v1/video/research/analyses?executed=true&limit=1', farm, signal)).json()).analyses }
export async function analyzeResearchVideo(farm: FarmId, sample: ResearchEvidenceSet, signal: AbortSignal): Promise<ResearchVideoAnalysis> { return (await videoFetch('/v1/video/research/analyses', farm, signal, { evidence_set_id: sample.id, question: sample.question })).json() }

export type PatrolEvent = { id: string; clip_id: string | null; camera_id: string; title: string; source: 'test_event' | 'camera_reading'; status: 'new' | 'reviewing' | 'resolved'; outcome: string | null; created_at: string; start_seconds: number; end_seconds: number; analysis: (VideoAnalysis & { answer_en?: string; video_url?: string; segment_id?: string; frame_times?: number[]; box?: number[] | null }) | null; history: { at: string; label: string }[]; progress?: { phase: string; updated_at: string; steps: { phase: string; at: string }[] }
  /** A camera reading's record (camera_feeds.py): the check that raised it and where. */
  check_id?: string; segment_id?: string; title_en?: string; synthetic?: boolean; zone_id?: string | null; bed_id?: string | null; ask?: string | null; last_seen_at?: string }
export async function patrolRequest(farm: FarmId, suffix = '', body?: object, signal = AbortSignal.timeout(120000)): Promise<PatrolEvent> { return (await videoFetch(`/v1/video/events${suffix}`, farm, signal, body)).json() }
export async function listPatrolEvents(farm: FarmId, signal = AbortSignal.timeout(10000)): Promise<PatrolEvent[]> { return (await (await videoFetch('/v1/video/events', farm, signal)).json()).events }

// Camera feeds (camera_feeds.py): short segments received from each camera and read by the AI when the scene changes.
export type CameraCheckRow = { id: string; decision: 'answer' | 'abstain'; present: boolean | null; needs_check: boolean; summary_ko: string; summary_en: string; frames: number[]; box: number[] | null; confidence: number | null }
export type CameraReading = { status: 'read' | 'unchanged' | 'unavailable' | 'failed' | 'limit' | 'waiting'; read_at?: string; elapsed_ms?: number; model?: string; checks: CameraCheckRow[]; same_as?: string; same_as_recorded_at?: string }
export type CameraSegment = { id: string; camera_id: string; recorded_at: string; duration_seconds: number; video_url: string; frames: { url: string; at: number }[]; reading: CameraReading | null }
export type CameraFeed = { id: string; title: string; title_en?: string | null; zone_id: string | null; bed_id: string | null; synthetic: boolean; generator: { model?: string; license?: string } | null; source_kind: 'rtsp' | 'hls' | 'file'; checks: string[]; state: 'receiving' | 'no_signal' | 'waiting'; last_error_at: string | null; latest: CameraSegment | null; open_events: number }
export type CameraFeedList = { enabled: boolean; receiving: boolean; interval_seconds: number; segment_seconds: number; reads_today: number; daily_limit: number; cameras: CameraFeed[] }
export type CameraAnswer = { decision: 'answer' | 'abstain'; present: boolean | null; answer: string | null; reason: string; confidence: number; box: [number, number, number, number] | null; camera_id: string; question: string; model: string; elapsed_ms: number; analyzed_at: string; frame_url: string; segment_id: string; recorded_at: string; synthetic_image: boolean }
export async function getCameraFeeds(farm: FarmId, signal: AbortSignal): Promise<CameraFeedList> { return (await videoFetch('/v1/video/cameras', farm, signal)).json() }
export async function getCameraSegments(farm: FarmId, cameraId: string, signal: AbortSignal): Promise<CameraSegment[]> { return (await (await videoFetch(`/v1/video/cameras/${encodeURIComponent(cameraId)}/segments`, farm, signal)).json()).segments }
export async function askCamera(farm: FarmId, body: { camera_id: string; question: string; lang: string; location?: string }, signal = AbortSignal.timeout(90000)): Promise<CameraAnswer> { return (await videoFetch('/v1/video/cameras/ask', farm, signal, body)).json() }

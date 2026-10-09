import {normalizeApiErrorDetail} from "./api-error.ts";
import type { AdvisorTurn, FarmId } from "./types";

export function advisorTurnAt(turns: AdvisorTurn[], selection: FarmSelection | null, cycleId?: string | null) {
  if (!selection) return null;
  return [...turns].reverse().find(turn => turn.status === 'complete' && turn.assistantMessage && turn.queryContext?.bedId === selection.bedId && turn.queryContext.tier === selection.tier && (turn.queryContext.cycleId ?? null) === (cycleId ?? null)) ?? null;
}

export type FarmBed = {
  id: string;
  label: string;
  zone_id: string;
  position: { x: number; y: number; z: number };
  tiers: { id: string; tier: number; label: string }[];
  camera_ids: string[];
};
export type FarmLayout = {
  name?: string;
  farm?: {name:string;crop:string;cultivar:string;location:string};
  mapping_status?: string;
  farm_id: string;
  version: string;
  beds: FarmBed[];
  zones: { id: string; label: string; bed_ids: string[] }[];
  cameras: { id: string }[];
  devices: {
    key: string;
    label: string;
    zone_id: string | null;
    affected_bed_ids: string[];
  }[];
};
export type FarmSelection = { bedId: string; tier: number };
export type CropCycle = {
  revision?: number;
  events?: { id: string; kind: string; effective_kind?: string; occurred_at: string; recorded_at?: string; note?: string; removed_count?: number; weight_kg?: number; growth_percent?: number; reason?: string; corrects?: string }[];
  id: string;
  bed_id: string;
  tier: number;
  crop: string;
  cultivar: string;
  harvest_part: string;
  planted_on: string;
  initial_count: number;
  remaining_count: number;
  planned_harvest_from: string | null;
  planned_harvest_to: string | null;
  status: string;
  latest_observation: { growth_percent: number; observed_at: string } | null;
  harvests: {
    weight_kg: number;
    harvested_at: string;
    removed_count: number;
  }[];
};

export async function farmRequest<T>(
  farmId: FarmId,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const base = (import.meta.env.VITE_API_BASE_URL ?? "/api").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    signal,
    headers: {
      "X-Demo-Token": import.meta.env.VITE_DEMO_TOKEN ?? "demo-admin",
      "X-Farm-Context": farmId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((error) => {
    if (signal?.aborted) throw error;
    throw new Error("연결을 확인하지 못했습니다. 같은 요청으로 결과를 다시 확인하세요.");
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(
      normalizeApiErrorDetail(error.detail, response.status),
    ), { status: response.status });
  }
  return response.json() as Promise<T>;
}

export function selectedBed(
  layout: FarmLayout | null,
  selection: FarmSelection | null,
) {
  return layout?.beds.find((b) => b.id === selection?.bedId) ?? null;
}
export function cycleAt(cycles: CropCycle[], selection: FarmSelection | null) {
  return (
    cycles.find(
      (c) =>
        c.bed_id === selection?.bedId &&
        c.tier === selection.tier &&
        c.status === "growing",
    ) ?? null
  );
}
export function observationScale(cycle: CropCycle | null) {
  if (!cycle || cycle.remaining_count <= 0 || !cycle.latest_observation)
    return null;
  return Math.max(
    0.2,
    Math.min(1, cycle.latest_observation.growth_percent / 100),
  );
}

export function activePlantFraction(cycle: CropCycle | null) {
  if (!cycle || cycle.initial_count <= 0) return 0;
  return Math.min(1, Math.max(0, cycle.remaining_count / cycle.initial_count));
}

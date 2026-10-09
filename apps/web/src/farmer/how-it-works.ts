import type { AdvisorRetrieval, AdvisorTurn, Evidence } from "../types.ts";
import { L } from "./i18n.ts";

/**
 * What the first page's "how it works" players show, taken from real records:
 * a saved advisor answer (retrieval route, candidates per method, fused
 * sources, the answer), the last research camera run, and a live run of the
 * answer-review rules. Nothing here makes up a number; missing parts are left
 * out and the player says it is an example only when no record exists.
 */

export type Channel = "dense" | "sparse" | "graph";
export const CHANNELS: Channel[] = ["dense", "sparse", "graph"];
export const channelName = (c: Channel) => ({ dense: L("의미 검색", "Semantic"), sparse: L("낱말 검색", "Keyword"), graph: L("관계 근거", "Relation") })[c];

/** The newest finished answer that cited at least two published guides; routed by the retrieval policy and written by an AI model when possible. */
export function pickKnowledgeTurn(turns: AdvisorTurn[]): AdvisorTurn | null {
  const cited = turns.filter((t) => t.status === "complete" && (t.assistantMessage?.content ?? "").length > 40 && t.evidence.filter((e) => e.sourceKind === "public_knowledge").length >= 2);
  const routed = cited.filter((t) => t.retrieval.route?.mode === "qact");
  const pool = routed.length ? routed : cited;
  const written = pool.filter((t) => !!t.execution.model);
  return (written.length ? written : pool).at(-1) ?? null;
}

/** "dense: 2145" → candidates found by each method. */
export function channelCounts(retrieval: Pick<AdvisorRetrieval, "channels">): Partial<Record<Channel, number>> {
  const out: Partial<Record<Channel, number>> = {};
  for (const entry of retrieval.channels ?? []) {
    const m = /^(dense|sparse|graph)\s*:\s*(\d+)/i.exec(entry.trim());
    if (m) out[m[1].toLowerCase() as Channel] = Number(m[2]);
  }
  return out;
}

/** The weight each method got for this question, as shares of one (missing methods are 0). */
export function routeWeights(route: AdvisorRetrieval["route"]): Record<Channel, number> {
  const raw = route?.weights ?? {};
  const w = { dense: Number(raw.dense ?? 0), sparse: Number(raw.sparse ?? 0), graph: Number(raw.graph ?? 0) };
  const total = w.dense + w.sparse + w.graph;
  if (total <= 0) return { dense: 1, sparse: 0, graph: 0 };
  return { dense: w.dense / total, sparse: w.sparse / total, graph: w.graph / total };
}

/**
 * Whether relation evidence took part: the route asked for it and its gate let
 * it through ("source_span_verified_graph_relation_passed"); an absent,
 * unrequested or suppressed relation leaves it out.
 */
export const graphUsed = (route: AdvisorRetrieval["route"]) =>
  !!route && route.path.includes("graph") && (!route.graphReason || /passed|verified|accepted/.test(route.graphReason)) && !/absent|not_requested|suppress|unreliable|below/.test(route.graphReason ?? "");

/** Server numbers as a person reads them: long decimals to one place, ISO times to "2026.09.28 15:55". */
export function readable(text: string, stampOf: (iso: string) => string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})/g, (iso) => stampOf(iso))
    .replace(/\d+\.\d{3,}/g, (m) => String(Number(Number(m).toFixed(1))));
}

/** The answer as plain lines: headings, list marks and emphasis removed, short enough to read in a card. */
export function answerLines(content: string, max = 5): string[] {
  return content
    .split("\n")
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\*\*/g, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, max);
}

/** Sources that fed the answer, published guides and farm documents first, then live readings; ranked by fused score. */
export function rankedSources(evidence: Evidence[]): { documents: Evidence[]; readings: Evidence[] } {
  const documents = evidence.filter((e) => e.sourceKind === "public_knowledge" || e.sourceKind === "private_knowledge").sort((a, b) => b.score - a.score);
  const readings = evidence.filter((e) => e.sourceKind === "private_simulation");
  return { documents, readings };
}

/** Which of the ranked sources an answer line quotes, by its title in the line. */
export function quotedSource(line: string, documents: Evidence[]): number | null {
  const i = documents.findIndex((d) => d.source && line.includes(d.source.replace(/\s*·\s*\d+쪽$/, "")));
  return i >= 0 ? i : null;
}

/** The answer-review lab run, reduced to what the player shows. */
export type ReviewRun = {
  previous_temperature: number;
  previous_status: string;
  input: { temperature: number; sensor_status: string; target_zone: string; changed_zone: string };
  units: { id: string; before: string; after: string; rechecked: boolean; text_changed: boolean }[];
  rechecked_units: string[];
  text_changed_units: string[];
  executed_at: string;
  external_llm_called: boolean;
  farm_state_modified: boolean;
};

export function reviewTally(run: ReviewRun) {
  return { total: run.units.length, rechecked: run.rechecked_units.length, rewritten: run.text_changed_units.length };
}

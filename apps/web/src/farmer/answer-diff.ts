import type { AdvisorTurn } from "../types";
import { L } from "./i18n.ts";

export function unitLabel(id: string): string {
  return ({ state: L("상태 설명", "Status"), action: L("행동 안내", "Action"), evidence: L("관측 근거", "Evidence") } as Record<string, string>)[id] ?? id;
}

const channelWords = (): Array<[RegExp, string]> => [
  [/dense/i, L("의미 검색", "semantic search")],
  [/sparse/i, L("낱말 검색", "keyword search")],
  [/graph/i, L("관계 근거", "relation evidence")],
];

/** "자료 5개, 의미 검색 + 관계 근거" — how the answer found its sources, in farmer words. */
export function retrievalSummary(turn: Pick<AdvisorTurn, "evidence" | "retrieval" | "assistantMessage">): string {
  const count = turn.evidence.length;
  if (!count) return L("참고 자료 없음. 관측만 사용", "No sources. Readings only");
  const raw = [...(turn.retrieval?.channels ?? []), ...(turn.assistantMessage?.searchPath ?? [])];
  const methods: string[] = [];
  for (const [pattern, word] of channelWords()) {
    if (raw.some((entry) => pattern.test(String(entry))) && !methods.includes(word)) methods.push(word);
  }
  const found = L(`자료 ${count}개`, `${count} ${count === 1 ? "source" : "sources"}`);
  const how = methods.length ? `, ${methods.join(" + ")}` : "";
  const review = turn.retrieval?.researchDiagnosticsOnly ? L(", 검색 품질 검토 중", ", search quality under review") : "";
  return `${found}${how}${review}`;
}

export type AnswerRevisionUnit = {
  id: string;
  label: string;
  before: string | null;
  after: string;
  /** The server re-rendered this unit because a value it depends on changed. */
  rechecked: boolean;
  /** The wording actually differs from the previous answer. */
  textChanged: boolean;
};
export type AnswerRevision = {
  status: NonNullable<AdvisorTurn["stateReview"]>["status"];
  total: number;
  /** Units the server rechecked (declared `changed_units`, or text comparison when undeclared). */
  changed: string[];
  /** Units whose wording differs from the previous answer. */
  textChanged: string[];
  refreshCount: number;
  units: AnswerRevisionUnit[];
};

/**
 * Compare a rechecked answer with the answer it replaced. The server names the
 * re-rendered units (`changed_units`); rewording is judged against the previous
 * turn so "checked again" and "actually changed" stay distinct, as in the research.
 */
export function answerRevision(turn: AdvisorTurn, turns: AdvisorTurn[]): AnswerRevision | null {
  const review = turn.stateReview;
  if (!review || !review.previous_response_id) return null;
  const previous = turns.find((t) => t.responseId === review.previous_response_id)?.stateReview ?? null;
  const declared = review.changed_units;
  const units = review.units.map((unit) => {
    const before = previous?.units.find((u) => u.id === unit.id)?.text ?? null;
    const textChanged = before !== null && before !== unit.text;
    const rechecked = declared ? declared.includes("all") || declared.includes(unit.id) : textChanged;
    return { id: unit.id, label: unitLabel(unit.id), before, after: unit.text, rechecked, textChanged: rechecked && (before === null ? false : textChanged) };
  });
  return {
    status: review.status,
    total: units.length,
    changed: units.filter((u) => u.rechecked).map((u) => u.id),
    textChanged: units.filter((u) => u.textChanged).map((u) => u.id),
    refreshCount: review.refresh_count,
    units,
  };
}

export function unitChangeLabel(unit: AnswerRevisionUnit): string {
  return unit.textChanged ? L("수정됨", "Revised") : unit.rechecked ? L("재확인, 변경 없음", "Rechecked, no change") : L("유지", "Kept");
}

/** Short tally for the answer's meta line: "재확인 2 / 수정 없음 / 1회차". */
export function revisionTally(rev: AnswerRevision): string {
  const changed = rev.textChanged.length ? L(`수정 ${rev.textChanged.length}`, `${rev.textChanged.length} revised`) : L("수정 없음", "none revised");
  return L(`재확인 ${rev.changed.length} / ${changed} / ${rev.refreshCount}회차`, `${rev.changed.length} rechecked / ${changed} / round ${rev.refreshCount}`);
}

/** Titles of the sources behind an answer, for one line under the text. */
export function sourcesLine(titles: string[], max = 2): string {
  if (!titles.length) return L("근거: 관측만 사용", "Sources: readings only");
  const shown = titles.slice(0, max).join(", ");
  const more = titles.length > max ? L(` 외 ${titles.length - max}`, ` and ${titles.length - max} more`) : "";
  return `${L("근거", "Sources")}: ${shown}${more}`;
}

export function revisionSummary(rev: AnswerRevision): string {
  if (rev.status === "needs_confirmation") return L("상태가 다시 변경되었습니다. 값이 계속 변하고 있어 새 질문이 필요합니다.", "Status changed again. Values keep changing, so a new question is needed.");
  if (rev.status === "stale") return L("상태가 변경되었습니다. 새로 질문하세요.", "Status changed. Ask a new question.");
  if (!rev.changed.length) return L("상태가 변경되었으나 답변 내용은 유지됩니다.", "Status changed, but the answer still holds.");
  return rev.textChanged.length
    ? L(`상태 변경으로 ${rev.total}개 항목 중 ${rev.changed.length}개를 재확인하고 ${rev.textChanged.length}개를 수정했습니다.`, `After the status change, ${rev.changed.length} of ${rev.total} parts were rechecked and ${rev.textChanged.length} revised.`)
    : L(`상태 변경으로 ${rev.total}개 항목 중 ${rev.changed.length}개를 재확인했습니다. 수정 사항은 없습니다.`, `After the status change, ${rev.changed.length} of ${rev.total} parts were rechecked. Nothing was revised.`);
}

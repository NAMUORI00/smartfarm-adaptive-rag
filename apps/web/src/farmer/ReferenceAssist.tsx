import { useEffect, useState } from "react";
import type { FarmId } from "../types";
import { harvestGuide, metricReference, passageSource } from "./assist-api";
import type { HarvestGuide, MetricReference, Passage } from "./assist-api";
import { AiMark } from "./AiBrief";
import type { ReaderTarget } from "./DocReader";
import { FarmIcon } from "./FarmIcon";
import { periodState, periodStateText, periodText, seoulToday } from "./harvest-periods";
import { L, term } from "./i18n";
import { RefNote } from "./RefNote";

/** The quoted sentences, stepped through in the reader in the order shown. */
export const passageTarget = (passages: Passage[], start = 0): ReaderTarget => ({
  passages: passages.map((p) => ({ documentId: p.document_id ?? p.source_id, chunkId: p.chunk_id ?? null, text: p.sentence, kind: "quote" as const })),
  start,
});

/** A quoted sentence names its source; with the reader it opens there, else the source site. */
export function PassageSource({ passages, index, onOpen }: { passages: Passage[]; index: number; onOpen?: (target: ReaderTarget) => void }) {
  const p = passages[index];
  if (onOpen) {
    return (
      <button type="button" className="fm-passage-open" onClick={() => onOpen(passageTarget(passages, index))}>
        <FarmIcon name="file" />{passageSource(p)}
      </button>
    );
  }
  return (
    <small>
      {passageSource(p)}
      {p.source_url && /^https?:/.test(p.source_url) && <>, <a href={p.source_url} target="_blank" rel="noreferrer">{L("원문", "Source")}</a></>}
    </small>
  );
}

function PassageList({ passages, onOpen }: { passages: Passage[]; onOpen?: (target: ReaderTarget) => void }) {
  return (
    <ul className="fm-passages">
      {passages.map((p, i) => (
        <li key={`${p.source_id}:${p.sentence}`}>
          <q lang="ko">{p.sentence}</q>
          <PassageSource passages={passages} index={i} onOpen={onOpen} />
        </li>
      ))}
    </ul>
  );
}

/**
 * "이 값 괜찮아?": the sentences the growing guides give for this reading,
 * quoted with their page. Shown next to the farm's own range, never merged
 * into it: a guide sentence is a reference, not this farm's setting.
 */
export function MetricReferenceBox({ farmId, metricKey, hasFarmRange, onOpen }: { farmId: FarmId; metricKey: string; hasFarmRange: boolean; onOpen?: (target: ReaderTarget) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<MetricReference | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    if (!open || state !== "idle") return;
    setState("loading");
    metricReference(farmId, metricKey).then((d) => { setData(d); setState("ready"); }).catch(() => setState("error"));
  }, [open, state, farmId, metricKey]);
  return (
    <details className="fm-helper fm-refbox" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <AiMark />{hasFarmRange ? L("재배 자료 기준과 비교", "Compare with the growing guides") : L("재배 자료 기준 보기", "See the growing guides' range")}
      </summary>
      {open && (
        <div className="fm-refbox-body">
          {state === "loading" && <p className="fm-hint">{L("재배 자료를 찾는 중…", "Searching the growing guides…")}</p>}
          {state === "error" && <p className="fm-hint">{L("자료를 불러오지 못했습니다.", "Could not load the guides.")}</p>}
          {state === "ready" && data && (data.passages.length ? (
            <>
              <PassageList passages={data.passages} onOpen={onOpen} />
              <small className="fm-hint">{hasFarmRange ? L("농장 기준 범위는 위 값 옆에 있습니다. 자료 문장은 참고이며 농장 기준을 바꾸지 않습니다.", "The farm's own range is shown with the value. Guide sentences are reference and do not change it.") : L("이 값에는 농장 기준이 등록되지 않았습니다. 자료 문장은 참고입니다.", "No farm range is registered for this value. Guide sentences are for reference.")}</small>
            </>
          ) : (
            <p className="fm-hint">{L("이 값의 기준을 적은 문장을 재배 자료에서 찾지 못했습니다.", "No sentence giving this value's range was found in the guides.")}</p>
          ))}
        </div>
      )}
    </details>
  );
}

/**
 * The guides' harvest periods, each dated from this cycle's planting and
 * placed against today. A period is dated only when it speaks of the part this
 * cycle harvests (a leaf crop is not given the rhizome's growing period).
 */
export function HarvestGuideBox({ farmId, cycleId, onOpen }: { farmId: FarmId; cycleId: string; onOpen?: (target: ReaderTarget) => void }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HarvestGuide | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    if (!open || state !== "idle") return;
    setState("loading");
    harvestGuide(farmId, cycleId).then((d) => { setData(d); setState("ready"); }).catch(() => setState("error"));
  }, [open, state, farmId, cycleId]);
  const today = seoulToday();
  const part = data?.harvest_part ?? "";
  const undated = !!data?.passages.some((p) => (p.periods?.length ?? 0) > 0 && !p.for_harvest);
  return (
    <details className="fm-helper fm-refbox fm-harvest-guide" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <AiMark />{L("자료 기준 수확 시기", "Harvest time in the guides")}
      </summary>
      {open && (
        <div className="fm-refbox-body">
          {state === "loading" && <p className="fm-hint">{L("재배 자료를 찾는 중…", "Searching the growing guides…")}</p>}
          {state === "error" && <p className="fm-hint">{L("자료를 불러오지 못했습니다.", "Could not load the guides.")}</p>}
          {state === "ready" && data && (data.passages.length ? (
            <ul className="fm-passages">
              {data.passages.map((p, i) => (
                <li key={`${p.source_id}:${p.sentence}`}>
                  <q lang="ko">{p.sentence}</q>
                  {p.for_harvest && p.periods?.map((w, i) => {
                    const at = periodState(w, today);
                    return (
                      <span key={i} className="fm-guide-window">
                        {periodText(w)}
                        <em className={`fm-badge ${at === "now" ? "is-ok" : "is-off"}`}>{periodStateText(at)}</em>
                      </span>
                    );
                  })}
                  <PassageSource passages={data.passages} index={i} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="fm-hint">{L("수확 시기를 적은 문장을 재배 자료에서 찾지 못했습니다.", "No sentence about harvest time was found in the guides.")}</p>
          ))}
          {state === "ready" && undated && (
            <small className="fm-hint">
              {part
                ? L(`수확 부위(${part})와 맞지 않는 기간 문장은 수확 날짜로 바꾸지 않았습니다.`, `Period sentences that do not match this cycle's harvest part (${term(part)}) are not turned into harvest dates.`)
                : L("이 회차의 수확 부위와 맞지 않는 기간 문장은 수확 날짜로 바꾸지 않았습니다.", "Period sentences that do not match this cycle's harvest part are not turned into harvest dates.")}
            </small>
          )}
          <RefNote kind="harvest" compact />
        </div>
      )}
    </details>
  );
}

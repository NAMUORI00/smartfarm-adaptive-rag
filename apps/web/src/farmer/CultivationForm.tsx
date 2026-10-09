import { useEffect, useRef, useState } from "react";
import type { Farm } from "../types";
import { farmRequest } from "../farm-spatial";
import type { FarmSelection, CropCycle, FarmLayout } from "../farm-spatial";
import { stamp as formatSensorUpdateTime } from "./time-format";
import { CropHistory } from "./CropHistory";
import { L, place, term } from "./i18n";
export function CropEditor({
  farm,
  selection,
  cycle,
  layout,
  cycles = [],
  onSave,
}: {
  farm: Farm;
  selection: FarmSelection;
  cycle: CropCycle | null;
  layout?: FarmLayout | null;
  cycles?: CropCycle[];
  onSave: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    lock = useRef(false),
    storageKey = `farmer.crop.${farm.id}.${selection.bedId}.${selection.tier}`;
  const [pending, setPending] = useState<{path: string; payload: Record<string, unknown>} | null>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? "null"); } catch { return null; }
  });
  const formRoot = useRef<HTMLDivElement>(null);
  const draftKey = `${storageKey}.draft.${cycle?.id ?? "new"}`;
  useEffect(()=>{
    try { const drafts=JSON.parse(sessionStorage.getItem(draftKey)??"{}");
      formRoot.current?.querySelectorAll<HTMLFormElement>("form[data-work]").forEach(form=>{
        const values=drafts[form.dataset.work??""]??{};
        for(const field of Array.from(form.elements)) if(field instanceof HTMLInputElement && field.name && field.type!=="hidden" && values[field.name]!==undefined) field.value=values[field.name];
      });
    } catch { /* An unreadable optional draft must not block work. */ }
  },[draftKey]);
  function saveDraft(){
    const drafts:Record<string,Record<string,string>>={};
    formRoot.current?.querySelectorAll<HTMLFormElement>("form[data-work]").forEach(form=>{
      const values:Record<string,string>={};for(const [key,value] of new FormData(form)) if(typeof value==="string"&&key!=="at")values[key]=value;
      drafts[form.dataset.work??""]=values;
    });
    sessionStorage.setItem(draftKey,JSON.stringify(drafts));
  }
  const [slots,setSlots]=useState([`${selection.bedId}:${selection.tier}`]);
  async function persist(write: {path: string; payload: Record<string, unknown>}) {
    if (lock.current) return false;
    lock.current = true; setBusy(true); setError("");
    localStorage.setItem(storageKey, JSON.stringify(write)); setPending(write);
    try {
      await farmRequest(farm.id, write.path, write.payload);
      localStorage.removeItem(storageKey); setPending(null);
      sessionStorage.removeItem(draftKey); await onSave(); setError(L("기록을 저장했습니다.", "Record saved.")); return true;
    } catch (e) {
      const status = (e as {status?: number}).status;
      if (status && status >= 400 && status < 500) {localStorage.removeItem(storageKey); setPending(null);}
      setError(e instanceof Error ? e.message : L("저장 결과를 확인하지 못했습니다.", "Could not confirm the save result.")); return false;
    } finally { lock.current = false; setBusy(false); }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>, kind: string) {
    e.preventDefault();
    if (lock.current || pending) return;
    const form = e.currentTarget,
      data = new FormData(form),
      n = (k: string) => Number(data.get(k)),
      s = (k: string) => String(data.get(k) ?? "");
    try {
      if (kind === "create")
        await persist({path: "/v1/cultivation/batches", payload: {request_id: crypto.randomUUID(), cycles: slots.map(slot => ({
          bed_id: slot.split(":")[0],
          tier: Number(slot.split(":")[1]),
          crop: s("crop"),
          cultivar: s("cultivar"),
          harvest_part: s("part"),
          planted_on: s("date"),
          initial_count: n("count"),
          planned_harvest_from: s("from") || null,
          planned_harvest_to: s("to") || null,
        }))}});
      else if (cycle) {
        const saved = await persist({path: `/v1/cultivation/cycles/${cycle.id}/events`, payload: {
          request_id: crypto.randomUUID(), revision: cycle.revision ?? 0,
          occurred_at: new Date(s("at") + ":00+09:00").toISOString(),
          kind: kind === "observations" ? "observation" : "harvest", note: s("note"),
          ...(kind === "observations" ? {growth_percent: n("growth")} : {removed_count: n("removed"), weight_kg: n("weight")}),
        }});
        if(saved && kind === "harvests") form.reset();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : L("저장하지 못했습니다.", "Could not save."));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const harvestSoon = (() => {
    if (!cycle?.planned_harvest_from) return false;
    const days = (Date.parse(`${cycle.planned_harvest_from}T00:00:00+09:00`) - Date.now()) / 86400000;
    return days <= 7;
  })();
  return (
    <div ref={formRoot} onChangeCapture={saveDraft}>
      <h3 id="farm-section-crop" className="fm-visually-hidden">{L("재배·수확", "Cultivation and harvest")}</h3>
      {pending && <section role="alert"><p>{L("저장 결과 확인 필요. 새 기록 전에 같은 요청을 확인하세요.", "Save result unconfirmed. Check the same request before adding a new record.")}</p><button disabled={busy} onClick={() => void persist(pending)}>{L("저장 확인", "Check save")}</button></section>}
      {cycle ? (
        <>
          {/* Recording a harvest is the one thing this tab is for; the rest waits under "다른 기록". */}
          <details className="fm-crop-primary" open={harvestSoon}>
            <summary>{L("수확 기록하기", "Record harvest")}</summary>
            <form data-work="harvest" onSubmit={(e) => void submit(e, "harvests")}>
              <WorkTime />
              <label>
                {L("실측 수확량 (kg)", "Measured harvest (kg)")}
                <input
                  name="weight"
                  type="number" inputMode="decimal"
                  min="0.001"
                  step="0.001"
                  required
                />
              </label>
              <label>
                {L("재배를 마친 개체 수", "Plants finished")}
                <input
                  name="removed"
                  type="number" inputMode="decimal"
                  min="0"
                  max={cycle.remaining_count}
                  defaultValue="0"
                  required
                />
              </label>
              <p>{L("잎만 수확하고 식물을 계속 키우면 0주로 기록합니다.", "If you harvest only leaves and keep growing the plants, enter 0.")}</p>
              <details><summary>{L("메모 (선택)", "Note (optional)")}</summary><label>
                {L("메모", "Note")}
                <input name="note" maxLength={500} />
              </label></details>
              <button disabled={busy || !!pending}>{L("수확 기록 저장", "Save harvest")}</button>
            </form>
          </details>
          <details className="fm-crop-more">
            <summary>{L("다른 기록: 자람 정도, 정정, 지난 수확", "Other records: growth, corrections, past harvests")}</summary>
          <details>
            <summary>{L("자람 정도 기록", "Record growth")}</summary>
            <p>
              {L("현장 관측값으로 작물 크기를 표시합니다. 자동 추정값이 아닙니다.", "Crop size is shown from on-site observations. It is not an automatic estimate.")}
            </p>
            <form data-work="observation" onSubmit={(e) => void submit(e, "observations")}>
              <WorkTime />
              <p>{L("등록한 목표 크기를 100%로 보고 같은 기준으로 관측하세요. 자동 추정값이 아닙니다.", "Treat the registered target size as 100% and observe on the same basis. It is not an automatic estimate.")}</p>
              <label>
                {L("관측 생육 정도 (%)", "Observed growth (%)")}
                <input
                  name="growth"
                  type="number" inputMode="decimal"
                  min="0"
                  max="100"
                  defaultValue={cycle.latest_observation?.growth_percent}
                  required
                />
              </label>
              <details><summary>{L("메모 (선택)", "Note (optional)")}</summary><label>
                {L("관측 메모", "Observation note")}
                <input name="note" maxLength={500} />
              </label></details>
              <button disabled={busy || !!pending}>{L("관측 저장", "Save observation")}</button>
            </form>
          </details>
          <CropHistory cycle={cycle} busy={busy || !!pending} onWrite={payload => persist({path: `/v1/cultivation/cycles/${cycle.id}/events`, payload})} />
          <details><summary>{L("지난 수확 보기", "Show past harvests")}</summary>
          {cycle.harvests.map((h, i) => (
            <p key={i}>
              {formatSensorUpdateTime(h.harvested_at)}, {h.weight_kg}kg,{" "}
              {L(`${h.removed_count}주 종료`, `${h.removed_count} ${h.removed_count === 1 ? "plant" : "plants"} finished`)}
            </p>
          ))}</details>
          </details>
        </>
      ) : (
        <>
          <p>{L("이 위치의 재배 정보를 등록하세요.", "Register cultivation for this location.")}</p>
          <form data-work="create" onSubmit={(e) => void submit(e, "create")}>
            <details><summary>{L(`함께 등록할 위치 (${slots.length}곳)`, `Locations to register together (${slots.length})`)}</summary>{layout?.beds.map(b=><fieldset key={b.id}><legend>{place(b.label)}</legend>{b.tiers.map(t=>{const k=`${b.id}:${t.tier}`,occupied=cycles.some(c=>c.bed_id===b.id&&c.tier===t.tier&&c.status==="growing");return <label key={k}><input type="checkbox" checked={slots.includes(k)} disabled={occupied} onChange={e=>setSlots(v=>e.target.checked?[...v,k]:v.filter(x=>x!==k))}/>{L(`${t.tier}단`, `Tier ${t.tier}`)} {occupied?L("재배 중", "Growing"):""}</label>;})}</fieldset>)}</details>
            <details><summary>{L("작물 정보", "Crop details")} / {term(farm.crop)}</summary><label>
              {L("작물", "Crop")}
              <input
                name="crop"
                defaultValue={farm.crop}
                required
                maxLength={100}
              />
            </label>
            <label>
              {L("품종", "Cultivar")}
              <input
                name="cultivar"
                defaultValue={farm.cultivar}
                maxLength={100}
              />
            </label>
            <label>
              {L("수확 부위", "Harvested part")}
              <input name="part" defaultValue="잎" required maxLength={50} />
            </label>
            </details><label>
              {L("정식일", "Planting date")}
              <input name="date" type="date" required />
            </label>
            <label>
              {L("개체 수", "Plant count")}
              <input name="count" type="number" inputMode="decimal" min="1" step="1" required />
            </label>
            <details><summary>{L("수확 일정 (선택)", "Harvest schedule (optional)")}</summary><label>
              {L("수확 예정 시작", "Harvest from")}
              <input name="from" type="date" />
            </label>
            <label>
              {L("수확 예정 종료", "Harvest until")}
              <input name="to" type="date" />
            </label>
            </details><button className="farm-primary" disabled={busy || !!pending || !slots.length}>
              {L("재배 정보 등록", "Register cultivation")}
            </button>
          </form>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {cycles.filter(c=>c.bed_id===selection.bedId&&c.tier===selection.tier&&c.status!=="growing").map(c=><details key={c.id}><summary>{L("지난 재배", "Past cycle")} / {c.planted_on}, {term(c.crop)}</summary><CropHistory cycle={c} busy={busy||!!pending} onWrite={payload=>persist({path:`/v1/cultivation/cycles/${c.id}/events`,payload})}/></details>)}
    </div>
  );
}

export function WorkTime({value}: {value?: string}) {
  const stamp = (v: Date) => new Date(v.getTime()+9*3600000).toISOString().slice(0,16);
  const [at,setAt]=useState(()=>stamp(value ? new Date(value) : new Date()));
  return <div><p>{L("작업 시각", "Work time")} / {formatSensorUpdateTime(at+":00+09:00")}</p><input type="hidden" name="at" value={at}/><details><summary>{L("작업 시각 변경", "Change work time")}</summary><label>{L("작업한 날짜와 시각", "Date and time of work")}<input type="datetime-local" required max={stamp(new Date())} value={at} onChange={e=>setAt(e.target.value)}/></label></details></div>;
}

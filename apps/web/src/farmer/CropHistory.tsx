import { useState } from "react";
import type { CropCycle } from "../farm-spatial";
import { stamp as formatSensorUpdateTime } from "./time-format";
import { WorkTime } from "./CultivationForm";
import { L } from "./i18n";
export function CropHistory({cycle, busy, onWrite}: {cycle: CropCycle; busy: boolean; onWrite: (value: Record<string,unknown>)=>Promise<boolean>}) {
  const [target, setTarget] = useState<NonNullable<CropCycle["events"]>[number] | null>(null);
  const kind = target?.effective_kind ?? target?.kind ?? "closure";
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const data=new FormData(e.currentTarget), s=(k:string)=>String(data.get(k)??"");
    const saved = await onWrite({request_id:crypto.randomUUID(), revision:cycle.revision??0, kind:target?"correction":"closure", corrects:target?.id??null,
      occurred_at:new Date(s("at")+":00+09:00").toISOString(),note:s("note"),
      ...(kind==="closure"?{reason:s("reason")}:kind==="harvest"?{weight_kg:Number(s("weight")),removed_count:Number(s("removed"))}:{growth_percent:Number(s("growth"))})});
    if(saved) setTarget(null);
  }
  const kindLabels: Record<string,string> = {harvest:L("수확","Harvest"),observation:L("생육 관측","Growth check"),closure:L("재배 종료","Cycle ended"),correction:L("정정","Correction")};
  return <details><summary>{L("기록 정정·고사·폐기","Correct records, dead or discarded plants")}</summary>
    <p>{L("원기록은 보존합니다. 고사·폐기는 수확량 없이 종료합니다.","The original record is kept. Dead or discarded plants end the cycle without a harvest weight.")}</p>
    <form key={target?.id??"closure"} onSubmit={e=>void submit(e)}><h3>{target?L("선택한 기록 정정","Correct selected record"):L("재배 종료","End cycle")}</h3><WorkTime value={target?.occurred_at}/>
      {kind==="closure"?<label>{L("종료 사유","Reason for ending")}<select name="reason" defaultValue={target?.reason??"discarded"}><option value="discarded">{L("폐기","Discarded")}</option><option value="dead">{L("고사","Dead")}</option><option value="stopped">{L("재배 중단","Cultivation stopped")}</option></select></label>:kind==="harvest"?<><label>{L("수확량 kg","Harvest weight kg")}<input name="weight" type="number" min="0.001" step="0.001" required defaultValue={target?.weight_kg}/></label><label>{L("종료 개체","Plants removed")}<input name="removed" type="number" min="0" required defaultValue={target?.removed_count}/></label></>:<label>{L("생육 정도 %","Growth %")}<input name="growth" type="number" min="0" max="100" required defaultValue={target?.growth_percent}/></label>}
      <label>{L("사유","Reason")}<input name="note" required maxLength={2000}/></label><button disabled={busy || (!target && cycle.status!=="growing")}>{target?L("정정 기록 저장","Save correction"):L("재배 종료 기록 저장","Save cycle end")}</button>{target&&<button type="button" onClick={()=>setTarget(null)}>{L("정정 취소","Cancel correction")}</button>}
    </form>
    {[...(cycle.events??[])].reverse().map(event=><article key={event.id}><b>{kindLabels[event.kind]??L("기록","Record")}</b><p>{L("작업","Done")} {formatSensorUpdateTime(event.occurred_at)}<br/>{L("저장","Saved")} {formatSensorUpdateTime(event.recorded_at)}. {event.note}</p>{!(cycle.events??[]).some(e=>e.corrects===event.id)&&<button onClick={()=>setTarget(event)}>{L("정정하기","Correct")}</button>}</article>)}
  </details>;
}

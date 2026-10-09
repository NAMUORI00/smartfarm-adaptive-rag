import {useEffect,useState} from "react";
import {farmRequest} from "../farm-spatial";
import type {FarmId} from "../types";
import {FarmIcon} from "./FarmIcon";
import { L } from "./i18n";
type RuntimeState={status:string;run_id?:string;time_scale?:string;last_tick?:string};
/**
 * Run control for a backend that exposes an operating loop. In the header
 * (`compact`) it stays silent while the farm is running and surfaces a short
 * chip plus one action only when the loop is paused or stopped. A backend
 * without this endpoint (a field gateway) simply has no such control, so the
 * panel renders nothing instead of an error; the header already reports the
 * data connection.
 */
export function OperatingPanel({farmId,manage=false,compact=false}:{farmId:FarmId;manage?:boolean;compact?:boolean}) {
  const [state,setState]=useState<RuntimeState|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  // Stopping the farm's operation asks once more; pausing does not.
  const [confirming,setConfirming]=useState(false);
  useEffect(()=>{let live=true;void farmRequest<RuntimeState>(farmId,"/v1/demo/runtime").then(v=>{if(live)setState(v);}).catch(()=>{if(live)setError("unsupported");});return()=>{live=false;};},[farmId]);
  async function change(action:string){setBusy(true);setError("");try{setState(await farmRequest(farmId,"/v1/demo/runtime",{action}));}catch{setError(L("처리 결과 확인 필요. 상태를 다시 조회하세요.","Result unconfirmed. Check the status again."));}finally{setBusy(false);}}
  function reload(){void farmRequest<RuntimeState>(farmId,"/v1/demo/runtime").then(v=>{setState(v);setError("");}).catch(()=>setError(L("운영 연결을 확인하세요.","Check the operations connection.")));}
  const statusText=state?.status==="running"?L("운영 중","running"):state?.status==="paused"?L("일시정지","paused"):state?.status==="stopped"?L("운영 종료","stopped"):L("운영 준비","getting ready");
  if(error==="unsupported"&&!state)return null;
  if(compact){
    if(error||!state||state.status==="running")return null;
    return <section className="fm-operating-chip" aria-label={L("농장 운영 상태","Farm operation status")}>
      <FarmIcon name="warning" /><span>{L(`농장 운영 ${statusText}`,`Farm operation ${statusText}`)}</span>
      {state.status==="stopped"?<button disabled={busy} onClick={()=>void change("start")}>{L("운영 시작","Start")}</button>
        :<button disabled={busy} onClick={()=>void change("resume")}>{L("운영 재개","Resume")}</button>}
    </section>;
  }
  if(manage){
    const stopped=state?.status==="stopped";
    return <div className="fm-operating-manage">
      <p className="fm-setting-status">{L("현재","Now")} <strong>{statusText}</strong></p>
      <div className="fm-setting-actions">
        {stopped&&<button type="button" className="fm-primary" disabled={busy} onClick={()=>void change("start")}>{L("농장 운영 시작","Start farm operation")}</button>}
        {!stopped&&<button type="button" disabled={busy||!state} onClick={()=>void change(state?.status==="running"?"pause":"resume")}>{state?.status==="running"?L("운영 일시정지","Pause operation"):L("운영 재개","Resume operation")}</button>}
        {!stopped&&(confirming
          ?<><button type="button" className="fm-danger" disabled={busy} onClick={()=>{setConfirming(false);void change("stop");}}>{L("종료 확인","Confirm stop")}</button><button type="button" onClick={()=>setConfirming(false)}>{L("취소","Cancel")}</button></>
          :<button type="button" className="fm-danger-outline" disabled={busy||!state} onClick={()=>setConfirming(true)}>{L("운영 종료","Stop operation")}</button>)}
      </div>
      {confirming&&<small className="fm-setting-note" role="status">{L("종료하면 새 사건과 관측 변화가 멈춥니다. 지금까지의 기록은 남습니다.","Stopping halts new events and changes. Records so far are kept.")}</small>}
      {error&&error!=="unsupported"&&<p role="status">{error}<button type="button" disabled={busy} onClick={reload}>{L("상태 다시 확인","Check status again")}</button></p>}
    </div>;
  }
  return <section className="fm-operating-guide">
    <p><strong>{L("농장 운영","Farm operation")}</strong> / {statusText}</p>
    {state?.status==="stopped"&&<button disabled={busy} onClick={()=>void change("start")}>{L("농장 운영 시작","Start farm operation")}</button>}
    {(manage||state?.status==="paused")&&state?.status!=="stopped"&&<button disabled={busy||!state} onClick={()=>void change(state?.status==="running"?"pause":"resume")}>{state?.status==="running"?L("운영 일시정지","Pause operation"):L("운영 재개","Resume operation")}</button>}
    {manage&&state?.status!=="stopped"&&<button disabled={busy} onClick={()=>void change("stop")}>{L("운영 종료, 기록 보존","Stop operation, keep records")}</button>}
    {error&&error!=="unsupported"&&<p role="status">{error}<button disabled={busy} onClick={reload}>{L("상태 다시 확인","Check status again")}</button></p>}
  </section>;
}

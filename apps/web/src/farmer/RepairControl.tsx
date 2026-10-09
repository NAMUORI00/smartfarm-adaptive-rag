import {useState} from "react";
import {farmRequest} from "../farm-spatial";
import type {FarmId} from "../types";
import { L, term } from "./i18n";
export function RepairControl({farmId,instanceId,label,fault,onChanged}:{farmId:FarmId;instanceId:string;label:string;fault:boolean;onChanged:()=>Promise<void>}){
 const key=`farmer.repair.${farmId}.${instanceId}`;
 const [pending,setPending]=useState(()=>localStorage.getItem(key)),[open,setOpen]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
 async function repair(){if(busy)return;setBusy(true);const id=pending??crypto.randomUUID();setPending(id);localStorage.setItem(key,id);
 try {let confirmed=false;if(pending){const result=await farmRequest<{request_status:string}>(farmId,`/v1/demo/runtime?request_id=${encodeURIComponent(id)}`);confirmed=result.request_status==="confirmed";}
 if(!confirmed)await farmRequest(farmId,"/v1/demo/runtime",{action:"repair",instance_id:instanceId,request_id:id});
 localStorage.removeItem(key);setPending(null);setOpen(false);setMessage(L("점검·복구를 기록했습니다. 출력과 관측 회복은 계속 확인하세요.","Inspection and repair recorded. Keep checking output and sensor recovery."));await onChanged();
 }catch{setMessage(L("반영 여부 확인 필요. 같은 점검 요청으로 다시 확인하세요.","Result unconfirmed. Check again with the same inspection request."));}finally{setBusy(false);}}
 if(!fault&&!pending&&!message)return null;
 return <section>{message&&<p role="status">{message}</p>}{pending?<button disabled={busy} onClick={()=>void repair()}>{L("같은 점검 요청 확인","Check the same inspection request")}</button>:fault&&<button onClick={()=>setOpen(v=>!v)}>{L("점검·복구 기록","Record inspection and repair")}</button>}{open&&!pending&&<div><p>{L(`${label}을 현장에서 점검·복구했으면 기록합니다. 환경 경보는 관측 회복을 확인한 뒤 종료됩니다.`,`Record this once ${term(label)} has been inspected and repaired on site. Environment alerts close after sensor readings recover.`)}</p><button disabled={busy} onClick={()=>void repair()}>{L("복구 완료 기록","Record repair complete")}</button><button onClick={()=>setOpen(false)}>{L("취소","Cancel")}</button></div>}</section>;
}

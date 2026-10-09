import type {ControlDraft} from "../types";
export type PendingControl = {draft:ControlDraft; revision:string; requestId:string; uncertain?:boolean; context?:{alertId:string;occurrenceId:string}|null};
const prefix=(farm:string)=>`farmer.control.${farm}.`;
const key=(farm:string,p:PendingControl)=>prefix(farm)+p.requestId;
export function pendingControls(farm:string):PendingControl[]{
  // Preserve uncertain requests saved by the previous interface version.
  try {const old=JSON.parse(sessionStorage.getItem("farmer.pendingControl")??"null");
    if((old?.draft?.farmId===farm || (!old?.draft?.farmId && farm==="farm-wasabi-a"))&&old?.requestId&&old?.draft?.target){rememberControl(farm,old);sessionStorage.removeItem("farmer.pendingControl");}
  } catch { /* Keep unreadable legacy data available for diagnosis. */ }
  return Object.keys(localStorage).filter(k=>k.startsWith(prefix(farm))).flatMap(k=>{try{const p=JSON.parse(localStorage.getItem(k)??"null");return p?.draft?.target&&p.requestId?[p]:[];}catch{return [];}});
}
export function rememberControl(farm:string,p:PendingControl){localStorage.setItem(key(farm,p),JSON.stringify({...p,uncertain:true}));}
export function forgetControl(farm:string,p:PendingControl){localStorage.removeItem(key(farm,p));}

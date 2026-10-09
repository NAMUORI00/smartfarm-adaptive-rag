import {useEffect,useState} from "react";
import type {FarmId} from "../types";
import {farmRequest} from "../farm-spatial";
import {AuthenticatedMedia} from "../AuthenticatedMedia";
import { L } from "./i18n";
type Clip={id:string;title:string;source_label:string;source_url:string;license:string;attribution:string;difference:string};
export function ExampleVideos({farmId}:{farmId:FarmId}){
  const [clips,setClips]=useState<Clip[]>([]),[selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{let active=true;void farmRequest<{clips:Clip[]}>(farmId,"/v1/video/examples").then(v=>{if(active)setClips(v.clips);}).catch(()=>{});return()=>{active=false;};},[farmId]);
  return <section><h3>{L("예시 영상, 학습 자료","Example videos for learning")}</h3><p>{L("현재 베드 영상이나 이번 사건의 증거가 아닙니다. AI 조절 근거로 사용하지 않습니다.","Not footage of a current bed or evidence for this event. Not used as grounds for AI control.")}</p>{clips.map(c=><article key={c.id}><strong>{c.title}</strong><p>{c.difference}</p><p>{c.attribution}, {c.license}</p><a href={c.source_url} target="_blank" rel="noreferrer">{L("출처·이용 조건 보기","View source and terms of use")}</a><button onClick={()=>setSelected(selected===c.id?null:c.id)}>{selected===c.id?L("예시 닫기","Close example"):L("예시 영상 재생","Play example video")}</button>{selected===c.id&&<AuthenticatedMedia farmId={farmId} path={`/v1/video/media/${c.id}`}/>}</article>)}{!clips.length&&<p>{L("출처·이용 조건이 확인된 예시 영상의 연결을 확인하세요.","Check the connection for example videos with verified source and terms.")}</p>}</section>;
}

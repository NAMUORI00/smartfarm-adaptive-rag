import { L } from "./i18n";

/**
 * The customary "for reference only" notice on AI and third-party helpers:
 * it says what the output is, that it is not a diagnosis, guarantee or
 * official record, and who decides. One wording per kind, used everywhere.
 */
export type RefKind = "photo" | "voice" | "harvest" | "report" | "notify" | "weather" | "standards" | "translation" | "disease" | "reference";

export function refText(kind: RefKind): string {
  switch (kind) {
    case "photo":
      return L("AI 사진 확인은 참고용이며 병해 진단이 아닙니다. 사진에 보이지 않는 원인은 판단하지 않습니다. 정확한 진단은 농업기술센터 등 전문기관에 의뢰하세요.", "The AI photo check is for reference only and is not a disease diagnosis. It does not judge causes the photo cannot show. For a diagnosis, consult an agricultural extension office or another expert body.");
    case "voice":
      return L("음성 인식은 틀릴 수 있습니다. 보내거나 저장하기 전에 내용을 확인하세요.", "Speech recognition can be wrong. Check the text before sending or saving.");
    case "harvest":
      return L("재배 자료의 일반적인 기간을 옮긴 참고 정보이며 이 농장의 수확 시기나 수량을 보증하지 않습니다.", "General periods quoted from the growing guides, for reference only. They do not guarantee this farm's harvest time or yield.");
    case "report":
      return L("기록된 값만 집계한 참고 자료입니다. 공식 보고·정산·인증 자료로 쓰기 전에 원자료를 확인하세요.", "A reference summary of recorded values only. Check the source records before using it for official reports, settlement or certification.");
    case "notify":
      return L("알림은 보조 수단이며 전달을 보장하지 않습니다. 중요한 경보는 화면에서 직접 확인하세요.", "Notifications are an aid and delivery is not guaranteed. Check important alerts on screen.");
    case "weather":
      return L("Open-Meteo 예보를 바탕으로 한 참고 정보이며 실제 기상과 다를 수 있습니다. 기상청 특보를 함께 확인하세요.", "Reference information based on the Open-Meteo forecast; actual weather may differ. Check official weather warnings too.");
    case "standards":
      return L("등록된 문서를 근거로 한 참고 답변이며 법적 효력이 없습니다. 최신 인증·출하 기준은 해당 기관에 확인하세요.", "A reference answer from the registered documents, with no legal force. Confirm current certification and shipping standards with the issuing body.");
    case "translation":
      return L("AI가 작성한 답변은 참고용이며 원문 자료와 차이가 있을 수 있습니다.", "Answers written by the AI are for reference and may differ from the source documents.");
    case "disease":
      return L("센서 기록과 재배 자료의 조건을 대조한 참고 알림이며 병해 발생을 예측하거나 진단하지 않습니다.", "A reference notice matching sensor records with conditions in the growing guides. It does not predict or diagnose disease.");
    default:
      return L("참고용 정보입니다. 최종 판단과 조치는 사용자가 결정합니다.", "For reference only. Decisions and actions remain yours.");
  }
}

export function RefNote({ kind, compact = false }: { kind: RefKind; compact?: boolean }) {
  return (
    <p className={`fm-refnote ${compact ? "is-compact" : ""}`} role="note">
      <span className="fm-refnote-tag">{L("참고용", "Reference")}</span>
      {refText(kind)}
    </p>
  );
}

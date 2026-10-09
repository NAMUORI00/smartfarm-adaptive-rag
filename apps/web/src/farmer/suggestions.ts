import type { Alert } from "../types";
import { L } from "./i18n.ts";

/**
 * The three questions offered in the assistant follow what is happening at
 * the chosen place: a doubtful sensor, an open alert, a device the farmer just
 * changed, a harvest coming up. Every question still asks the assistant to
 * separate what the readings confirm from what it is guessing.
 */
export type Suggestion = {
  id: string;
  label: string;
  icon: "sensor" | "book" | "clock" | "warning" | "harvest" | "controls";
  question: string;
};

export type SuggestionContext = {
  crop: string;
  alerts: Pick<Alert, "title" | "kind" | "severity">[];
  recentControl: { device: string; value: string } | null;
  /** Days until the planned harvest; 0 today, negative when overdue; null when none is registered. */
  harvestInDays: number | null;
};

const ASK_HONEST = "관측으로 확인한 사실과 추정을 구분해 주세요.";

/** Korean particles after a word: 을/를 and (으)로, chosen by its last syllable. */
function lastConsonant(word: string): number | null {
  const code = word.trim().slice(-1).charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 ? code % 28 : null;
}
function withObject(word: string) {
  const c = lastConsonant(word);
  return `${word}${c ? "을" : "를"}`;
}
function withDirection(word: string) {
  const c = lastConsonant(word);
  return c && c !== 8 ? "으로" : "로";
}

export function suggestedQuestions(ctx: SuggestionContext, count = 3): Suggestion[] {
  const list: Suggestion[] = [
    { id: "state", label: L("현재 상태 점검", "Check current status"), icon: "sensor", question: "지금 센서 상태를 설명하고 가능한 원인과 현장에서 확인할 일을 구분해 알려주세요." },
  ];
  const sensor = ctx.alerts.find((a) => a.kind === "sensor_health");
  if (sensor) list.push({ id: "sensor", label: L("센서 점검 방법", "How to check sensors"), icon: "warning", question: `${sensor.title.includes("온도") ? "온도 센서" : "센서"} 고장 점검 방법과 점검 전까지 이 값을 다루는 방법` });
  const risk = [...ctx.alerts].filter((a) => a.kind === "crop_risk").sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"))[0];
  if (risk) list.push({ id: "alert", label: L("경보 대응 방법", "How to respond to the alert"), icon: "warning", question: `${ctx.crop} ${risk.title.replace(/\s*경보$/, "")} 대응 방법과 조절할 설비` });
  if (ctx.recentControl) {
    // "A동 1구역 · 공기 온도 센서 재보정" → "공기 온도 센서 재보정": the place is already the context.
    const device = ctx.recentControl.device.split("·").pop()!.trim();
    list.push({ id: "after-control", label: L("조절 후 확인 항목", "What to check after a change"), icon: "controls", question: `방금 ${withObject(device)} "${ctx.recentControl.value}"${withDirection(ctx.recentControl.value)} 조절했습니다. 회복을 어떤 값으로 확인하고 얼마나 기다려야 하나요? ${ASK_HONEST}` });
  }
  if (ctx.harvestInDays !== null && ctx.harvestInDays <= 7) {
    const when = ctx.harvestInDays < 0 ? "예정일이 지났어요" : ctx.harvestInDays === 0 ? "오늘이에요" : `${ctx.harvestInDays}일 뒤예요`;
    list.push({ id: "harvest", label: L("수확 전 확인 항목", "What to check before harvest"), icon: "harvest", question: `${ctx.crop} 수확이 ${when}. 수확 전에 확인할 것을 출처와 함께 알려주세요. ${ASK_HONEST}` });
  }
  list.push({ id: "guide", label: L("재배 기준", "Growing standards"), icon: "book", question: `${ctx.crop}의 온도와 습도는 어떻게 관리하나요? 출처와 함께 설명해 주세요.` });
  list.push({ id: "outlook", label: L("향후 변화 전망", "Outlook for coming changes"), icon: "clock", question: "앞으로 예상되는 변화가 있나요? 관측으로 확인한 사실과 추정을 구분하고, 충분한 관측이 없으면 예측할 수 없다고 밝혀 주세요." });
  return list.slice(0, Math.max(1, count));
}

/** Days from today (Asia/Seoul) to a YYYY-MM-DD date; null when absent. */
export function daysUntil(date: string | null | undefined, now = Date.now()): number | null {
  if (!date) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const a = Date.parse(`${date}T00:00:00Z`), b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

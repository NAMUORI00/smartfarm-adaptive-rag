/**
 * Console language. Korean is the default; English is a full second language
 * for the console's own words. Text written by the farm's backend (alert
 * titles, advisor answers, source titles) arrives in Korean and is shown as
 * received, except for place names and a few fixed alert titles mapped here.
 *
 * Call sites pass both wordings: `L("오늘 수확", "Harvest today")`. Pure
 * modules read the same store, so a language change re-renders everything
 * from the root without keys or dictionaries to keep in sync.
 */
export type Lang = "ko" | "en";

const KEY = "farmer.lang";
let current: Lang = read();
const listeners = new Set<() => void>();

function read(): Lang {
  try {
    const saved = globalThis.localStorage?.getItem(KEY);
    return saved === "en" ? "en" : "ko";
  } catch {
    return "ko";
  }
}

export function getLang(): Lang {
  return current;
}

export function setLang(next: Lang) {
  if (next === current) return;
  current = next;
  try { globalThis.localStorage?.setItem(KEY, next); } catch { /* storage unavailable */ }
  try { if (typeof document !== "undefined") document.documentElement.lang = next; } catch { /* no document */ }
  listeners.forEach((fn) => fn());
}

export function subscribeLang(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The wording for the current language. */
export function L(ko: string, en: string): string {
  return current === "en" ? en : ko;
}

/** "A구역" → "Zone A", "4번 베드" → "Bed 4", "7–9번" → "7–9" in English; unchanged in Korean. */
export function place(label: string | null | undefined): string {
  if (!label) return "";
  if (current === "ko") return label;
  return label
    .replace(/([A-Z])구역/g, "Zone $1")
    .replace(/(\d+)번 베드/g, "Bed $1")
    .replace(/(\d+)–(\d+)번/g, "beds $1–$2")
    .replace(/(\d+)번/g, "$1")
    .replace(/(\d+)단/g, "tier $1");
}

/**
 * A Korean particle after a word: the first form after a final consonant, the
 * second after a vowel ("천창과", "냉각기와"). A word that does not end in
 * Hangul takes the vowel form.
 */
export function josa(word: string, afterConsonant: string, afterVowel: string): string {
  const code = word.trim().slice(-1).charCodeAt(0) - 0xac00;
  return code >= 0 && code <= 11171 && code % 28 !== 0 ? afterConsonant : afterVowel;
}

/** Alert and device names that the backend sends in Korean, for English screens. */
const TERMS: [RegExp, string][] = [
  // Harvest parts, and the cultivations the growing guides name, when they are the whole name.
  [/^잎·잎자루$/, "leaves and petioles"],
  [/^잎자루$/, "petioles"],
  [/^잎$/, "leaves"],
  [/^(근경|뿌리줄기)$/, "rhizome"],
  [/^밭재배$/, "Field culture"],
  [/^물재배$/, "Water culture"],
  [/^(양액|수경)재배$/, "Hydroponic culture"],
  [/^시설재배$/, "Greenhouse culture"],
  [/^노지재배$/, "Open-field culture"],
  // Kinds of guide in the library, when they are the whole name.
  [/^PDF 문서$/, "PDF document"],
  [/^웹 문서$/, "Web page"],
  [/^텍스트 문서$/, "Text document"],
  [/^농장 운영 SOP$/, "Farm SOP"],
  [/^동료심사 논문$/, "Peer-reviewed paper"],
  [/^시뮬레이터 정책$/, "Simulator policy"],
  [/^현장 운영 사례$/, "Field operation case"],
  [/^공공 적응 사례$/, "Public adaptation case"],
  [/^공식 농업유산 자료$/, "Official agricultural heritage record"],
  // Device names as the approvals carry them (api.ts mapProposal).
  [/천창 개도/g, "Roof vent opening"],
  [/측창 개도/g, "Side vent opening"],
  [/재보정 실행/g, "recalibrate"],
  [/냉각 켜기/g, "cooling on"],
  [/냉각 끄기/g, "cooling off"],
  [/난방 켜기/g, "heating on"],
  [/난방 끄기/g, "heating off"],
  [/관수 시작/g, "irrigation on"],
  [/관수 멈춤/g, "irrigation off"],
  [/재배실 온도 센서 건전성 경보/g, "Room temperature sensor health alert"],
  [/재배실 온도 센서 확인/g, "Check room temperature sensor"],
  [/근권 온도 경보/g, "Root-zone temperature alert"],
  [/근권 온도/g, "Root-zone temperature"],
  [/재배실 온도/g, "Room temperature"],
  [/공기 온도 센서 재보정/g, "Air temperature sensor recalibration"],
  [/공기 온도 센서/g, "Air temperature sensor"],
  [/온도 센서/g, "Temperature sensor"],
  [/공기 온도/g, "Air temperature"],
  [/상대습도/g, "Relative humidity"],
  [/저장조 수위/g, "Tank level"],
  [/CO₂ 농도/g, "CO₂"],
  [/상대 습도/g, "Relative humidity"],
  [/습도/g, "Humidity"],
  [/배지 수분지수/g, "Substrate moisture index"],
  [/배지 수분/g, "Substrate moisture"],
  [/공급 EC/g, "Supply EC"],
  [/배액 EC/g, "Drain EC"],
  [/공급 pH/g, "Supply pH"],
  [/배액 pH/g, "Drain pH"],
  [/광량/g, "Light"],
  [/근권 냉각기/g, "Root-zone chiller"],
  [/냉각기/g, "Chiller"],
  [/난방기/g, "Heater"],
  [/관수 펌프/g, "Irrigation pump"],
  [/환기팬/g, "Ventilation fan"],
  [/천창/g, "Roof vent"],
  [/측창/g, "Side vent"],
  [/차광 커튼/g, "Shade curtain"],
  [/차광/g, "Shade"],
  [/고추냉이/g, "Wasabi"],
  [/고설베드/g, "raised-bed"],
  [/([A-Z])동/g, "House $1"],
  [/관수 유량/g, "Irrigation flow"],
  [/관수 압력/g, "Irrigation pressure"],
  [/기온/g, "Air temperature"],
  [/경보/g, "alert"],
];

/** Farm-supplied names in the current language; free text is left as sent. */
export function term(text: string | null | undefined): string {
  if (!text) return "";
  if (current === "ko") return text;
  let out = place(text);
  for (const [pattern, en] of TERMS) out = out.replace(pattern, en);
  return out;
}

/** Fixed sentences the telemetry service writes into alerts, for English screens. */
const SENTENCES: [string, string][] = [
  ["온도 센서 값이 물리 허용 범위를 벗어났습니다. 센서, 배선, 통신 상태를 먼저 점검하세요.", "The temperature sensor reading is outside the physically possible range. Check the sensor, wiring and communication first."],
  ["공기 온도와 근권 온도의 차이가 비정상적으로 큽니다. 작물 위험 판단 전에 센서 상태를 점검하세요.", "The gap between air and root-zone temperature is abnormally large. Check the sensors before judging crop risk."],
  ["관수 사이클이 중단되어 유량이 없습니다. 관수 펌프를 시작하고 배지 수분 회복을 확인하세요.", "The irrigation cycle has stopped and there is no flow. Start the irrigation pump and confirm substrate moisture recovers."],
  ["펌프가 작동 중이지만 관수 유량이 낮습니다. 필터와 관수 라인을 점검하세요.", "The pump is running but irrigation flow is low. Check the filter and irrigation line."],
  ["센서 관측값이 수신되지 않았습니다. 전원·배선·통신 상태를 확인하세요.", "No sensor readings have been received. Check power, wiring and communication."],
  ["센서 데이터 품질이 운영 판단 기준을 충족하지 않습니다.", "Sensor data quality does not meet the operating threshold."],
  ["연결된 경보가 해소되어 센서 정상 범위 복귀를 확인했습니다.", "The linked alert cleared and the readings were confirmed back in range."],
  ["센서가 정상 범위로 돌아온 것을 확인했습니다.", "The readings were confirmed back in range."],
  ["현장 확인이 필요한 상태입니다.", "An on-site check is needed."],
  ["조치 후 센서가 정상 범위로 돌아오는지 확인하고 있습니다.", "Watching whether the readings return to range after the action."],
  ["준비된 장치 조정을 확인하면 바로 반영합니다.", "The prepared adjustment is applied as soon as it is reviewed and allowed."],
  ["원인과 사용할 수 있는 조치를 확인하고 있습니다.", "Looking into the cause and the actions available."],
  // The parts of a structured answer (answer_review_core.render_unit / finish_initial).
  ["현재 관측 연결을 확인해야 합니다. 저장된 값만으로 지금 상태를 판단하지 않습니다.", "The live readings need checking. The current state is not judged from stored values alone."],
  ["최근 관측을 확인할 수 없습니다. 연결 상태를 확인하세요.", "No recent readings. Check the connection."],
  ["현재 수신된 구역 관측은 기준 범위입니다. 자세한 수치는 관측값에서 확인할 수 있습니다.", "The zone's current readings are in range. See the readings for the numbers."],
  ["상태가 달라졌습니다. 필요한 조절을 다시 확인한 뒤 허용해 주세요.", "Conditions changed. Review the needed adjustment again before allowing it."],
  ["직접 조절은 변경 내용을 확인한 뒤 허용할 수 있습니다.", "A direct adjustment can be allowed after reviewing the change."],
  ["판단에 사용한 자료와 관측을 확인하세요.", "Check the sources and readings used."],
  // The console's own short questions (briefing, suggestions, camera findings), as recorded in the advisor history.
  ["온도 센서 고장 점검 방법", "How to check a faulty temperature sensor"],
  ["고추냉이 잎이 누렇게 변하는 원인", "Why wasabi leaves turn yellow"],
  ["고추냉이 잎이 시들고 처지는 원인", "Why wasabi leaves wilt and droop"],
  ["고추냉이 수확 시기", "When to harvest wasabi"],
  ["고추냉이 고온기 차광과 환기 관리", "Shading and ventilation for wasabi in hot weather"],
  ["고추냉이 저온기 보온 관리", "Keeping wasabi warm in cold weather"],
  ["고추냉이 장마철 습도와 배수 관리", "Humidity and drainage for wasabi in the rainy season"],
  ["지금 센서 상태를 설명하고 가능한 원인과 현장에서 확인할 일을 구분해 알려주세요.", "Explain the current sensor state, separating possible causes from what to check on site."],
  // A stored answer whose readings moved again (answer_review.py).
  ["관측이 다시 달라졌습니다. 현재 상태를 확인하고 새로 질문해 주세요.", "The readings changed again. Check the current state and ask a new question."],
  // An answer the readings overtook while it was being written (main.py).
  ["답변을 준비하는 동안 관측이 달라졌습니다. 최신 상태를 다시 확인해야 합니다.", "The readings changed while the answer was being prepared. Check the latest state again."],
  ["경계 통과 확인 · 기존 연구 영상", "Boundary crossing check, published research video"],
  ["AIHub 다각도 CCTV 공개 연구 자료", "AIHub multi-view CCTV public research data"],
  ["사람이 표시된 경계선을 넘어 침입하고 있는가?", "Is a person crossing the marked boundary line?"],
];

/**
 * Alert sentences from the farm's backend in the current language: known fixed
 * sentences and the "range" sentences are translated; anything else is shown
 * as sent.
 */
export function prose(text: string | null | undefined): string {
  if (!text) return "";
  if (current === "ko") return text;
  for (const [ko, en] of SENTENCES) if (text.trim() === ko) return en;
  const range = text.match(/^(.+?)(?:가|이) 시범 운영 (?:recipe|재배 기준) (범위|상한|하한)(?:를|을|보다) (크게 )?(벗어났습니다|낮습니다)\.?$/);
  if (range) {
    const [, metric, bound, far] = range;
    const where = bound === "상한" ? "above the trial upper limit" : bound === "하한" ? "below the trial lower limit" : "outside the trial range";
    return `${term(metric)} is ${far ? "far " : ""}${where}.`;
  }
  const lower = text.match(/^(.+?)(?:가|이) 운영 하한보다 (크게 )?낮습니다\.?$/);
  if (lower) return `${term(lower[1])} is ${lower[2] ? "far " : ""}below the operating lower limit.`;
  const shared = text.match(/^구역 공용 관측 (\d+)개 기준입니다\. 관측 시각: (.*)$/);
  if (shared) return `Based on ${shared[1]} shared zone readings. Read at: ${shared[2]}`;
  // "재배실 온도 65°C (관측 확인 필요) · 근권 온도 16°C (기준 범위)"
  const parts = text.split(" · ").map((part) => part.match(/^(.+?) (-?[\d.]+)(\S*) \((관측 확인 필요|점검 필요|기준 범위)\)$/));
  if (parts.length && parts.every(Boolean)) {
    const state = { "관측 확인 필요": "reading needs a check", "점검 필요": "needs attention", "기준 범위": "in range" } as Record<string, string>;
    return parts.map((m) => `${term(m![1])} ${m![2]}${m![3]} (${state[m![4]]})`).join(" · ");
  }
  const gap = text.match(/^(.+?)(?:와|과) (.+?)의 차이가 비정상적으로 큽니다\. 작물 위험 판단 전에 센서 상태를 점검하세요\.?$/);
  if (gap) return `The gap between ${term(gap[1])} and ${term(gap[2])} is abnormally large. Check the sensors before judging crop risk.`;
  return text;
}

/**
 * A backend title or sentence for display: a known sentence is translated,
 * a short name goes through `term`, and any other Korean sentence is shown
 * whole rather than half-translated word by word.
 */
export function backendText(text: string | null | undefined): string {
  if (!text) return "";
  const cleaned = text.replace(/recipe/g, "재배 기준");
  if (current === "ko") return cleaned;
  const translated = prose(cleaned);
  if (translated !== cleaned) return translated;
  return /[가-힣]/.test(cleaned) && /(니다|세요|습니다)\.?$/.test(cleaned.trim()) ? cleaned : term(cleaned);
}

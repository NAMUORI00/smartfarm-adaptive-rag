import { useEffect, useRef, useState } from "react";
import type { CropCycle, FarmLayout } from "../farm-spatial";
import { farmRequest } from "../farm-spatial";
import type { FarmId } from "../types";
import { parseRecord, passageSource, photoCheck } from "./assist-api";
import type { PhotoCheck, RecordDraft } from "./assist-api";
import { AiMark } from "./AiBrief";
import { FarmIcon } from "./FarmIcon";
import { getLang, L, place } from "./i18n";
import { RefNote } from "./RefNote";

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
};
function recognitionClass(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}
/** Whether this browser can take voice input at all. */
export const voiceSupported = () => typeof window !== "undefined" && recognitionClass() !== null;

/** What went wrong with the microphone, in words the farmer can act on (null: stopped on purpose). */
function voiceError(code: string | undefined): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return L("마이크 사용이 허용되지 않았습니다. 주소창의 사이트 권한에서 마이크를 허용하세요.", "Microphone access is blocked. Allow the microphone in the site permissions.");
    case "no-speech":
      return L("말소리를 듣지 못했습니다. 마이크 단추를 누르고 다시 말해 주세요.", "No speech was heard. Tap the microphone and speak again.");
    case "audio-capture":
      return L("마이크를 찾지 못했습니다.", "No microphone was found.");
    case "network":
      return L("음성 인식 서비스에 연결하지 못했습니다.", "Could not reach the speech recognition service.");
    case "language-not-supported":
      return L("이 브라우저는 이 언어의 음성 인식을 지원하지 않습니다.", "This browser cannot recognise speech in this language.");
    default:
      return L("음성을 알아듣지 못했습니다. 다시 시도해 주세요.", "The speech could not be recognised. Try again.");
  }
}

/**
 * A microphone button: the browser's speech recognition fills the text field.
 * Hidden where the browser has none; a refused microphone or silence is said
 * through `onError` (an empty string clears it).
 */
export function VoiceButton({ onText, onError, label }: { onText: (text: string) => void; onError?: (message: string) => void; label?: string }) {
  const [listening, setListening] = useState(false);
  const ref = useRef<Recognition | null>(null);
  const Rec = typeof window !== "undefined" ? recognitionClass() : null;
  useEffect(() => () => ref.current?.stop(), []);
  if (!Rec) return null;
  function toggle() {
    if (listening) { ref.current?.stop(); return; }
    const rec = new Rec!();
    rec.lang = getLang() === "en" ? "en-US" : "ko-KR";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => { const t = e.results[0]?.[0]?.transcript ?? ""; if (t) { onError?.(""); onText(t); } };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => { setListening(false); const message = voiceError(e.error); if (message) onError?.(message); };
    ref.current = rec;
    try {
      rec.start();
      setListening(true);
      onError?.("");
    } catch {
      setListening(false);
      onError?.(voiceError(undefined) ?? "");
    }
  }
  return (
    <button type="button" className={`fm-voice ${listening ? "is-on" : ""}`} aria-pressed={listening} onClick={toggle} aria-label={listening ? L("음성 입력 멈춤", "Stop voice input") : label ?? L("말로 입력", "Speak")} title={listening ? L("듣는 중… 누르면 멈춤", "Listening… tap to stop") : label ?? L("말로 입력", "Speak")}>
      <FarmIcon name="mic" />
    </button>
  );
}

/**
 * "말로 기록": a sentence becomes a record draft the farmer checks before it
 * is saved. The draft is made on the server by a local parser (or the AI,
 * only with the farm's consent). Nothing is saved without "기록 저장".
 */
export function SpeakRecord({ farmId, layout, cycles, bedId, tier, allowRemote, onSaved, bare = false }: {
  farmId: FarmId; layout: FarmLayout; cycles: CropCycle[]; bedId: string; tier: number; allowRemote: boolean; onSaved: () => Promise<void> | void;
  /** Inside a row that already names it: no heading and no card of its own. */
  bare?: boolean;
}) {
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<RecordDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const d = draft?.draft;
  const bed = layout.beds.find((b) => b.id === (d?.bed_id ?? bedId));
  const cycle = d ? cycles.find((c) => c.bed_id === (d.bed_id ?? bedId) && c.tier === (d.tier ?? tier) && c.status === "growing") : undefined;
  async function makeDraft() {
    if (!text.trim()) return;
    setBusy(true); setMessage("");
    try { setDraft(await parseRecord(farmId, { text: text.trim(), bed_id: bedId, tier, allow_remote: allowRemote })); }
    catch (e) { setMessage(e instanceof Error ? e.message : L("초안을 만들지 못했습니다.", "Could not make a draft.")); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!d || !cycle) return;
    setBusy(true); setMessage("");
    try {
      await farmRequest(farmId, `/v1/cultivation/cycles/${cycle.id}/events`, {
        request_id: crypto.randomUUID(),
        revision: cycle.revision ?? 0,
        occurred_at: new Date().toISOString(),
        kind: d.kind,
        note: d.note ?? text.trim(),
        ...(d.kind === "observation" ? { growth_percent: d.growth_percent } : { removed_count: d.removed_count ?? 0, weight_kg: d.weight_kg ?? 0 }),
      });
      setMessage(L("기록했습니다.", "Recorded."));
      setDraft(null); setText("");
      await onSaved();
    } catch (e) { setMessage(e instanceof Error ? e.message : L("저장하지 못했습니다.", "Could not save.")); }
    finally { setBusy(false); }
  }
  return (
    <section className={`fm-speak ${bare ? "is-bare" : ""}`} aria-label={L("말로 기록", "Record by voice")}>
      {!bare && <strong><AiMark />{L("말로 기록", "Record by speaking")}</strong>}
      <div className="fm-speak-row">
        <input value={text} maxLength={300} onChange={(e) => setText(e.target.value)} placeholder={L("예: 3번 베드 1단 잎 0.5kg 땄어", "e.g. Harvested 0.5 kg of leaves on bed 3, tier 1")} aria-label={L("기록할 내용", "What to record")} />
        <VoiceButton onText={(t) => setText(t)} onError={setMessage} label={L("말로 기록", "Record by speaking")} />
        <button type="button" onClick={() => void makeDraft()} disabled={busy || !text.trim()}>{L("초안 만들기", "Make draft")}</button>
      </div>
      {d && (
        <div className="fm-speak-draft" role="group" aria-label={L("기록 초안", "Record draft")}>
          <p><b>{d.kind === "harvest" ? L("수확", "Harvest") : d.kind === "observation" ? L("생육 관찰", "Growth observation") : L("기록 종류 확인 필요", "Record type unclear")}</b>, {bed ? place(bed.label) : L("베드 확인 필요", "Bed unclear")}{d.tier ? L(`, ${d.tier}단`, `, tier ${d.tier}`) : ""}</p>
          {d.kind && (
            <p>
              {d.kind === "harvest"
                ? L(`무게 ${d.weight_kg ?? "—"}kg, 제거 ${d.removed_count ?? 0}주`, `Weight ${d.weight_kg ?? "—"} kg, removed ${d.removed_count ?? 0}`)
                : L(`생육 ${d.growth_percent ?? "—"}%`, `Growth ${d.growth_percent ?? "—"}%`)}
            </p>
          )}
          {(draft.missing.length > 0 || draft.message) && <p className="fm-hint" role="status">{draft.message ?? L(`빠진 항목: ${draft.missing.join(", ")}`, `Missing: ${draft.missing.join(", ")}`)}</p>}
          {!cycle && <p className="fm-hint">{L("이 베드·단에 재배 중인 회차가 없어 저장할 수 없습니다.", "No growing cycle on that bed and tier, so this cannot be saved.")}</p>}
          <small className="fm-hint">{draft.parser === "llm" ? L("AI가 문장을 읽어 만든 초안입니다.", "Draft made by the AI from your sentence.") : L("문장에서 숫자와 베드를 읽어 만든 초안입니다.", "Draft read from the numbers and bed in your sentence.")}</small>
          <div className="fm-speak-actions">
            <button type="button" className="fm-primary" disabled={busy || !cycle || !d.kind || draft.missing.length > 0} onClick={() => void save()}>{L("기록 저장", "Save record")}</button>
            <button type="button" onClick={() => setDraft(null)}>{L("취소", "Cancel")}</button>
          </div>
        </div>
      )}
      {message && <p className="fm-hint" role="status">{message}</p>}
      <RefNote kind="voice" compact />
    </section>
  );
}

/**
 * Phone photos run to several megabytes; a 1600-pixel JPEG shows the leaves as
 * well, uploads quickly and stays under the server's 6 MB limit. A browser that
 * cannot decode the file sends it as chosen.
 */
async function shrinkPhoto(file: File, max = 1600): Promise<File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1_500_000) { bitmap.close(); return file; }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); return file; }
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg" }) : file;
  } catch {
    return file;
  }
}

/** The server's refusal, in the screen's language. */
function photoError(e: unknown): string {
  const status = (e as { status?: number } | null)?.status;
  const detail = e instanceof Error ? e.message : "";
  if (getLang() === "ko" && /[가-힣]/.test(detail)) return detail;
  if (status === 409) return L("설정에서 '농장 전용 자료도 AI로 요약'을 켜야 합니다.", "Turn on 'Let the AI read farm-only records' in settings first.");
  if (status === 413) return L("사진이 너무 큽니다. 6MB 이하 사진을 골라 주세요.", "The photo is too large; choose one under 6 MB.");
  if (status === 422) return /JPG/.test(detail) ? L("JPG, PNG, WEBP 사진만 확인할 수 있습니다.", "Only JPG, PNG or WEBP photos can be checked.") : L("사진과 대상 베드를 확인해 주세요.", "Check the photo and the bed it is for.");
  if (status === 502) return L("사진 확인 AI에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요.", "Could not reach the photo-check AI. Try again shortly.");
  if (status === 503) return L("사진을 확인할 AI 모델이 설정되지 않았습니다.", "No AI model is set up for photo checks.");
  return L("사진을 확인하지 못했습니다.", "Could not check the photo.");
}

/**
 * "사진으로 확인": each photo goes to the AI only after the farmer agrees to
 * that photo. It says what it sees, holds back on what a photo cannot show
 * (the cause), and quotes the growing guides for what to check next.
 */
export function PhotoCheckBox({ farmId, zoneId, bedId, onAsk, farmConsent, onOpenSettings }: { farmId: FarmId; zoneId: string | null; bedId: string | null; onAsk: (question: string) => void; farmConsent: boolean; onOpenSettings: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PhotoCheck | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (!file) { setPreview(null); return; } const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  async function run() {
    if (!file || !consent) return;
    setBusy(true); setError(""); setResult(null);
    try { setResult(await photoCheck(farmId, await shrinkPhoto(file), { zone_id: zoneId, bed_id: bedId })); }
    catch (e) { setError(photoError(e)); }
    finally { setBusy(false); }
  }
  return (
    <section className="fm-photo" aria-label={L("사진으로 확인", "Check a photo")}>
      <strong><AiMark />{L("사진으로 확인", "Check a photo")}</strong>
      {!farmConsent && (
        <p className="fm-hint" role="note">
          {L("농장 사진은 농장 전용 자료입니다. 설정에서 '농장 전용 자료도 AI로 요약'을 켜야 사진 확인을 쓸 수 있습니다.", "Farm photos are farm-only records. Turn on 'Let the AI read farm-only records' in settings to use the photo check.")}{" "}
          <button type="button" className="fm-link-button" onClick={onOpenSettings}>{L("설정 열기", "Open settings")}</button>
        </p>
      )}
      <label className="fm-photo-pick">
        <FarmIcon name="camera" /><span className="fm-photo-name">{file ? file.name : L("사진 고르기 또는 찍기", "Choose or take a photo")}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setResult(null); setError(""); setConsent(false); }} />
      </label>
      {preview && <img className="fm-photo-preview" src={preview} alt={L("확인할 사진", "Photo to check")} />}
      <label className="fm-inline-check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {L("이 사진을 외부 AI로 보내 확인하는 데 동의합니다. 사진은 저장하지 않습니다.", "I agree to send this photo to an outside AI for checking. The photo is not stored.")}
      </label>
      <button type="button" className="fm-primary" disabled={!file || !consent || !farmConsent || busy} onClick={() => void run()}>{busy ? L("AI가 사진을 보는 중…", "The AI is looking…") : L("사진 확인", "Check photo")}</button>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div className="fm-photo-result">
          <p><span className={`fm-badge ${result.decision === "answer" ? "is-ok" : "is-info"}`}>{result.decision === "answer" ? L("보이는 것", "What is visible") : L("판단 보류", "Held back")}</span></p>
          {result.findings.length > 0 && (
            <ul>{result.findings.map((f) => <li key={f.text} lang="ko">{f.text} <small>{L(`확신도 ${Math.round(f.confidence * 100)}%`, `confidence ${Math.round(f.confidence * 100)}%`)}</small></li>)}</ul>
          )}
          {result.abstentions.length > 0 && (
            <ul className="fm-photo-abstain">{result.abstentions.map((a) => <li key={a.question} lang="ko"><b>{a.question}</b> {a.reason}</li>)}</ul>
          )}
          {result.passages.length > 0 && (
            <ul className="fm-passages">{result.passages.map((p) => <li key={p.source_id + p.sentence}><q lang="ko">{p.sentence}</q><small>{passageSource(p)}</small></li>)}</ul>
          )}
          {getLang() === "en" && (result.findings.length > 0 || result.abstentions.length > 0) && <small className="fm-hint">{L("AI 관찰은 한국어로 적혀 있습니다.", "The AI's notes are written in Korean.")}</small>}
          {result.findings.length > 0 && (
            // A short question the advisor can search ("고추냉이 잎 황변 원인"); long findings find no guide passages.
            <button type="button" onClick={() => onAsk(result.symptoms?.length ? `고추냉이 잎 ${result.symptoms.join(" ")} 원인` : `고추냉이 ${result.findings.map((f) => f.text).slice(0, 2).join(", ")} 원인과 확인 방법`)}>{L("AI에게 원인 묻기", "Ask the AI why")}</button>
          )}
        </div>
      )}
      <RefNote kind="photo" compact />
    </section>
  );
}

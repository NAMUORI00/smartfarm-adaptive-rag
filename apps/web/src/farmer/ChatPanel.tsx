import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { AdvisorTurn, ControlDraft, FarmId, KnowledgeDocument } from "../types";
import { AdvisorMarkdown } from "../AdvisorMarkdown";
import { groupKnowledgeSources } from "../source-library";
import { AnswerCard, authorOf, historyCite, HistorySources, usedGuides, withReadableTimes } from "./AnswerCard";
import type { ReaderTarget } from "./DocReader";
import { AiMark } from "./AiBrief";
import { farmWords } from "./ai-brief";
import { PhotoCheckBox, VoiceButton, voiceSupported } from "./CaptureAssist";
import { FarmIcon } from "./FarmIcon";
import { getLang, L, prose } from "./i18n";
import { ModuleTag } from "./ModuleTag";
import { RefNote } from "./RefNote";
import { shortStamp } from "./time-format";

type Suggestion = { id: string; label: string; question: string };

/**
 * The advisor as a chat: questions on the right, the AI's answers on the left,
 * the latest at the bottom next to the input. Everything the first version
 * stacked above the answer — preset questions, earlier questions, the photo
 * check, source selection — moves to where messengers keep it: quick replies
 * over the input, the conversation itself, and a "+" tray.
 */
export function ChatPanel(props: {
  open: boolean;
  chatRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  farmId: FarmId;
  zoneId: string | null;
  bedId: string | null;
  turn: AdvisorTurn | undefined;
  turns: AdvisorTurn[];
  /** Earlier answers for the same place, oldest first. */
  history: AdvisorTurn[];
  /** An answer to bring into view and open in full (one opened from the library). */
  focusResponseId?: string | null;
  busy: boolean;
  sending: string | null;
  error: string;
  suggestions: Suggestion[];
  /** The text to show for a question: the English name of a preset question on the English screen. */
  questionLabel: (question: string) => string;
  question: string;
  setQuestion: (value: string | ((now: string) => string)) => void;
  onAsk: (question: string) => Promise<boolean>;
  onReview: (draft: ControlDraft) => void;
  onRecheck: (responseId: string) => void;
  zoneLabel: (id: string) => string;
  lang: string;
  farmConsent: boolean;
  onOpenSettings: () => void;
  onOpenLibrary: () => void;
  sources: KnowledgeDocument[];
  sourceIds: string[];
  setSourceIds: (update: (ids: string[]) => string[]) => void;
  loadSources: () => void;
  sourceLoading: boolean;
  /** Opens cited passages, or a guide from the picker, in the evidence reader. */
  onOpenSource?: (target: ReaderTarget) => void;
}) {
  const { open, turn, history, busy, sending, question, setQuestion, questionLabel, sources, sourceIds, setSourceIds } = props;
  const [tray, setTray] = useState(false);
  const [tool, setTool] = useState<"photo" | "sources" | null>(null);
  const [voiced, setVoiced] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [sourceQuery, setSourceQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The newest message is at the bottom; keep it in view as the thread grows.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => { const b = bodyRef.current; if (b) b.scrollTop = b.scrollHeight; });
    return () => cancelAnimationFrame(id);
  }, [open, history.length, sending, busy, tool, props.error]);
  // A new answer is read from its top: bring its question to the top of the thread.
  useEffect(() => {
    if (!open || !turn?.id) return;
    const id = requestAnimationFrame(() => {
      const b = bodyRef.current;
      const asked = b?.querySelector<HTMLElement>(".fm-msg.is-me.is-latest");
      if (b && asked) b.scrollTop = Math.max(0, asked.offsetTop - 8);
    });
    return () => cancelAnimationFrame(id);
  }, [open, turn?.id]);
  // An answer opened from the library: its question at the top of the thread, the answer in full and outlined.
  const focus = props.focusResponseId ?? null;
  useEffect(() => {
    if (!open || !focus) return;
    const t = history.find((h) => h.responseId === focus);
    if (t) setExpanded((ids) => (ids.includes(t.id) ? ids : [...ids, t.id]));
    const frame = requestAnimationFrame(() => {
      const b = bodyRef.current;
      const asked = b?.querySelector<HTMLElement>(`[data-response="${CSS.escape(focus)}"]`);
      if (b && asked) b.scrollTop = Math.max(0, asked.offsetTop - 8);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const empty = !turn && !history.length && !sending;
  const selected = groupKnowledgeSources(sources).filter((s) => s.documentIds.some((id) => sourceIds.includes(id)));
  function openTool(next: "photo" | "sources") {
    setTray(false);
    setTool(next);
    if (next === "sources" && !sources.length) props.loadSources();
  }
  function send(text: string) {
    const sent = text.trim();
    if (!sent) return;
    // Cleared once the answer arrives; a failed send keeps the text.
    void props.onAsk(sent).then((ok) => { if (ok) { setQuestion((now) => (now === sent ? "" : now)); setVoiced(false); } });
  }
  const canVoice = voiceSupported();
  return (
    <section id="farm-chat" ref={props.chatRef} className="fm-chat" role="dialog" aria-label={L("AI 농장 상담", "AI farm advisor")} hidden={!open} tabIndex={-1} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); props.onClose(); } }}>
      <header className="fm-chat-header">
        <h2><AiMark />{L("AI 농장 상담", "AI farm advisor")}</h2>
        <span className="fm-chat-target" title={L("질문 대상", "Asking about")}>{props.label}</span>
        <button className="fm-chat-close" aria-label={L("상담 닫기", "Close advisor")} onClick={props.onClose}><FarmIcon name="close" /></button>
      </header>
      <div className="fm-chat-body" ref={bodyRef}>
        <ol className="fm-thread" aria-live="polite">
          {empty && (
            <li className="fm-msg is-ai">
              <div className="fm-bubble">
                <p>{L(`${props.label}에 대해 물어보세요. 센서 값과 재배 자료를 함께 읽고 답합니다.`, `Ask about ${props.label}. I read your sensor values and the growing guides together.`)}</p>
                <ModuleTag id="rag" />
                <ModuleTag id="qact" />
              </div>
            </li>
          )}
          {history.map((t) => {
            const q = t.userMessage?.content ?? "";
            // A stored answer in the server's words: lines it knows whole are translated, the rest stays as written.
            const text = farmWords(withReadableTimes((t.assistantMessage?.content ?? "").split("\n").map((line) => prose(line)).join("\n")), props.zoneLabel);
            const long = text.length > 160;
            const isOpen = expanded.includes(t.id);
            // Its sources show with the answer in full (the answer opened from the library opens in full).
            const guides = !!props.onOpenSource && usedGuides(t);
            const author = authorOf(t);
            return [
              <li key={`${t.id}-q`} className="fm-msg is-me" data-response={t.responseId ?? undefined}><p className="fm-bubble" title={questionLabel(q) !== q ? q : undefined}>{questionLabel(q)}</p></li>,
              <li key={`${t.id}-a`} className={`fm-msg is-ai ${focus && t.responseId === focus ? "is-focus" : ""}`}>
                <div className={`fm-bubble is-old ${long && !isOpen ? "is-clamped" : ""}`}>
                  <div className="fm-answer-body" lang={getLang() !== "ko" && /[가-힣]/.test(text) ? "ko" : undefined}><AdvisorMarkdown content={text} cite={historyCite(t, props.onOpenSource)} /></div>
                  {isOpen && guides && <HistorySources turn={t} onOpenSource={props.onOpenSource} />}
                  <footer className="fm-answer-foot">
                    <span className="fm-answer-ai" title={author.note}><AiMark title={author.note} />{author.text}</span>
                    <time dateTime={t.recordedAt}>{shortStamp(t.recordedAt ?? null)}</time>
                    <span className="fm-answer-foot-tools">
                      {(long || guides) && <button type="button" aria-expanded={isOpen} onClick={() => setExpanded((ids) => (isOpen ? ids.filter((id) => id !== t.id) : [...ids, t.id]))}>{isOpen ? L("접기", "Less") : long ? L("전체 보기", "More") : L("근거 보기", "Sources")}</button>}
                      <button type="button" disabled={busy} onClick={() => send(q)} title={L("지금 값으로 같은 질문을 다시 합니다", "Ask the same question with today's values")}>{L("다시 묻기", "Ask again")}</button>
                    </span>
                  </footer>
                </div>
              </li>,
            ];
          })}
          {turn && (
            <>
              <li className="fm-msg is-me is-latest" data-response={turn.responseId ?? undefined}><p className="fm-bubble" title={questionLabel(turn.userMessage?.content ?? "") !== turn.userMessage?.content ? turn.userMessage?.content : undefined}>{questionLabel(turn.userMessage?.content ?? "")}</p></li>
              <li className={`fm-msg is-ai ${focus && turn.responseId === focus ? "is-focus" : ""}`}>
                <div className="fm-bubble is-answer">
                  <AnswerCard turn={turn} turns={props.turns} busy={busy} onReview={props.onReview} onRecheck={props.onRecheck} zoneLabel={props.zoneLabel} onOpenLibrary={props.onOpenLibrary} onOpenSource={props.onOpenSource} />
                  {/인증|출하|규격|GAP|certif|shipping|grading|export standard/i.test(turn.userMessage?.content ?? "") && <RefNote kind="standards" compact />}
                  {props.lang === "en" && <RefNote kind="translation" compact />}
                </div>
              </li>
            </>
          )}
          {sending && sending !== turn?.userMessage?.content && (
            <li className="fm-msg is-me"><p className="fm-bubble" title={questionLabel(sending) !== sending ? sending : undefined}>{questionLabel(sending)}</p></li>
          )}
          {busy && (
            <li className="fm-msg is-ai">
              <p className="fm-bubble fm-typing" role="status"><AiMark />{L("답변 작성 중", "Writing an answer")}<span className="fm-typing-dots" aria-hidden="true"><i /><i /><i /></span></p>
            </li>
          )}
          {props.error && <li className="fm-msg is-system"><p role="alert">{props.error}</p></li>}
          {tool === "photo" && (
            <li className="fm-msg is-tool">
              <button type="button" className="fm-tool-close" aria-label={L("사진 확인 닫기", "Close photo check")} onClick={() => setTool(null)}><FarmIcon name="close" /></button>
              <PhotoCheckBox farmId={props.farmId} zoneId={props.zoneId} bedId={props.bedId} farmConsent={props.farmConsent} onOpenSettings={props.onOpenSettings} onAsk={(q) => { setTool(null); send(q); }} />
            </li>
          )}
          {tool === "sources" && (
            <li className="fm-msg is-tool">
              <button type="button" className="fm-tool-close" aria-label={L("자료 고르기 닫기", "Close source picker")} onClick={() => setTool(null)}><FarmIcon name="close" /></button>
              <section className="fm-source-pick" aria-label={L("참고 자료 고르기", "Choose sources")}>
                <strong>{L("이번 질문에 쓸 자료 고르기", "Sources for this question")}</strong>
                <p className="fm-hint">
                  {L("고르지 않으면 관련 자료를 찾아 답합니다. 자료를 더하거나 빼는 곳은 자료실입니다.", "If none are chosen, related sources are found automatically. Documents are added or removed in the library.")}{" "}
                  <button type="button" className="fm-link-button" onClick={props.onOpenLibrary}>{L("자료실 열기", "Open the library")}</button>
                </p>
                <label className="fm-source-search">
                  <span className="fm-visually-hidden">{L("자료 찾기", "Find a document")}</span>
                  <input type="search" value={sourceQuery} onChange={(e) => setSourceQuery(e.target.value)} placeholder={L("자료 이름으로 찾기", "Search by title")} />
                </label>
                {props.sourceLoading && <p>{L("자료를 불러오는 중…", "Loading sources…")}</p>}
                {groupKnowledgeSources(sources.filter((s) => s.status === "ready" && s.retrievalState === "active")).filter((s) => !sourceQuery.trim() || s.title.toLowerCase().includes(sourceQuery.trim().toLowerCase())).slice(0, 40).map((s) => (
                  <div className="fm-source-row" key={s.id}>
                    <label className="fm-source">
                      <input
                        type="checkbox"
                        checked={s.documentIds.every((id) => sourceIds.includes(id))}
                        onChange={(e) => setSourceIds((ids) => (e.target.checked ? [...new Set([...ids, ...s.documentIds])] : ids.filter((id) => !s.documentIds.includes(id))))}
                      />
                      <span>{s.title}<small>{[s.representative.issuer, s.pageLabel].filter(Boolean).join(", ")}</small></span>
                    </label>
                    {props.onOpenSource && (
                      <button type="button" className="fm-source-view" onClick={() => props.onOpenSource!({ passages: [{ documentId: s.documentIds[0], kind: "quote", text: null }] })} aria-label={L(`${s.title} 원문 보기`, `Read ${s.title}`)}>
                        <FarmIcon name="file" />{L("보기", "Read")}
                      </button>
                    )}
                  </div>
                ))}
              </section>
            </li>
          )}
        </ol>
      </div>
      <div className="fm-chat-compose">
        {sourceIds.length > 0 && (
          <div className="fm-source-chips" aria-label={L("고른 자료", "Chosen sources")}>
            {selected.map((s) => (
              <button type="button" key={s.id} aria-label={L(`${s.title} 선택 해제`, `Deselect ${s.title}`)} onClick={() => setSourceIds((ids) => ids.filter((id) => !s.documentIds.includes(id)))}>
                {s.title} ×
              </button>
            ))}
            {!selected.length && <small>{L(`고른 자료 ${sourceIds.length}개`, `${sourceIds.length} chosen`)}</small>}
          </div>
        )}
        {!tray && (
          <div className="fm-quick" aria-label={L("추천 질문", "Suggested questions")}>
            {props.suggestions.map((sg) => (
              <button type="button" key={sg.id} disabled={busy} title={props.lang === "ko" ? sg.question : undefined} onClick={() => send(sg.question)}>{sg.label}</button>
            ))}
          </div>
        )}
        {tray && (
          <div className="fm-chat-tray">
            <button type="button" onClick={() => openTool("photo")}><FarmIcon name="camera" />{L("사진으로 확인", "Check a photo")}</button>
            <button type="button" onClick={() => openTool("sources")}><FarmIcon name="book" />{L("이번 질문 자료", "Sources for this")}{sourceIds.length ? ` (${selected.length || sourceIds.length})` : ""}</button>
          </div>
        )}
        {voiced && question.trim() && <RefNote kind="voice" compact />}
        {voiceError && <p className="fm-voice-error" role="status">{voiceError}</p>}
        <form className="fm-chat-form" onSubmit={(e) => { e.preventDefault(); send(question); }}>
          <button type="button" className={`fm-chat-plus ${tray ? "is-open" : ""}`} aria-expanded={tray} aria-label={L("사진·자료 더 보기", "Photo and sources")} onClick={() => setTray((v) => !v)}>
            <FarmIcon name={tray ? "close" : "plus"} />
          </button>
          <label>
            <span className="fm-visually-hidden">{L("궁금한 내용", "Your question")}</span>
            <input ref={inputRef} value={question} onChange={(e) => { setQuestion(e.target.value); if (!e.target.value) setVoiced(false); }} maxLength={900} placeholder={L("궁금한 것을 물어보세요", "Ask anything")} />
          </label>
          {!question.trim() && canVoice ? (
            <VoiceButton onText={(t) => { setQuestion(t); setVoiced(true); inputRef.current?.focus(); }} onError={setVoiceError} label={L("말로 묻기", "Ask by voice")} />
          ) : (
            <button type="submit" className="fm-chat-send" disabled={busy || !question.trim()} aria-label={L("보내기", "Send")} title={L("보내기", "Send")}>
              <FarmIcon name="send" />
            </button>
          )}
        </form>
      </div>
    </section>
  );
}

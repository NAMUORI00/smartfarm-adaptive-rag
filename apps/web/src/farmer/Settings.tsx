import { ReplayNote } from "./ReplayNote";
import type { ReactNode } from "react";
import type { FarmId } from "../types";
import { OperatingPanel } from "./OperatingPanel";
import { FarmIcon } from "./FarmIcon";
import { L } from "./i18n";
import { RefNote } from "./RefNote";
import type { NotifySupport } from "./notify";

type Theme = "light" | "dark" | "system";

/** On or off, said as a switch: the state is the switch's position, not a word on a button. */
export function Switch({ on, onChange, label, disabled = false }: { on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="fm-switch" disabled={disabled} onClick={() => onChange(!on)}>
      <span className="fm-switch-track" aria-hidden="true"><span className="fm-switch-knob" /></span>
    </button>
  );
}

/** A row that goes somewhere: its name on the left, the chevron on the right. */
function NavRow({ title, note, onClick }: { title: string; note?: string; onClick: () => void }) {
  return (
    <button type="button" className="fm-setting-row is-nav" onClick={onClick}>
      <span><strong>{title}</strong>{note && <small>{note}</small>}</span>
      <FarmIcon name="chevron" />
    </button>
  );
}

function SwitchRow({ title, note, on, onChange, disabled, children }: { title: string; note: string; on: boolean; onChange: (next: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <div className="fm-setting-row">
      <span><strong>{title}</strong><small>{note}</small>{children}</span>
      <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

const SECTIONS = () => [
  ["settings-farm", L("농장 운영", "Farm operation")],
  ["settings-screen", L("화면", "Screen")],
  ["settings-alerts", L("알림", "Notifications")],
  ["settings-ai", L("AI와 자료", "AI and guides")],
  ["settings-records", L("기록", "Records")],
  ["settings-help", L("도움말", "Help")],
] as const;

/**
 * Settings as a page of its own, in groups: the farm's operation, the screen,
 * notifications, what the AI may read and where its guides are kept, records,
 * help, and the developer tools folded at the end. Every on/off is a switch,
 * every place to go is a row with a chevron, and stopping the farm's
 * operation asks once more.
 */
export function Settings(props: {
  farmId: FarmId;
  notice: ReactNode;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  lang: string;
  setLang: (lang: "ko" | "en") => void;
  contrast: boolean;
  setContrast: (on: boolean) => void;
  privateRemote: boolean;
  onPrivateRemote: (on: boolean) => void;
  notify: boolean;
  notifyState: NotifySupport;
  onNotify: (on: boolean) => void;
  locationSummary: string;
  locationForm: ReactNode;
  onLibrary: () => void;
  onReport: () => void;
  onTour: () => void;
  onHome?: () => void;
  devTools: ReactNode;
}) {
  const go = (id: string) => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  return (
    <section className="fm-settings-page" aria-labelledby="fm-settings-title">
      <header className="fm-page-head">
        <h2 id="fm-settings-title">{L("설정", "Settings")}</h2>
      </header>
      <div className="fm-settings-layout">
        <nav className="fm-settings-nav" aria-label={L("설정 묶음", "Settings groups")}>
          {SECTIONS().map(([id, name]) => <button type="button" key={id} onClick={() => go(id)}>{name}</button>)}
        </nav>
        <div className="fm-settings-sections">
          <ReplayNote />
          {props.notice}
          <section id="settings-farm" aria-labelledby="settings-farm-title">
            <h3 id="settings-farm-title">{L("농장 운영", "Farm operation")}</h3>
            <OperatingPanel farmId={props.farmId} manage />
          </section>
          <section id="settings-screen" aria-labelledby="settings-screen-title">
            <h3 id="settings-screen-title">{L("화면", "Screen")}</h3>
            <div className="fm-setting-row">
              <span><strong>{L("밝기", "Brightness")}</strong></span>
              <div className="fm-segment" role="group" aria-label={L("화면 밝기", "Brightness")}>
                {(["light", "dark", "system"] as const).map((t) => (
                  <button type="button" key={t} aria-pressed={props.theme === t} onClick={() => props.setTheme(t)}>
                    {t === "light" ? L("밝게", "Light") : t === "dark" ? L("어둡게", "Dark") : L("기기 설정", "System")}
                  </button>
                ))}
              </div>
            </div>
            <div className="fm-setting-row">
              <span><strong>{L("언어", "Language")}</strong></span>
              <div className="fm-segment" role="group" aria-label={L("언어", "Language")}>
                {(["ko", "en"] as const).map((code) => (
                  <button type="button" key={code} lang={code} aria-pressed={props.lang === code} onClick={() => props.setLang(code)}>
                    {code === "ko" ? "한국어" : "English"}
                  </button>
                ))}
              </div>
            </div>
            <SwitchRow title={L("선명하게 보기", "High contrast")} note={L("글자와 선을 더 진하게 보입니다.", "Text and lines are drawn darker.")} on={props.contrast} onChange={props.setContrast} />
          </section>
          <section id="settings-alerts" aria-labelledby="settings-alerts-title">
            <h3 id="settings-alerts-title">{L("알림", "Notifications")}</h3>
            <SwitchRow
              title={L("브라우저 알림", "Browser notifications")}
              note={L("화면을 내려 둔 동안 '먼저 볼 곳' 1순위가 바뀌면 이 기기에 알립니다.", "While this tab is in the background, a new top item is shown as a notification on this device.")}
              on={props.notify && props.notifyState === "granted"}
              onChange={props.onNotify}
              disabled={props.notifyState === "unsupported"}
            >
              {props.notifyState === "unsupported" && <small className="fm-setting-note">{L("이 브라우저는 웹 알림을 지원하지 않습니다.", "This browser does not support web notifications.")}</small>}
              {props.notifyState === "denied" && <small className="fm-setting-note">{L("브라우저가 이 사이트의 알림을 막고 있습니다. 주소창의 사이트 설정에서 알림을 허용한 뒤 다시 켜세요.", "The browser is blocking notifications for this site. Allow them in the site settings, then turn this on again.")}</small>}
              {props.notify && props.notifyState === "granted" && <RefNote kind="notify" compact />}
            </SwitchRow>
            <details className="fm-setting-row is-fold">
              <summary>
                <span><strong>{L("날씨 준비 알림 위치", "Location for weather alerts")}</strong><small>{props.locationSummary}</small></span>
              </summary>
              {props.locationForm}
            </details>
          </section>
          <section id="settings-ai" aria-labelledby="settings-ai-title">
            <h3 id="settings-ai-title">{L("AI와 자료", "AI and guides")}</h3>
            <NavRow title={L("자료실", "Reference library")} note={L("AI 상담이 찾아서 인용하는 재배 자료", "The growing guides the AI advisor searches and cites")} onClick={props.onLibrary} />
            <SwitchRow
              title={L("농장 전용 자료도 AI로 요약", "Let the AI read farm-only records")}
              note={L("켜면 우리 농장 SOP와 기록이 섞인 질문도 외부 AI가 읽고 답합니다. 끄면 원문 발췌로만 답합니다.", "When on, questions involving the farm's own SOPs and records are also read by the outside AI. When off, those answers only quote the sources.")}
              on={props.privateRemote}
              onChange={props.onPrivateRemote}
            />
          </section>
          <section id="settings-records" aria-labelledby="settings-records-title">
            <h3 id="settings-records-title">{L("기록", "Records")}</h3>
            <NavRow title={L("주간 보고서", "Weekly report")} note={L("지난 7일의 수확, 경보, 허용한 설비 변경", "The last 7 days of harvests, alerts and allowed changes")} onClick={props.onReport} />
          </section>
          <section id="settings-help" aria-labelledby="settings-help-title">
            <h3 id="settings-help-title">{L("도움말", "Help")}</h3>
            <NavRow title={L("사용법 다시 보기", "Replay the tour")} onClick={props.onTour} />
            {props.onHome && <NavRow title={L("서비스 소개", "About")} note={L("첫 화면의 시스템 구조와 연구 설명", "The system diagram and the studies on the first page")} onClick={props.onHome} />}
          </section>
          {props.devTools}
        </div>
      </div>
    </section>
  );
}

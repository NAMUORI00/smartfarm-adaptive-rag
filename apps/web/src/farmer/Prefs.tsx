import { useEffect, useSyncExternalStore } from "react";
import { FarmIcon } from "./FarmIcon";
import { getLang, L, setLang, subscribeLang } from "./i18n";
import type { Lang } from "./i18n";

/**
 * Theme and language, shared by the service page and the console, with one
 * control that sits in every top bar. The theme follows the device until the
 * person picks one; the resolved value ("light" | "dark") is always written on
 * the page root so both themes are drawn by the same token set.
 */
export type ThemeChoice = "light" | "dark" | "system";

const THEME_KEY = "farmer.theme";
let theme: ThemeChoice = readTheme();
const themeListeners = new Set<() => void>();
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function readTheme(): ThemeChoice {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}
function subscribeTheme(fn: () => void) {
  themeListeners.add(fn);
  media?.addEventListener("change", fn);
  return () => { themeListeners.delete(fn); media?.removeEventListener("change", fn); };
}
function resolvedTheme(): "light" | "dark" {
  return theme === "system" ? (media?.matches ? "dark" : "light") : theme;
}
export function setTheme(next: ThemeChoice) {
  theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
  themeListeners.forEach((fn) => fn());
}

/** Current theme choice, the theme actually drawn, and the language; re-renders on any change. */
export function usePrefs() {
  const choice = useSyncExternalStore(subscribeTheme, () => theme, () => "system" as ThemeChoice);
  const resolved = useSyncExternalStore(subscribeTheme, resolvedTheme, () => "light" as const);
  const lang = useSyncExternalStore(subscribeLang, getLang, () => "ko" as Lang);
  useEffect(() => {
    document.documentElement.dataset.fmTheme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.documentElement.lang = lang;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#161b19" : "#f1f2ee");
  }, [resolved, lang]);
  return { theme: choice, resolved, lang, setTheme, setLang };
}

/** The theme switch and the language switch, one pair, the same in every top bar. */
export function Prefs({ compact = false }: { compact?: boolean }) {
  const { resolved, lang } = usePrefs();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <div className={`fm-prefs ${compact ? "is-compact" : ""}`}>
      <button
        type="button"
        className="fm-prefs-theme"
        onClick={() => setTheme(next)}
        aria-label={L(next === "dark" ? "어두운 화면으로 전환" : "밝은 화면으로 전환", next === "dark" ? "Switch to dark mode" : "Switch to light mode")}
        title={L(next === "dark" ? "어두운 화면" : "밝은 화면", next === "dark" ? "Dark mode" : "Light mode")}
      >
        <FarmIcon name={resolved === "dark" ? "sun" : "moon"} />
        {!compact && <span>{resolved === "dark" ? L("라이트", "Light") : L("다크", "Dark")}</span>}
      </button>
      {/* Phones: one button that switches to the other language. */}
      <button
        type="button"
        className="fm-prefs-lang-toggle"
        onClick={() => setLang(lang === "ko" ? "en" : "ko")}
        aria-label={lang === "ko" ? "Switch to English" : "한국어로 전환"}
        lang={lang === "ko" ? "en" : "ko"}
      >
        {lang === "ko" ? "EN" : "KO"}
      </button>
      <div className="fm-prefs-lang" role="group" aria-label={L("언어", "Language")}>
        <button type="button" aria-pressed={lang === "ko"} onClick={() => setLang("ko")} lang="ko">KOR</button>
        <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")} lang="en">ENG</button>
      </div>
    </div>
  );
}

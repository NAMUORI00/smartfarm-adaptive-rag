import { useEffect, useState } from "react";
import { getAlertAdvisory } from "../api";
import { getLang } from "./i18n";
import type { AlertAdvisory, FarmId } from "../types";

export type AdviceState = { status: "loading" } | { status: "ready"; advisory: AlertAdvisory } | { status: "error" };

// The server keeps each analysis per alert lifecycle and limits concurrent model
// calls; the page keeps its copy for five minutes and never asks twice at once.
const cache = new Map<string, { at: number; state: AdviceState }>();
const inflight = new Map<string, Promise<void>>();
const TTL = 5 * 60 * 1000;

/**
 * The AI analysis for the alerts at the top of the brief, fetched one after
 * another so a slow model never holds the screen. Nothing is asked when the
 * list is empty.
 */
export function useAlertAdvice(farmId: FarmId, alertIds: string[]): { advice: Record<string, AdviceState>; refresh: (alertId: string) => void } {
  const lang = getLang();
  const key = `${lang}|${alertIds.join("|")}`;
  const [, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const id of alertIds) {
        const cacheKey = `${farmId}:${lang}:${id}`;
        const hit = cache.get(cacheKey);
        if (hit && (hit.state.status === "loading" || Date.now() - hit.at < TTL)) continue;
        if (!inflight.has(cacheKey)) {
          cache.set(cacheKey, { at: Date.now(), state: { status: "loading" } });
          if (!cancelled) setTick((n) => n + 1);
          inflight.set(cacheKey, getAlertAdvisory(farmId, id, { lang })
            .then((advisory) => { cache.set(cacheKey, { at: Date.now(), state: { status: "ready", advisory } }); })
            // A failure is retried after a minute, not on every render.
            .catch(() => { cache.set(cacheKey, { at: Date.now() - TTL + 60_000, state: { status: "error" } }); })
            .finally(() => inflight.delete(cacheKey)));
        }
        await inflight.get(cacheKey);
        if (!cancelled) setTick((n) => n + 1);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, key]);
  const out: Record<string, AdviceState> = {};
  for (const id of alertIds) {
    const hit = cache.get(`${farmId}:${lang}:${id}`);
    if (hit) out[id] = hit.state;
  }
  /** "다시 분석": ask again past the cache (the server allows it once a minute per alert). */
  const refresh = (alertId: string) => {
    const cacheKey = `${farmId}:${lang}:${alertId}`;
    if (inflight.has(cacheKey)) return;
    const previous = cache.get(cacheKey);
    cache.set(cacheKey, { at: Date.now(), state: { status: "loading" } });
    setTick((n) => n + 1);
    inflight.set(cacheKey, getAlertAdvisory(farmId, alertId, { lang, refresh: true })
      .then((advisory) => { cache.set(cacheKey, { at: Date.now(), state: { status: "ready", advisory } }); })
      .catch(() => { if (previous) cache.set(cacheKey, previous); else cache.set(cacheKey, { at: Date.now() - TTL + 60_000, state: { status: "error" } }); })
      .finally(() => { inflight.delete(cacheKey); setTick((n) => n + 1); }));
  };
  return { advice: out, refresh };
}

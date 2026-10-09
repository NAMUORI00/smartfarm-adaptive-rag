import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDashboard,
  getDashboardSnapshot,
  getApprovals,
  getAudit,
  getOperationCases,
  getCultivationStrategies,
  getAdvisorSessions,
  getAdvisorSession,
  createAdvisorSession,
  askAdvisor,
  recheckAdvisor,
} from "../api";
import { farmRequest } from "../farm-spatial";
import { getLang, L } from "./i18n.ts";
import { notifyOn } from "./notify.ts";
import type { FarmLayout, CropCycle, FarmSelection } from "../farm-spatial";
import type {
  DashboardSnapshot,
  Approval,
  AuditEvent,
  OperationCase,
  CultivationStrategies,
  AdvisorTurn,
  FarmId,
} from "../types";

export function useFarmRuntime(farmId: FarmId) {
  const [selection, setSelection] = useState<FarmSelection | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [layout, setLayout] = useState<FarmLayout | null>(null),
    [cycles, setCycles] = useState<CropCycle[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]),
    [audit, setAudit] = useState<AuditEvent[]>([]),
    [cases, setCases] = useState<OperationCase[]>([]);
  const [strategies, setStrategies] = useState<CultivationStrategies | null>(
      null,
    ),
    [turns, setTurns] = useState<AdvisorTurn[]>([]);
  const [error, setError] = useState(""),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false);
  const session = useRef<string | null>(null),
    sessionTask = useRef<Promise<string> | null>(null);
  const live = useRef(true),
    jobs = useRef(new Map<string, Promise<void>>());
  const retries = useRef(new Map<string, {count:number; after:number}>());
  // Until one full read has landed, the page has no layout to draw: keep trying on the fast tick.
  const loaded = useRef(false);
  const firstTry = useRef(0);
  const single = useCallback((key: string, task: () => Promise<void>) => {
    const existing = jobs.current.get(key);
    if (existing) return existing;
    const job = task().then(()=>{retries.current.delete(key);})
      .catch((e) => {
        const count=(retries.current.get(key)?.count??0)+1;
        retries.current.set(key,{count,after:Date.now()+Math.min(30000,2000*2**Math.min(count,4))});
        if (live.current)
          setError(e instanceof Error && /[가-힣]/.test(e.message) ? e.message : L("연결을 확인하세요. 마지막 수신값을 표시하고 있습니다.", "Check the connection. Showing the last received values."));
      })
      .finally(() => jobs.current.delete(key));
    jobs.current.set(key, job);
    return job;
  }, []);
  const refreshCrops = useCallback(async () => {
    const r = await farmRequest<{ cycles: CropCycle[] }>(
      farmId,
      "/v1/cultivation/cycles",
    );
    if (live.current) setCycles(r.cycles);
  }, [farmId]);
  const refreshHistory = useCallback(async () => {
    const sessions = await getAdvisorSessions(farmId);
    if (sessions[0]) session.current = sessions[0].id;
    if (session.current) {
      const s = await getAdvisorSession(farmId, session.current);
      if (live.current) setTurns(s.turns);
    }
  }, [farmId]);
  // One slow reply (the API busy with a long answer) is not a lost farm:
  // the badge turns only after two misses in a row, about four seconds.
  const liveMisses = useRef(0);
  const refreshLive = useCallback(
    () =>
      single("live", async () => {
        const r = await getDashboardSnapshot(farmId);
        if (!live.current) return;
        const ok = r.state === "connected" && r.data?.dataOrigin === "telemetry_service";
        liveMisses.current = ok ? 0 : liveMisses.current + 1;
        if (ok || liveMisses.current >= 2) setConnected(ok);
        if (r.data && (ok || liveMisses.current >= 2)) setSnapshot((s) => (s ? { ...s, ...r.data } : null));
        if (r.error && liveMisses.current >= 2) setError(r.error);
        else if (ok) setError("");
        if(r.state!=="connected") throw new Error(r.error??L("관측 연결을 확인하세요.", "Check the sensor connection."));
      }),
    [farmId, single],
  );
  const refreshRecords = useCallback(
    () =>
      single("records", async () => {
        const [p, a, c] = await Promise.all([
          getApprovals(farmId),
          getAudit(farmId),
          getOperationCases(farmId),
        ]);
        if (!live.current) return;
        if (p.state === "connected") setApprovals(p.data);
        if (a.state === "connected") setAudit(a.data);
        if (c.state === "connected") setCases(c.data);
        const failed = [p, a, c].find((r) => r.state !== "connected");
        if (failed) throw new Error(failed.error ?? L("운영 기록의 최근 상태를 확인하지 못했습니다.", "Could not load the latest operation records."));
      }),
    [farmId, single],
  );
  const refresh = useCallback(
    () =>
      single("full", async () => {
        // The layout arrives in a tenth of a second; the plan is drawn from it at once
        // instead of waiting for ten hours of series behind the dashboard.
        const keepLayout = (l: FarmLayout) => {
          if (live.current) setLayout((previous) => (JSON.stringify(previous) === JSON.stringify(l) ? previous : l));
          return l;
        };
        const [d, , t] = await Promise.all([
          getDashboard(farmId),
          farmRequest<FarmLayout>(farmId, "/v1/farm/layout").then(keepLayout),
          getCultivationStrategies(farmId),
        ]);
        if (!live.current) return;
        setStrategies(t.data);
        // The 2-second live read owns the connection badge. This slower read
        // carries ten hours of series; when it is late it must not say the
        // farm is disconnected while live readings keep arriving.
        if (d.data) setConnected(d.state === "connected" && d.data.dataOrigin === "telemetry_service");
        // A delayed series response must not replace a newer live snapshot.
        if (d.data)
          setSnapshot((s) =>
            s && Date.parse(s.generatedAt) > Date.parse(d.data!.generatedAt)
              ? {
                  ...s,
                  telemetry: d.data!.telemetry,
                  telemetryByZone: d.data!.telemetryByZone,
                }
              : d.data,
          );
        if (d.data) setError(d.error ?? "");
        if (d.data) loaded.current = true;
        await Promise.all([refreshCrops(), refreshRecords(), refreshHistory()]);
      }),
    [farmId, single, refreshCrops, refreshRecords, refreshHistory],
  );
  useEffect(() => {
    live.current = true;
    void refresh();
    const visible = () => document.visibilityState === "visible";
    let hiddenRead = 0;
    const fast = setInterval(() => {
      if (visible() && Date.now()>=(retries.current.get("live")?.after??0)) void refreshLive();
      // With browser notifications on, a tab in the background still reads the live state
      // about once a minute, so a new top item can be announced; the rest waits for its return.
      else if (!visible() && notifyOn() && Date.now() - hiddenRead >= 60_000 && Date.now() >= (retries.current.get("live")?.after ?? 0)) {
        hiddenRead = Date.now();
        void refreshLive();
      }
      // A first read that failed (the API restarting, a dropped request) is retried within seconds, not after 30.
      if (visible() && !loaded.current && Date.now() - firstTry.current >= 4000) { firstTry.current = Date.now(); void refresh(); }
    }, 2000);
    const records = setInterval(() => {
      if (visible() && Date.now()>=(retries.current.get("records")?.after??0)) void refreshRecords();
    }, 5000);
    const full = setInterval(() => {
      if (visible()) void refresh();
    }, 30000);
    const resume = () => {
      if (visible()) void refresh();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      live.current = false;
      clearInterval(fast);
      clearInterval(records);
      clearInterval(full);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh, refreshLive, refreshRecords]);
  async function ensureSession() {
    if (session.current) return session.current;
    if (!sessionTask.current)
      sessionTask.current = createAdvisorSession(farmId, "우리 농장")
        .then((s) => (session.current = s.id))
        .finally(() => {
          sessionTask.current = null;
        });
    return sessionTask.current;
  }
  async function ask(
    question: string,
    selection: FarmSelection | null,
    /** null asks about the whole farm. */
    zoneId: string | null,
    cycleId?: string,
    sourceIds: string[] = [],
    videoAnalysisId?: string,
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const id = await ensureSession();
      await askAdvisor(
        farmId,
        question,
        sourceIds,
        true,
        id,
        crypto.randomUUID(),
        {
          bedId: selection?.bedId,
          tier: selection?.tier,
          cycleId,
          // A whole-farm question names no zones: the server refuses "all" with a zone list.
          selectedZoneIds: zoneId ? [zoneId] : [],
          zoneScopeMode: zoneId ? "focused" : "all",
          sourceSelectionMode: sourceIds.length ? "explicit" : "automatic",
          videoAnalysisId,
          answerLanguage: getLang(),
        },
      );
      await refreshHistory();
    } finally {
      setBusy(false);
    }
  }
  async function recheck(responseId: string) {
    if (!session.current || busy) return;
    setBusy(true);
    try {
      await recheckAdvisor(farmId, session.current, responseId);
      await refreshHistory();
    } finally {
      setBusy(false);
    }
  }
  return {
    farmId,
    selection,
    setSelection,
    snapshot,
    layout,
    cycles,
    approvals,
    audit,
    cases,
    strategies,
    turns,
    error,
    connected,
    busy,
    refresh,
    refreshLive,
    refreshRecords,
    refreshCrops,
    refreshHistory,
    ask,
    recheck,
  };
}
export type FarmRuntime = ReturnType<typeof useFarmRuntime>;

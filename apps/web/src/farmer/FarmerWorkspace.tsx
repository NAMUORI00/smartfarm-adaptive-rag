import { assetUrl } from "./asset-url";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { FarmPlan, FarmPlanList } from "./FarmPlan";
import { RecentWork } from "./RecentWork";
import { FarmIcon } from "./FarmIcon";
import { RepairControl } from "./RepairControl";
import { DeviceControl } from "./DeviceControl";
import { OperatingPanel } from "./OperatingPanel";
import { CropEditor } from "./CultivationForm";
import { pendingControls, rememberControl, forgetControl } from "./pending-controls";
import type { FarmRuntime } from "./useFarmRuntime";
import { usePatrolEvents } from "./usePatrolEvents";
import { useCameraFeeds } from "./useCameraFeeds";
import { BedCamera } from "./CameraFeeds";
import { eventText, eventTitle, feedTitle, feedTone, openCameraEvents } from "./camera-feeds";
import { buildTodos, shortAlertTitle } from "./todo-engine";
import type { TodoItem } from "./todo-engine";
import { ChatPanel } from "./ChatPanel";
import { BalancePanel, KeyTile, ReadingRow, StabilityLine } from "./SensorReadings";
import { Steps } from "./Steps";
import { keyReadings, otherProblemReadings, relatedDeviceTargets, sparklineSamples } from "./sensor-links";
import { cameraSummary, openPatrolCount } from "./camera-state";
import { deviceLevel, stageCues } from "./stage-cues";
import type { Cue } from "./stage-cues";
import type { DeviceSpec } from "./FarmMap";
import { writeLastSeen } from "./since-summary";
import { daysUntil, suggestedQuestions } from "./suggestions";
import { ModuleMap } from "./ModuleMap";
import { ModuleTag } from "./ModuleTag";
import { HarvestTimeline } from "./HarvestTimeline";
import { backendText, josa, L, place, term } from "./i18n";
import { controlHold, deviceReach } from "./control-gate";
import { progressText, trackProgress } from "./device-progress";
const FarmMap = lazy(() =>
  import("./FarmMap").then((m) => ({ default: m.FarmMap })),
);
const CameraView = lazy(() =>
  import("./CameraView").then((m) => ({ default: m.CameraView })),
);
// The library is its own page: its list and reader load when it is opened.
const Library = lazy(() =>
  import("./Library").then((m) => ({ default: m.Library })),
);
import { advisorTurnAt, cycleAt, selectedBed } from "../farm-spatial";
import type { FarmSelection } from "../farm-spatial";
import type {
  ControlDraft,
  Farm,
  KnowledgeDocument,
  OperationCase,
} from "../types";
import {
  createControlProposal,
  getKnowledge,
  getOperationCaseCsv,
} from "../api";
import { controlDraftCanBeReviewed } from "../control-progress";
import { actuatorForControl } from "../operator-ui";
import { operationalStateText, controlStateText, controlValueText } from "./control-labels";
import {
  incidentContextForTarget,
  operationCaseProgress,
  operationCaseSummary,
  operationCaseStatusLabel,
} from "../operation-cases";
import { shortStamp, stamp as formatSensorUpdateTime } from "./time-format";
import { Prefs, setTheme, usePrefs } from "./Prefs";
import { TOUR_KEY, Tutorial } from "./Tutorial";
import { cameraFinding, cameraLabel, loadDemoCameras } from "./demo-cameras";
import { buildBrief, farmWords } from "./ai-brief";
import type { BriefItem } from "./ai-brief";
import { AiBrief, AiMark } from "./AiBrief";
import { useAlertAdvice } from "./useAlertAdvice";
import { acknowledgeOperationCase } from "../api";
import { diseaseWatch as fetchDiseaseWatch, getAiPrivacy, harvestGuide, saveFarmLocation, setAiPrivacy, weatherForecast } from "./assist-api";
import { notifySupport, showNotification } from "./notify";
import type { NotifySupport } from "./notify";
import { growthDisplay, growthText, guideMonths, plantScale } from "./growth-display";
import type { DiseaseWatch, WeatherForecast } from "./assist-api";
import { WorkPlanList } from "./AiBrief";
import { ControlPreviewBox, EffectChart, seriesForTarget } from "./ControlAssist";
import { HarvestGuideBox, MetricReferenceBox } from "./ReferenceAssist";
import type { LibraryFocus } from "./Library";
import { DocReader } from "./DocReader";
import type { ReaderTarget } from "./DocReader";
import { Settings } from "./Settings";
import { SpeakRecord } from "./CaptureAssist";
import { HandoverNote, WeeklyReport } from "./ReportAssist";
import { workPlan } from "./report-lines";
import { RefNote } from "./RefNote";
import { sinceSummary } from "./since-summary";
import type { PlanPin } from "./FarmPlan";
import type { DemoCameraManifest } from "./demo-cameras";
import {
  controlProvenance,
  deviceRevision,
  latestObservedAt,
  manualDraft,
  observationIssue,
  observationProblem,
  plannedHarvests,
  relevantObservationKey,
  selectionKey,
} from "./workspace-state";
type Task =
  | "state"
  | "devices"
  | "crop"
  | "records"
  | "advisor"
  | null;
/** Four work steps stay visible; settings live in the header menu. */
const TABS = [
  { id: "state", icon: "sensor" },
  { id: "devices", icon: "controls" },
  { id: "crop", icon: "harvest" },
  { id: "records", icon: "records" },
] as const;
/** Labels are read at render time so a language change takes effect. */
function tabLabel(id: (typeof TABS)[number]["id"]) {
  return id === "state" ? L("상태", "Status")
    : id === "devices" ? L("설비", "Equipment")
    : id === "crop" ? L("재배·수확", "Harvest")
    : L("기록", "Records");
}
function controlSteps(): readonly string[] {
  return [
    L("관측 확인", "Check readings"),
    L("변경 내용 확인", "Review change"),
    L("변경 허용", "Allow change"),
    L("장치 응답", "Device reply"),
    L("회복 확인", "Confirm recovery"),
  ];
}
/** The settings line under the farm location: the place, and tomorrow's forecast when it came. */
function forecastNote(weather: WeatherForecast | null): string {
  if (!weather || !weather.configured) return L("위치를 정하면 내일 예보와 재배실 기준을 비교해 알립니다.", "With a location, tomorrow's forecast is compared with the room's range.");
  const where = weather.location?.label ?? ("label" in weather ? weather.label : "");
  if (!("days" in weather) || !weather.available) return L(`현재: ${where}. 예보를 받지 못했습니다.`, `Now: ${where}. The forecast could not be fetched.`);
  const day = weather.days[1] ?? weather.days[0];
  const hi = day?.t_max, lo = day?.t_min, rain = day?.precip_mm;
  const parts = [
    typeof hi === "number" ? L(`최고 ${hi}°C`, `high ${hi}°C`) : null,
    typeof lo === "number" ? L(`최저 ${lo}°C`, `low ${lo}°C`) : null,
    typeof rain === "number" ? L(`비 ${rain}mm`, `rain ${rain} mm`) : null,
  ].filter(Boolean).join(", ");
  const when = weather.days[1] ? L("내일", "Tomorrow") : L("오늘", "Today");
  return parts ? L(`현재: ${where}. ${when} ${parts}`, `Now: ${where}. ${when}: ${parts}`) : L(`현재: ${where}`, `Now: ${where}`);
}

/** "오늘 11:43" / "9월 9일 14:00" — enough for a morning check, no full timestamp. */
/** Viewport class, same breakpoints as farmer.css: the plan becomes a list on phones, and on tablets whenever the panel is open. */
function useMedia(query: string) {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}
const defaultFarm: Farm = {
  id: "farm-wasabi-a",
  name: "우리 농장",
  location: "재배동",
  crop: "고추냉이",
  cultivar: "",
  cultivationSystem: "다단식 재배",
  productionGoal: "",
  profileId: "",
  growthStage: "",
  lotId: "",
  nextHarvest: "",
  status: "stable",
};
/**
 * Where the dashboard opens when entered from the first page: a bed (a given
 * tier, with the advisor), a device (on its state tab), a zone (with the
 * advisor), the advisor, the cameras (at the question put to two cameras) or
 * the library.
 */
export type StartIntent =
  | { kind: "bed"; bedId: string; tier?: number; chat?: boolean; tab?: "state" | "devices" | "crop" | "records" }
  | { kind: "device"; zoneId: string; key: string; tab?: "state" }
  | { kind: "zone"; zoneId: string; chat?: boolean }
  | { kind: "chat" }
  | { kind: "camera"; focus?: "multiview" }
  | { kind: "library" };

export function FarmerWorkspace({
  runtime: r,
  onLegacy,
  initialView = "map",
  onHome,
  start,
}: {
  runtime: FarmRuntime;
  onLegacy: () => void;
  initialView?: "map" | "research";
  onHome?: () => void;
  start?: StartIntent;
}) {
  const { selection, setSelection } = r;
  const farm: Farm = { ...defaultFarm, ...r.layout?.farm };
  const [task, setTask] = useState<Task>(null),
    [focus, setFocus] = useState(Boolean(selection)),
    [contrast, setContrast] = useState(() => localStorage.getItem("farmer.contrast") === "true");
  const [visited, setVisited] = useState<Task[]>([]);
  const initializedZone = useRef(false);
  const [zoneFocus, setZoneFocus] = useState<string | null>(null);
  const [controlNote, setControlNote] = useState("");
  useEffect(() => {localStorage.setItem("farmer.contrast",String(contrast));},[contrast]);
  const [question, setQuestion] = useState(""),
    [message, setMessage] = useState(""),
    [sources, setSources] = useState<KnowledgeDocument[]>([]),
    [sourceIds, setSourceIds] = useState<string[]>([]);
  const [pending, setPending] = useState<{
      draft: ControlDraft;
      revision: string;
      requestId: string;
      uncertain?: boolean;
      context?: { alertId: string; occurrenceId: string } | null;
    } | null>(null),
    [executing, setExecuting] = useState(false),
    [sourceLoading, setSourceLoading] = useState(false);
  useEffect(() => {
    const saved = JSON.stringify(pendingControls(r.farmId)[0] ?? null);
    if (saved) {
      try {
        const v = JSON.parse(saved);
        if (v?.requestId && v.draft?.target)
          setPending({ ...v, uncertain: true });
      } catch {
        sessionStorage.removeItem("farmer.pendingControl");
      }
    }
  }, []);
  const executionLock = useRef(false),
    reviewed = useRef(""),
    panelRef = useRef<HTMLDivElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  const bed = selectedBed(r.layout, selection),
    cycle = cycleAt(r.cycles, selection),
    snapshot = r.snapshot;
  const selectedZone = bed?.zone_id ?? zoneFocus;
  // Plant size in the 3D model: a growth record, else the days since planting against the
  // harvest date or, with no date, the shortest period the growing guides give for the crop.
  const [guidePeriod, setGuidePeriod] = useState<Record<string, number | null>>({});
  const cropKey = (c: { crop: string; harvest_part: string }) => `${c.crop}|${c.harvest_part}`;
  useEffect(() => {
    const need = new Map<string, string>();
    for (const c of r.cycles) {
      if (c.status === "growing" && !c.latest_observation && !c.planned_harvest_from && !(cropKey(c) in guidePeriod) && !need.has(cropKey(c))) need.set(cropKey(c), c.id);
    }
    if (!need.size) return;
    const ctrl = new AbortController();
    void (async () => {
      for (const [key, id] of need) {
        const months = await harvestGuide(r.farmId, id, ctrl.signal).then((g) => guideMonths(g.passages)).catch(() => null);
        if (ctrl.signal.aborted) return;
        setGuidePeriod((now) => ({ ...now, [key]: months }));
      }
    })();
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.farmId, r.cycles]);
  const plantScales = useMemo(() => {
    const out: Record<string, number> = {};
    for (const c of r.cycles) {
      const g = growthDisplay(c, Date.now(), guidePeriod[cropKey(c)]);
      if (g) out[c.id] = plantScale(g);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.cycles, guidePeriod]);
  const zoneLabel = (id?: string | null) =>
    place(r.layout?.zones.find((z) => z.id === id)?.label ?? L("농장", "Farm"));
  const metrics =
    snapshot?.metrics.filter(
      (m) => !selectedZone || !m.zoneId || m.zoneId === selectedZone,
    ) ?? [];
  const alerts = (snapshot?.alerts ?? [])
    .filter((a) => a.status !== "resolved")
    .sort(
      (a, b) =>
        ({critical:3,warning:2,info:1}[b.severity] - {critical:3,warning:2,info:1}[a.severity]) || Number(b.kind === "sensor_health")-Number(a.kind === "sensor_health") || Date.parse(a.occurredAt ?? "")-Date.parse(b.occurredAt ?? ""),
    );
  // The first screen is the whole farm; a zone or bed is chosen by the farmer
  // (or by "오늘의 농장"), never pre-selected.
  useEffect(() => {
    if (!initializedZone.current && r.layout?.zones.length) initializedZone.current = true;
  }, [r.layout]);
  // Plan first; a bed opens the single-bed workbench; "지도로" returns to the plan
  // with the bed still chosen. The 3D scene mounts on first use and then stays.
  const [planMode, setPlanMode] = useState(true);
  const [mapLoaded, setMapLoaded] = useState(false);
  // One device alone on the workbench (actuator key `zone:target`).
  const [deviceStage, setDeviceStage] = useState<string | null>(null);
  const stage: "overview" | "zone" | "bed" | "device" = deviceStage && !planMode ? "device" : selection && !planMode ? "bed" : selectedZone ? "zone" : "overview";
  const { theme, resolved, lang, setLang } = usePrefs();
  // "연구 모듈 표시": tags on the exact spots the research code runs. Off by default so a farmer sees a clean screen.
  const [showModules, setShowModules] = useState(() => { try { return localStorage.getItem("farmer.showModules") === "true"; } catch { return false; } });
  useEffect(() => { try { localStorage.setItem("farmer.showModules", String(showModules)); } catch { /* storage unavailable */ } }, [showModules]);
  // First visit: a short tour over the real screen, once; "?" replays it.
  const [tourSeen, setTourSeen] = useState(() => { try { return !!localStorage.getItem(TOUR_KEY); } catch { return true; } });
  const [tourOpen, setTourOpen] = useState(false);
  // "Since you last looked" is kept for the next visit, written when the tab goes away.
  useEffect(() => {
    const save = () => { if (document.visibilityState === "hidden") writeLastSeen(r.farmId); };
    document.addEventListener("visibilitychange", save);
    window.addEventListener("pagehide", () => writeLastSeen(r.farmId));
    return () => { document.removeEventListener("visibilitychange", save); writeLastSeen(r.farmId); };
  }, [r.farmId]);
  const zoneAlerts = alerts.filter(
    (a) => !selectedZone || !a.zoneId || a.zoneId === selectedZone,
  );
  const turn = selection
      ? advisorTurnAt(r.turns, selection, cycle?.id)
      : [...r.turns].reverse().find((t) => t.status === "complete" && !t.queryContext?.bedId && (selectedZone ? t.queryContext?.zoneScopeMode === "focused" && t.queryContext.selectedZoneIds.includes(selectedZone) : t.queryContext?.zoneScopeMode === "all")),
    activeCases = r.cases.filter((c) => c.status !== "resolved");
  const superseded = new Set(r.turns.map((t) => t.stateReview?.previous_response_id).filter(Boolean));
  // An answer opened from the library (one that used a guide): kept in the thread and brought into view.
  const [focusAnswer, setFocusAnswer] = useState<string | null>(null);
  const placeTurns = r.turns
    .filter((t) => t.status === "complete" && t.id !== turn?.id && (selection ? t.queryContext?.bedId === selection.bedId : selectedZone ? t.queryContext?.zoneScopeMode === "focused" && t.queryContext.selectedZoneIds.includes(selectedZone) && !t.queryContext?.bedId : t.queryContext?.zoneScopeMode === "all"));
  const recentTurns = placeTurns.filter((t) => !(t.responseId && superseded.has(t.responseId))).slice(-4);
  const focusedTurn = focusAnswer ? placeTurns.find((t) => t.responseId === focusAnswer) : undefined;
  const chatHistory = focusedTurn && !recentTurns.includes(focusedTurn) ? [focusedTurn, ...recentTurns] : recentTurns;
  const label =
    bed && selection ? L(`${bed.label}, ${selection.tier}단`, `${place(bed.label)}, tier ${selection.tier}`) : selectedZone ? zoneLabel(selectedZone) : L("농장 전체", "Whole farm");
  // One short status line for the selected place, in the same words as the hero.
  const zoneTone = !r.connected
    ? "attention"
    : zoneAlerts.some((a) => a.severity === "critical")
      ? "danger"
      : zoneAlerts.length || observationProblem(metrics)
        ? "attention"
        : "ok";
  const zoneStatus = !r.connected
    ? L("연결 확인 필요", "Check connection")
    : zoneAlerts[0]
      ? term(shortAlertTitle(zoneAlerts[0].title))
      : observationProblem(metrics)
        ? L("값 확인 필요", "Check readings")
        : L("이상 없음", "No issues");
  const thresholds =
    r.strategies?.versions.find(
      (v) => v.versionId === r.strategies?.activeVersionId,
    )?.thresholds ?? [];
  const obsKey =
    snapshot && bed
      ? relevantObservationKey(
          snapshot,
          bed.zone_id,
          turn?.stateReview?.mode === "selective",
        )
      : "";
  useEffect(() => {
    if (
      !r.connected ||
      !snapshot ||
      !turn?.responseId ||
      !turn.stateReview ||
      turn.stateReview.mode !== "selective" ||
      !bed ||
      r.busy ||
      ["needs_confirmation", "stale"].includes(turn.stateReview.status)
    )
      return;
    const key = `${turn.responseId}:${obsKey}`;
    if (reviewed.current === key) return;
    reviewed.current = key;
    void r.recheck(turn.responseId).catch((e) => setMessage(String(e.message)));
  }, [turn?.responseId, obsKey, r.busy]);

  useEffect(() => {
    panelRef.current?.scrollTo({top:0});
  }, [selectedZone, selection?.bedId, selection?.tier]);
  // Popovers (다른 할 일, 메뉴) are <details>; close them on outside click or Escape
  // so they never sit over the panel tabs.
  useEffect(() => {
    const closeAll = (except?: Element | null) => {
      document.querySelectorAll<HTMLDetailsElement>(".fm-today-list[open], .fm-menu[open], .fm-since[open], .fm-more[open]").forEach((d) => {
        if (!except || !d.contains(except)) d.removeAttribute("open");
      });
    };
    const onPointer = (e: PointerEvent) => closeAll(e.target as Element);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeAll(); };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  // Whole farm by default; picking a bed narrows the scene to that bed alone.
  const [compactMap, setCompactMap] = useState(false);
  // A tier picked on the chosen bed: the 3D moves in to that tier alone.
  const [tierZoom, setTierZoom] = useState(false);
  const [mapHidden, setMapHidden] = useState(false);
  const narrow = useMedia("(max-width: 899px)");
  // Turning into phone width with a bed open (rotation, narrowing the window)
  // lands the way a tap does on a phone: panel first, 3D folded.
  useEffect(() => {
    if (narrow && selection) setMapHidden(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narrow]);
  const tablet = useMedia("(max-width: 1279px)");
  const [chatOpen, setChatOpen] = useState(false);
  // Centre column: the 3D farm or the camera screens. The list and the work panel stay put.
  const [view, setView] = useState<"map" | "camera" | "research" | "report" | "library" | "settings">(initialView);
  // The evidence reader: a cited passage shown inside its document, beside the chat on a wide screen.
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  // The library opens at a document when the reader points there.
  const [libraryFocus, setLibraryFocus] = useState<LibraryFocus | null>(null);
  useEffect(() => {
    // A visitor sent to a particular place from the first page is not stopped by the tour.
    if (start || tourSeen || tourOpen || view !== "map" || stage !== "overview" || !r.layout || !snapshot) return;
    // Wait a moment so the drawing is laid out before the tour measures it.
    const id = window.setTimeout(() => setTourOpen(true), 800);
    return () => window.clearTimeout(id);
  }, [tourSeen, tourOpen, view, stage, r.layout, snapshot]);
  const [cameraFocus, setCameraFocus] = useState<string | null>(null);
  const [demoCameras, setDemoCameras] = useState<DemoCameraManifest | null>(null);
  useEffect(() => { void loadDemoCameras().then(setDemoCameras); }, []);
  // The brief column: what to look at first, today's work in walking order, or the shift handover.
  const [briefTab, setBriefTab] = useState<"brief" | "work" | "handover">("brief");
  const [handoverHours, setHandoverHours] = useState<12 | 24>(12);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const dayStore = (name: string) => `farmer.${name}.${r.farmId}.${today}`;
  const readDay = (name: string): string[] => { try { return JSON.parse(localStorage.getItem(dayStore(name)) ?? "[]"); } catch { return []; } };
  const [workDone, setWorkDone] = useState<string[]>(() => readDay("workDone"));
  const [hiddenToday, setHiddenToday] = useState<string[]>(() => readDay("briefHidden"));
  useEffect(() => { try { localStorage.setItem(dayStore("workDone"), JSON.stringify(workDone)); localStorage.setItem(dayStore("briefHidden"), JSON.stringify(hiddenToday)); } catch { /* storage unavailable */ } });
  const [acking, setAcking] = useState<string[]>([]);
  // Reference helpers the brief reads: sensor records against guide conditions, and the forecast.
  const [disease, setDisease] = useState<DiseaseWatch | null>(null);
  const [weather, setWeather] = useState<WeatherForecast | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => {
      void fetchDiseaseWatch(r.farmId).then((d) => { if (!stop) setDisease(d); }).catch(() => undefined);
      void weatherForecast(r.farmId).then((w) => { if (!stop) setWeather(w); }).catch(() => undefined);
    };
    load();
    const id = window.setInterval(load, 10 * 60 * 1000);
    return () => { stop = true; window.clearInterval(id); };
  }, [r.farmId]);
  // Farm-only records may go to the outside AI only with this consent (settings).
  const [privateRemote, setPrivateRemote] = useState(false);
  useEffect(() => { void getAiPrivacy(r.farmId).then((p) => setPrivateRemote(p.allow_private_remote)).catch(() => undefined); }, [r.farmId]);
  // Browser notifications for a new top item while the tab is in the background (opt-in, this device only).
  const [notify, setNotify] = useState(() => { try { return localStorage.getItem("farmer.notify") === "true"; } catch { return false; } });
  // No notifications in this browser, or refused for this site: the switch says so instead of turning off silently.
  const [notifyState, setNotifyState] = useState<NotifySupport>(() => notifySupport());
  const [sending, setSending] = useState<string | null>(null);
  const [location, setLocation] = useState({ label: "", latitude: "", longitude: "" });
  // The saved farm location fills the form once, so it can be read and corrected.
  useEffect(() => {
    const saved = weather && weather.configured ? weather.location : undefined;
    if (saved) setLocation((now) => (now.label || now.latitude || now.longitude ? now : { label: saved.label, latitude: String(saved.latitude), longitude: String(saved.longitude) }));
  }, [weather]);
  const [expandedReading, setExpandedReading] = useState<string | null>(null);
  const [readingsOpen, setReadingsOpen] = useState(false);
  // `zone:target#nonce` — a fresh nonce re-opens the same device from a reading row.
  const [deviceFocus, setDeviceFocus] = useState<string | null>(null);
  const patrol = usePatrolEvents(r.farmId);
  const patrolOpen = openPatrolCount(patrol.events);
  // The cameras the server receives and reads; a record they raise is fetched as soon as it is counted.
  const feeds = useCameraFeeds(r.farmId);
  const feedRecords = (feeds.live ?? []).reduce((n, c) => n + c.open_events, 0);
  useEffect(() => { if (feedRecords) void patrol.reload(); }, [feedRecords]); // eslint-disable-line react-hooks/exhaustive-deps
  const chatTrigger = useRef<HTMLButtonElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  const tab = (task ?? "state") as Exclude<Task, null>;
  const unconfirmed = pendingControls(r.farmId);
  function closeChat() { setChatOpen(false); setFocusAnswer(null); chatTrigger.current?.focus(); }
  function showPlan() {
    setPlanMode(true);
    setDeviceStage(null);
    setView("map");
    setMapHidden(false);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(".fm-plan [role='button']")?.focus());
  }
  function open(next: Task) {
    if (next === "advisor") {
      setChatOpen(true);
      setVisited(v => v.includes("advisor") ? v : [...v, "advisor"]);
      requestAnimationFrame(() => chatRef.current?.focus());
      return;
    }
    returnFocus.current = document.activeElement as HTMLElement;
    if (view === "map" && selection && next && ["state", "devices", "crop"].includes(next))
      setFocus(true);
    setTask(next);
    if (next) setVisited(v => v.includes(next) ? v : [...v, next]);
    panelRef.current?.scrollTo({top:0});
    setMessage("");
    requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>(`[data-tab="${next ?? "state"}"]`) ??
        panelRef.current;
      target?.focus({preventScroll:true});
    });
  }
  function close() {
    if (executing) return;
    setTask(null);
    returnFocus.current?.focus();
  }
  function choose(s: FarmSelection, zoomTier = false) {
    setTierZoom(zoomTier || (s.bedId === selection?.bedId && tierZoom));
    setZoneFocus(null);
    setSelection(s);
    setDeviceStage(null);
    setFocus(true);
    setCompactMap(true);
    setPlanMode(false);
    setMapLoaded(true);
    setView("map");
    if (narrow) {
      setMapHidden(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".fm-panel")?.scrollIntoView({ block: "start" }));
    }
    setSourceIds([]);
    setQuestion("");
    setMessage("");
    if (!task) setTask("state");
  }
  /** A zone's equipment list, or one device alone on the workbench with its control open. */
  function chooseDevice(zoneId: string, key?: string) {
    setSelection(null);
    setZoneFocus(zoneId);
    setFocus(true);
    setMessage("");
    if (!key) {
      setDeviceStage(null);
      setCompactMap(false);
      open("devices");
      return;
    }
    setDeviceStage(key);
    setDeviceFocus(`${key}#${Date.now()}`);
    setCompactMap(true);
    setPlanMode(false);
    setMapLoaded(true);
    setView("map");
    open("devices");
    if (narrow) {
      setMapHidden(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>(".fm-panel")?.scrollIntoView({ block: "start" }));
    }
  }
  function review(draft: ControlDraft) {
    setChatOpen(false);
    setMessage("");
    const unresolved = JSON.stringify(pendingControls(r.farmId).find(p=>p.draft.target===draft.target&&p.draft.zoneId===draft.zoneId) ?? null);
    if (unresolved !== "null") {
      try {
        setPending({ ...JSON.parse(unresolved), uncertain: true });
        setMessage(L("이전 요청의 반영 여부부터 확인하세요.", "First check whether the previous request was applied."));
        return;
      } catch {
        sessionStorage.removeItem("farmer.pendingControl");
      }
    }
    if (!snapshot) return;
    if (
      !controlDraftCanBeReviewed(
        draft,
        alerts.map((a) => a.occurrenceId),
      )
    )
      return setMessage(L("상태가 변경되었습니다. 다시 확인한 뒤 조절하세요.", "The status has changed. Check again before adjusting."));
    const d = actuatorForControl(
      snapshot.actuators,
      draft.target,
      draft.zoneId,
    );
    setPending({
      draft,
      revision: deviceRevision(d, snapshot),
      requestId: crypto.randomUUID(),
      context:
        draft.origin === "manual"
          ? incidentContextForTarget(
              snapshot.incidents,
              draft.target,
              draft.zoneId,
            )
          : null,
    });
  }
  async function execute() {
    if (!pending || !snapshot || executionLock.current) return;
    const d = actuatorForControl(
      snapshot.actuators,
      pending.draft.target,
      pending.draft.zoneId,
    );
    if (
      !r.connected ||
      !snapshot.operationalControlAllowed ||
      !pending.draft.zoneId ||
      d?.health === "offline"
    ) {
      setMessage(L("연결과 장치 상태를 먼저 확인하세요.", "Check the connection and device status first."));
      return;
    }
    if (
      !pending.uncertain &&
      pending.revision !== deviceRevision(d, snapshot)
    ) {
      setPending(null);
      setMessage(
        L("장치나 경보 상태가 바뀌었습니다. 변경 내용을 다시 확인하세요.", "Device or alert status changed. Review the change again."),
      );
      return;
    }
    rememberControl(r.farmId, pending);
    executionLock.current = true;
    setExecuting(true);
    setMessage("");
    try {
      const v = pending.draft;
      const context = pending.context;
      const result = await createControlProposal(r.farmId, {
        requestId: pending.requestId,
        action: v.action,
        target: v.target,
        zoneId: v.zoneId!,
        value: v.value,
        rationale: v.rationale,
        ...controlProvenance(v),
        contextAlertId: context?.alertId,
        contextAlertOccurrenceId: context?.occurrenceId,
      });
      forgetControl(r.farmId, pending);
      setPending(null);
      setMessage(
        result.verification?.outcome === "resolved"
          ? L("장치 반영과 환경 회복을 확인했습니다.", "Device change and environment recovery confirmed.")
          : result.executionStatus === "applied_to_simulator"
            ? L("장치가 응답했습니다. 환경 변화는 계속 확인합니다.", "The device replied. Environment changes are still being watched.")
            : (result.failureReason ?? L("장치 반영 여부를 확인해야 합니다.", "Check whether the device applied the change.")),
      );
      await Promise.all([r.refreshRecords(), r.refreshLive()]);
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500)
        forgetControl(r.farmId, pending);
      setPending((p) =>
        status && status >= 400 && status < 500
          ? null
          : p
            ? { ...p, uncertain: true }
            : p,
      );
      setMessage(
        `${status && status >= 400 && status < 500 ? L("변경하지 않았습니다", "Not changed") : L("반영 여부 확인 중", "Checking whether it was applied")}. ${e instanceof Error ? (e.message.includes("already has the requested state") ? L("이미 선택한 상태입니다. 새 명령은 만들지 않았습니다.", "Already in the selected state. No new command was created.") : /abort|fetch|network/i.test(e.message) ? L("응답을 받지 못했습니다. 같은 요청의 결과를 다시 확인하세요.", "No response received. Check the result of the same request again.") : e.message) : L("응답을 받지 못했습니다.", "No response received.")}`,
      );
      await r.refreshRecords();
    } finally {
      executionLock.current = false;
      setExecuting(false);
    }
  }
  async function ask(q: string, zoneOverride?: string | null, at?: FarmSelection) {
    if (!q.trim()) return false;
    setMessage("");
    // The question shows in the chat at once, before the answer arrives.
    setSending(q);
    const zone = zoneOverride === undefined ? selectedZone ?? null : zoneOverride;
    try {
      await r.ask(q, at ?? (zoneOverride === undefined ? selection : null), zone, at ? cycleAt(r.cycles, at)?.id : zoneOverride === undefined ? cycle?.id : undefined, sourceIds);
      return true;
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : L("자문을 확인하지 못했습니다.", "Could not get advice."),
      );
      return false;
    } finally {
      setSending(null);
    }
  }
  async function loadSources() {
    setSourceLoading(true);
    const result = await getKnowledge(r.farmId);
    setSources(result.data);
    if (result.error) setMessage(result.error);
    setSourceLoading(false);
  }
  useEffect(()=>{if(message||pending) panelRef.current?.scrollTo({top:0});},[message,pending]);
  // A device opened from an alert, cue or reading must be on screen, not below the fold.
  useEffect(() => {
    if (!deviceFocus) return;
    const id = window.setTimeout(() => panelRef.current?.querySelector<HTMLElement>(".fm-equipment[data-focused]")?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
    return () => window.clearTimeout(id);
  }, [deviceFocus]);
  // One ordered list reads every channel: connection, alerts, unconfirmed controls,
  // observations, patrol records, stale advice, running cases, harvest dates.
  // Before the first reply nothing has failed yet: say "connecting", not "connection lost".
  const connecting = !snapshot && !r.error;
  const todos = buildTodos({
    connected: r.connected,
    connecting,
    alerts,
    observationProblem: observationProblem(snapshot?.metrics ?? []),
    pendingControls: unconfirmed.length,
    activeCases: activeCases.length,
    patrolOpen,
    adviceStale: !!turn?.stateReview && ["stale", "needs_confirmation"].includes(turn.stateReview.status),
    plannedHarvests: plannedHarvests(r.cycles).length,
    zoneLabel,
  });
  const todo = todos[0];
  // Example cameras on the plan.
  const planCameras = (demoCameras?.cameras ?? []).map((c) => {
    const feed = feeds.live?.find((f) => f.id === c.id);
    const tone = feed ? feedTone(feed) : cameraFinding(c) ? ("attention" as const) : ("ok" as const);
    return { id: c.id, label: L(`${cameraLabel(c)} (예시 카메라)`, `${cameraLabel(c)} (example camera)`), zoneId: c.zone_id, col: c.col, row: c.row, angle: c.angle, tone };
  });
  // The AI brief: every channel read together, ranked, pinned to its place.
  // Each device's request against its report: applying for a few seconds, or staying different.
  const progressSeen = useRef(new Map<string, number>());
  const progress = useMemo(() => trackProgress(snapshot?.actuators ?? [], progressSeen.current, Date.now()), [snapshot]);
  const brief = buildBrief({
    connected: r.connected || connecting,
    alerts,
    metrics: snapshot?.metrics ?? [],
    thresholds,
    actuators: snapshot?.actuators ?? [],
    pending: unconfirmed.map((p) => ({ target: p.draft.target, zoneId: p.draft.zoneId ?? null })),
    cycles: r.cycles,
    beds: r.layout?.beds ?? [],
    zoneLabel,
    cameras: demoCameras?.cameras ?? [],
    cameraEvents: feeds.live ? openCameraEvents(patrol.events).map((e) => {
      const feed = feeds.live?.find((f) => f.id === e.camera_id);
      return {
        id: e.id, checkId: e.check_id ?? "", cameraId: e.camera_id, cameraTitle: feed ? feedTitle(feed) : e.camera_id,
        zoneId: e.zone_id ?? feed?.zone_id ?? null, bedId: e.bed_id ?? feed?.bed_id ?? null,
        title: eventTitle(e), text: eventText(e), ask: e.ask ?? null, synthetic: !!e.synthetic, createdAt: e.created_at,
      };
    }) : undefined,
    turns: r.turns,
    acknowledged: Object.fromEntries(r.cases.filter((c) => c.acknowledgedAt && c.status !== "resolved").map((c) => [c.alertId, c.acknowledgedAt!])),
    hidden: hiddenToday,
    diseaseWatch: disease,
    weather,
    settling: Object.keys(progress).filter((key) => progress[key].state === "settling"),
  });
  // The AI alert analysis for the two alerts at the top; the server caches it per alert.
  const { advice, refresh: refreshAdvice } = useAlertAdvice(r.farmId, brief.filter((i) => i.alertId).slice(0, 2).map((i) => i.alertId!));
  const stops = workPlan(brief, r.layout?.beds ?? [], r.layout?.zones.map((z) => z.id) ?? []);
  const [hoverBrief, setHoverBrief] = useState<string | null>(null);
  // Pins follow the open tab: the top three, or every stop of today's route in order.
  const pins: PlanPin[] = briefTab === "work"
    ? stops.flatMap((s, i) => s.anchor && !workDone.includes(s.id) ? [{ id: s.id, rank: i + 1, tone: s.item.tone, anchor: s.anchor, label: s.item.what }] : [])
    : brief.slice(0, 3).flatMap((item, i) => item.anchor ? [{ id: item.id, rank: i + 1, tone: item.tone, anchor: item.anchor, label: item.what }] : []);
  useEffect(() => {
    // A new top item while the tab is hidden: one browser notification, if the farmer turned them on.
    const top = brief[0];
    if (!notify || !top || notifySupport() !== "granted" || !document.hidden) return;
    const key = "farmer.notified";
    try { if (localStorage.getItem(key) === top.id) return; localStorage.setItem(key, top.id); } catch { /* storage unavailable */ }
    showNotification(L("우리 농장: 먼저 볼 곳", "Our farm: look here first"), `${top.what}. ${top.todo}`);
  }, [notify, brief[0]?.id]);
  const watched = snapshot
    ? L(
        `${shortStamp(latestObservedAt(snapshot.metrics))} 기준, 센서 ${snapshot.metrics.length}개, 설비 ${snapshot.actuators.length}대${demoCameras ? `, 예시 카메라 ${demoCameras.cameras.length}대` : ""}`,
        `As of ${shortStamp(latestObservedAt(snapshot.metrics))}: ${snapshot.metrics.length} sensors, ${snapshot.actuators.length} devices${demoCameras ? `, ${demoCameras.cameras.length} example cameras` : ""}`,
      )
    : L("농장 값을 받는 중", "Receiving farm data");
  const onMain = view === "map" && stage === "overview";
  // Away from the main page, the AI speaks up once per item it thinks was missed.
  const [nudgeReady, setNudgeReady] = useState("");
  const [dismissed, setDismissed] = useState<string[]>(() => { try { return JSON.parse(sessionStorage.getItem("farmer.nudgeDismissed") ?? "[]"); } catch { return []; } });
  // Entered from the first page to see one case: no bubble covers that case while it is on screen.
  const onStartCase = !!start && (
    start.kind === "bed" ? view === "map" && stage === "bed" && selection?.bedId === start.bedId
    : start.kind === "device" ? view === "map" && stage === "device" && deviceStage === start.key
    : start.kind === "zone" ? view === "map" && stage === "zone" && zoneFocus === start.zoneId
    : start.kind === "camera" ? view === "camera"
    : start.kind === "library" ? view === "library"
    : false);
  // An item already shown in the open panel ("AI 판단") is not said again in a bubble.
  // Management pages (settings, library, report) are left alone; the camera page and open panels still hear it.
  const nudgeItem = !onMain && !onStartCase && !narrow && (view === "map" || view === "camera") && !reader ? brief.find((i) => i.tone !== "info" && !dismissed.includes(i.id) && !(view === "map" && !!i.anchor && i.anchor.zoneId === selectedZone)) ?? null : null;
  const nudgeKey = nudgeItem?.id ?? "";
  useEffect(() => {
    if (!nudgeKey || dismissed.includes(nudgeKey)) return;
    const id = window.setTimeout(() => setNudgeReady(nudgeKey), 2500);
    return () => window.clearTimeout(id);
  }, [nudgeKey, dismissed]);
  const nudge = nudgeItem && nudgeReady === nudgeKey ? nudgeItem : null;
  function dismissNudge() {
    if (!nudgeKey) return;
    const next = [...dismissed, nudgeKey];
    setDismissed(next);
    try { sessionStorage.setItem("farmer.nudgeDismissed", JSON.stringify(next)); } catch { /* storage unavailable */ }
  }
  function startTour() { goMain(); setTourOpen(true); }
  function goMain() {
    setSelection(null); setZoneFocus(null); setTask(null); setFocus(false); setCompactMap(false); setChatOpen(false); setReader(null); setView("map"); showPlan();
  }
  /** The library, opened at a page (and a sentence on it) when one is named. */
  function openLibrary(documentId?: string | null, quote?: string | null) {
    setReader(null); setChatOpen(false); setLibraryFocus(documentId ? { documentId, quote: quote ?? null } : null); setView("library");
  }
  /** From the library to the reading a guide sentence is about: the zone where it needs a look, else the first. */
  function openReadingFromLibrary(metricKey: string) {
    const rows = (snapshot?.metrics ?? []).filter((m) => m.key === metricKey && m.zoneId);
    const row = rows.find((m) => m.status !== "normal") ?? rows[0];
    if (!row?.zoneId) return;
    selectZone(row.zoneId);
    const rowKey = `${metricKey}:${row.zoneId}`;
    setReadingsOpen(true);
    setExpandedReading(rowKey);
    requestAnimationFrame(() => document.getElementById(`fm-reading-${rowKey}`)?.scrollIntoView({ block: "center" }));
  }
  /** From the library to an answer that cited a guide: the place it was asked about, with the chat open. */
  function openAnswerFromLibrary(t: { queryContext?: { bedId?: string | null; zoneScopeMode?: string; selectedZoneIds?: string[] } | null; responseId?: string | null }) {
    const context = t.queryContext;
    setFocusAnswer(t.responseId ?? null);
    const at = context?.bedId ? bedAt(context.bedId) : null;
    if (at) choose(at);
    else if (context?.zoneScopeMode === "focused" && context.selectedZoneIds?.[0]) selectZone(context.selectedZoneIds[0]);
    else goMain();
    requestAnimationFrame(() => open("advisor"));
  }
  function toggleNotify(next: boolean) {
    const apply = (on: boolean) => {
      setNotify(on);
      try { localStorage.setItem("farmer.notify", String(on)); } catch { /* storage unavailable */ }
      setNotifyState(notifySupport());
      // One notice right away shows that this device receives them.
      if (on) showNotification(L("우리 농장 알림", "Farm notifications"), L("이 기기에서 '먼저 볼 곳' 1순위가 바뀌면 알립니다.", "This device will be told when the top item changes."), "farmer-notify-on");
    };
    if (!next) apply(false);
    else if (notifySupport() === "granted") apply(true);
    else if (notifySupport() === "default") void Notification.requestPermission().then((p) => apply(p === "granted")).catch(() => apply(false));
    else apply(false);
  }
  function togglePrivateRemote(next: boolean) {
    void setAiPrivacy(r.farmId, next).then((p) => setPrivateRemote(p.allow_private_remote)).catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
  }
  function selectZone(zoneId: string) {
    setSelection(null); setDeviceStage(null); setZoneFocus(zoneId); setFocus(true); setCompactMap(false); setView("map"); setMessage(""); open("state");
  }
  /** A bed with its first planted tier (or its lowest), for questions and harvest work. */
  function bedAt(bedId: string): FarmSelection | null {
    const target = r.layout?.beds.find((b) => b.id === bedId);
    if (!target) return null;
    const planted = r.cycles.filter((c) => c.bed_id === bedId && c.status === "growing").map((c) => c.tier).sort((a, b) => a - b)[0];
    return { bedId, tier: planted ?? target.tiers[0]?.tier ?? 1 };
  }
  // Entered from the first page with a place in mind: open it once the layout is here.
  const startApplied = useRef(false);
  useEffect(() => {
    if (!start || startApplied.current || !r.layout) return;
    startApplied.current = true;
    if (start.kind === "bed") {
      const known = start.tier && r.layout.beds.some((b) => b.id === start.bedId && b.tiers.some((t) => t.tier === start.tier));
      const at = known ? { bedId: start.bedId, tier: start.tier! } : bedAt(start.bedId);
      if (at) choose(at);
      if (start.tab && start.tab !== "state") { const tab = start.tab; requestAnimationFrame(() => open(tab)); }
      if (start.chat) requestAnimationFrame(() => open("advisor"));
    } else if (start.kind === "device") {
      chooseDevice(start.zoneId, start.key);
      if (start.tab === "state") requestAnimationFrame(() => open("state"));
    } else if (start.kind === "zone") {
      selectZone(start.zoneId);
      if (start.chat) requestAnimationFrame(() => open("advisor"));
    } else if (start.kind === "chat") open("advisor");
    else if (start.kind === "camera") {
      if (start.focus) setCameraFocus(start.focus);
      setView("camera");
    }
    else if (start.kind === "library") setView("library");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, r.layout]);
  /** The primary button of a brief item: go where the problem is, with the right tool open. */
  function runBrief(item: BriefItem) {
    const a = item.anchor;
    switch (item.go) {
      case "reconnect": void r.refresh(); return;
      case "ask": askBrief(item); return;
      case "sensor":
      case "device":
        if (a?.kind === "device") chooseDevice(a.zoneId, a.deviceKey);
        else if (a) selectZone(a.zoneId);
        return;
      case "zone": if (a) selectZone(a.zoneId); return;
      case "harvest": {
        const at = a?.kind === "bed" ? bedAt(a.bedId) : null;
        if (at) { choose(at); open("crop"); }
        return;
      }
      case "camera":
        if (a?.kind === "camera") setCameraFocus(a.cameraId);
        setView("camera");
        return;
      case "advice": {
        const at = a?.kind === "bed" ? bedAt(a.bedId) : null;
        if (at) choose(at); else if (a) selectZone(a.zoneId);
        open("advisor");
        return;
      }
      case "pending": {
        if (a) selectZone(a.zoneId);
        const first = unconfirmed[0];
        if (first) setPending({ ...first, uncertain: true });
        open("records");
        return;
      }
    }
  }
  /** "AI에게 묻기": the item's question, asked about the place it concerns. */
  function askBrief(item: BriefItem) {
    if (!item.ask) return;
    const at = item.askAt?.bedId ? bedAt(item.askAt.bedId) : null;
    if (at) {
      choose(at);
      open("advisor");
      void ask(item.ask, item.askAt?.zoneId ?? null, at);
      return;
    }
    openChatWith(item.ask, item.askAt?.zoneId ?? null);
  }
  /** "확인함": the alert's case is marked seen on the server; it stays until values recover. */
  async function ackBrief(item: BriefItem) {
    const c = r.cases.find((x) => x.alertId === item.alertId && x.status !== "resolved");
    if (!c || !item.alertId) { setMessage(L("이 경보의 처리 기록을 찾지 못했습니다. 잠시 후 다시 시도하세요.", "No handling record for this alert yet. Try again shortly.")); return; }
    setAcking((a) => [...a, item.alertId!]);
    try { await acknowledgeOperationCase(r.farmId, c.incidentId); await r.refreshRecords(); }
    catch (e) { setMessage(e instanceof Error ? e.message : L("확인 기록을 남기지 못했습니다.", "Could not record it.")); }
    finally { setAcking((a) => a.filter((x) => x !== item.alertId)); }
  }
  function hideBrief(item: BriefItem) { setHiddenToday((h) => [...new Set([...h, item.id])]); }
  function openChatWith(q: string, zoneId: string | null, bedId?: string | null) {
    const at = bedId ? bedAt(bedId) : null;
    if (at) { choose(at); open("advisor"); void ask(q, zoneId, at); return; }
    // The answer shows for the place it is about, so move the context there first.
    if (zoneId && bed?.zone_id !== zoneId) { setSelection(null); setZoneFocus(zoneId); }
    open("advisor");
    void ask(q, zoneId);
  }
  // What the stage draws for the chosen place, from readings, alerts and device reports only.
  const cues = snapshot && selectedZone
    ? stageCues({ metrics: snapshot.metrics, thresholds, alerts: snapshot.alerts, actuators: snapshot.actuators, zoneId: selectedZone, connected: r.connected })
    : null;
  const sensorSuspect = (zoneId?: string | null) =>
    alerts.some((a) => a.kind === "sensor_health" && a.zoneId === zoneId) ||
    (snapshot?.metrics ?? []).some((m) => m.zoneId === zoneId && m.key === "air_temperature_c" && !!m.quality && m.quality !== "good");
  /** A device's state in one phrase; the temperature sensor reports its reading, not "on"/"completed". */
  const deviceStateText = (d: { target?: string | null; health?: string; state: string; zoneId?: string | null }) =>
    d.target === "air_temperature_sensor_reset"
      ? sensorSuspect(d.zoneId) ? L("값 확인 필요", "Reading needs a check") : L("정상 수신", "Receiving normally")
      : d.health === "fault" ? L("점검 필요", "Needs inspection") : operationalStateText(d.state);
  const stageDevice = deviceStage ? snapshot?.actuators.find((d) => `${d.zoneId}:${d.target ?? d.key}` === deviceStage) ?? null : null;
  const stageDeviceLevel = stageDevice ? deviceLevel(stageDevice) : null;
  // The page path in the top bar; its last item is the page title.
  const crumbs: string[] =
    view === "camera" ? [L("카메라 관제", "Camera monitoring")]
    : view === "report" ? [L("주간 보고서", "Weekly report")]
    : view === "library" ? [L("자료실", "Reference library")]
    : view === "settings" ? [L("설정", "Settings")]
    : view === "research" ? [L("시스템", "System"), L("연구 모듈 지도", "Research module map")]
    : stage === "device" && stageDevice ? [L("종합 현황", "Overview"), zoneLabel(stageDevice.zoneId), term(stageDevice.label)]
    : (stage === "bed" || (narrow && stage === "zone")) && bed && selection ? [L("종합 현황", "Overview"), zoneLabel(bed.zone_id), place(bed.label)]
    : stage === "zone" && selectedZone ? [L("종합 현황", "Overview"), zoneLabel(selectedZone)]
    : [L("종합 현황", "Overview")];
  const stageDeviceSpec: DeviceSpec | null = stageDevice && stageDeviceLevel
    ? {
        key: deviceStage!,
        target: stageDevice.target ?? null,
        label: stageDevice.label,
        on: stageDeviceLevel.on,
        percent: stageDeviceLevel.percent,
        tone: stageDevice.health === "fault" || stageDevice.health === "offline" || (stageDevice.target === "air_temperature_sensor_reset" && !!cues?.sensor && cues.sensor !== "ok") ? "attention" : "ok",
        health: stageDevice.health === "fault" || stageDevice.health === "offline" ? "fault" : stageDevice.target === "air_temperature_sensor_reset" && !!cues?.sensor && cues.sensor !== "ok" ? "suspect" : "ok",
        progress: progress[stageDevice.key]?.state ?? null,
      }
    : null;
  // Where a machine's work goes, under its 3D model: "근권에 찬 양액: B구역 베드 9개".
  const stageReach = stageDevice ? deviceReach(stageDevice.target) : null;
  const stageBeds = stageDevice ? r.layout?.devices.find((x) => x.key === stageDevice.key)?.affected_bed_ids.length ?? 0 : 0;
  const recentApproval = r.approvals
    .filter((a) => (!selectedZone || a.zoneId === selectedZone) && a.createdAtIso && Date.now() - Date.parse(a.createdAtIso) < 30 * 60 * 1000)
    .sort((a, b) => Date.parse(b.createdAtIso!) - Date.parse(a.createdAtIso!))[0];
  const suggestions = suggestedQuestions({
    crop: farm.crop,
    alerts: zoneAlerts,
    recentControl: recentApproval ? { device: recentApproval.device, value: recentApproval.requestedValue } : null,
    harvestInDays: daysUntil(cycle?.planned_harvest_from),
  });
  // Beds in walking order (row by row) for "이전 · 다음".
  const orderedBeds = [...(r.layout?.beds ?? [])].sort((a, b) => a.position.z - b.position.z || a.position.x - b.position.x);
  const bedIndex = bed ? orderedBeds.findIndex((b) => b.id === bed.id) : -1;
  const prevBed = bedIndex > 0 ? orderedBeds[bedIndex - 1] : null;
  const nextBed = bedIndex >= 0 && bedIndex < orderedBeds.length - 1 ? orderedBeds[bedIndex + 1] : null;
  function openCue(cue: Cue) {
    if (cue.deviceKey) { setDeviceFocus(`${cue.deviceKey}#${Date.now()}`); open("devices"); return; }
    if (cue.metricKey) {
      const rowKey = `${cue.metricKey}:${selectedZone}`;
      setReadingsOpen(true);
      setExpandedReading(rowKey);
      open("state");
      requestAnimationFrame(() => document.getElementById(`fm-reading-${rowKey}`)?.scrollIntoView({ block: "nearest" }));
      return;
    }
    open("state");
  }
  function runTodo(item: TodoItem) {
    switch (item.kind) {
      case "reconnect":
        void r.refresh();
        return;
      case "zone":
        setSelection(null);
        setDeviceStage(null);
        setZoneFocus(item.zoneId ?? null);
        setCompactMap(false);
        setFocus(true);
        setView("map");
        open("state");
        return;
      case "state":
        setView("map");
        open("state");
        return;
      case "pending": {
        const first = unconfirmed[0];
        if (first) setPending({ ...first, uncertain: true });
        open("records");
        return;
      }
      case "camera":
        setView("camera");
        requestAnimationFrame(() => document.getElementById("fm-patrol")?.scrollIntoView({ block: "start" }));
        return;
      case "advisor":
        open("advisor");
        return;
      case "records":
        open("records");
        return;
      case "crop":
        open("crop");
        return;
    }
  }
  // A rechecked answer in the handover names the place it was asked about.
  const turnPlace = (t: { queryContext?: { bedId?: string | null; zoneScopeMode?: string; selectedZoneIds?: string[] } | null }) => {
    const bedLabel = t.queryContext?.bedId ? r.layout?.beds.find((b) => b.id === t.queryContext!.bedId)?.label : null;
    if (bedLabel) return place(bedLabel);
    const zone = t.queryContext?.zoneScopeMode === "focused" ? t.queryContext.selectedZoneIds?.[0] : null;
    return zone ? zoneLabel(zone) : null;
  };
  const sinceIso = new Date(Date.now() - handoverHours * 3600 * 1000).toISOString();
  const since = sinceSummary({ alerts: snapshot?.alerts ?? [], approvals: r.approvals, turns: r.turns, patrol: patrol.events }, sinceIso, zoneLabel, 12, turnPlace);
  const remainingWork = stops.filter((s) => !workDone.includes(s.id)).length;
  // With a panel open, the AI speaks at the top of the panel instead of over it.
  const nudgeInline = view === "map" && stage !== "overview";
  // The main page's right-hand column: the same frame as the bed and device panels.
  const briefPanel = onMain && (
    <aside className={`fm-panel fm-brief-panel ${narrow ? "is-phone" : ""}`} aria-label={L("AI 브리핑", "AI brief")}>
      <div className="fm-panel-head">
        <div className="fm-panel-title">
          <strong className="fm-brief-title"><AiMark title={L("AI가 고른 우선순위", "Ranked by the AI")} />{L("AI 브리핑", "AI brief")}</strong>
          <p className="fm-panel-status">{watched}</p>
        </div>
      </div>
      <div className="fm-tabs is-three" role="tablist" aria-label={L("AI 브리핑 보기", "AI brief views")}>
        {([["brief", L("먼저 볼 곳", "Look first")], ["work", L("오늘 작업", "Today")], ["handover", L("인수인계", "Handover")]] as const).map(([id, text]) => (
          <button key={id} id={`brief-tab-${id}`} role="tab" aria-selected={briefTab === id} aria-controls="brief-body" onClick={() => setBriefTab(id)}>
            {text}{id === "work" && remainingWork > 0 ? <em className="fm-count">{remainingWork}</em> : null}
          </button>
        ))}
      </div>
      <div className="fm-panel-body" id="brief-body" role="tabpanel" aria-labelledby={`brief-tab-${briefTab}`}>
        {briefTab === "brief" && (
          <AiBrief
            headless
            items={brief}
            advice={advice}
            active={hoverBrief}
            watched=""
            phone={narrow}
            onHover={setHoverBrief}
            onGo={runBrief}
            onAsk={askBrief}
            onDraft={(draft) => { if (draft.zoneId) selectZone(draft.zoneId); review(draft); }}
            zoneLabel={zoneLabel}
            onAck={(item) => void ackBrief(item)}
            onHide={hideBrief}
            onRefresh={refreshAdvice}
            acking={acking}
            onOpenSources={setReader}
          />
        )}
        {briefTab === "work" && (
          <WorkPlanList phone={narrow} stops={stops} done={workDone} onToggle={(id) => setWorkDone((d) => d.includes(id) ? d.filter((x) => x !== id) : [...d, id])} onGo={runBrief} active={hoverBrief} onHover={setHoverBrief} />
        )}
        {briefTab === "handover" && (
          <HandoverNote
            farmId={r.farmId}
            since={since.items}
            items={brief}
            open={brief.filter((i) => !i.acknowledgedAt)}
            sinceLabel={L(`${formatSensorUpdateTime(sinceIso)} 이후`, `Since ${formatSensorUpdateTime(sinceIso)}`)}
            hours={handoverHours}
            onHours={setHandoverHours}
          />
        )}
      </div>
    </aside>
  );
  const locationForm = (
              <form className="fm-location" onSubmit={(e) => {
                e.preventDefault();
                // An empty field is not 0 (Number("") is 0, a point in the Atlantic).
                const read = (v: string) => (v.trim() === "" ? NaN : Number(v));
                const lat = read(location.latitude), lon = read(location.longitude);
                if (!location.label.trim() || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) {
                  setMessage(L("위치 이름과 위도(-90~90), 경도(-180~180)를 확인해 주세요.", "Check the name, the latitude (-90 to 90) and the longitude (-180 to 180)."));
                  return;
                }
                void saveFarmLocation(r.farmId, { label: location.label.trim(), latitude: lat, longitude: lon })
                  .then(() => weatherForecast(r.farmId).then(setWeather))
                  .then(() => setMessage(L("농장 위치를 저장했습니다. 날씨 준비 알림에 씁니다.", "Farm location saved for weather alerts.")))
                  .catch((err) => setMessage(err instanceof Error ? err.message : String(err)));
              }}>
                <div className="fm-location-presets">
                  {([["제주", "Jeju", 33.45, 126.56], ["철원", "Cheorwon", 38.15, 127.31], ["평창", "Pyeongchang", 37.37, 128.39], ["봉화", "Bonghwa", 36.89, 128.73]] as const).map(([ko, en, la, lo]) => (
                    <button type="button" key={ko} onClick={() => setLocation({ label: L(ko, en), latitude: String(la), longitude: String(lo) })}>{L(ko, en)}</button>
                  ))}
                </div>
                <div className="fm-location-fields">
                  <label>{L("이름", "Name")}<input value={location.label} onChange={(e) => setLocation((v) => ({ ...v, label: e.target.value }))} /></label>
                  <label>{L("위도", "Latitude")}<input inputMode="decimal" value={location.latitude} onChange={(e) => setLocation((v) => ({ ...v, latitude: e.target.value }))} /></label>
                  <label>{L("경도", "Longitude")}<input inputMode="decimal" value={location.longitude} onChange={(e) => setLocation((v) => ({ ...v, longitude: e.target.value }))} /></label>
                </div>
                <button className="fm-primary">{L("위치 저장", "Save location")}</button>
                <RefNote kind="weather" compact />
              </form>
  );
  const devTools = (
              <details className="fm-dev-tools">
                <summary>{L("개발과 검토 도구", "Developer & review tools")}</summary>
                <label className="fm-inline-check">
                  <input type="checkbox" checked={showModules} onChange={(e) => setShowModules(e.target.checked)} />
                  {L("화면에 연구 모듈 위치 표시", "Show research module locations on screen")}
                </label>
                <button className="fm-wide" onClick={() => setView("research")}>
                  {L("연구 모듈 지도", "Research module map")} <span>›</span>
                </button>
                <button className="fm-wide" onClick={onLegacy}>
                  {L("기존 운영 콘솔", "Legacy operations console")} <span>›</span>
                </button>
                <a className="fm-wide fm-link" href={assetUrl("/answer-review.html")}>
                  {L("연구용 답변 비교", "Research answer comparison")} <span>›</span>
                </a>
                <p>
                  {L("입력 출처", "Input source")}: {snapshot?.inputMode ?? L("미확인", "Unknown")},{" "}
                  {snapshot?.dataOrigin ?? L("미확인", "Unknown")}
                </p>
                <p>{cameraSummary(r.layout).text}. {patrol.status === "error" ? L("관제 기록 연결 확인 필요", "Monitoring records: check connection") : L(`관제 기록 ${patrol.events.length}건`, `Monitoring records: ${patrol.events.length}`)}</p>
                <button onClick={() => setView("camera")}>
                  {L("카메라 화면에서 연결 다시 확인", "Recheck connection on the camera screen")}
                </button>
              </details>
  );
  const notice = (message || r.error) && (
    <div className="fm-inline-notice" role="status">
      <span>{message || r.error}</span>
      <button
        aria-label={L("안내 닫기", "Close notice")}
        onClick={() => {
          setMessage("");
          if (r.error) void r.refresh();
        }}
      >
        ×
      </button>
    </div>
  );
  return (
    <main
      className={`farmer-workspace is-${stage} ${view !== "map" ? "is-camera" : ""} ${onMain && !narrow ? "has-brief" : ""} ${reader ? "has-reader" : ""} ${contrast ? "high-contrast" : ""} ${showModules ? "show-modules" : ""}`}
      data-theme={resolved}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          if (pending && !executing && !pending.uncertain) setPending(null);
          else close();
        }
      }}
    >
      <header className="fm-header">
        {/* The first page (the service page with the drawn farm) is one tap away from anywhere. */}
        {onHome && (
          <button
            className={`fm-icon-btn fm-home ${onMain ? "" : "is-sub"}`}
            aria-label={L("첫 화면으로", "Home page")}
            title={L("첫 화면으로", "Home page")}
            onClick={onHome}
          >
            <FarmIcon name="home" />
          </button>
        )}
        {!onMain && (
          <button className="fm-icon-btn" aria-label={L("메인으로", "Back to main")} title={L("메인으로", "Back to main")} onClick={goMain}><FarmIcon name="back" /></button>
        )}
        <h1 className="fm-title">{onMain ? (term(r.layout?.farm?.name ?? r.layout?.name) || L("우리 농장", "Our farm")) : crumbs[crumbs.length - 1]}</h1>
        <div className="fm-header-meta">
          <OperatingPanel farmId={r.farmId} compact />
          {alerts.length > 0 && (
            <button className={`fm-alert-chip is-${todo.tone}`} onClick={() => runTodo(todo)} title={todo.title} aria-label={L(`경보 ${alerts.length}건: ${todo.title}`, `${alerts.length} alerts: ${todo.title}`)}>
              <FarmIcon name="warning" /><b>{alerts.length}</b>
            </button>
          )}
          {(() => {
            const state = r.connected ? L("정상 수신", "Receiving") : connecting ? L("연결 중", "Connecting") : L("수신 끊김", "Disconnected");
            const time = snapshot ? formatSensorUpdateTime(latestObservedAt(snapshot.metrics)) : null;
            return (
              <button
                type="button"
                className="fm-icon-btn fm-live-btn"
                aria-label={L(`${state}. 누르면 다시 받습니다`, `${state}. Tap to refresh`)}
                title={time ? L(`${time} 기준. 누르면 다시 받습니다`, `As of ${time}. Tap to refresh`) : state}
                onClick={() => void r.refresh()}
              >
                <span className={`fm-live is-${r.connected ? "ok" : connecting ? "info" : "warn"}`} aria-hidden="true" />
              </button>
            );
          })()}
          {/* On a phone the top bar has no room for the refresh button: the dot alone says the state. */}
          <span className={`fm-live fm-live-phone is-${r.connected ? "ok" : connecting ? "info" : "warn"}`} role="img" aria-label={r.connected ? L("정상 수신", "Receiving") : connecting ? L("연결 중", "Connecting") : L("수신 끊김", "Disconnected")} />
          <button className="fm-icon-btn fm-help" aria-label={L("사용법", "How to use")} title={L("사용법", "How to use")} onClick={startTour}>
            <FarmIcon name="help" />
          </button>
          <button className="fm-icon-btn" aria-label={L("카메라", "Cameras")} title={L("카메라", "Cameras")} aria-pressed={view === "camera"} onClick={() => setView(view === "camera" ? "map" : "camera")}>
            <FarmIcon name="camera" />{patrolOpen > 0 && <em className="fm-count">{patrolOpen}</em>}
          </button>
          <button className="fm-icon-btn fm-lib-icon" aria-label={L("자료실", "Reference library")} title={L("자료실: AI 상담이 인용하는 재배 자료", "Library: the guides the AI advisor cites")} aria-pressed={view === "library"} onClick={() => (view === "library" ? goMain() : openLibrary())}>
            <FarmIcon name="book" />
          </button>
          <button className="fm-icon-btn" aria-label={L("설정", "Settings")} title={L("설정", "Settings")} aria-pressed={view === "settings"} onClick={() => { setChatOpen(false); setReader(null); setView(view === "settings" ? "map" : "settings"); }}>
            <FarmIcon name="settings" />
          </button>
          <Prefs compact />
        </div>
      </header>

      <section
        className={`fm-world ${view !== "map" ? "is-camera" : ""} ${view === "map" && mapHidden ? "is-hidden" : ""} ${view === "map" && (narrow ? stage === "overview" || stage === "zone" : tablet && stage === "zone") ? "is-list" : ""}`}
        aria-label={L("우리 농장 보기", "Farm view")}
      >
        <div className="fm-map-stage" data-stage={stage}>
          {mapHidden && (
            <div className="fm-map-folded">
              <button className="fm-map-reopen" onClick={() => setMapHidden(false)}>
                <FarmIcon name={stage === "bed" ? "bed" : stage === "device" ? "controls" : "map"} />
                {stage === "bed" && bed ? L(`${bed.label} 3D 보기`, `View ${place(bed.label)} in 3D`) : stage === "device" && stageDevice ? L(`${stageDevice.label} 3D 보기`, `View ${term(stageDevice.label)} in 3D`) : L("배치도 보기", "View layout")}
              </button>
              {(stage === "bed" || stage === "device") && <button onClick={showPlan}>{L("배치도로", "Back to layout")}</button>}
            </div>
          )}
          {r.layout && (stage === "overview" || stage === "zone") && (() => {
            // The SVG plan needs width; with the panel open on a tablet the list reads better.
            const Plan = narrow || (tablet && stage === "zone") ? FarmPlanList : FarmPlan;
            return (
              <>
              {narrow && briefPanel}
              <Plan
                layout={r.layout}
                snapshot={snapshot}
                connected={r.connected}
                selection={selection}
                selectedZone={selectedZone}
                selectedDevice={deviceStage}
                progress={progress}
                cycles={r.cycles}
                plantScales={plantScales}
                onSelectBed={(bedId) => {
                  // A new bed opens on its lowest planted tier, so a bed planted only on tier 4 opens there.
                  const tier = selection?.bedId === bedId ? selection.tier : bedAt(bedId)?.tier;
                  if (tier !== undefined) choose({ bedId, tier });
                }}
                onSelectZone={selectZone}
                onSelectDevice={chooseDevice}
                cameras={planCameras}
                onSelectCamera={(id) => { setCameraFocus(id); setView("camera"); }}
                pins={pins}
                route={briefTab === "work"}
                activePin={hoverBrief}
                onPinHover={setHoverBrief}
                onPin={(id) => { const item = brief.find((i) => i.id === id); if (item) runBrief(item); }}
              />
              </>
            );
          })()}
          {r.layout && mapLoaded ? (
            <Suspense
              fallback={
                <div className="fm-map-message" role="status">
                  {L("베드 모형 준비 중…", "Preparing the bed model…")}
                </div>
              }
            >
              <FarmMap
                layout={r.layout}
                selection={selection}
                selectedZoneId={selectedZone}
                alertZoneIds={r.layout?.zones.filter(z=>alerts.some(a=>!a.zoneId||a.zoneId===z.id)).map(z=>z.id)??[]}
                cycles={r.cycles}
                plantScales={plantScales}
                focus={focus}
                compact={compactMap}
                cues={stage === "bed" ? cues : null}
                device={stage === "device" ? stageDeviceSpec : null}
                tierFocus={stage === "bed" && tierZoom}
                live={r.connected}
                onCue={openCue}
                onSelect={(s) => choose(s, stage === "bed" && s.bedId === selection?.bedId)}
                onEquipment={() => open("devices")}
                onFallback={showPlan}
              />
            </Suspense>
          ) : !r.layout ? (
            <div className="fm-empty">
              <h2>{L("배치 정보 수신 중", "Receiving layout")}</h2>
              <p>{r.error || L("배치 정보를 불러오고 있습니다.", "Loading layout information.")}</p>
              <button className="fm-primary" onClick={() => void r.refresh()}>{L("다시 확인", "Check again")}</button>
            </div>
          ) : null}
          {!mapHidden && (stage === "bed" || stage === "device") && (
            <div className="fm-map-bar">
              <span className="fm-map-chip">
                {stage === "bed"
                  ? L(`센서: ${zoneLabel(selectedZone)} 공용`, `Sensors: shared in ${zoneLabel(selectedZone)}`)
                  : stageDeviceLevel && stageDevice ? `${zoneLabel(selectedZone)} / ${stageDevice.target === "air_temperature_sensor_reset" ? deviceStateText(stageDevice) : stageDeviceLevel.text}` : zoneLabel(selectedZone)}
              </span>
              {stage === "device" && stageReach && (
                <span className="fm-map-chip">{L(`${stageReach}: ${zoneLabel(selectedZone)} 베드 ${stageBeds}개`, `${stageReach}: ${stageBeds} ${stageBeds === 1 ? "bed" : "beds"} in ${zoneLabel(selectedZone)}`)}</span>
              )}
              {stage === "device" && stageDevice && progress[stageDevice.key] && (
                <span className={`fm-map-chip is-${progress[stageDevice.key].state}`} role="status">{progressText(progress[stageDevice.key])}</span>
              )}
              {stage === "bed" && cycle && (
                <span className="fm-map-chip" title={L("3D 작물 크기의 근거", "What the plant size in 3D is based on")}>
                  {growthText(growthDisplay(cycle, Date.now(), guidePeriod[cropKey(cycle)]))}
                </span>
              )}
              {stage === "bed" && tierZoom && selection && (
                <button className="fm-map-whole" onClick={() => setTierZoom(false)}>{L(`${selection.tier}단 크게 보는 중 · 베드 전체 보기`, `Tier ${selection.tier} close-up · View whole bed`)}</button>
              )}
              {narrow && <button className="fm-map-hide" onClick={() => setMapHidden(true)}>{L("접기", "Collapse")}</button>}
            </div>
          )}
        </div>
        {view === "research" && (
          <ModuleMap
            onBack={showPlan}
            showTags={showModules}
            onToggleTags={() => setShowModules((v) => !v)}
            onGo={(target) => {
              if (target === "plan") { showPlan(); return; }
              if (target === "camera") { setView("camera"); return; }
              // Show it on a bed that has something to show: the first bed with a saved answer, else one in an alerted zone.
              const alertZone = alerts[0]?.zoneId;
              const answered = r.turns.map((t) => t.queryContext?.bedId).find(Boolean);
              const bedTarget = r.layout?.beds.find((b) => b.id === answered) ?? r.layout?.beds.find((b) => b.zone_id === alertZone) ?? r.layout?.beds[0];
              if (!bedTarget) return;
              setShowModules(true);
              choose({ bedId: bedTarget.id, tier: bedTarget.tiers[0]?.tier ?? 1 });
              requestAnimationFrame(() => open(target === "advisor" ? "advisor" : target === "devices" ? "devices" : "state"));
            }}
          />
        )}
        {view === "library" && (
          <Suspense fallback={<p className="fm-hint" role="status">{L("자료실을 여는 중…", "Opening the library…")}</p>}>
            <Library
              farmId={r.farmId}
              focus={libraryFocus}
              metricKeys={[...new Set((snapshot?.metrics ?? []).map((m) => m.key))]}
              metricLabel={(key) => term(snapshot?.metrics.find((m) => m.key === key)?.label ?? key)}
              onOpenReading={openReadingFromLibrary}
              onOpenAnswer={openAnswerFromLibrary}
              placeOf={turnPlace}
            />
          </Suspense>
        )}
        {view === "report" && (
          <WeeklyReport farmId={r.farmId} layout={r.layout} cycles={r.cycles} cases={r.cases} approvals={r.approvals} onBack={() => setView("settings")} />
        )}
        {view === "settings" && (
          <Settings
            farmId={r.farmId}
            notice={notice}
            theme={theme}
            setTheme={setTheme}
            lang={lang}
            setLang={setLang}
            contrast={contrast}
            setContrast={setContrast}
            privateRemote={privateRemote}
            onPrivateRemote={togglePrivateRemote}
            notify={notify}
            notifyState={notifyState}
            onNotify={toggleNotify}
            locationSummary={forecastNote(weather)}
            locationForm={locationForm}
            onLibrary={() => openLibrary()}
            onReport={() => setView("report")}
            onTour={startTour}
            onHome={onHome}
            devTools={devTools}
          />
        )}
        {view === "camera" && (
          <Suspense fallback={<p className="fm-camera-loading" role="status">{L("카메라 화면 준비 중…", "Preparing the camera screen…")}</p>}>
            <CameraView farmId={r.farmId} layout={r.layout} selectedZone={selectedZone} zoneLabel={zoneLabel} patrol={patrol} feeds={feeds} focusCamera={cameraFocus} onAsk={(q, zone, bedId) => openChatWith(q, zone, bedId)} />
          </Suspense>
        )}
      </section>

      {!narrow && briefPanel}
      <aside className="fm-panel" aria-label={L("농장 작업 패널", "Farm work panel")} hidden={stage === "overview" || view !== "map"}>
        <div className="fm-panel-head">
          <div className="fm-panel-title">
            <strong>{stage === "device" && stageDevice ? term(stageDevice.label) : label}</strong>
            {stage === "device" && stageDevice && stageDeviceLevel ? (
              <p className="fm-panel-status">
                {stageDevice.target === "air_temperature_sensor_reset" ? (
                  <span className={`fm-badge is-${sensorSuspect(stageDevice.zoneId) ? "warn" : "ok"}`}>{sensorSuspect(stageDevice.zoneId) ? L("점검", "Inspect") : L("정상", "Normal")}</span>
                ) : (
                  <span className={`fm-badge is-${stageDevice.health === "fault" || stageDevice.health === "offline" ? "warn" : stageDeviceLevel.on ? "ok" : "off"}`}>
                    {stageDevice.health === "fault" ? L("점검", "Inspect") : stageDevice.health === "offline" ? L("무응답", "No response") : stageDeviceLevel.on ? L("가동", "Running") : L("정지", "Stopped")}
                  </span>
                )}
                <span>{zoneLabel(selectedZone)} / {stageDevice.target === "air_temperature_sensor_reset" ? deviceStateText(stageDevice) : stageDeviceLevel.text}</span>
              </p>
            ) : (
              <>
                <p className="fm-panel-status">
                  <span className={`fm-badge is-${zoneTone === "danger" ? "danger" : zoneTone === "attention" ? "warn" : "ok"}`}>{zoneTone === "danger" ? L("긴급", "Critical") : zoneTone === "attention" ? L("주의", "Warning") : L("정상", "Normal")}</span>
                  <span>{zoneStatus}</span>
                  {bed && (
                    <span className="fm-panel-crop">
                      {cycle ? L(`${cycle.crop} ${cycle.remaining_count}주`, `${term(cycle.crop)}, ${cycle.remaining_count} plants`) : L("재배 미등록", "No crop registered")}
                      {(() => { const d = daysUntil(cycle?.planned_harvest_from); return d !== null && d <= 7 ? <em className="fm-dday">{d < 0 ? L("수확일 지남", "Harvest date passed") : d === 0 ? L("오늘 수확", "Harvest today") : L(`수확 D-${d}`, `Harvest D-${d}`)}</em> : null; })()}
                    </span>
                  )}
                </p>
              </>
            )}
          </div>
          {stage === "bed" && bed && selection && (
            <div className="fm-panel-nav" role="group" aria-label={L("이웃 베드", "Neighbouring beds")}>
              <button disabled={!prevBed} aria-label={prevBed ? L(`이전: ${prevBed.label}`, `Previous: ${place(prevBed.label)}`) : L("이전 베드 없음", "No previous bed")} onClick={() => prevBed && choose({ bedId: prevBed.id, tier: selection.tier })}>
                <FarmIcon name="back" />{prevBed ? place(prevBed.label.replace(/\s*베드$/, "")) : ""}
              </button>
              <button disabled={!nextBed} aria-label={nextBed ? L(`다음: ${nextBed.label}`, `Next: ${place(nextBed.label)}`) : L("다음 베드 없음", "No next bed")} onClick={() => nextBed && choose({ bedId: nextBed.id, tier: selection.tier })}>
                {nextBed ? place(nextBed.label.replace(/\s*베드$/, "")) : ""}<FarmIcon name="chevron" />
              </button>
            </div>
          )}
        </div>
        {bed && selection && (
          <div className="fm-tier-row" role="group" aria-label={L(`${bed.label} 단 고르기`, `Choose a tier of ${place(bed.label)}`)}>
            {[...bed.tiers].sort((a, b) => b.tier - a.tier).map((tier) => {
              const tierCycle = r.cycles.find((c) => c.bed_id === bed.id && c.tier === tier.tier && c.status === "growing");
              return (
                <button
                  key={tier.id}
                  className="fm-tier-select"
                  aria-pressed={selection.tier === tier.tier}
                  aria-label={L(`${tier.tier}단, ${tierCycle ? `${tierCycle.crop} ${tierCycle.remaining_count}주` : "빈 단"}`, `Tier ${tier.tier}, ${tierCycle ? `${term(tierCycle.crop)}, ${tierCycle.remaining_count} plants` : "empty"}`)}
                  onClick={() => choose({ bedId: bed.id, tier: tier.tier }, true)}
                >
                  <strong>{L(`${tier.tier}단`, `Tier ${tier.tier}`)}</strong>
                  <span>{tierCycle ? L(`${tierCycle.remaining_count}주`, `${tierCycle.remaining_count} plants`) : L("빈 단", "Empty")}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="fm-tabs" role="tablist" aria-label={L("작업 단계", "Work steps")}>
          {TABS.filter((t) => stage !== "device" || t.id !== "crop").map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              data-tab={t.id}
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => open(t.id)}
            >
              <FarmIcon name={t.icon} />{tabLabel(t.id)}
            </button>
          ))}
        </div>
        <div className="fm-panel-body" ref={panelRef} tabIndex={-1}>
          {notice}
          {nudge && nudgeInline && !chatOpen && !tourOpen && (
            <div className={`fm-nudge is-inline is-${nudge.tone}`} role="status" aria-live="polite">
              <p><strong><AiMark />{nudge.what}</strong><span>{nudge.why}</span></p>
              <div>
                <button className="fm-primary" onClick={() => { dismissNudge(); runBrief(nudge); }}>{nudge.todo}</button>
                {nudge.ask && <button onClick={() => { dismissNudge(); askBrief(nudge); }}>{L("AI에게 묻기", "Ask the AI")}</button>}
                <button className="fm-nudge-close" aria-label={L("알림 닫기", "Dismiss")} onClick={dismissNudge}><FarmIcon name="close" /></button>
              </div>
            </div>
          )}
          {!pending && unconfirmed.length > 0 && (
            <section className="fm-pending-work" aria-label={L("변경 결과 확인 필요", "Change results to check")}>
              <strong><FarmIcon name="warning" />{L(`변경 결과 확인 필요 ${unconfirmed.length}건`, `${unconfirmed.length} change result${unconfirmed.length === 1 ? "" : "s"} to check`)}</strong>
              {unconfirmed.map(p => (
                <button key={p.requestId} onClick={()=>setPending({...p,uncertain:true})}>
                  {(() => { const name = actuatorForControl(snapshot?.actuators ?? [], p.draft.target, p.draft.zoneId)?.label; return L(`${name ?? "설비"}, ${zoneLabel(p.draft.zoneId)} 결과 확인`, `Check result: ${name ? term(name) : "Equipment"}, ${zoneLabel(p.draft.zoneId)}`); })()}
                </button>
              ))}
            </section>
          )}
          {pending && (
            <section
              className="fm-confirm"
              role="region"
              aria-label={L("변경 내용 확인", "Review change")}
              tabIndex={-1}
              ref={(e) => {
                if (e && !e.contains(document.activeElement)) e.focus();
              }}
            >
              <small>{L("변경 내용 확인", "Review change")}</small>
              <ModuleTag id="gate" live={pending.uncertain ? L("응답을 받지 못한 요청이라 같은 요청 번호로 결과만 다시 확인합니다. 새 명령은 만들지 않습니다.", "This request got no reply, so only its result is rechecked under the same request number. No new command is made.") : L("'변경 허용'을 누르는 순간 장치와 경보 상태를 다시 읽고, 이 화면을 연 뒤 달라졌으면 실행하지 않습니다.", "Pressing 'Allow change' rereads device and alert status. If anything changed since this screen opened, nothing runs.")} />
              <h2>
                {pending.uncertain
                  ? L("반영 여부를 확인하고 있습니다", "Checking whether the change was applied")
                  : L("이 내용으로 변경할까요?", "Apply this change?")}
              </h2>
              <h3>
                {term(
                  actuatorForControl(
                    snapshot?.actuators ?? [],
                    pending.draft.target,
                    pending.draft.zoneId,
                  )?.label,
                )}
              </h3>
              <p>
                {L("적용 범위", "Scope")}: {zoneLabel(pending.draft.zoneId)},{" "}
                {
                  r.layout?.devices.find((d) => d.zone_id === pending.draft.zoneId && (d.key === pending.draft.target || snapshot?.actuators.find(a=>a.key===d.key&&a.zoneId===d.zone_id)?.target===pending.draft.target))?.affected_bed_ids.length ?? L("범위 확인 필요", "scope to be confirmed")
                }
                {L("개 베드", " beds")}
              </p>
              <p className="fm-confirm-change">
                {controlStateText(
                  pending.draft.beforeState ?? L("미보고", "Not reported"),
                  pending.draft.target,
                )}{" "}
                →{" "}
                <strong>
                  {controlValueText(pending.draft.value, pending.draft.target)}
                </strong>
              </p>
              <p>{farmWords(pending.draft.rationale, zoneLabel)}</p>
              {!pending.uncertain && <ControlPreviewBox farmId={r.farmId} draft={pending.draft} />}
              {message && <p role="alert">{message}</p>}
              <button
                className="fm-primary"
                disabled={executing}
                onClick={() => void execute()}
              >
                {executing
                  ? L("장치 응답 확인 중…", "Waiting for device reply…")
                  : pending.uncertain
                    ? L("같은 요청의 결과 다시 확인", "Recheck result of the same request")
                    : L("변경 허용", "Allow change")}
              </button>
              <button
                disabled={executing}
                onClick={() => {
                  if (!pending.uncertain)
                    forgetControl(r.farmId, pending);
                  setPending(null);
                  void r.refreshRecords();
                }}
              >
                {pending.uncertain ? L("기록에서 계속 확인", "Keep checking in records") : L("취소", "Cancel")}
              </button>
            </section>
          )}

            <>
              <section
                className="fm-tabpanel"
                role="tabpanel"
                id="panel-state"
                aria-labelledby="tab-state"
                hidden={tab !== "state"}
              >
                {(() => {
                  // The AI's judgement for this place: its zone's items, and this bed's own.
                  const here = brief.filter((i) => i.anchor && i.anchor.zoneId === selectedZone && (i.anchor.kind !== "bed" || i.anchor.bedId === bed?.id) && (i.anchor.kind !== "camera" || !i.anchor.bedId || i.anchor.bedId === bed?.id));
                  return here.length > 0 && (
                    <AiBrief
                      compact
                      title={L("AI 판단", "AI judgement")}
                      items={here.slice(0, 2)}
                      advice={advice}
                      active={null}
                      watched=""
                      onHover={() => undefined}
                      onGo={runBrief}
                      onAsk={askBrief}
                      onDraft={review}
                      zoneLabel={zoneLabel}
                      onOpenSources={setReader}
                    />
                  );
                })()}
                {(() => {
                  // The camera watching this bed: its live picture and the AI's line, a tap away from the camera page.
                  const feed = bed && stage !== "device" ? feeds.live?.find((f) => f.bed_id === bed.id) : undefined;
                  return feed && <BedCamera farmId={r.farmId} feed={feed} onOpen={() => { setCameraFocus(feed.id); setView("camera"); }} />;
                })()}
                <div className="fm-key-grid" aria-label={L("주요 값", "Key readings")}>
                  {keyReadings(metrics).map((m) => {
                    const rowKey = `${m.key}:${m.zoneId}`;
                    return (
                      <KeyTile
                        key={rowKey}
                        metric={m}
                        issue={observationIssue(m, r.connected)}
                        threshold={thresholds.find((t) => t.metric === m.key)}
                        samples={sparklineSamples(snapshot?.telemetryByZone ?? {}, m.zoneId ?? selectedZone, m.key, snapshot?.metrics ?? [])}
                        grade={zoneAlerts.some((a) => a.kind === "sensor_health" && a.severity === "critical") ? "danger" : undefined}
                        onOpen={() => {
                          setReadingsOpen(true);
                          setExpandedReading(rowKey);
                          requestAnimationFrame(() => document.getElementById(`fm-reading-${rowKey}`)?.scrollIntoView({ block: "nearest" }));
                        }}
                      />
                    );
                  })}
                </div>
                {metrics.length > 0 && (
                  <p className="fm-footnote">
                    {selectedZone ? L(`${zoneLabel(selectedZone)} 공용 센서 값이며 베드별 실측이 아닙니다.`, `Shared sensor values for ${zoneLabel(selectedZone)}, not measured per bed.`) : L("농장 전체 값입니다.", "Values for the whole farm.")}
                  </p>
                )}
                {(() => {
                  const others = otherProblemReadings(metrics, keyReadings(metrics));
                  return others.length > 0 && (
                    <button
                      className="fm-wide fm-other-problems"
                      onClick={() => {
                        const rowKey = `${others[0].key}:${others[0].zoneId}`;
                        setReadingsOpen(true);
                        setExpandedReading(rowKey);
                        requestAnimationFrame(() => document.getElementById(`fm-reading-${rowKey}`)?.scrollIntoView({ block: "nearest" }));
                      }}
                    >
                      <FarmIcon name="warning" />{L(`다른 값 확인 필요 ${others.length}개`, `${others.length} other reading${others.length === 1 ? "" : "s"} to check`)} <span>{others.map((m) => term(m.label)).slice(0, 2).join(", ")}{others.length > 2 ? L(" 외", " and more") : ""}</span>
                    </button>
                  );
                })()}
                <details className="fm-all-readings" open={readingsOpen} onToggle={(e) => setReadingsOpen(e.currentTarget.open)}>
                  <summary>{L(`관측 전체 ${metrics.length}개, 추이와 기준`, `All readings (${metrics.length}), trends and ranges`)}</summary>
                <StabilityLine metrics={metrics} thresholds={thresholds} />
                <div className="fm-reading-grid" aria-label={L("관측 전체", "All readings")}>
                  {[...metrics]
                    .sort((a, b) => {
                      const priority = (m: typeof a) =>
                        observationProblem([m])
                          ? 3
                          : m.status === "critical"
                            ? 4
                            : m.status === "warning"
                              ? 2
                              : 0;
                      return priority(b) - priority(a);
                    })
                    .map((m) => {
                      const rowKey = `${m.key}:${m.zoneId}`;
                      const zoneId = m.zoneId ?? selectedZone;
                      const related = relatedDeviceTargets(m.key)
                        .map((target) => actuatorForControl(snapshot?.actuators ?? [], target, zoneId))
                        .filter((d): d is NonNullable<typeof d> => Boolean(d))
                        .map((d) => {
                          const key = `${d.zoneId}:${d.target ?? d.key}`;
                          return { key, label: term(d.label), onOpen: () => { setDeviceFocus(`${key}#${Date.now()}`); open("devices"); } };
                        });
                      return (
                        <ReadingRow
                          key={rowKey}
                          id={`fm-reading-${rowKey}`}
                          metric={m}
                          issue={observationIssue(m, r.connected)}
                          threshold={thresholds.find((t) => t.metric === m.key)}
                          samples={sparklineSamples(snapshot?.telemetryByZone ?? {}, zoneId, m.key, snapshot?.metrics ?? [])}
                          expanded={expandedReading === rowKey}
                          onToggle={() => setExpandedReading((v) => (v === rowKey ? null : rowKey))}
                          relatedDevices={related}
                          scopeLabel={L(`${zoneLabel(zoneId)} 공용 센서, 베드별 실측 아님`, `Shared ${zoneLabel(zoneId)} sensor, not per bed`)}
                          extra={<MetricReferenceBox farmId={r.farmId} metricKey={m.key} hasFarmRange={!!thresholds.find((t) => t.metric === m.key)} onOpen={setReader} />}
                        />
                      );
                    })}
                </div>
                </details>
                {!metrics.length && <p>{L("아직 받은 값이 없습니다.", "No readings received yet.")}</p>}
                <BalancePanel
                  indicator={snapshot?.derivedIndicators.find((i) => i.zoneId === selectedZone)}
                  zoneMetrics={metrics}
                />
                <details className="fm-trend-disclosure">
                  <summary>{L("환경 추이", "Environment trends")}</summary>
                  <Trend runtime={r} zone={selectedZone ?? undefined} />
                </details>
              </section>

              <section
                className="fm-tabpanel"
                role="tabpanel"
                id="panel-devices"
                aria-labelledby="tab-devices"
                hidden={tab !== "devices"}
              >
                {visited.includes("devices") && (
                  <>
                    {(() => {
                      // Where the last change in this zone stands: device reply awaited (4),
                      // device replied and recovery being watched (5), or recovered (done).
                      // Only a recent approval counts, so an old record does not sit on
                      // "회복 확인" all day.
                      const recent = r.approvals
                        .filter((a) => (!selectedZone || a.zoneId === selectedZone) && a.createdAtIso && Date.now() - Date.parse(a.createdAtIso) < 30 * 60 * 1000)
                        .sort((a, b) => Date.parse(b.createdAtIso!) - Date.parse(a.createdAtIso!))[0];
                      const outcome = recent?.verification?.outcome ?? (recent?.executionStatus === "applied_to_simulator" ? "device_applied" : null);
                      const step = executing ? 3
                        : pending ? (pending.uncertain ? 3 : 1)
                        : outcome === "device_pending" ? 3
                        : outcome === "device_applied" || outcome === "recovery_pending" || outcome === "unrecovered" ? 4
                        : outcome === "resolved" ? 5
                        : 0;
                      // Nothing in progress: no strip. It appears once a change is being checked.
                      if (step === 0) return null;
                      const CONTROL_STEPS = controlSteps();
                      return (
                        <Steps
                          label={L("설비 조절 순서", "Equipment adjustment steps")}
                          items={CONTROL_STEPS}
                          completed={step}
                          active={step >= CONTROL_STEPS.length ? null : step}
                          now={step >= CONTROL_STEPS.length ? L("회복 확인 완료. 기록 탭에 저장됨", "Recovery confirmed. Saved in Records.") : undefined}
                        />
                      );
                    })()}
                    <p className="fm-footnote">
                      {L("설비는 구역 단위로 움직입니다. 변경 전에 함께 영향을 받는 베드를 확인하세요.", "Equipment runs per zone. Before a change, check which beds it also affects.")}
                    </p>
                    <details className="fm-control-note">
                      <summary>{L("조절 메모 (선택)", "Adjustment note (optional)")}</summary>
                      <label>{L("사유", "Reason")}<input value={controlNote} onChange={e=>setControlNote(e.target.value)} maxLength={500}/></label>
                    </details>
                    {stage === "device" && stageDevice && (() => {
                      // The readings this device moves, so the effect of a change has somewhere to show.
                      const related = metrics.filter((m) => relatedDeviceTargets(m.key).includes(stageDevice.target as never));
                      return related.length > 0 && (
                        <div className="fm-device-readings">
                          <h3>{L(`${stageDevice.label}${josa(stageDevice.label, "과", "와")} 관련된 관측`, `Readings related to the ${term(stageDevice.label).toLowerCase()}`)}</h3>
                          <div className="fm-key-grid">
                            {related.slice(0, 2).map((m) => (
                              <KeyTile
                                key={m.key}
                                metric={m}
                                issue={observationIssue(m, r.connected)}
                                threshold={thresholds.find((t) => t.metric === m.key)}
                                samples={sparklineSamples(snapshot?.telemetryByZone ?? {}, m.zoneId ?? selectedZone, m.key, snapshot?.metrics ?? [])}
                                onOpen={() => { setReadingsOpen(true); setExpandedReading(`${m.key}:${m.zoneId}`); open("state"); }}
                              />
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                    {snapshot?.actuators
                      .filter((d) => !selectedZone || !d.zoneId || d.zoneId === selectedZone)
                      .sort((a, b) => Number(`${b.zoneId}:${b.target ?? b.key}` === deviceStage) - Number(`${a.zoneId}:${a.target ?? a.key}` === deviceStage))
                      .map((d, index) => {
                        const deviceKey = `${d.zoneId}:${d.target ?? d.key}`;
                        const focused = deviceFocus?.startsWith(`${deviceKey}#`) ?? false;
                        // The device on the stage is already named in the panel head: its controls show without a fold.
                        const onStage = stage === "device" && deviceKey === deviceStage;
                        // The server's pause during a room-temperature sensor alert, else only the readings this device moves (control-gate.ts).
                        // An alert without a zone counts for zone A, as the server counts it.
                        const hold = d.capability?.action === "recalibrate_air_temperature_sensor" ? null : controlHold(d.target, snapshot.metrics.filter((m) => m.zoneId === d.zoneId), snapshot.alerts.filter((a) => (a.zoneId ?? "zone-a") === d.zoneId), r.connected);
                        const body = (
                          <>
                          <RepairControl farmId={r.farmId} instanceId={`${d.zoneId}:${d.target??d.key}`} label={`${zoneLabel(d.zoneId)}, ${term(d.label)}`} fault={d.health==="fault"} onChanged={r.refresh} />
                          <DeviceControl
                            device={d}
                            bare={onStage}
                            stateText={d.target === "air_temperature_sensor_reset" ? deviceStateText(d) : undefined}
                            scope={(() => { const n = r.layout?.devices.find((x) => x.key === d.key && x.zone_id === d.zoneId)?.affected_bed_ids.length ?? 0; return L(`${zoneLabel(d.zoneId)}, ${n}개 베드`, `${zoneLabel(d.zoneId)}, ${n} bed${n === 1 ? "" : "s"}`); })()}
                            progress={progress[d.key]}
                            disabled={!r.connected || !snapshot.operationalControlAllowed || !d.zoneId || !!hold}
                            disabledReason={
                              !r.connected ? L("관측 연결을 먼저 확인하세요.", "Check the sensor connection first.")
                              : !snapshot.operationalControlAllowed ? L("현재 입력 상태에서는 조절을 허용하지 않습니다.", "Adjustment is not allowed in the current input mode.")
                              : hold?.zoneWide ? L(`${zoneLabel(d.zoneId)} 재배실 온도 센서 이상 경보가 켜져 있어, 경보가 풀릴 때까지 이 구역 설비 조작을 멈춥니다. 센서 재보정은 할 수 있습니다.`, `A room-temperature sensor alert is active in ${zoneLabel(d.zoneId)}, so its equipment stays paused until the alert clears. The sensor can still be recalibrated.`)
                              : hold?.metric ? L(`${zoneLabel(d.zoneId)} ${term(hold.metric.label)} 값이 '${hold.issue}' 상태라 이 설비 변경을 잠시 막습니다. 센서를 점검하면 다시 열립니다.`, `${zoneLabel(d.zoneId)} ${term(hold.metric.label)} reads "${hold.issue}", so changes to this device are on hold until the sensor is checked.`)
                              : hold ? L(`${zoneLabel(d.zoneId)}에서 받은 관측이 없어 이 설비 변경을 잠시 막습니다.`, `No readings from ${zoneLabel(d.zoneId)}, so changes to this device are on hold.`)
                              : undefined
                            }
                            onReview={(v) => {
                              try {
                                review({...manualDraft(d, v), rationale: controlNote.trim() || "운영자가 선택한 설비 조절"});
                              } catch (e) {
                                setMessage(String(e));
                              }
                            }}
                          />
                          <details className="fm-device-detail">
                            <summary>{L("장치 상세", "Device detail")}</summary>
                            <p>
                              {L("요청", "Requested")} {operationalStateText(d.desiredValue ?? L("미보고", "Not reported"))} / {L("보고", "Reported")}{" "}
                              {operationalStateText(d.reportedValue ?? L("미보고", "Not reported"))} / {L("실제 출력", "Actual output")}{" "}
                              {operationalStateText(d.effectiveValue ?? L("미보고", "Not reported"))}
                            </p>
                            <small>{formatSensorUpdateTime(d.feedbackAt ?? null)}</small>
                          </details>
                          </>
                        );
                        if (onStage) return <section key={deviceKey} className="fm-equipment is-stage" data-focused>{body}</section>;
                        return (
                          <Fragment key={focused ? deviceFocus! : deviceKey}>
                            {stage === "device" && index === 1 && <h3 className="fm-subhead">{L("같은 구역 다른 설비", "Other equipment in this zone")}</h3>}
                            <details className="fm-equipment" data-focused={focused || undefined} open={focused || undefined}>
                              <summary>
                                {term(d.label)}
                                <em className={d.health === "fault" || (d.target === "air_temperature_sensor_reset" && sensorSuspect(d.zoneId)) ? "warn" : ""}>
                                  {deviceStateText(d)}
                                </em>
                              </summary>
                              {body}
                            </details>
                          </Fragment>
                        );
                      })}
                    {!snapshot?.actuators.length && <p>{L("연결된 설비 정보를 기다리고 있습니다.", "Waiting for connected equipment information.")}</p>}
                  </>
                )}
              </section>

              <section
                className="fm-tabpanel"
                role="tabpanel"
                id="panel-crop"
                aria-labelledby="tab-crop"
                hidden={tab !== "crop"}
              >
                {visited.includes("crop") && (
                  <>
                    {cycle && <HarvestTimeline cycle={cycle} />}
                    {selection ? (
                      <CropEditor
                        key={selectionKey(selection)}
                        farm={farm}
                        selection={selection}
                        cycle={cycle}
                        layout={r.layout}
                        cycles={r.cycles}
                        onSave={r.refreshCrops}
                      />
                    ) : (
                      <p className="fm-hint">{L("베드와 단을 선택하면 재배·수확을 기록할 수 있습니다.", "Select a bed and tier to record crops and harvests.")}</p>
                    )}
                    {selection && r.layout && (
                      <details className="fm-helper">
                        <summary><AiMark />{L("말로 기록", "Record by speaking")}</summary>
                        <SpeakRecord bare farmId={r.farmId} layout={r.layout} cycles={r.cycles} bedId={selection.bedId} tier={selection.tier} allowRemote={privateRemote} onSaved={r.refreshCrops} />
                      </details>
                    )}
                    {cycle && <HarvestGuideBox key={cycle.id} farmId={r.farmId} cycleId={cycle.id} onOpen={setReader} />}
                    <details className="fm-schedule-list">
                      <summary>{L(`수확 일정 (${plannedHarvests(r.cycles).length}건)`, `Harvest schedule (${plannedHarvests(r.cycles).length})`)}</summary>
                      {plannedHarvests(r.cycles).map((c) => (
                        <button
                          className="fm-schedule"
                          key={c.id}
                          onClick={() => {
                            choose({ bedId: c.bed_id, tier: c.tier });
                            open("crop");
                          }}
                        >
                          <strong>
                            {(() => { const b = r.layout?.beds.find((x) => x.id === c.bed_id)?.label ?? ""; return L(`${b}, ${c.tier}단, ${c.crop}`, `${place(b)}, tier ${c.tier}, ${term(c.crop)}`); })()}
                          </strong>
                          <span>
                            {c.planned_harvest_from}
                            {c.planned_harvest_to ? ` ~ ${c.planned_harvest_to}` : ""}{L(`, 남은 ${c.remaining_count}주`, `, ${c.remaining_count} plants left`)}
                          </span>
                          <small>{(() => {const today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);return (c.planned_harvest_to??c.planned_harvest_from??"")<today?L("예정일 경과. 현장 확인 필요", "Past planned date. Check on site"):c.planned_harvest_from===today?L("오늘 예정", "Planned today"):(c.planned_harvest_from??"")<today?L("수확 예정 기간", "In harvest window"):L("다가오는 일정", "Upcoming");})()}</small>
                        </button>
                      ))}
                      {!plannedHarvests(r.cycles).length && (
                        <p>{L("수확 예정일이 등록된 재배가 없습니다.", "No crops have a planned harvest date.")}</p>
                      )}
                      {r.cycles.filter((c) => c.status === "growing" && !c.planned_harvest_from).length > 0 && (
                        <>
                          <h4>{L("예정일 미등록", "No planned date")}</h4>
                          {r.cycles
                            .filter((c) => c.status === "growing" && !c.planned_harvest_from)
                            .map((c) => (
                              <button
                                className="fm-schedule"
                                key={c.id}
                                onClick={() => {
                                  choose({ bedId: c.bed_id, tier: c.tier });
                                  open("crop");
                                }}
                              >
                                <strong>
                                  {(() => { const b = r.layout?.beds.find((x) => x.id === c.bed_id)?.label ?? ""; return L(`${b}, ${c.tier}단, ${c.crop}`, `${place(b)}, tier ${c.tier}, ${term(c.crop)}`); })()}
                                </strong>
                                <small>{L("수확 예정일 미등록", "Harvest date not registered")}</small>
                              </button>
                            ))}
                        </>
                      )}
                    </details>
                  </>
                )}
              </section>

              <section
                className="fm-tabpanel"
                role="tabpanel"
                id="panel-records"
                aria-labelledby="tab-records"
                hidden={tab !== "records"}
              >
                {visited.includes("records") && (
                  <>
                    <div className="fm-section-head">
                      <h3>{selectedZone ? L(`${zoneLabel(selectedZone)} 기록`, `${zoneLabel(selectedZone)} records`) : L("농장 전체 기록", "Whole farm records")}</h3>
                      {selectedZone && (
                        <button onClick={() => {setSelection(null);setZoneFocus(null);}}>{L("전체 보기", "View all")}</button>
                      )}
                    </div>
                    {r.cases
                      .filter((c) => !selectedZone || !c.zoneId || c.zoneId === selectedZone)
                      .map((c) => (
                        <CaseCard key={c.id} record={c} farmId={r.farmId} />
                      ))}
                    {!r.cases.length && <p>{L("아직 경보 처리 기록이 없습니다.", "No alert handling records yet.")}</p>}
                    {r.approvals.filter((a) => !selectedZone || a.zoneId === selectedZone).length > 0 && (
                      <details className="fm-approval-list">
                        <summary>{L("설비 조절 결과", "Equipment adjustment results")}</summary>
                        {r.approvals
                          .filter((a) => !selectedZone || a.zoneId === selectedZone)
                          .map((a) => (
                            <article className="fm-case" key={a.id}>
                              <small>{a.createdAtIso ? formatSensorUpdateTime(a.createdAtIso) : a.createdAt}</small>
                              <strong>{term(a.device)}</strong>
                              <p>
                                {L(`변경값 ${a.requestedValue}, ${zoneLabel(a.zoneId)}`, `Set to ${a.requestedValue}, ${zoneLabel(a.zoneId)}`)}
                              </p>
                              <p>
                                {a.verification?.outcome === "resolved"
                                  ? L("장치 반영과 환경 회복 확인", "Device change and recovery confirmed")
                                  : a.executionStatus === "applied_to_simulator"
                                    ? L("장치 응답 확인. 환경 회복과 구분", "Device replied. Recovery is tracked separately")
                                    : a.status === "failed"
                                      ? L("변경 결과 확인 필요", "Change result needs checking")
                                      : L("장치 응답 확인 중", "Waiting for device reply")}
                              </p>
                              <small>{a.verification?.detail ?? a.failureReason ?? ""}</small>
                              {a.executionStatus === "applied_to_simulator" && (a.executedAt ?? a.createdAtIso) && a.zoneId && seriesForTarget(a.target).slice(0, 1).map((s) => (
                                <EffectChart key={s.field} points={snapshot?.telemetryByZone[a.zoneId!] ?? []} at={(a.executedAt ?? a.createdAtIso)!} field={s.field} label={s.label} unit={s.unit} />
                              ))}
                            </article>
                          ))}
                      </details>
                    )}
                    <RecentWork
                      runtime={r}
                      showPending={false}
                      onResume={p => setPending({ ...p, uncertain: true })}
                    />
                  </>
                )}
              </section>
            </>
        </div>
      </aside>
      {/* The advisor is one tap away on every screen, and speaks up when something may have been missed. */}
      {tourOpen && <Tutorial onClose={() => { setTourOpen(false); setTourSeen(true); }} />}
      {nudge && !chatOpen && !tourOpen && !nudgeInline && (
        <div className={`fm-nudge is-${nudge.tone}`} role="status" aria-live="polite">
          <p><strong><AiMark />{nudge.what}</strong><span>{nudge.why}</span></p>
          <div>
            {nudge.ask && <button className="fm-primary" onClick={() => { dismissNudge(); askBrief(nudge); }}>{L("AI에게 묻기", "Ask the AI")}</button>}
            <button className={nudge.ask ? undefined : "fm-primary"} onClick={() => { dismissNudge(); runBrief(nudge); }}>{nudge.todo}</button>
            <button className="fm-nudge-close" aria-label={L("알림 닫기", "Dismiss")} onClick={dismissNudge}><FarmIcon name="close" /></button>
          </div>
        </div>
      )}
      <button ref={chatTrigger} className={`fm-fab ${chatOpen ? "is-open" : ""}`} aria-expanded={chatOpen} aria-controls="farm-chat" onClick={() => (chatOpen ? closeChat() : open("advisor"))} title={L("AI 농장 상담", "AI farm advisor")}>
        <FarmIcon name={chatOpen ? "close" : "advisor"} />
        <span>{chatOpen ? L("닫기", "Close") : L("AI 상담", "Ask AI")}</span>
        {nudge && !chatOpen && !tourOpen && <i className="fm-fab-dot" aria-hidden="true" />}
      </button>
      <ChatPanel
        open={chatOpen}
        chatRef={chatRef}
        onClose={closeChat}
        label={label}
        farmId={r.farmId}
        zoneId={selectedZone ?? null}
        bedId={selection?.bedId ?? null}
        turn={turn ?? undefined}
        turns={r.turns}
        history={chatHistory}
        focusResponseId={focusAnswer}
        busy={r.busy}
        sending={sending}
        error={r.error || message}
        suggestions={suggestions}
        questionLabel={(q) => suggestions.find((s) => s.question === q)?.label ?? (lang !== "ko" ? brief.find((i) => i.ask === q)?.what : undefined) ?? q}
        question={question}
        setQuestion={setQuestion}
        onAsk={(q) => ask(q)}
        onReview={review}
        onRecheck={(responseId) => {
          setMessage("");
          void r.recheck(responseId).catch((e) => setMessage(String(e.message)));
        }}
        zoneLabel={zoneLabel}
        lang={lang}
        farmConsent={privateRemote}
        onOpenSettings={() => { setChatOpen(false); setView("settings"); }}
        onOpenLibrary={() => openLibrary()}
        onOpenSource={setReader}
        sources={sources}
        sourceIds={sourceIds}
        setSourceIds={setSourceIds}
        loadSources={() => void loadSources()}
        sourceLoading={sourceLoading}
      />
      {reader && (
        <DocReader
          farmId={r.farmId}
          target={reader}
          beside={chatOpen && !narrow}
          onClose={() => setReader(null)}
          onOpenLibrary={(documentId, quote) => openLibrary(documentId, quote)}
        />
      )}
    </main>
  );
}
function Trend({ runtime: r, zone }: { runtime: FarmRuntime; zone?: string }) {
  const options = [
    ["rootZoneTemperature", "근권 온도", "°C"],
    ["temperature", "기온", "°C"],
    ["humidity", "습도", "%"],
    ["ec", "EC", "dS/m"],
    ["substrateMoisture", "배지 수분", "%"],
    ["irrigationFlow", "관수 유량", "L/min"],
  ] as const;
  const [key, setKey] = useState<string>("rootZoneTemperature");
  const points = zone ? (r.snapshot?.telemetryByZone[zone] ?? []) : [];
  if (!points.length) return <p>{L("이 구역의 추이 기록이 없습니다.", "No trend records for this zone.")}</p>;
  const option = options.find((o) => o[0] === key)!;
  const optionName = term(option[1]);
  const values = points.map((p) => p[option[0]]),
    min = Math.min(...values),
    max = Math.max(...values);
  return (
    <figure className="fm-trend">
      <label>
        {L("환경 추이", "Environment trends")}
        <select value={key} onChange={(e) => setKey(e.target.value)}>
          {options.map((o) => (
            <option key={o[0]} value={o[0]}>
              {term(o[1])}
            </option>
          ))}
        </select>
      </label>
      <svg viewBox="0 0 300 100" role="img" aria-label={L(`${optionName} 추이`, `${optionName} trend`)}>
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          points={values
            .map(
              (v, i) =>
                `${(i / Math.max(1, values.length - 1)) * 300},${90 - ((v - min) / Math.max(1, max - min)) * 80}`,
            )
            .join(" ")}
        />
      </svg>
      <figcaption>
        {optionName} / {min.toFixed(1)}–{max.toFixed(1)} {option[2]}
      </figcaption>
      <small>
        {points[0].time} – {points[points.length - 1].time}
      </small>
    </figure>
  );
}

function CaseCard({
  record: c,
  farmId,
}: {
  record: OperationCase;
  farmId: Farm["id"];
}) {
  const [error, setError] = useState("");
  async function download() {
    try {
      const csv = await getOperationCaseCsv(farmId, c.incidentId),
        url = URL.createObjectURL(
          new Blob([csv], { type: "text/csv;charset=utf-8" }),
        );
      const a = document.createElement("a");
      a.href = url;
      a.download = `operation-${c.incidentId}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <article className="fm-case">
      <small>{L(operationCaseStatusLabel(c.status), ({ needs_action: "Needs a look", awaiting_approval: "Waiting for approval", monitoring: "Watching recovery", resolved: "Resolved", handoff: "On-site check needed" } as const)[c.status])}</small>
      <strong>{backendText(c.title)}</strong>
      <p>{c.status === "needs_action" ? L("해당 구역의 관측과 설비 출력을 확인하세요. 직접 조절하거나 AI 자문을 이용할 수 있습니다.", "Check this zone's readings and equipment output. You can adjust directly or ask the AI advisor.") : backendText(operationCaseSummary(c))}</p>
      <ol className="fm-progress">
        {operationCaseProgress(c).map((s) => (
          <li key={s.id} className={s.state}>
            {L(s.label, ({ "감지": "Detected", "확인": "Checked", "장치 조정": "Device change", "처리": "Handled", "정상 회복": "Recovered", "현장 점검": "On-site check", "회복": "Recovery" } as Record<string, string>)[s.label] ?? s.label)}
          </li>
        ))}
      </ol>
      <details>
        <summary>{L("처리 과정과 근거", "Process and evidence")}</summary>
        {c.timeline.map((t) => (
          <p key={t.id}>
            {backendText(t.title)}. {backendText(t.detail)}
            <small>{formatSensorUpdateTime(t.occurredAt)}</small>
          </p>
        ))}
        <button onClick={() => void download()}>{L("기록 내려받기", "Download record")}</button>
      </details>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

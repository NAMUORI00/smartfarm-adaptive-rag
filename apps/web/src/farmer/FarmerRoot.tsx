import { lazy, Suspense, useState } from "react";
import { FarmerWorkspace } from "./FarmerWorkspace";
import type { StartIntent } from "./FarmerWorkspace";
import { Landing } from "./Landing";
import { useFarmRuntime } from "./useFarmRuntime";
import { usePrefs } from "./Prefs";
import { L } from "./i18n";
import { VideoSessionProvider } from "../video-context";
import "./farmer.css";
const Legacy = lazy(async () => {
  await Promise.all([
    import("../styles.css"),
    import("../operator-design.css"),
  ]);
  return import("../App");
});
export default function FarmerRoot() {
  const runtime = useFarmRuntime("farm-wasabi-a");
  // Theme and language live at the root so a change redraws every screen at once.
  usePrefs();
  const [legacy, setLegacy] = useState(false);
  // Landing first; "#dashboard" (or entering once in this tab) goes straight to the console.
  const [entry, setEntry] = useState<null | "map" | "research">(() => {
    if (typeof window === "undefined") return null;
    if (location.hash === "#dashboard") return "map";
    try { return sessionStorage.getItem("farmer.entered") === "true" ? "map" : null; } catch { return null; }
  });
  // Where to open inside the dashboard when a card or the plan on the first page is used.
  const [start, setStart] = useState<StartIntent | undefined>(undefined);
  function enter(view: "map" | "research", intent?: StartIntent) {
    try { sessionStorage.setItem("farmer.entered", "true"); } catch { /* storage unavailable */ }
    history.replaceState(null, "", "#dashboard");
    setStart(intent);
    setEntry(view);
    window.scrollTo(0, 0);
  }
  function home() {
    try { sessionStorage.removeItem("farmer.entered"); } catch { /* storage unavailable */ }
    history.replaceState(null, "", location.pathname);
    setStart(undefined);
    setEntry(null);
    window.scrollTo(0, 0);
  }
  return (
    <VideoSessionProvider>
      {legacy ? (
        <>
          <button
            className="fm-legacy-return"
            onClick={() => {
              setLegacy(false);
              void runtime.refreshHistory();
            }}
          >
            {L("우리 농장으로 돌아가기", "Back to my farm")}
          </button>
          <Suspense fallback={<p>{L("운영 화면을 불러오는 중…", "Loading the operations screen…")}</p>}>
            <Legacy runtime={runtime} onFarm={() => setLegacy(false)} />
          </Suspense>
        </>
      ) : (
        entry === null ? (
          <Landing runtime={runtime} onEnter={(intent) => enter("map", intent)} onResearch={() => enter("research")} />
        ) : (
          <FarmerWorkspace key={`${entry}:${JSON.stringify(start ?? null)}`} runtime={runtime} initialView={entry} start={start} onLegacy={() => setLegacy(true)} onHome={home} />
        )
      )}
    </VideoSessionProvider>
  );
}

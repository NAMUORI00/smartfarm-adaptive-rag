import { useCallback, useEffect } from "react";
import type { FarmId } from "../types";
import { listPatrolEvents } from "../video-api";
import type { PatrolEvent } from "../video-api";
import { useVideoSession, useVideoValue } from "../video-context";
import type { VideoRequest } from "../video-session";

const KEY = "events.catalog";

/**
 * Patrol records for the farm, shared with any other screen through the video
 * session. One fetch on mount, then a slow refresh while the tab is visible;
 * a disabled video service (404) stops the refresh instead of retrying.
 */
export function usePatrolEvents(farmId: FarmId) {
  const session = useVideoSession();
  const [records] = useVideoValue<VideoRequest<PatrolEvent[]>>(KEY, { status: "idle" });
  const reload = useCallback(
    () => session.run(KEY, (signal) => listPatrolEvents(farmId, signal), true),
    [farmId, session],
  );
  useEffect(() => {
    void session.run(KEY, (signal) => listPatrolEvents(farmId, signal));
    const timer = window.setInterval(() => {
      const current = session.read<VideoRequest<PatrolEvent[]>>(KEY);
      if (document.visibilityState !== "visible" || current?.error?.includes("(404)")) return;
      void reload();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [farmId, session, reload]);
  return { events: records.value ?? [], status: records.status, error: records.error, reload };
}
export type PatrolRuntime = ReturnType<typeof usePatrolEvents>;

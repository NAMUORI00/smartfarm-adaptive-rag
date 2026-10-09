import { useCallback, useEffect, useRef, useState } from "react";
import type { FarmId } from "../types";
import { getCameraFeeds } from "../video-api";
import type { CameraFeedList } from "../video-api";

/**
 * The farm's camera feeds: what each camera sent last and what the AI saw in it.
 * Refreshed every 15 seconds while the tab is visible; a server without camera
 * feeds (404) stops the refresh instead of retrying.
 */
export function useCameraFeeds(farmId: FarmId) {
  const [list, setList] = useState<CameraFeedList | null>(null);
  const [error, setError] = useState("");
  const stopped = useRef(false);
  const reload = useCallback(async () => {
    try {
      const value = await getCameraFeeds(farmId, AbortSignal.timeout(10000));
      setList(value);
      setError("");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("(404)")) stopped.current = true;
      setError(message);
    }
  }, [farmId]);
  useEffect(() => {
    stopped.current = false;
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !stopped.current) void reload();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [reload]);
  return { list, error, reload, live: list?.enabled ? list.cameras : null };
}
export type CameraFeedsRuntime = ReturnType<typeof useCameraFeeds>;

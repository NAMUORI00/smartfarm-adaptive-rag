import { useEffect, useRef, useState } from "react";
import type { FarmId } from "../types";
import { loadVideoMedia } from "../video-api";
import { L } from "./i18n";

/**
 * One camera's media, fetched with the farm's credentials. A new segment
 * replaces the one playing only once it has loaded, so the picture never
 * blanks between segments the way a CCTV view would not.
 */
function useMedia(farmId: FarmId, path: string | null) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const current = useRef("");
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setFailed(false);
    void loadVideoMedia(farmId, path, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      const next = URL.createObjectURL(blob);
      const previous = current.current;
      current.current = next;
      setUrl(next);
      if (previous) window.setTimeout(() => URL.revokeObjectURL(previous), 1000);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [farmId, path]);
  useEffect(() => () => { if (current.current) URL.revokeObjectURL(current.current); }, []);
  return { url, failed };
}

export function FeedVideo({ farmId, path, controls = false, label }: { farmId: FarmId; path: string | null; controls?: boolean; label: string }) {
  const { url, failed } = useMedia(farmId, path);
  if (!url) return <div className="fm-feed-empty" role="status">{failed ? L("영상을 불러오지 못했습니다.", "Could not load the video.") : path ? L("영상 불러오는 중", "Loading video") : L("받은 영상 없음", "No video yet")}</div>;
  return <video className="fm-feed-video" src={url} autoPlay muted loop playsInline controls={controls} aria-label={label} />;
}

export function FeedImage({ farmId, path, alt }: { farmId: FarmId; path: string; alt: string }) {
  const { url, failed } = useMedia(farmId, path);
  if (!url) return <div className="fm-feed-empty" role="status">{failed ? L("화면을 불러오지 못했습니다.", "Could not load the frame.") : L("화면 불러오는 중", "Loading frame")}</div>;
  return <img src={url} alt={alt} />;
}

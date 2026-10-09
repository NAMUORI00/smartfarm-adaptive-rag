import { L } from "./i18n";
import { stamp } from "./time-format";

/** In the public demo build only: says the screen replays a recording and reaches no server, AI or device. */
export function ReplayNote({ className }: { className?: string }) {
  const info = typeof window === "undefined" ? undefined : window.__smartfarmReplay;
  if (!info) return null;
  return (
    <p className={`fm-replay-note ${className ?? ""}`} role="note">
      {L(
        `공개 데모: ${stamp(info.capturedAt)}에 기록한 운영 데이터와 AI 응답을 재생합니다. 실제 서버, AI, 설비에는 연결되어 있지 않습니다.`,
        `Public demo: replays operation data and AI answers recorded on ${stamp(info.capturedAt)}. Not connected to any server, AI model or device.`,
      )}
    </p>
  );
}

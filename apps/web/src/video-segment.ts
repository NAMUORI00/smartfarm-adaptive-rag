export function videoSegment(playback: number, duration: number, windowSeconds: number) {
  const end = Math.max(0, Math.min(Number.isFinite(playback) ? playback : 0, duration))
  return { start_seconds: Math.max(0, end - Math.max(1, Math.min(windowSeconds, 30))), end_seconds: end }
}

/**
 * One timestamp format for the whole console, in farm time (Asia/Seoul):
 * "2026.09.23 15:20". Seconds are left out; the reading's own time is what
 * matters, never a ticking client clock.
 */
export function stamp(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "-";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}.${parts.month}.${parts.day} ${hour}:${parts.minute}`;
}

/** "15:20" for today, "09.22 15:20" for another day. */
export function shortStamp(value: string | null | undefined, now: Date = new Date()): string {
  const full = stamp(value);
  if (full === "-") return full;
  const today = stamp(now.toISOString()).slice(0, 10);
  return full.startsWith(today) ? full.slice(11) : full.slice(5);
}

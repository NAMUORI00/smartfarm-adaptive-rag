/** Display the timestamp supplied by telemetry, never a client-side ticking clock. */
export function formatSensorUpdateTime(value: string | null | undefined): string {
  if (!value) return '시각 미상'
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) return '시각 미상'
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)
}

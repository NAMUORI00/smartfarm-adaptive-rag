import type { CultivationStrategyThreshold, DerivedIndicator, Metric } from "../types";
import { normalizeSvgPoints, recentDelta } from "../sensor-trends";
import type { SensorTrendSample } from "../sensor-trends";
import { stamp as formatSensorUpdateTime } from "./time-format";
import { FarmIcon } from "./FarmIcon";
import { bandGauge, derivedIndicatorRows, metricPrecision, readingCounts, readingCountsText, sampleSpanText } from "./sensor-links";
import { L, place, term } from "./i18n";

const qualityLabel = (q: NonNullable<Metric["quality"]>): string => ({
  good: L("양호", "Good"), suspect: L("의심", "Suspect"), bad: L("불량", "Bad"), stale: L("오래됨", "Stale"), missing: L("누락", "Missing"),
})[q];
const upDown = (dir: string) => (dir === "up" ? L("상승", "up") : L("하강", "down"));
const movedText = (span: string | null | undefined, amount: string, dir: string) =>
  L(`${span} 전보다 ${amount} ${upDown(dir)}`, `${dir === "up" ? "Up" : "Down"} ${amount}, ${span}`);

/** Every reading of a kind uses the same number of decimals, so tiles line up (18.0 beside 16.1, never 18 beside 16.12). */
export function readingValue(metric: Metric): { number: number | null; text: string } {
  const raw = metric.value.replace(/,/g, "").trim();
  const numeric = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const digits = metricPrecision(metric.key);
  return { number: numeric, text: numeric === null ? metric.value : numeric.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits }) };
}

export function rangeText(threshold: CultivationStrategyThreshold | undefined): string {
  return threshold ? L(`기준 ${threshold.lower ?? "—"}–${threshold.upper ?? "—"} ${threshold.unit}`, `Range ${threshold.lower ?? "—"}–${threshold.upper ?? "—"} ${threshold.unit}`) : L("기준 없음", "No threshold");
}

export function Sparkline({ samples, label }: { samples: SensorTrendSample[]; label: string }) {
  const points = normalizeSvgPoints(samples, 96, 28, 2);
  const span = sampleSpanText(samples);
  if (points.length < 3 || !span) return <span className="fm-spark-empty">{L("추이 자료 부족", "Not enough trend data")}</span>;
  const line = points.map((p) => `${p.x},${p.y}`).join(" ");
  const last = points[points.length - 1];
  return (
    <svg className="fm-spark" viewBox="0 0 96 28" preserveAspectRatio="none" role="img" aria-label={L(`${label} ${span} 추이`, `${term(label)} trend, ${span}`)}>
      <polyline points={line} vectorEffect="non-scaling-stroke" />
      <circle cx={last.x} cy={last.y} r="2.4" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The registered range as a light band, the current value as a needle (concept from the operations mockup). Drawn only when a range exists. */
export function BandGauge({ value, threshold }: { value: number; threshold: CultivationStrategyThreshold }) {
  const gauge = bandGauge(value, threshold.lower, threshold.upper);
  if (!gauge) return null;
  return (
    <div
      className={`fm-band ${gauge.outside ? "outside" : ""}`}
      role="img"
      aria-label={L(`${rangeText(threshold)}, 현재 ${value} ${threshold.unit}${gauge.outside ? ", 기준 밖" : ", 기준 안"}`, `${rangeText(threshold)}, now ${value} ${threshold.unit}${gauge.outside ? ", out of range" : ", in range"}`)}
    >
      <span className="fm-band-range" style={{ left: `${gauge.bandStart}%`, width: `${Math.max(gauge.bandEnd - gauge.bandStart, 1)}%` }} />
      <span className="fm-band-needle" style={{ left: `${gauge.needle}%` }} />
    </div>
  );
}

export function ReadingRow({
  metric: m, issue, threshold, samples, expanded, onToggle, relatedDevices, scopeLabel, id, extra,
}: {
  /** Shown at the end of the opened detail (the growing guides' range). */
  extra?: import("react").ReactNode;
  id?: string;
  metric: Metric;
  issue: string;
  threshold: CultivationStrategyThreshold | undefined;
  samples: SensorTrendSample[];
  expanded: boolean;
  onToggle: () => void;
  relatedDevices: { key: string; label: string; onOpen: () => void }[];
  scopeLabel: string;
}) {
  const value = readingValue(m);
  const range = rangeText(threshold);
  const delta = recentDelta(samples, m.unit, metricPrecision(m.key));
  const span = sampleSpanText(samples);
  const icon = m.label.includes("온도") ? "temperature" : /수분|습도|유량/.test(m.label) ? "water" : "sensor";
  return (
    <article id={id} className={`fm-reading ${issue ? "uncertain" : m.status}`}>
      <button type="button" className="fm-reading-toggle" aria-expanded={expanded} onClick={onToggle}>
        <span className="fm-reading-label"><FarmIcon name={icon} />{term(m.label)}</span>
        <Sparkline samples={samples} label={m.label} />
        <strong>{value.text}<small>{m.unit}</small></strong>
        <small className="fm-reading-note">
          {issue ? `${issue} / ${range}` : m.status === "normal" ? range : `${L("확인 필요", "Check")} / ${range}`}
        </small>
      </button>
      {threshold && value.number !== null && <BandGauge value={value.number} threshold={threshold} />}
      {expanded && (
        <div className="fm-reading-detail">
          <dl>
            <dt>{L("추이 구간", "Trend span")}</dt><dd>{span ? L(`${span}, 표본 ${samples.length}개`, `${span}, ${samples.length} ${samples.length === 1 ? "sample" : "samples"}`) : L("추이 자료 부족. 표본 3개 이상 필요", "Not enough trend data. Needs 3 or more samples")}</dd>
            <dt>{L("최근 변화", "Recent change")}</dt><dd>{delta ? `${delta.direction === "up" ? "↑" : delta.direction === "down" ? "↓" : "→"} ${delta.label}` : L("변화 계산 중", "Calculating change")}</dd>
            <dt>{L("수신 시각", "Received")}</dt><dd>{formatSensorUpdateTime(m.observedAt ?? null)}</dd>
            <dt>{L("센서 품질", "Sensor quality")}</dt><dd>{m.quality ? qualityLabel(m.quality) : L("미보고", "Not reported")}</dd>
            <dt>{L("적용 범위", "Applies to")}</dt><dd>{place(scopeLabel)}</dd>
          </dl>
          {relatedDevices.length > 0 && (
            <div className="fm-reading-devices">
              {relatedDevices.map((d) => (
                <button type="button" key={d.key} onClick={d.onOpen}><FarmIcon name="controls" />{L(`${d.label} 열기`, `Open ${term(d.label)}`)}</button>
              ))}
            </div>
          )}
          {extra}
        </div>
      )}
    </article>
  );
}

/**
 * One of the four numbers shown first: value, then one short verdict. A
 * reading without a registered range is grey, not green; a reading of
 * doubtful quality says so above the number instead of pretending.
 */
export function KeyTile({ metric: m, issue, threshold, samples = [], grade, onOpen }: {
  metric: Metric;
  issue: string;
  threshold: CultivationStrategyThreshold | undefined;
  samples?: SensorTrendSample[];
  /** The alert grade for this reading, so the tile keeps the same colour as the alert everywhere. */
  grade?: "attention" | "danger";
  onOpen: () => void;
}) {
  const value = readingValue(m);
  // Direction of travel over the sampled span; nothing when the sensor is doubtful or the span is too short.
  const spanMinutes = samples.length > 2 ? (Date.parse(samples[samples.length - 1].time) - Date.parse(samples[0].time)) / 60000 : 0;
  const delta = !issue && spanMinutes >= 10 ? recentDelta(samples, m.unit, metricPrecision(m.key)) : null;
  const moving = delta && delta.direction !== "steady" ? delta : null;
  const suspect = issue === L("센서 품질 확인", "Check sensor quality");
  const tone = suspect && grade ? grade : issue ? "attention" : m.status === "critical" ? "danger" : m.status === "warning" ? "attention" : threshold ? "ok" : "none";
  const word = issue ? issue : m.status === "normal" ? (threshold ? L("기준 안", "In range") : L("기준 없음", "No threshold")) : m.status === "critical" ? L("기준 크게 벗어남", "Far out of range") : L("기준 벗어남", "Out of range");
  const span = sampleSpanText(samples);
  if (suspect) {
    // The verdict is the main information; the received number is secondary and not used for judgement.
    return (
      <button type="button" className={`fm-key-tile is-${tone} is-suspect`} onClick={onOpen} aria-label={L(`${m.label}, 센서 확인 필요, 수신값 ${value.text} ${m.unit}, 판단에 쓰지 않음, 자세히 보기`, `${term(m.label)}, check sensor, received ${value.text} ${m.unit}, not used for judgement, show details`)}>
        <span className="fm-key-label">{term(m.label)}</span>
        <strong className="fm-key-word">{L("센서 확인 필요", "Check sensor")}</strong>
        <span className="fm-key-status"><span className="fm-dot" aria-hidden="true" />{L(`수신값 ${value.text} ${m.unit}. 판단에 쓰지 않음`, `Received ${value.text} ${m.unit}. Not used for judgement`)}</span>
      </button>
    );
  }
  return (
    <button type="button" className={`fm-key-tile is-${tone}`} onClick={onOpen} aria-label={`${term(m.label)} ${value.text} ${m.unit}, ${word}${moving ? `, ${movedText(span, moving.label.replace(/^[+-]/, ""), moving.direction)}` : ""}, ${L("자세히 보기", "show details")}`}>
      <span className="fm-key-label">{term(m.label)}</span>
      <strong>{value.text}<small>{m.unit}</small></strong>
      <span className="fm-key-status">
        <span className="fm-dot" aria-hidden="true" />{word}
        {moving && <span className={`fm-key-delta is-${moving.direction}`} title={movedText(span, moving.label.replace(/^[+-]/, ""), moving.direction)}>{moving.direction === "up" ? "↑" : "↓"} {moving.label.replace(/^[+-]/, "")} <small>{span?.replace(/^최근 /, "").replace(/^Last /, "")}</small></span>}
      </span>
    </button>
  );
}

export function StabilityLine({ metrics, thresholds }: { metrics: Metric[]; thresholds: CultivationStrategyThreshold[] }) {
  if (!metrics.length) return null;
  const counts = readingCounts(metrics, (key) => thresholds.some((t) => t.metric === key));
  return <p className="fm-stability"><FarmIcon name="trend" />{readingCountsText(counts)}</p>;
}

export function BalancePanel({ indicator, zoneMetrics }: { indicator: DerivedIndicator | undefined; zoneMetrics: Metric[] }) {
  if (!indicator) return null;
  const rows = derivedIndicatorRows(indicator, zoneMetrics);
  const attention = rows.filter((r) => r.status !== "normal").length;
  return (
    <details className="fm-balance">
      <summary>{L("환경 균형", "Environment balance")} / {attention ? L(`확인 ${attention}개`, `${attention} to check`) : L(`${rows.length}개 정상`, `${rows.length} normal`)}</summary>
      <div className="fm-balance-grid">
        {rows.map((r) => (
          <div className={`fm-balance-item ${r.status}`} key={r.key}>
            <span>{term(r.label)}</span>
            <strong>{r.value}</strong>
            <small>{r.statusLabel}</small>
          </div>
        ))}
      </div>
      <small className="fm-note">{L("관련 센서를 함께 계산한 참고 지표입니다. 조절 근거는 각 관측과 기준에서 확인하세요.", "Reference indicators calculated from related sensors. Check each reading and its range before adjusting.")}</small>
    </details>
  );
}

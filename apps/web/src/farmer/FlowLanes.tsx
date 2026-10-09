import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { FarmIcon } from "./FarmIcon";
import type { IconName } from "./FarmIcon";
import { AiMark } from "./AiBrief";
import { L } from "./i18n";
import { MODULES } from "./research-modules";
import type { ModuleId } from "./research-modules";
import { LANE_ORDER, laneName, routeKind, routePath } from "./flow-model";
import type { FlowCell, Lane } from "./flow-model";

/**
 * One step of a flow: a box in a lane, with what it received or produced drawn
 * inside. A step a study performs carries that study's mark and its role there.
 */
export type FlowNode = FlowCell & { title: string; body: ReactNode; research?: ModuleId; role?: string };

/** Which of the three studies a research module belongs to. */
export const STUDY_OF: Record<ModuleId, 1 | 2 | 3> = { rag: 1, qact: 1, video: 2, sr: 3, gate: 3 };
/** What moves from one box to the next; the label is the data on the wire. */
export type FlowEdge = { from: string; to: string; label?: string | null };

const LANE_ICON: Record<Exclude<Lane, "ai">, IconName> = { screen: "screen", server: "server", field: "sensor" };
const STEP_MS = 1400;
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function LaneMark({ lane }: { lane: Lane }) {
  return lane === "ai" ? <AiMark /> : <FarmIcon name={LANE_ICON[lane]} />;
}

/**
 * Plays a flow once it comes into view, a step at a time; afterwards the data
 * keeps moving along the wires while the flow stays in view. New data (a run
 * made now) replays it. Reduced motion shows every step at once.
 */
function useFlowPlayer(count: number, resetKey: string) {
  const last = count - 1;
  const [step, setStep] = useState(() => (reducedMotion() ? last : -1));
  const [playing, setPlaying] = useState(false);
  const [inView, setInView] = useState(false);
  const seen = useRef(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (reducedMotion()) { setStep(last); return; }
    setStep(-1);
    setPlaying(seen.current);
  }, [resetKey, last]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A tall board (a phone stacks every step) counts as seen once its top is well inside the screen.
    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      setInView(visible);
      if (visible && !seen.current && !reducedMotion()) { seen.current = true; setPlaying(true); }
    }, { threshold: 0, rootMargin: "0px 0px -35% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!playing) return;
    if (step >= last) { setPlaying(false); return; }
    const id = window.setTimeout(() => setStep((s) => Math.min(last, s + 1)), step < 0 ? 300 : STEP_MS);
    return () => window.clearTimeout(id);
  }, [playing, step, last]);
  const replay = useCallback(() => { setStep(reducedMotion() ? last : -1); setPlaying(!reducedMotion()); }, [last]);
  const toggle = useCallback(() => setPlaying((p) => !p), []);
  return { ref, step, playing, done: step >= last, inView, replay, toggle };
}

/**
 * One flow on a board: its name, where its data came from, a replay control,
 * and the flow itself drawn across the lanes it passes through.
 */
export function FlowBoard({ title, source, tools, nodes, edges, columns, resetKey, empty }: {
  title: string;
  source: ReactNode;
  tools?: ReactNode;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Relative widths of the step columns. */
  columns: number[];
  resetKey: string;
  /** Shown instead of the drawing when there is nothing to draw yet. */
  empty?: ReactNode;
}) {
  const player = useFlowPlayer(nodes.length, resetKey);
  const label = player.playing ? L("멈춤", "Pause") : player.done ? L("다시 보기", "Replay") : L("재생", "Play");
  return (
    <div ref={player.ref} className={`fm-fl ${player.done ? "is-done" : ""} ${player.inView ? "is-inview" : ""}`}>
      <header className="fm-fl-subhead">
        <h3>{title}</h3>
        <span className="fm-fl-source">{source}</span>
        <span className="fm-fl-tools">
          {tools}
          {!empty && (
            <button type="button" className="fm-fl-replay" onClick={player.done ? player.replay : player.toggle} aria-label={label}>
              <FarmIcon name={player.playing ? "pause" : player.done ? "refresh" : "play"} />{label}
            </button>
          )}
        </span>
      </header>
      {empty ?? <FlowLanes nodes={nodes} edges={edges} columns={columns} step={player.step} done={player.done} />}
    </div>
  );
}

type Wire = { id: string; d: string; to: number; ai: boolean; label: { x: number; y: number; text: string } | null };

/**
 * The lanes (screen, AI, server, site) as rows and the steps as columns; wires
 * are measured from the boxes and routed around them. On a narrow screen the
 * same boxes stack in order, each tagged with its lane.
 */
function FlowLanes({ nodes, edges, columns, step, done }: { nodes: FlowNode[]; edges: FlowEdge[]; columns: number[]; step: number; done: boolean }) {
  const lanes = LANE_ORDER.filter((lane) => nodes.some((n) => n.lane === lane));
  const order = nodes.map((n) => n.id);
  const gridRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [wires, setWires] = useState<Wire[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // What the wiring depends on; the boxes' contents change size, which the observer catches.
  const shape = JSON.stringify([nodes.map((n) => [n.id, n.lane, n.col, n.span ?? 1]), edges.map((e) => [e.from, e.to, e.label ?? ""])]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const cells: FlowCell[] = nodes.map(({ id, lane, col, span }) => ({ id, lane, col, span }));
    const measure = () => {
      // The stacked (narrow) layout draws its own connectors.
      if (getComputedStyle(grid).getPropertyValue("--fl-wired").trim() !== "1") { setWires((w) => (w.length ? [] : w)); return; }
      const base = grid.getBoundingClientRect();
      const box = (id: string) => {
        const el = grid.querySelector<HTMLElement>(`[data-node="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      };
      const next: Wire[] = edges.flatMap((e) => {
        const a = cells.find((c) => c.id === e.from), b = cells.find((c) => c.id === e.to);
        const ba = box(e.from), bb = box(e.to);
        if (!a || !b || !ba || !bb) return [];
        const { d, label } = routePath(routeKind(a, b, cells, lanes), ba, bb);
        const text = e.label ?? "";
        // A label goes on a wire only where it has room beside the boxes.
        const fits = label && text && label.room >= Math.min(140, 22 + text.length * 7);
        return [{ id: `${e.from}>${e.to}`, d, to: order.indexOf(e.to), ai: b.lane === "ai", label: fits ? { x: label.x, y: label.y, text } : null }];
      });
      setWires((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      setSize((prev) => (Math.abs(prev.w - base.width) < 0.5 && Math.abs(prev.h - base.height) < 0.5 ? prev : { w: base.width, h: base.height }));
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(grid);
    grid.querySelectorAll("[data-node]").forEach((el) => ro.observe(el));
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);
  return (
    <div className="fm-fl-board">
      <div className="fm-fl-grid" ref={gridRef} style={{ "--fl-cols": columns.map((c) => `minmax(0, ${c}fr)`).join(" ") } as CSSProperties}>
        {lanes.map((lane, i) => (
          <Fragment key={lane}>
            <div className={`fm-fl-lane is-${lane}`} style={{ gridRow: i + 1 }} aria-hidden="true"><LaneMark lane={lane} /><span>{laneName(lane)}</span></div>
            <div className={`fm-fl-band is-${lane} ${i === 0 ? "is-first" : ""}`} style={{ gridRow: i + 1 }} aria-hidden="true" />
          </Fragment>
        ))}
        <svg className="fm-fl-wires" width={size.w} height={size.h} aria-hidden="true">
          <defs>
            {(["off", "on", "ai"] as const).map((k) => (
              <marker key={k} id={`${uid}-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L8 4L0 8Z" className={`is-${k}-head`} />
              </marker>
            ))}
          </defs>
          {wires.map((w) => {
            const head = step >= w.to ? (w.ai ? "ai" : "on") : "off";
            return <path key={w.id} d={w.d} markerEnd={`url(#${uid}-${head})`} className={`${step >= w.to ? "is-on" : ""} ${w.ai ? "is-ai" : ""}`} />;
          })}
        </svg>
        <ol className="fm-fl-nodes" role="list">
          {nodes.map((n, i) => {
            const incoming = edges.filter((e) => e.to === n.id);
            const into = incoming.map((e) => e.label).filter(Boolean).join(", ");
            return (
              <li
                key={n.id}
                data-node={n.id}
                data-lane={n.lane}
                className={`fm-fl-node ${n.research ? "is-research" : ""} ${step >= i ? "is-on" : ""} ${step === i && !done ? "is-now" : ""}`}
                style={{ gridRow: lanes.indexOf(n.lane) + 1, gridColumn: `${n.col + 1} / span ${n.span ?? 1}`, "--fl-delay": incoming.length ? "0.55s" : "0s" } as CSSProperties}
              >
                {incoming.length > 0 && <span className="fm-fl-in" aria-hidden="true"><i />{into}</span>}
                <p className={`fm-fl-lanetag is-${n.lane}`}><LaneMark lane={n.lane} />{laneName(n.lane)}</p>
                <h4><b>{i + 1}</b>{n.title}</h4>
                <div className="fm-fl-body">{n.body}</div>
                {n.research && (
                  <p className="fm-fl-rmark" title={MODULES[n.research].name}>
                    <span>{L(`연구 ${STUDY_OF[n.research]}`, `Study ${STUDY_OF[n.research]}`)}</span>{n.role ?? MODULES[n.research].name}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
        {wires.map((w, k) => (
          <Fragment key={w.id}>
            <i className={`fm-fl-packet ${w.ai ? "is-ai" : ""} ${step === w.to && !done ? "is-run" : ""}`} style={{ offsetPath: `path("${w.d}")`, "--k": k } as CSSProperties} aria-hidden="true" />
            {w.label && <span className={`fm-fl-wire-label ${step >= w.to ? "is-on" : ""}`} style={{ left: w.label.x, top: w.label.y }} aria-hidden="true">{w.label.text}</span>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

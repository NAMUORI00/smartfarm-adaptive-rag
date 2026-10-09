import { useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import type { CropCycle, FarmLayout, FarmSelection } from "../farm-spatial";
import { daysUntil } from "./suggestions";
import type { Actuator, DashboardSnapshot } from "../types";
import { iconPath } from "./FarmIcon";
import type { IconName } from "./FarmIcon";
import { deviceIcon, deviceLevel, deviceShortLabel } from "./stage-cues";
import { progressText } from "./device-progress";
import type { DeviceProgress } from "./device-progress";
import { shortAlertTitle } from "./todo-engine";
import { observationProblem } from "./workspace-state";
import { L, place, term } from "./i18n";
import type { BriefAnchor, BriefTone } from "./ai-brief";

type Tone = "ok" | "attention" | "danger";
type ChipTone = "on" | "off" | "attention";

export type PlanProps = {
  layout: FarmLayout;
  snapshot: DashboardSnapshot | null;
  connected: boolean;
  selection: FarmSelection | null;
  selectedZone: string | null;
  selectedDevice: string | null;
  cycles?: CropCycle[];
  /** Plant scale per crop cycle, as the 3D model draws it (growth-display.ts). */
  plantScales?: Record<string, number>;
  onSelectBed: (bedId: string) => void;
  onSelectZone: (zoneId: string) => void;
  /** A zone's whole equipment list, or one device by its actuator key. */
  onSelectDevice: (zoneId: string, deviceKey?: string) => void;
  /** Devices still applying a change, or staying away from it (device-progress.ts). */
  progress?: Record<string, DeviceProgress>;
};

type PlanDevice = { key: string; target: string | null; short: string; text: string; icon: IconName; tone: ChipTone; slot: "top" | "bottom" | "right" | "machinery"; on: boolean; progress: DeviceProgress | null };


// Where a device sits on the zone: vents and the curtain on the roof line,
// the side vent and the sensor along the lower edge, the fan on the end wall,
// machines (chiller, heater, pump) in their own block beside the zone.
function slotFor(target: string | null | undefined): PlanDevice["slot"] {
  switch (target) {
    case "roof_vent":
    case "shade_curtain": return "top";
    case "side_vent":
    case "air_temperature_sensor_reset": return "bottom";
    case "ventilation_fan": return "right";
    default: return "machinery";
  }
}
const slotOrder: Record<PlanDevice["slot"], string[]> = {
  top: ["roof_vent", "shade_curtain"],
  bottom: ["side_vent", "air_temperature_sensor_reset"],
  right: ["ventilation_fan"],
  machinery: ["root_zone_chiller", "heater", "irrigation_pump"],
};

function planDevice(d: Actuator, sensorSuspect: boolean, progress: DeviceProgress | null): PlanDevice {
  const level = deviceLevel(d);
  const fault = d.health === "fault" || d.health === "offline";
  const sensor = d.target === "air_temperature_sensor_reset";
  const text = sensor ? (sensorSuspect ? L("확인 필요", "needs check") : L("정상", "Normal")) : fault ? (d.health === "offline" ? L("응답 없음", "No response") : L("점검 필요", "needs service")) : term(level.text);
  return {
    key: d.key,
    target: d.target ?? null,
    short: term(deviceShortLabel(d.target, d.label)),
    text: progress ? `${text}, ${progressText(progress)}` : text,
    icon: deviceIcon(d.target),
    // A lasting difference between request and output is something to check, like a fault.
    tone: fault || (sensor && sensorSuspect) || progress?.state === "differs" ? "attention" : level.on && !sensor ? "on" : "off",
    slot: slotFor(d.target),
    on: level.on && !sensor && !fault,
    progress,
  };
}

/** What each zone shows on the plan: tone, one mark, its devices. Shared by the SVG plan and the phone list. */
function planZones({ layout, snapshot, connected, progress }: Pick<PlanProps, "layout" | "snapshot" | "connected" | "progress">) {
  const alerts = (snapshot?.alerts ?? []).filter((a) => a.status !== "resolved");
  return layout.zones.map((zone) => {
    const beds = layout.beds.filter((b) => b.zone_id === zone.id);
    const zoneAlerts = alerts.filter((a) => !a.zoneId || a.zoneId === zone.id);
    const metrics = snapshot?.metrics.filter((m) => !m.zoneId || m.zoneId === zone.id) ?? [];
    const actuators = (snapshot?.actuators ?? []).filter((d) => d.zoneId === zone.id);
    const sensorSuspect = zoneAlerts.some((a) => a.kind === "sensor_health") || metrics.some((m) => m.key === "air_temperature_c" && !!m.quality && m.quality !== "good");
    const devices = actuators.map((d) => planDevice(d, sensorSuspect, progress?.[d.key] ?? null));
    const bySlot = (slot: PlanDevice["slot"]) => devices.filter((d) => d.slot === slot).sort((a, b) => slotOrder[slot].indexOf(a.target ?? "") - slotOrder[slot].indexOf(b.target ?? ""));
    const faults = devices.filter((d) => d.tone === "attention").length;
    const tone: Tone = !connected ? "attention" : zoneAlerts.some((a) => a.severity === "critical") ? "danger" : zoneAlerts.length || faults || observationProblem(metrics) ? "attention" : "ok";
    const first = [...zoneAlerts].sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"))[0];
    const mark = first
      ? { text: L(`${shortAlertTitle(first.title)} ${zoneAlerts.length}건`, `${term(shortAlertTitle(first.title))} (${zoneAlerts.length})`), tone: (first.severity === "critical" ? "danger" : "attention") as Tone }
      : connected && observationProblem(metrics)
        ? { text: L("값 확인", "Check values"), tone: "attention" as Tone }
        : null;
    return { zone, beds, tone, mark, devices, bySlot, faults };
  });
}

const bedNumber = (label: string) => label.replace(/\s*베드$/, "");
/** The bed number as shown ("4번" in Korean, "4" in English). */
const bedNumberText = (label: string) => place(bedNumber(label));
/** bedCrop keeps Korean values; these are its display forms. */
const harvestText = (h: string) => (h === "수확 지남" ? L("지남", "Late") : h === "오늘 수확" ? L("오늘", "Today") : h);
const harvestAria = (h: string) => (h === "수확 지남" ? L(h, "harvest past due") : h === "오늘 수확" ? L(h, "harvest due today") : L(h, `harvest ${h}`));

/**
 * The tiers of a bed that carry a crop, lowest first, each with the size its
 * plants are drawn at (1 when nothing sets it). Tier 4 alone shows in the
 * fourth slot, not the first.
 */
export function bedTiers(cycles: CropCycle[] | undefined, bedId: string, scales?: Record<string, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const c of cycles ?? []) if (c.bed_id === bedId && c.status === "growing") out.set(c.tier, scales?.[c.id] ?? 1);
  return out;
}
// A leaf for a seedling is smaller, never gone.
const leafScale = (plant: number) => 0.78 * (0.45 + 0.55 * plant);

/** What a bed carries, for the plan: planted or empty, and the nearest harvest within a week. */
export function bedCrop(cycles: CropCycle[] | undefined, bedId: string, now = Date.now()): { planted: number; harvest: string | null } {
  const growing = (cycles ?? []).filter((c) => c.bed_id === bedId && c.status === "growing");
  const days = growing.map((c) => daysUntil(c.planned_harvest_from, now)).filter((d): d is number => d !== null && d <= 7);
  const soonest = days.length ? Math.min(...days) : null;
  return { planted: growing.length, harvest: soonest === null ? null : soonest < 0 ? "수확 지남" : soonest === 0 ? "오늘 수확" : `D-${soonest}` };
}

/**
 * The first screen: the greenhouse drawn from above, so it reads without the
 * words. The two zones are shaded floor areas in their real interlocking
 * shape; each bed is a tray with one leaf per planted tier; every device is a
 * pictogram where it works — vents and the shade band on the roof side, the
 * fan on the end wall (turning when it runs), the side vent on the side wall,
 * the thermometer in the aisle, and chiller, heater and pump in the machine
 * room, each with its own pipe into the zone that flows while it runs. Colour
 * carries the state: green running, amber check, red urgent; a change still
 * being applied runs a dashed ring round its device. When readings stop,
 * nothing moves. Pointing at a device marks the beds it serves. Names and
 * values are in each item's tooltip and label, and in the panel that opens on tap.
 */
export type PlanCamera = { id: string; label: string; zoneId: string; col: number; row: number; angle: number; tone?: "ok" | "attention" };
/** A numbered AI brief item pinned to the place it concerns. */
export type PlanPin = { id: string; rank: number; tone: BriefTone; anchor: BriefAnchor; label: string };
type PinProps = { pins?: PlanPin[]; activePin?: string | null; onPin?: (id: string) => void; onPinHover?: (id: string | null) => void; /** Join the pins in order: today's walking route. */ route?: boolean };

const GX = 64, GY = 78, CELL_W = 118, CELL_H = 132;
const TRAY_W = 94, TRAY_H = 72;
const MACHINE_W = 150;
/** The machine room is tall enough for one pipe per machine under the machines. */
const ROOM_H = 118;
/** The motion a running machine's pictogram makes on the plan. */
const MOTION: Record<string, string> = { ventilation_fan: "fm-pd-spin", root_zone_chiller: "fm-pd-anim-chill", heater: "fm-pd-anim-heat", irrigation_pump: "fm-pd-anim-drop" };

export function FarmPlan(props: PlanProps & { cameras?: PlanCamera[]; onSelectCamera?: (id: string) => void } & PinProps) {
  const { layout, snapshot, connected, selection, selectedZone, selectedDevice, cycles, plantScales, onSelectBed, onSelectZone, onSelectDevice, cameras = [], onSelectCamera, pins = [], activePin, onPin, onPinHover, route = false, progress } = props;
  // The device pointed at (or chosen) marks the beds it serves.
  const [pointed, setPointed] = useState<string | null>(null);
  const servedBy = (key: string | null | undefined) => new Set(key ? layout.devices.find((x) => x.key === key)?.affected_bed_ids ?? [] : []);
  const served = servedBy(pointed ?? selectedDevice);
  // Where each thing is drawn, so an AI brief pin can sit on it.
  const devicePos = new Map<string, { x: number; y: number }>();
  const zoneTagPos = new Map<string, { x: number; y: number }>();
  const activate = (fn: () => void) => (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); fn(); }
  };
  const xs = [...new Set(layout.beds.map((b) => b.position.x))].sort((a, b) => a - b);
  const zs = [...new Set(layout.beds.map((b) => b.position.z))].sort((a, b) => a - b);
  const cols = xs.length, rows = zs.length;
  const houseW = cols * CELL_W, houseH = rows * CELL_H;
  const machineX = GX + houseW + 84;
  const W = machineX + MACHINE_W + 24;
  const H = GY + houseH + 78;
  const cellOf = (bedId: string) => {
    const b = layout.beds.find((x) => x.id === bedId)!;
    return { col: xs.indexOf(b.position.x), row: zs.indexOf(b.position.z) };
  };
  const cx = (col: number) => GX + col * CELL_W + CELL_W / 2;
  const cy = (row: number) => GY + row * CELL_H + CELL_H / 2;
  const zones = planZones({ layout, snapshot, connected, progress });
  // Water reaching the beds while a pump runs (only while readings arrive).
  const watered = new Set<string>();
  if (connected) for (const z of zones) for (const d of z.devices) if (d.target === "irrigation_pump" && d.on) servedBy(d.key).forEach((id) => watered.add(id));
  const zoneAt = new Map<string, string>();
  for (const b of layout.beds) { const c = cellOf(b.id); zoneAt.set(`${c.col}:${c.row}`, b.zone_id); }
  // Which wall a zone faces: the zone holding the first row has the top wall, the other the bottom wall.
  const topZone = zoneAt.get("0:0");
  const plantedTiers = (bedId: string) => new Set((cycles ?? []).filter((c) => c.bed_id === bedId && c.status === "growing").map((c) => c.tier)).size;

  const device = (zoneId: string, d: PlanDevice, x: number, y: number, extra?: ReactElement) => {
    const level = snapshot?.actuators.find((a) => a.key === d.key);
    devicePos.set(d.key, { x, y });
    // A running machine moves only while readings arrive; an old state is not shown as live.
    const motion = connected && d.on && d.tone === "on" ? MOTION[d.target ?? ""] : undefined;
    return (
      <g
        key={d.key}
        role="button"
        tabIndex={0}
        className={`fm-pd is-${d.tone} ${d.progress ? `is-${d.progress.state}` : ""} ${selectedDevice === d.key ? "is-selected" : ""} fm-pd-${d.target ?? "other"}`}
        aria-label={`${d.short}: ${d.text}`}
        onClick={() => onSelectDevice(zoneId, d.key)}
        onKeyDown={activate(() => onSelectDevice(zoneId, d.key))}
        onMouseEnter={() => setPointed(d.key)}
        onMouseLeave={() => setPointed(null)}
        onFocus={() => setPointed(d.key)}
        onBlur={() => setPointed(null)}
        transform={`translate(${x} ${y})`}
      >
        <title>{`${d.short}: ${d.text}`}</title>
        {d.progress?.state === "settling" && <rect x={-25} y={-25} width={50} height={50} rx={9} className="fm-pd-settle" />}
        <rect x={-20} y={-20} width={40} height={40} rx={6} className="fm-pd-tile" />
        {extra}
        <g className={motion} style={d.target === "ventilation_fan" ? { animationDuration: `${Math.max(0.6, 3 - (deviceLevel(level ?? ({} as Actuator)).percent ?? 0) / 40)}s` } : undefined}>
          <path d={iconPath(d.icon)} transform="translate(-12 -12)" className="fm-pd-icon" />
        </g>
        {d.progress?.state === "differs" ? (
          <g className="fm-pd-diff"><rect x={6} y={-29} width={22} height={18} rx={4} /><text x={17} y={-15}>≠</text></g>
        ) : d.tone === "attention" && <circle cx={15} cy={-15} r={6} className="fm-pd-alert" />}
      </g>
    );
  };

  // A pin sits at the top-right corner of what it points at.
  function pinAt(anchor: BriefAnchor): { x: number; y: number } | null {
    if (anchor.kind === "device") { const p = devicePos.get(anchor.deviceKey); return p ? { x: p.x + 18, y: p.y - 18 } : null; }
    if (anchor.kind === "bed") {
      if (!layout.beds.some((b) => b.id === anchor.bedId)) return null;
      const { col, row } = cellOf(anchor.bedId);
      return { x: cx(col) + TRAY_W / 2 - 2, y: cy(row) - TRAY_H / 2 + 12 };
    }
    if (anchor.kind === "camera") {
      const c = cameras.find((x) => x.id === anchor.cameraId);
      if (!c) return null;
      return { x: GX + c.col * CELL_W + 16, y: GY + c.row * CELL_H - 16 };
    }
    const p = zoneTagPos.get(anchor.zoneId);
    return p ? { x: p.x + 6, y: p.y } : null;
  }
  return (
    <div className={`fm-plan ${connected ? "" : "is-stale"}`} data-stage={selection ? "bed" : selectedZone ? "zone" : "overview"}>
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={L("농장 배치도", "Farm layout")} preserveAspectRatio="xMidYMid meet">
        <defs>
          <pattern id="fm-shade-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="8" height="8" className="fm-shade-bg" />
            <line x1="0" y1="0" x2="0" y2="8" className="fm-shade-line" />
          </pattern>
        </defs>
        {/* Zone floors, tinted by state. */}
        {zones.map(({ zone, tone }) => (
          <g key={zone.id} className={`fm-pz is-${tone} ${selectedZone === zone.id ? "is-selected" : ""}`} onClick={() => onSelectZone(zone.id)}>
            {[...zoneAt.entries()].filter(([, z]) => z === zone.id).map(([key]) => {
              const [col, row] = key.split(":").map(Number);
              return <rect key={key} x={GX + col * CELL_W} y={GY + row * CELL_H} width={CELL_W} height={CELL_H} className="fm-pz-floor" />;
            })}
          </g>
        ))}
        {/* The boundary between the zones, drawn once. */}
        {[...zoneAt.entries()].flatMap(([key, z]) => {
          const [col, row] = key.split(":").map(Number);
          const out: ReactElement[] = [];
          const right = zoneAt.get(`${col + 1}:${row}`), below = zoneAt.get(`${col}:${row + 1}`);
          if (right && right !== z) out.push(<line key={`${key}r`} x1={GX + (col + 1) * CELL_W} y1={GY + row * CELL_H} x2={GX + (col + 1) * CELL_W} y2={GY + (row + 1) * CELL_H} className="fm-pz-border" />);
          if (below && below !== z) out.push(<line key={`${key}b`} x1={GX + col * CELL_W} y1={GY + (row + 1) * CELL_H} x2={GX + (col + 1) * CELL_W} y2={GY + (row + 1) * CELL_H} className="fm-pz-border" />);
          return out;
        })}
        {/* The house: walls, and the service door at the lower left. */}
        <rect x={GX} y={GY} width={houseW} height={houseH} rx={4} className="fm-house" />
        <g className="fm-door" aria-hidden="true">
          <rect x={GX + 16} y={GY + houseH - 3} width={44} height={6} className="fm-door-gap" />
          <path d={`M${GX + 16} ${GY + houseH} a44 44 0 0 1 44 -44`} className="fm-door-swing" />
        </g>
        {/* Zone tags with the alert mark. */}
        {zones.map(({ zone, tone, mark }) => {
          const cells = [...zoneAt.entries()].filter(([, z]) => z === zone.id).map(([k]) => k.split(":").map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
          const [col, row] = cells[0];
          const x = GX + col * CELL_W + 8, y = GY + row * CELL_H + 7;
          const tagW = 70 + (mark ? 34 : 0);
          zoneTagPos.set(zone.id, { x: x + tagW, y });
          return (
            <g
              key={`tag-${zone.id}`}
              role="button"
              tabIndex={0}
              className={`fm-pz-tag is-${tone}`}
              aria-label={mark ? `${place(zone.label)}: ${mark.text}` : place(zone.label)}
              onClick={() => onSelectZone(zone.id)}
              onKeyDown={activate(() => onSelectZone(zone.id))}
            >
              <title>{mark ? `${place(zone.label)}: ${mark.text}` : place(zone.label)}</title>
              <rect x={x} y={y} width={tagW} height={24} rx={3} />
              <text x={x + 10} y={y + 17}>{place(zone.label)}</text>
              {mark && (
                <g className={`fm-pz-mark is-${mark.tone}`}>
                  <path d={iconPath("warning")} transform={`translate(${x + 68} ${y + 3}) scale(0.75)`} />
                  <text x={x + 90} y={y + 17}>{mark.text.match(/\d+/g)?.at(-1) ?? "!"}</text>
                </g>
              )}
            </g>
          );
        })}
        {/* Beds: a tray with one leaf per planted tier; empty tiers are open dots. */}
        {layout.beds.map((b) => {
          const { col, row } = cellOf(b.id);
          const x = cx(col) - TRAY_W / 2, y = cy(row) - TRAY_H / 2 + 10;
          const planted = plantedTiers(b.id);
          const tiers = bedTiers(cycles, b.id, plantScales);
          const crop = bedCrop(cycles, b.id);
          const selected = selection?.bedId === b.id;
          const label = `${place(b.label)}: ${planted ? L(`${planted}개 단 재배 중`, `${planted} of 4 tiers planted`) : L("빈 베드", "empty")}${crop.harvest ? `, ${harvestAria(crop.harvest)}` : ""}`;
          return (
            <g
              key={b.id}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={label}
              className={`fm-pb ${planted ? "is-planted" : "is-empty"} ${selected ? "is-selected" : ""} ${served.has(b.id) ? "is-served" : ""}`}
              onClick={() => onSelectBed(b.id)}
              onKeyDown={activate(() => onSelectBed(b.id))}
            >
              <title>{label}</title>
              <rect x={x} y={y} width={TRAY_W} height={TRAY_H} rx={5} className="fm-pb-tray" />
              {/* Four tiers, left to right from the lowest: a leaf where a crop is registered. */}
              {[0, 1, 2, 3].map((i) => {
                const lx = x + 15 + i * 21.5, ly = y + 49;
                const plant = tiers.get(i + 1);
                const k = plant === undefined ? 0 : leafScale(plant);
                return plant !== undefined
                  ? <path key={i} d={iconPath("leaf")} transform={`translate(${(lx - 12 * k).toFixed(1)} ${(ly - 12 * k).toFixed(1)}) scale(${k.toFixed(3)})`} className="fm-pb-leaf" />
                  : <circle key={i} cx={lx} cy={ly} r={3.5} className="fm-pb-slot" />;
              })}
              <text x={x + 8} y={y + 19} className="fm-pb-num">{bedNumberText(b.label)}</text>
              {watered.has(b.id) && (
                <g transform={`translate(${x + TRAY_W / 2 - 6} ${y + 57}) scale(0.5)`} aria-hidden="true">
                  <g className="fm-pb-drip"><path d={iconPath(deviceIcon("irrigation_pump"))} /></g>
                </g>
              )}
              {crop.harvest && (
                <g className="fm-pb-harvest">
                  <rect x={x + TRAY_W - 48} y={y + 5} width={42} height={19} rx={3} />
                  <text x={x + TRAY_W - 27} y={y + 19} textAnchor="middle">{harvestText(crop.harvest)}</text>
                </g>
              )}
            </g>
          );
        })}
        {/* Devices where they work. */}
        {zones.map(({ zone, bySlot }) => {
          const top = zone.id === topZone;
          const wallY = top ? GY : GY + houseH;
          const outY = top ? GY - 34 : GY + houseH + 34;
          const zoneRow = top ? 0 : rows - 1;
          const nodes: ReactElement[] = [];
          const shade = bySlot("top").find((d) => d.target === "shade_curtain");
          const vent = bySlot("top").find((d) => d.target === "roof_vent");
          if (shade) {
            const pct = deviceLevel(snapshot?.actuators.find((a) => a.key === shade.key) ?? ({} as Actuator)).percent ?? 0;
            nodes.push(
              <g key={`${zone.id}-shade-band`} className="fm-shade-band" aria-hidden="true">
                <rect x={GX + 60} y={top ? wallY - 12 : wallY + 4} width={houseW - 120} height={8} rx={2} className="fm-shade-track" />
                <rect x={GX + 60} y={top ? wallY - 12 : wallY + 4} width={((houseW - 120) * pct) / 100} height={8} rx={2} fill="url(#fm-shade-hatch)" />
              </g>,
            );
            nodes.push(device(zone.id, shade, GX + 30, outY));
          }
          if (vent) {
            const pct = deviceLevel(snapshot?.actuators.find((a) => a.key === vent.key) ?? ({} as Actuator)).percent ?? 0;
            nodes.push(device(zone.id, vent, GX + houseW - 30, outY, <rect x={-16} y={top ? 12 : -16} width={32 * (pct / 100)} height={4} className="fm-pd-level" />));
          }
          const side = bySlot("bottom").find((d) => d.target === "side_vent");
          if (side) nodes.push(device(zone.id, side, GX - 34, cy(zoneRow)));
          const sensor = bySlot("bottom").find((d) => d.target === "air_temperature_sensor_reset");
          if (sensor) nodes.push(device(zone.id, sensor, top ? GX + CELL_W : GX + houseW - CELL_W, GY + (top ? 1 : rows - 1) * CELL_H));
          const fan = bySlot("right")[0];
          if (fan) nodes.push(device(zone.id, fan, GX + houseW + 34, cy(zoneRow)));
          // Machine room beside the zone's end wall: tapping it opens the zone's equipment.
          const machines = bySlot("machinery");
          const my = cy(zoneRow) - 46;
          const roomLabel = L(`${place(zone.label)} 설비실`, `${place(zone.label)} plant room`);
          nodes.push(
            <g
              key={`${zone.id}-room`}
              className="fm-room"
              role="button"
              tabIndex={0}
              aria-label={L(`${roomLabel}: 설비 목록 열기`, `${roomLabel}: open its equipment`)}
              onClick={() => onSelectDevice(zone.id)}
              onKeyDown={activate(() => onSelectDevice(zone.id))}
            >
              <title>{L(`${roomLabel}: 설비 목록 열기`, `${roomLabel}: open its equipment`)}</title>
              <rect x={machineX} y={my} width={MACHINE_W} height={ROOM_H} rx={4} className="fm-room-box" />
              <text x={machineX + 10} y={my + 19} className="fm-room-label">{roomLabel}</text>
            </g>,
          );
          // One pipe per machine, from under it into the zone, lanes stacked so none cross;
          // it flows from the room toward the beds only while that machine runs.
          machines.forEach((d, i) => {
            const x = machineX + 30 + i * 46, lane = my + 88 + i * 10;
            nodes.push(<path key={`${d.key}-pipe`} d={`M${x} ${my + 78} V${lane} H${GX + houseW}`} className={`fm-pipe fm-pipe-${d.target ?? "other"} ${connected && d.on && d.tone === "on" ? "is-on" : ""}`} aria-hidden="true" />);
          });
          machines.forEach((d, i) => nodes.push(device(zone.id, d, machineX + 30 + i * 46, my + 58)));
          return <g key={`${zone.id}-devices`}>{nodes}</g>;
        })}
        {/* Cameras with their field of view. */}
        {cameras.map((c) => {
          const x = GX + c.col * CELL_W, y = GY + c.row * CELL_H;
          return (
            <g
              key={c.id}
              role="button"
              tabIndex={0}
              className={`fm-pcam ${c.tone === "attention" ? "is-attention" : ""}`}
              aria-label={c.label}
              onClick={() => onSelectCamera?.(c.id)}
              onKeyDown={activate(() => onSelectCamera?.(c.id))}
              transform={`translate(${x} ${y}) rotate(${c.angle})`}
            >
              <title>{c.label}</title>
              <path d="M0 0 L120 -46 A124 124 0 0 1 120 46 Z" className="fm-pcam-fov" />
              <g transform={`rotate(${-c.angle})`}>
                <circle r={17} className="fm-pcam-dot" />
                <path d={iconPath("camera")} transform="translate(-10 -10) scale(0.84)" className="fm-pcam-icon" />
              </g>
            </g>
          );
        })}
        {/* Today's route: the stops joined in walking order. */}
        {route && (() => {
          const points = [...pins].sort((a, b) => a.rank - b.rank).map((p) => pinAt(p.anchor)).filter((p): p is { x: number; y: number } => !!p);
          return points.length > 1 ? <polyline points={points.map((p) => `${p.x},${p.y}`).join(" ")} className="fm-route-line" aria-hidden="true" /> : null;
        })()}
        {/* AI brief: the most pressing items, numbered, on the spot they concern. */}
        {pins.map((pin) => {
          const at = pinAt(pin.anchor);
          if (!at) return null;
          return (
            <g
              key={pin.id}
              role="button"
              tabIndex={0}
              className={`fm-ppin is-${pin.tone} ${activePin === pin.id ? "is-active" : ""}`}
              aria-label={L(`AI 우선 확인 ${pin.rank}: ${pin.label}`, `AI priority ${pin.rank}: ${pin.label}`)}
              transform={`translate(${at.x} ${at.y})`}
              onClick={() => onPin?.(pin.id)}
              onKeyDown={activate(() => onPin?.(pin.id))}
              onMouseEnter={() => onPinHover?.(pin.id)}
              onMouseLeave={() => onPinHover?.(null)}
            >
              <title>{pin.label}</title>
              {pin.rank === 1 && <circle r={15} className="fm-ppin-pulse" />}
              <circle r={13} className="fm-ppin-dot" />
              <text y={5} textAnchor="middle">{pin.rank}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The same plan for a phone: zone by zone, beds as 56px buttons in three
 * columns, then the zone's devices as rows. Nothing is scaled down to read.
 */
export function FarmPlanList(props: PlanProps & { cameras?: PlanCamera[]; onSelectCamera?: (id: string) => void } & PinProps) {
  const { selection, selectedZone, selectedDevice, cycles, onSelectBed, onSelectZone, onSelectDevice } = props;
  return (
    <div className="fm-plan-list" role="group" aria-label={L("농장 약도", "Farm plan")}>
      {planZones(props).map(({ zone, beds, tone, mark, devices }) => (
        <section key={zone.id} className={`fm-plan-list-zone is-${tone} ${selectedZone === zone.id ? "is-selected" : ""}`}>
          <div className="fm-plan-list-head">
            <button type="button" onClick={() => onSelectZone(zone.id)} aria-label={L(`${zone.label} 전체 보기`, `View all of ${place(zone.label)}`)}>
              {place(zone.label)}
            </button>
            {mark && (
              <button type="button" className={`fm-plan-list-mark is-${mark.tone}`} onClick={() => onSelectZone(zone.id)}>
                {mark.text}
              </button>
            )}
          </div>
          <div className="fm-plan-list-beds">
            {beds.map((bed) => {
              const crop = bedCrop(cycles, bed.id);
              return (
                <button
                  type="button"
                  key={bed.id}
                  className={crop.planted ? "is-planted" : "is-empty"}
                  aria-pressed={selection?.bedId === bed.id}
                  aria-label={L(
                    `${bed.label} 보기, ${crop.planted ? `재배 ${crop.planted}단` : "빈 베드"}${crop.harvest ? `, ${crop.harvest}` : ""}`,
                    `View ${place(bed.label)}, ${crop.planted ? `${crop.planted} ${crop.planted === 1 ? "tier" : "tiers"} planted` : "empty bed"}${crop.harvest ? `, ${harvestAria(crop.harvest)}` : ""}`,
                  )}
                  onClick={() => onSelectBed(bed.id)}
                >
                  <span className="fm-plan-list-num">{bedNumberText(bed.label)}{crop.harvest && <em className="fm-plan-list-harvest">{harvestText(crop.harvest)}</em>}</span>
                  <span className="fm-plan-list-tiers" aria-hidden="true">
                    {(() => {
                      const tiers = bedTiers(cycles, bed.id, props.plantScales);
                      return [1, 2, 3, 4].map((t) => {
                        const plant = tiers.get(t);
                        return <i key={t} className={plant !== undefined ? "is-leaf" : ""} style={plant !== undefined ? { transform: `scale(${(0.45 + 0.55 * plant).toFixed(2)})` } : undefined} />;
                      });
                    })()}
                  </span>
                </button>
              );
            })}
          </div>
          {devices.length > 0 && (() => {
            const row = (d: PlanDevice) => (
              <button
                type="button"
                key={d.key}
                className={`fm-plan-list-device is-${d.tone}`}
                aria-pressed={selectedDevice === d.key}
                onClick={() => onSelectDevice(zone.id, d.key)}
              >
                <svg className="fm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPath(d.icon)} /></svg>
                <span>{d.short}</span>
                <small>{d.text}</small>
              </button>
            );
            const problems = devices.filter((d) => d.tone === "attention");
            const rest = devices.filter((d) => d.tone !== "attention");
            return (
              <div className="fm-plan-list-devices">
                {problems.map(row)}
                <details className="fm-plan-list-fold">
                  <summary>{L(`설비 ${devices.length}대`, `${devices.length} devices`)}{problems.length ? L(` (점검 ${problems.length})`, ` (${problems.length} to inspect)`) : ""}</summary>
                  <div>{rest.map(row)}</div>
                </details>
              </div>
            );
          })()}
        </section>
      ))}
    </div>
  );
}

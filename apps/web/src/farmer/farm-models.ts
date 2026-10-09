import * as T from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { Tone } from "./stage-cues";

/**
 * Procedural models for the single-bed and single-device work views.
 * Everything that moves or glows here is driven by what FarmMap passes in:
 * device reports, zone cues and the live flag. Nothing here makes up a value.
 */

export type FlowDir = "up" | "down" | "x" | "z" | "drop";
export type Flow = { color: T.Color; dir: FlowDir; speed: number; center: T.Vector3; spread: [number, number]; height: number };
export type DeviceFlows = { air: Flow | null; root: Flow | null; drop: Flow | null };
export type DeviceInput = {
  target: string | null;
  on: boolean;
  percent: number | null;
  tone: "ok" | "attention";
  health?: "ok" | "fault" | "suspect";
  /** settling: a change is being applied (the status light blinks green); differs: the output stays away from the request (amber). */
  progress?: "settling" | "differs" | null;
};
/** One animation step. `still` means reduced motion or stopped readings: nothing moves, every state is drawn statically. */
export type Tick = { dt: number; clock: number; still: boolean; camera: T.Camera };
/** Theme-aware colours for air and mist so they read on both the light and the dark stage. */
export type Palette = { air: T.Color; mist: T.Color };
export type DeviceModel = { group: T.Group; height: number; bounds: T.Box3; update: (spec: DeviceInput, tick: Tick) => DeviceFlows };

export const STATUS = {
  ok: new T.Color("#63b98a"),
  warn: new T.Color("#e0a24e"),
  danger: new T.Color("#e2685a"),
  off: new T.Color("#59625f"),
};
const CHILL = new T.Color("#72b4e8");
const RETURN_WARM = new T.Color("#d9927f");
const WARM = new T.Color("#ef9a5c");
const WATER = new T.Color("#3f8fdb");
const LCD = new T.Color("#7cbfaa");
const ELEMENT_HOT = new T.Color("#8a5a40"), ELEMENT_COLD = new T.Color("#5a4a42");
const NONE: DeviceFlows = { air: null, root: null, drop: null };

// ---------------------------------------------------------------- small helpers

const mat = (color: T.ColorRepresentation, o: T.MeshStandardMaterialParameters = {}) =>
  new T.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.08, ...o });
function mesh(parent: T.Object3D, geo: T.BufferGeometry, m: T.Material, x = 0, y = 0, z = 0, shadow = true) {
  const o = new T.Mesh(geo, m);
  o.position.set(x, y, z);
  o.castShadow = shadow;
  o.receiveShadow = true;
  parent.add(o);
  return o;
}
function group(parent: T.Object3D, x = 0, y = 0, z = 0) {
  const g = new T.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}
const boxG = (w: number, h: number, d: number) => new T.BoxGeometry(w, h, d);
const rbox = (w: number, h: number, d: number, r = 0.012) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2.1, h / 2.1, d / 2.1));
function cylX(r: number, len: number, seg = 16) { return new T.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2); }
function cylZ(r: number, len: number, seg = 16) { return new T.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2); }
const v3 = (x: number, y: number, z: number) => new T.Vector3(x, y, z);
/** Marks a subtree as an effect so it does not count toward the model's framing bounds. */
function fx<O extends T.Object3D>(o: O): O { o.userData.fx = true; return o; }

/** Deterministic random numbers so a bed looks the same every time it is opened. */
export function seeded(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pipe route through corner points with rounded elbows. */
function pipePath(points: T.Vector3[], bend = 0.05) {
  const path = new T.CurvePath<T.Vector3>();
  let from = points[0].clone();
  for (let i = 1; i < points.length; i++) {
    const c = points[i];
    if (i === points.length - 1) { path.add(new T.LineCurve3(from, c.clone())); break; }
    const next = points[i + 1];
    const dIn = c.clone().sub(points[i - 1]).normalize(), dOut = next.clone().sub(c).normalize();
    const r = Math.min(bend, c.distanceTo(points[i - 1]) / 2, next.distanceTo(c) / 2);
    const p1 = c.clone().addScaledVector(dIn, -r), p2 = c.clone().addScaledVector(dOut, r);
    if (from.distanceTo(p1) > 1e-4) path.add(new T.LineCurve3(from, p1));
    path.add(new T.QuadraticBezierCurve3(p1, c.clone(), p2));
    from = p2;
  }
  return path;
}
/** A tube along a curve whose radius narrows from r0 to r1. */
function taperedTube(curve: T.Curve<T.Vector3>, segments: number, radial: number, r0: number, r1: number) {
  const geo = new T.TubeGeometry(curve, segments, 1, radial, false);
  const pos = geo.getAttribute("position") as T.BufferAttribute;
  const p = new T.Vector3(), c = new T.Vector3();
  for (let i = 0; i <= segments; i++) {
    curve.getPointAt(i / segments, c);
    const r = r0 + (r1 - r0) * (i / segments);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      p.fromBufferAttribute(pos, k).sub(c).multiplyScalar(r).add(c);
      pos.setXYZ(k, p.x, p.y, p.z);
    }
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- textures (shared, uploaded per renderer)

let glowTex: T.Texture | null = null;
let dotTex: T.Texture | null = null;
let speckleTex: T.Texture | null = null;
let stripeTex: T.Texture | null = null;
function canvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return [c, c.getContext("2d")] as const;
}
/** A soft round spot for glows, particles and light pools. */
export function glowTexture() {
  if (!glowTex) {
    const [c, g] = canvas(64, 64);
    if (g) {
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.35, "rgba(255,255,255,0.6)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    }
    glowTex = new T.CanvasTexture(c);
    glowTex.colorSpace = T.SRGBColorSpace;
  }
  return glowTex;
}
/** A crisp round dot for particles that must read at a few pixels: water, coolant. */
function dotTexture() {
  if (!dotTex) {
    const [c, g] = canvas(32, 32);
    if (g) {
      const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.6, "rgba(255,255,255,1)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 32, 32);
    }
    dotTex = new T.CanvasTexture(c);
    dotTex.colorSpace = T.SRGBColorSpace;
  }
  return dotTex;
}
/** Perlite: light granules over a mid-grey bed; the material colour carries moisture. */
function speckleTexture() {
  if (!speckleTex) {
    const [c, g] = canvas(256, 128);
    if (g) {
      const rand = seeded("perlite");
      g.fillStyle = "rgb(196,194,188)";
      g.fillRect(0, 0, 256, 128);
      for (let i = 0; i < 1700; i++) {
        const light = rand() > 0.16;
        const v = light ? 218 + Math.round(rand() * 37) : 128 + Math.round(rand() * 40);
        g.fillStyle = `rgb(${v},${v},${v - 4})`;
        g.beginPath();
        g.arc(rand() * 256, rand() * 128, 0.6 + rand() * (light ? 1.8 : 1.1), 0, Math.PI * 2);
        g.fill();
      }
    }
    speckleTex = new T.CanvasTexture(c);
    speckleTex.colorSpace = T.SRGBColorSpace;
    speckleTex.wrapS = speckleTex.wrapT = T.RepeatWrapping;
  }
  return speckleTex;
}
/** Shade screen: alternating reflective and open strips with a fine cross thread. */
function stripeTexture() {
  if (!stripeTex) {
    const [c, g] = canvas(64, 64);
    if (g) {
      for (let x = 0; x < 64; x += 16) {
        g.fillStyle = "rgb(222,222,214)"; g.fillRect(x, 0, 12, 64);
        g.fillStyle = "rgb(150,156,150)"; g.fillRect(x + 12, 0, 4, 64);
      }
      g.fillStyle = "rgba(90,96,92,0.22)";
      for (let y = 0; y < 64; y += 4) g.fillRect(0, y, 64, 1);
    }
    stripeTex = new T.CanvasTexture(c);
    stripeTex.colorSpace = T.SRGBColorSpace;
    stripeTex.wrapS = stripeTex.wrapT = T.RepeatWrapping;
  }
  return stripeTex;
}

// ---------------------------------------------------------------- particle flows

/** Particles that run along a pipe on the side facing the camera: coolant, water, return flow. */
function pathFlow(parent: T.Object3D, curve: T.Curve<T.Vector3>, n: number, color: T.Color, size: number, radius: number) {
  const geo = new T.BufferGeometry();
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 4), phase = new Float32Array(n), jit = new Float32Array(n);
  const rand = seeded(`path${n}${radius}`);
  for (let i = 0; i < n; i++) { phase[i] = i / n + rand() * 0.02; jit[i] = rand(); }
  geo.setAttribute("position", new T.BufferAttribute(pos, 3));
  geo.setAttribute("color", new T.BufferAttribute(col, 4));
  const pts = fx(new T.Points(geo, new T.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, map: dotTexture() })));
  pts.frustumCulled = false;
  pts.visible = false;
  parent.add(pts);
  const p = new T.Vector3(), toCam = new T.Vector3(), q = new T.Quaternion();
  return (active: boolean, speed: number, tick: Tick) => {
    pts.visible = active;
    if (!active) return;
    // The camera's view direction, in the parent's frame.
    tick.camera.getWorldDirection(toCam).negate();
    parent.getWorldQuaternion(q);
    toCam.applyQuaternion(q.invert());
    for (let i = 0; i < n; i++) {
      if (!tick.still) phase[i] = (phase[i] + tick.dt * speed * (0.9 + 0.2 * jit[i])) % 1;
      const u = phase[i];
      curve.getPointAt(u, p).addScaledVector(toCam, radius * 1.05);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      const a = Math.min(1, u * 8, (1 - u) * 8);
      col[i * 4] = color.r; col[i * 4 + 1] = color.g; col[i * 4 + 2] = color.b; col[i * 4 + 3] = a;
    }
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("color").needsUpdate = true;
  };
}
type StreakArea = { origin: T.Vector3; dir: T.Vector3; a: T.Vector3; b: T.Vector3; travel: number; length: number; disc?: boolean };
/** Thin ribbons that stream through an opening: air from a fan, a vent or a heater outlet. */
function streakFlow(parent: T.Object3D, n: number, width: number) {
  const geo = new T.BufferGeometry();
  const pos = new Float32Array(n * 12), col = new Float32Array(n * 16);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) { const k = i * 4; idx.push(k, k + 1, k + 2, k + 2, k + 1, k + 3); }
  geo.setIndex(idx);
  geo.setAttribute("position", new T.BufferAttribute(pos, 3));
  geo.setAttribute("color", new T.BufferAttribute(col, 4));
  const ribbons = fx(new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: T.DoubleSide })));
  ribbons.frustumCulled = false;
  ribbons.visible = false;
  parent.add(ribbons);
  const rand = seeded(`streak${n}`);
  const ra = new Float32Array(n), rb = new Float32Array(n), phase = new Float32Array(n);
  for (let i = 0; i < n; i++) { ra[i] = rand(); rb[i] = rand(); phase[i] = rand(); }
  const view = new T.Vector3(), side = new T.Vector3(), base = new T.Vector3(), head = new T.Vector3(), tail = new T.Vector3(), q = new T.Quaternion();
  return (active: boolean, area: StreakArea, density: number, speed: number, color: T.Color, tick: Tick) => {
    ribbons.visible = active && density > 0;
    if (!ribbons.visible) return;
    tick.camera.getWorldDirection(view);
    parent.getWorldQuaternion(q);
    view.applyQuaternion(q.invert());
    side.crossVectors(area.dir, view).normalize().multiplyScalar(width / 2);
    const shown = Math.max(1, Math.round(n * Math.min(1, density)));
    for (let i = 0; i < n; i++) {
      if (!tick.still) phase[i] = (phase[i] + tick.dt * speed * (0.75 + 0.5 * ra[i])) % 1;
      const u = phase[i];
      let sa = ra[i] * 2 - 1, sb = rb[i] * 2 - 1;
      if (area.disc) { const ang = ra[i] * Math.PI * 2, rad = Math.sqrt(rb[i]); sa = Math.cos(ang) * rad; sb = Math.sin(ang) * rad; }
      base.copy(area.origin).addScaledVector(area.a, sa).addScaledVector(area.b, sb);
      head.copy(base).addScaledVector(area.dir, u * area.travel);
      tail.copy(head).addScaledVector(area.dir, -area.length);
      const alpha = i < shown ? Math.sin(Math.PI * u) * 0.75 : 0;
      const verts = [[head, 1], [tail, 0]] as const;
      let k = i * 4;
      for (const [pt, fade] of verts) {
        for (const s of [1, -1]) {
          pos[k * 3] = pt.x + side.x * s; pos[k * 3 + 1] = pt.y + side.y * s; pos[k * 3 + 2] = pt.z + side.z * s;
          col[k * 4] = color.r; col[k * 4 + 1] = color.g; col[k * 4 + 2] = color.b; col[k * 4 + 3] = alpha * fade;
          k++;
        }
      }
    }
    geo.getAttribute("position").needsUpdate = true;
    geo.getAttribute("color").needsUpdate = true;
  };
}

// ---------------------------------------------------------------- status: plate ring, beacon and glows

type StatusState = "fault" | "attention" | "settling" | "on" | "off";
function statusColor(state: StatusState) {
  return state === "fault" ? STATUS.danger : state === "attention" ? STATUS.warn : state === "on" || state === "settling" ? STATUS.ok : STATUS.off;
}
function glowSprite(parent: T.Object3D, size: number, x = 0, y = 0, z = 0) {
  const s = fx(new T.Sprite(new T.SpriteMaterial({ map: glowTexture(), transparent: true, depthWrite: false, opacity: 0 })));
  s.scale.setScalar(size);
  s.position.set(x, y, z);
  parent.add(s);
  return s;
}
/** Blink level for a status light: fast hard blink for a fault, slow breathing for attention, a quick soft pulse while a change is applied, steady otherwise. */
function blink(state: StatusState | "danger", tick: Tick) {
  if (tick.still) return 1;
  if (state === "fault" || state === "danger") return (tick.clock * 2.6) % 1 < 0.55 ? 1 : 0.12;
  if (state === "attention") return 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(tick.clock * Math.PI * 2 * 0.7));
  if (state === "settling") return 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(tick.clock * Math.PI * 2 * 1.4));
  return 1;
}
function statusRig(parent: T.Object3D, fp: { x: number; z: number; w: number; d: number }, beaconAt: T.Vector3 | null) {
  const ringGeo = new T.RingGeometry(0.93, 1, 72).rotateX(-Math.PI / 2);
  const ringMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
  const pulseMat = ringMat.clone();
  const rx = fp.w / 2 + 0.14, rz = fp.d / 2 + 0.14;
  // Just above the plate's inset surface so the ring never fights it for depth.
  const ring = fx(mesh(parent, ringGeo, ringMat, fp.x, 0.011, fp.z, false));
  const pulse = fx(mesh(parent, ringGeo, pulseMat, fp.x, 0.012, fp.z, false));
  ring.renderOrder = pulse.renderOrder = 3;
  ring.scale.set(rx, 1, rz);
  let lamp: T.MeshStandardMaterial | null = null, halo: T.Sprite | null = null;
  if (beaconAt) {
    const b = group(parent, beaconAt.x, beaconAt.y, beaconAt.z);
    mesh(b, new T.CylinderGeometry(0.024, 0.028, 0.018, 16), mat("#343b39"), 0, 0.009, 0);
    lamp = mat("#59625f", { emissive: "#000000", roughness: 0.25, transparent: true, opacity: 0.92 });
    mesh(b, new T.SphereGeometry(0.021, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), lamp, 0, 0.018, 0, false);
    halo = glowSprite(b, 0.11, 0, 0.03, 0);
  }
  return (state: StatusState, tick: Tick) => {
    const c = statusColor(state);
    const alarm = state === "fault" || state === "attention" || state === "settling";
    ring.visible = pulse.visible = alarm;
    if (alarm) {
      ringMat.color.copy(c); pulseMat.color.copy(c);
      const rate = state === "fault" ? 0.95 : state === "settling" ? 0.8 : 0.5;
      const k = tick.still ? 0.45 : (tick.clock * rate) % 1;
      ringMat.opacity = tick.still ? 0.7 : 0.5 + 0.25 * Math.sin(tick.clock * Math.PI * 2 * rate);
      pulse.scale.set(rx * (1 + 0.35 * k), 1, rz * (1 + 0.35 * k));
      pulseMat.opacity = (state === "fault" ? 0.6 : 0.4) * (1 - k);
    }
    if (lamp && halo) {
      const level = state === "off" ? 0 : blink(state, tick);
      lamp.color.copy(state === "off" ? STATUS.off : c);
      lamp.emissive.copy(c);
      lamp.emissiveIntensity = state === "off" ? 0 : 0.25 + 1.5 * level;
      halo.material.color.copy(c);
      halo.material.opacity = state === "off" ? 0 : 0.2 + 0.55 * level;
    }
  };
}

// ---------------------------------------------------------------- shared parts

function bladeGeometry(r0: number, r1: number, w: number, pitch: number) {
  const s = new T.Shape();
  s.moveTo(r0, -w * 0.32);
  s.quadraticCurveTo((r0 + r1) / 2, -w * 0.7, r1, -w * 0.42);
  s.quadraticCurveTo(r1 + w * 0.14, 0, r1, w * 0.46);
  s.quadraticCurveTo((r0 + r1) / 2, w * 0.62, r0, w * 0.3);
  s.closePath();
  return new T.ShapeGeometry(s, 8).rotateX(pitch);
}
/** A round wire guard (concentric rings and spokes) facing +z. */
function fanGuard(parent: T.Object3D, x: number, y: number, z: number, R: number, rings: number, spokes: number, m: T.Material, wire = 0.0045) {
  const g = group(parent, x, y, z);
  for (let i = 1; i <= rings; i++) mesh(g, new T.TorusGeometry((R * i) / rings, wire, 6, 56), m, 0, 0, 0, false);
  const spoke = new T.CylinderGeometry(wire, wire, R * 0.86, 5);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * Math.PI * 2;
    const s = mesh(g, spoke, m, Math.cos(a) * R * 0.57, Math.sin(a) * R * 0.57, 0, false);
    s.rotation.z = a - Math.PI / 2;
  }
  mesh(g, cylZ(R * 0.13, wire * 3, 24), m, 0, 0, 0.002, false);
  return g;
}
/** A faint disc over spinning blades, so a running fan still reads as running with motion reduced. */
function blurDisc(parent: T.Object3D, R: number, color: T.ColorRepresentation, x: number, y: number, z: number) {
  const m = new T.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
  fx(mesh(parent, new T.RingGeometry(R * 0.2, R, 48), m, x, y, z, false));
  return m;
}
/** A rod stretched between two points each frame: vent actuators. */
function stretch(rod: T.Object3D, a: T.Vector3, b: T.Vector3) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  rod.position.copy(a).addScaledVector(dir, 0.5);
  rod.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
  rod.scale.set(1, Math.max(len, 0.001), 1);
}

// ---------------------------------------------------------------- devices

type DevState = { spec: DeviceInput; running: boolean; level: number; fault: boolean; state: StatusState };
type Built = {
  height: number;
  footprint: { x: number; z: number; w: number; d: number };
  beacon: T.Vector3 | null;
  update: (s: DevState, tick: Tick) => DeviceFlows;
};
type Kit = { palette: Palette; dim: (m: T.MeshStandardMaterial) => T.MeshStandardMaterial };
const upFlow = (color: T.Color, cx: number, cy: number, cz: number, sx: number, sz: number, h: number, speed: number): Flow =>
  ({ dir: "up", color, center: v3(cx, cy, cz), spread: [sx, sz], height: h, speed });

/** A short run of bed trough with perlite and two young plants, where a machine's line ends: the line leads to the beds, not into the air. */
function bedEnd(g: T.Group, k: Kit, x: number, z: number, alongX: boolean) {
  const trough = k.dim(mat("#d9ddd8", { roughness: 0.6 }));
  const perlite = k.dim(mat("#efece4", { roughness: 0.95 }));
  const leaf = k.dim(mat("#6f9b5e", { roughness: 0.7 }));
  const [w, d] = alongX ? [0.46, 0.3] : [0.3, 0.46];
  mesh(g, rbox(w, 0.12, d, 0.012), trough, x, 0.06, z);
  mesh(g, boxG(w - 0.05, 0.012, d - 0.05), perlite, x, 0.117, z, false);
  for (const o of [-0.1, 0.1]) mesh(g, new T.SphereGeometry(0.035, 12, 8), leaf, x + (alongX ? o : 0), 0.14, z + (alongX ? 0 : o));
}

function chiller(g: T.Group, k: Kit): Built {
  const body = k.dim(mat("#e3e7e4", { roughness: 0.48 }));
  const trim = k.dim(mat("#c2cac6", { roughness: 0.4, metalness: 0.25 }));
  const dark = k.dim(mat("#2c3331", { roughness: 0.75 }));
  const steel = k.dim(mat("#7b8683", { roughness: 0.38, metalness: 0.55 }));
  const wire = k.dim(mat("#3a4240", { roughness: 0.5, metalness: 0.4 }));
  const cx = -0.14, w = 0.86, h = 0.6, d = 0.5, y0 = 0.07, front = d / 2;
  for (const z of [-0.17, 0.17]) mesh(g, rbox(w + 0.08, 0.05, 0.07, 0.008), steel, cx, 0.025, z);
  for (const x of [cx - w / 2, cx + w / 2]) for (const z of [-0.17, 0.17]) mesh(g, new T.CylinderGeometry(0.028, 0.03, 0.012, 14), dark, x, 0.006, z);
  mesh(g, rbox(w, h, d, 0.028), body, cx, y0 + h / 2, 0);
  mesh(g, rbox(w + 0.03, 0.028, d + 0.03, 0.01), trim, cx, y0 + h + 0.012, 0);
  mesh(g, rbox(w + 0.02, 0.03, d + 0.02, 0.008), trim, cx, y0 + 0.012, 0);
  // Condenser fan on the front face.
  const fx0 = cx - 0.16, fy = y0 + 0.3, fz = front + 0.002, R = 0.2;
  mesh(g, new T.CircleGeometry(R + 0.005, 48), dark, fx0, fy, fz, false);
  mesh(g, new T.TorusGeometry(R + 0.005, 0.017, 10, 56), trim, fx0, fy, fz + 0.004);
  const rotor = group(g, fx0, fy, fz + 0.016);
  const bladeMat = k.dim(mat("#aab4b0", { metalness: 0.4, roughness: 0.32, side: T.DoubleSide }));
  const blade = bladeGeometry(0.03, R - 0.018, 0.13, 0.38);
  for (let i = 0; i < 4; i++) mesh(rotor, blade, bladeMat).rotation.z = (i * Math.PI) / 2;
  mesh(rotor, cylZ(0.036, 0.03, 20), dark);
  const blur = blurDisc(g, R - 0.01, "#aab4b0", fx0, fy, fz + 0.024);
  fanGuard(g, fx0, fy, fz + 0.034, R, 4, 8, wire);
  // Control panel with a status display strip.
  const px = cx + 0.24;
  mesh(g, rbox(0.22, 0.27, 0.014, 0.006), k.dim(mat("#d0d6d3", { roughness: 0.4 })), px, y0 + 0.36, front + 0.006);
  const lcd = mat("#26302d", { emissive: LCD, emissiveIntensity: 0, roughness: 0.2 });
  mesh(g, boxG(0.15, 0.045, 0.004), lcd, px, y0 + 0.44, front + 0.014, false);
  for (let i = 0; i < 3; i++) mesh(g, cylZ(0.011, 0.01, 12), dark, px - 0.05 + i * 0.05, y0 + 0.37, front + 0.016, false);
  mesh(g, boxG(0.12, 0.03, 0.003), k.dim(mat("#9aa4a0")), px, y0 + 0.29, front + 0.014, false);
  // Side louvres.
  const sx = cx + w / 2;
  for (let i = 0; i < 9; i++) {
    const l = mesh(g, boxG(0.012, 0.024, d - 0.1), trim, sx + 0.004, y0 + 0.1 + i * 0.05, 0, false);
    l.rotation.z = 0.5;
  }
  // Insulated supply (cold, blue) and return (warm, muted red) lines toward the beds.
  const supplyPath = pipePath([v3(sx, 0.2, 0.1), v3(sx + 0.16, 0.2, 0.1), v3(sx + 0.16, 0.09, 0.1), v3(sx + 0.66, 0.09, 0.1)], 0.06);
  const returnPts = [v3(sx, 0.36, -0.1), v3(sx + 0.26, 0.36, -0.1), v3(sx + 0.26, 0.09, -0.1), v3(sx + 0.66, 0.09, -0.1)];
  const returnPath = pipePath([...returnPts].reverse(), 0.06);
  const supplyMat = k.dim(mat("#56809f", { roughness: 0.92 }));
  const returnMat = k.dim(mat("#a3685f", { roughness: 0.55 }));
  mesh(g, new T.TubeGeometry(supplyPath, 48, 0.032, 12), supplyMat);
  mesh(g, new T.TubeGeometry(returnPath, 48, 0.025, 12), returnMat);
  for (const [z, r] of [[0.1, 0.032], [-0.1, 0.025]] as const) {
    const y = z > 0 ? 0.2 : 0.36;
    mesh(g, new T.TorusGeometry(r + 0.006, 0.009, 8, 20).rotateY(Math.PI / 2), steel, sx + 0.006, y, z);
    const vx = sx + 0.42;
    mesh(g, cylX(r + 0.013, 0.07, 16), k.dim(mat("#8a8674", { metalness: 0.5, roughness: 0.4 })), vx, 0.09, z);
    mesh(g, boxG(0.1, 0.012, 0.02), dark, vx, 0.09 + r + 0.03, z);
    mesh(g, cylZ(0.006, 0.02).rotateX(Math.PI / 2), dark, vx, 0.09 + r + 0.018, z);
  }
  // The chilled lines run into the beds' root zone.
  bedEnd(g, k, sx + 0.81, 0, false);
  const supplyFlow = pathFlow(g, supplyPath, 26, CHILL, 10, 0.032);
  const returnFlow = pathFlow(g, returnPath, 18, RETURN_WARM, 8, 0.025);
  // Faint cold vapour off the chilled supply line: soft blobs, not dust.
  const vapour = [0, 1, 2, 3, 4, 5].map((i) => ({ s: glowSprite(g, 0.12), off: i / 6, x: sx + 0.22 + (i % 3) * 0.16 }));
  return {
    height: 0.8,
    footprint: { x: cx, z: 0, w: w + 0.08, d },
    beacon: v3(cx + w / 2 - 0.08, y0 + h + 0.026, -d / 2 + 0.08),
    update: (s, tick) => {
      if (s.running && !tick.still) rotor.rotation.z -= tick.dt * 13;
      blur.opacity = s.running ? 0.24 : 0;
      lcd.emissive.copy(s.fault ? STATUS.danger : LCD);
      lcd.emissiveIntensity = s.spec.on ? 0.95 : 0.03;
      supplyFlow(s.running, 0.42, tick);
      returnFlow(s.running, 0.32, tick);
      for (const v of vapour) {
        const u = tick.still ? 0.35 + v.off * 0.5 : (tick.clock * 0.22 + v.off) % 1;
        v.s.position.set(v.x + Math.sin(u * 3 + v.off * 9) * 0.03, 0.12 + u * 0.2, 0.1);
        v.s.scale.setScalar(0.1 + u * 0.14);
        v.s.material.color.copy(k.palette.mist);
        v.s.material.opacity = s.running ? 0.42 * Math.sin(Math.PI * u) : 0;
      }
      return NONE;
    },
  };
}

function heater(g: T.Group, k: Kit): Built {
  const body = k.dim(mat("#d5dad6", { roughness: 0.46 }));
  const trim = k.dim(mat("#a8b2ae", { roughness: 0.36, metalness: 0.45 }));
  const dark = k.dim(mat("#2a302e", { roughness: 0.8 }));
  const steel = k.dim(mat("#838d8a", { roughness: 0.35, metalness: 0.6 }));
  const w = 0.8, h = 0.5, d = 0.38, y0 = 0.09, front = d / 2;
  for (const x of [-w / 2 + 0.06, w / 2 - 0.06]) for (const z of [-d / 2 + 0.06, d / 2 - 0.06]) mesh(g, boxG(0.045, y0, 0.045), dark, x, y0 / 2, z);
  mesh(g, rbox(w, h, d, 0.03), body, 0, y0 + h / 2, 0);
  mesh(g, rbox(w + 0.02, 0.03, d + 0.02, 0.008), trim, 0, y0 + 0.012, 0);
  // Outlet: a dark recess, the heating element, a warm glow and angled louvres.
  mesh(g, new T.PlaneGeometry(w - 0.16, h - 0.18), dark, 0, y0 + h / 2, front + 0.003, false);
  mesh(g, rbox(w - 0.12, h - 0.14, 0.02, 0.008).translate(0, 0, 0), trim, 0, y0 + h / 2, front - 0.006, false);
  const element = mat("#5a4a42", { emissive: "#e56f35", emissiveIntensity: 0, roughness: 0.4, metalness: 0.3 });
  const ey = [y0 + 0.14, y0 + 0.25, y0 + 0.36];
  const coil = pipePath([v3(-0.27, ey[0], front + 0.012), v3(0.27, ey[0], front + 0.012), v3(0.27, ey[1], front + 0.012), v3(-0.27, ey[1], front + 0.012), v3(-0.27, ey[2], front + 0.012), v3(0.27, ey[2], front + 0.012)], 0.05);
  mesh(g, new T.TubeGeometry(coil, 140, 0.011, 8), element, 0, 0, 0, false);
  const glowMat = new T.MeshBasicMaterial({ color: "#f08a4a", map: glowTexture(), transparent: true, opacity: 0, depthWrite: false });
  fx(mesh(g, new T.PlaneGeometry(w - 0.1, h - 0.1), glowMat, 0, y0 + h / 2, front + 0.02, false));
  for (let i = 0; i < 6; i++) {
    const l = mesh(g, boxG(w - 0.16, 0.006, 0.05), trim, 0, y0 + 0.11 + i * 0.058, front + 0.036, false);
    l.rotation.x = -0.55;
  }
  // Radiator fins on top.
  const fins = new T.InstancedMesh(boxG(0.006, 0.07, d - 0.08), trim, 16);
  for (let i = 0; i < 16; i++) fins.setMatrixAt(i, new T.Matrix4().makeTranslation(-w / 2 + 0.2 + i * 0.03, y0 + h + 0.035, 0));
  fins.castShadow = true;
  g.add(fins);
  for (const z of [-d / 2 + 0.035, d / 2 - 0.035]) mesh(g, boxG(0.5, 0.02, 0.02), trim, -w / 2 + 0.425, y0 + h + 0.01, z);
  // Side controls and a pilot lamp.
  mesh(g, rbox(0.014, 0.16, 0.14, 0.005), dark, w / 2 + 0.006, y0 + h * 0.62, 0.06);
  mesh(g, cylX(0.022, 0.022, 18), trim, w / 2 + 0.022, y0 + h * 0.62 + 0.035, 0.06);
  const pilot = mat("#5b4a40", { emissive: "#f0a060", emissiveIntensity: 0, roughness: 0.3 });
  mesh(g, new T.SphereGeometry(0.011, 12, 10), pilot, w / 2 + 0.016, y0 + h * 0.62 - 0.035, 0.06, false);
  // Flue with a rain cap.
  const fl = v3(-w / 2 + 0.11, y0 + h, -d / 2 + 0.1);
  mesh(g, new T.CylinderGeometry(0.038, 0.038, 0.3, 18), steel, fl.x, fl.y + 0.15, fl.z);
  mesh(g, new T.CylinderGeometry(0.004, 0.07, 0.04, 18), steel, fl.x, fl.y + 0.33, fl.z);
  mesh(g, new T.CylinderGeometry(0.045, 0.045, 0.02, 18), trim, fl.x, fl.y + 0.01, fl.z);
  // Heat haze: soft warm blobs that rise off the fins.
  const haze = [0, 1, 2].map((i) => {
    const m = new T.MeshBasicMaterial({ color: "#f3a472", map: glowTexture(), transparent: true, opacity: 0, depthWrite: false });
    const o = fx(mesh(g, new T.PlaneGeometry(0.34, 0.5), m, -0.12 + i * 0.16, y0 + h + 0.3, 0, false));
    return { o, m, off: i / 3 };
  });
  const streak = streakFlow(g, 26, 0.012);
  const outlet: StreakArea = { origin: v3(0, y0 + h / 2, front + 0.06), dir: v3(0, 0.18, 1).normalize(), a: v3(w / 2 - 0.12, 0, 0), b: v3(0, h / 2 - 0.12, 0), travel: 0.55, length: 0.14 };
  const rise = upFlow(WARM, -0.05, y0 + h + 0.08, 0, w / 2 - 0.16, d / 2 - 0.1, 0.55, 0.4);
  let glow = 0;
  return {
    height: 0.85,
    footprint: { x: 0, z: 0, w, d },
    beacon: v3(w / 2 - 0.07, y0 + h + 0.004, -d / 2 + 0.07),
    update: (s, tick) => {
      glow = tick.still ? (s.running ? 1 : 0) : T.MathUtils.lerp(glow, s.running ? 1 : 0, 0.08);
      element.emissiveIntensity = glow * 1.9;
      element.color.copy(glow > 0.5 ? ELEMENT_HOT : ELEMENT_COLD);
      glowMat.opacity = glow * 0.5;
      pilot.emissiveIntensity = s.running ? 1.4 : 0;
      for (const hz of haze) {
        const u = tick.still ? 0.4 + hz.off * 0.4 : (tick.clock * 0.35 + hz.off) % 1;
        hz.o.position.y = y0 + h + 0.12 + u * 0.42;
        hz.o.position.x = -0.12 + hz.off * 0.48 + Math.sin(tick.clock * 1.3 + hz.off * 5) * (tick.still ? 0 : 0.03);
        hz.o.scale.set(1 + u * 0.5, 1 + u * 0.3, 1);
        hz.m.opacity = s.running ? 0.22 * Math.sin(Math.PI * u) : 0;
      }
      streak(s.running, outlet, 1, 0.8, WARM, tick);
      return { air: s.running ? rise : null, root: null, drop: null };
    },
  };
}

function pump(g: T.Group, k: Kit): Built {
  const steel = k.dim(mat("#8e9895", { roughness: 0.38, metalness: 0.55 }));
  const motorMat = k.dim(mat("#4d655d", { roughness: 0.42, metalness: 0.28 }));
  const cast = k.dim(mat("#6d7f8d", { roughness: 0.5, metalness: 0.35 }));
  const dark = k.dim(mat("#2b3230", { roughness: 0.7 }));
  const pvc = k.dim(mat("#8fa0a8", { roughness: 0.45 }));
  mesh(g, rbox(0.82, 0.03, 0.32, 0.006), steel, 0, 0.015, 0);
  for (const x of [-0.37, 0.37]) for (const z of [-0.13, 0.13]) mesh(g, new T.CylinderGeometry(0.01, 0.01, 0.012, 8), dark, x, 0.036, z, false);
  const unit = group(g);
  const ax = 0.17;
  for (const x of [-0.24, -0.04]) mesh(unit, boxG(0.05, 0.06, 0.2), motorMat, x, 0.06, 0);
  mesh(unit, cylX(0.105, 0.34, 32), motorMat, -0.14, ax, 0);
  const ribs = new T.InstancedMesh(boxG(0.3, 0.014, 0.012), motorMat, 14);
  const e = new T.Euler(), q = new T.Quaternion(), one = new T.Vector3(1, 1, 1);
  for (let i = 0; i < 14; i++) {
    const t = (i / 14) * Math.PI * 2;
    e.set(t, 0, 0);
    ribs.setMatrixAt(i, new T.Matrix4().compose(v3(-0.14, ax + Math.sin(t) * 0.109, Math.cos(t) * 0.109), q.setFromEuler(e), one));
  }
  ribs.castShadow = true;
  unit.add(ribs);
  mesh(unit, cylX(0.1, 0.06, 32), dark, -0.34, ax, 0);
  mesh(unit, new T.TorusGeometry(0.06, 0.006, 6, 28).rotateY(Math.PI / 2), steel, -0.372, ax, 0, false);
  mesh(unit, rbox(0.1, 0.07, 0.11, 0.008), motorMat, -0.12, ax + 0.14, 0);
  // Coupling between motor and pump: its bolt heads make rotation visible.
  const coupling = group(unit, 0.07, ax, 0);
  mesh(coupling, cylX(0.046, 0.05, 20), dark);
  for (let i = 0; i < 4; i++) {
    const t = (i / 4) * Math.PI * 2;
    mesh(coupling, boxG(0.02, 0.018, 0.018), steel, 0, Math.sin(t) * 0.046, Math.cos(t) * 0.046, false);
  }
  mesh(unit, cylX(0.12, 0.1, 36), cast, 0.17, ax, 0);
  mesh(unit, new T.CylinderGeometry(0.045, 0.05, 0.08, 20), cast, 0.17, ax + 0.14, 0);
  mesh(unit, cylX(0.056, 0.02, 24), steel, 0.23, ax, 0);
  // Suction from the tank behind, discharge up through a filter toward the beds.
  const suction = pipePath([v3(0.24, ax, 0), v3(0.42, ax, 0), v3(0.42, ax, -0.3)], 0.06);
  const discharge = pipePath([v3(0.17, ax + 0.18, 0), v3(0.17, 0.56, 0), v3(0.5, 0.56, 0), v3(0.5, 0.1, 0), v3(0.5, 0.1, 0.3)], 0.06);
  mesh(g, new T.TubeGeometry(suction, 40, 0.03, 12), pvc);
  mesh(g, new T.TubeGeometry(discharge, 80, 0.026, 12), pvc);
  mesh(g, new T.CylinderGeometry(0.042, 0.042, 0.08, 16).rotateX(Math.PI / 2), steel, 0.42, ax, -0.28);
  // The discharge leaves the bench toward the beds through a coupling.
  mesh(g, cylZ(0.036, 0.05, 16), steel, 0.5, 0.1, 0.285);
  mesh(g, new T.TorusGeometry(0.038, 0.007, 8, 20), steel, 0.5, 0.1, 0.31);
  const filter = k.dim(mat("#5f7f8e", { roughness: 0.4 }));
  mesh(g, new T.CylinderGeometry(0.055, 0.055, 0.15, 24), filter, 0.5, 0.34, 0);
  mesh(g, new T.CylinderGeometry(0.06, 0.06, 0.025, 24), dark, 0.5, 0.425, 0);
  mesh(g, new T.CylinderGeometry(0.036, 0.036, 0.04, 16), steel, 0.5, 0.27, 0);
  // Pressure gauge on the riser: no numbers, the needle only rests or sits in its working arc.
  const gy = 0.44;
  mesh(g, cylZ(0.008, 0.05, 8), steel, 0.17, gy, 0.045);
  mesh(g, cylZ(0.04, 0.018, 28), dark, 0.17, gy, 0.078);
  mesh(g, new T.CircleGeometry(0.034, 28), mat("#f1f1ec", { roughness: 0.3 }), 0.17, gy, 0.0875, false);
  for (let i = 0; i < 7; i++) {
    const t = 2.3 - (i / 6) * 4.6;
    const tk = mesh(g, boxG(0.0025, 0.007, 0.001), dark, 0.17 + Math.sin(t) * -0.027, gy + Math.cos(t) * 0.027, 0.0885, false);
    tk.rotation.z = t;
  }
  const needle = group(g, 0.17, gy, 0.089);
  mesh(needle, boxG(0.003, 0.026, 0.002).translate(0, 0.011, 0), mat("#b8453a"), 0, 0, 0, false);
  mesh(g, cylZ(0.004, 0.004, 8), dark, 0.17, gy, 0.09, false);
  // Suction from the nutrient tank behind; the discharge runs to the beds' drip lines.
  mesh(g, new T.CylinderGeometry(0.13, 0.13, 0.36, 28), k.dim(mat("#6b8290", { roughness: 0.5 })), 0.42, 0.18, -0.43);
  mesh(g, new T.CylinderGeometry(0.135, 0.135, 0.02, 28), dark, 0.42, 0.37, -0.43);
  bedEnd(g, k, 0.5, 0.45, true);
  const out = pathFlow(g, discharge, 30, WATER, 10, 0.026);
  const inn = pathFlow(g, suction, 16, WATER, 10, 0.03);
  let angle = 2.3;
  return {
    height: 0.62,
    footprint: { x: 0, z: 0, w: 0.82, d: 0.32 },
    beacon: v3(-0.12, ax + 0.175, 0),
    update: (s, tick) => {
      const move = s.running && !tick.still;
      unit.position.y = move ? Math.sin(tick.clock * 90) * 0.0022 : 0;
      unit.position.z = move ? Math.cos(tick.clock * 77) * 0.0015 : 0;
      if (move) coupling.rotation.x += tick.dt * 18;
      const target = s.running ? 0.35 : 2.3;
      angle = tick.still ? target : T.MathUtils.lerp(angle, target, 0.06);
      needle.rotation.z = angle + (move ? Math.sin(tick.clock * 23) * 0.02 : 0);
      out(s.running, 0.55, tick);
      inn(s.running, 0.5, tick);
      return NONE;
    },
  };
}

function fan(g: T.Group, k: Kit): Built {
  const frame = k.dim(mat("#c0c8c4", { roughness: 0.38, metalness: 0.4, side: T.DoubleSide }));
  const inner = k.dim(mat("#a8b1ad", { roughness: 0.42, metalness: 0.35, side: T.DoubleSide }));
  const dark = k.dim(mat("#2f3634", { roughness: 0.7 }));
  const wire = k.dim(mat("#3b4341", { roughness: 0.45, metalness: 0.45 }));
  const S = 0.95, cy = 0.53, D = 0.3, R = 0.43;
  const plate = new T.Shape();
  plate.moveTo(-S / 2, -S / 2); plate.lineTo(S / 2, -S / 2); plate.lineTo(S / 2, S / 2); plate.lineTo(-S / 2, S / 2); plate.closePath();
  const hole = new T.Path(); hole.absarc(0, 0, R, 0, Math.PI * 2, true); plate.holes.push(hole);
  const plateGeo = new T.ShapeGeometry(plate, 48);
  mesh(g, plateGeo, frame, 0, cy, D / 2);
  mesh(g, plateGeo, frame, 0, cy, -D / 2);
  for (const [w, hh, x, y] of [[S, 0.02, 0, S / 2 - 0.01], [S, 0.02, 0, -S / 2 + 0.01], [0.02, S, S / 2 - 0.01, 0], [0.02, S, -S / 2 + 0.01, 0]] as const)
    mesh(g, boxG(w, hh, D), frame, x, cy + y, 0);
  mesh(g, new T.CylinderGeometry(R, R, D, 56, 1, true).rotateX(Math.PI / 2), inner, 0, cy, 0);
  for (const x of [-1, 1]) for (const y of [-1, 1]) mesh(g, cylZ(0.012, 0.01, 10), dark, x * (S / 2 - 0.05), cy + y * (S / 2 - 0.05), D / 2 + 0.005, false);
  for (const x of [-0.34, 0.34]) mesh(g, rbox(0.07, 0.05, 0.44, 0.008), dark, x, 0.025, 0);
  // Motor behind the hub, held by struts.
  mesh(g, cylZ(0.085, 0.16, 24), dark, 0, cy, -0.08);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    const s = mesh(g, boxG(0.014, R - 0.05, 0.014), inner, Math.cos(a) * (R / 2 + 0.02), cy + Math.sin(a) * (R / 2 + 0.02), -0.1, false);
    s.rotation.z = a - Math.PI / 2;
  }
  const rotor = group(g, 0, cy, 0.03);
  const bladeMat = k.dim(mat("#d1d8d5", { metalness: 0.35, roughness: 0.3, side: T.DoubleSide }));
  const blade = bladeGeometry(0.06, R - 0.03, 0.22, 0.42);
  for (let i = 0; i < 5; i++) mesh(rotor, blade, bladeMat).rotation.z = (i / 5) * Math.PI * 2;
  mesh(rotor, cylZ(0.066, 0.07, 24), dark);
  mesh(rotor, new T.SphereGeometry(0.066, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), wire, 0, 0, 0.035);
  const blur = blurDisc(g, R - 0.03, "#d1d8d5", 0, cy, 0.075);
  fanGuard(g, 0, cy, D / 2 + 0.012, R, 5, 12, wire);
  const streak = streakFlow(g, 40, 0.013);
  const area: StreakArea = { origin: v3(0, cy, D / 2 + 0.05), dir: v3(0, 0, 1), a: v3(R * 0.8, 0, 0), b: v3(0, R * 0.8, 0), travel: 1.1, length: 0.2, disc: true };
  return {
    height: 1.0,
    footprint: { x: 0, z: 0, w: S, d: 0.44 },
    beacon: v3(S / 2 - 0.06, cy + S / 2, D / 2 - 0.05),
    update: (s, tick) => {
      if (s.running && !tick.still) rotor.rotation.z -= tick.dt * (2 + 16 * s.level);
      blur.opacity = s.running ? 0.1 + 0.22 * s.level : 0;
      streak(s.running, area, 0.3 + 0.7 * s.level, 0.3 + 1.1 * s.level, k.palette.air, tick);
      return NONE;
    },
  };
}

function vent(g: T.Group, k: Kit, side: boolean): Built {
  const alu = k.dim(mat("#b9c1bd", { roughness: 0.35, metalness: 0.5 }));
  const dark = k.dim(mat("#2f3634", { roughness: 0.7 }));
  const glass = k.dim(mat("#cfe0e4", { roughness: 0.08, metalness: 0, transparent: true, opacity: 0.32, depthWrite: false, side: T.DoubleSide }));
  const rod = group(g);
  mesh(rod, new T.CylinderGeometry(0.008, 0.008, 1, 10).translate(0, 0, 0), k.dim(mat("#9aa4a0", { metalness: 0.6, roughness: 0.3 })));
  const hinge = new T.Group();
  const attach = new T.Vector3(), fixed = new T.Vector3();
  const streak = streakFlow(g, 30, 0.012);
  let area: StreakArea;
  let maxAngle: number;
  if (!side) {
    // A roof segment: posts, a pitched frame and a sash hinged at the ridge.
    const ridgeY = 0.78, eaveY = 0.46, run = 0.72;
    const slope = Math.atan2(ridgeY - eaveY, run);
    for (const x of [-0.63, 0.63]) {
      mesh(g, boxG(0.04, eaveY, 0.04), alu, x, eaveY / 2, run / 2);
      mesh(g, boxG(0.04, ridgeY, 0.04), alu, x, ridgeY / 2, -run / 2);
    }
    mesh(g, boxG(1.3, 0.03, 0.03), alu, 0, 0.3, run / 2);
    const roof = group(g, 0, ridgeY, -run / 2);
    roof.rotation.x = slope;
    const L = Math.hypot(run, ridgeY - eaveY);
    for (const x of [-0.63, 0.63]) mesh(roof, boxG(0.045, 0.045, L), alu, x, 0, L / 2);
    mesh(roof, boxG(1.3, 0.055, 0.055), alu, 0, 0.005, 0);
    mesh(roof, boxG(1.3, 0.04, 0.04), alu, 0, 0, L);
    hinge.position.set(0, 0.03, 0);
    roof.add(hinge);
    for (const x of [-0.59, 0.59]) mesh(hinge, boxG(0.03, 0.028, L - 0.04), alu, x, 0, L / 2);
    mesh(hinge, boxG(1.21, 0.028, 0.03), alu, 0, 0, 0.02);
    mesh(hinge, boxG(1.21, 0.03, 0.035), alu, 0, 0, L - 0.035);
    mesh(hinge, boxG(0.02, 0.02, L - 0.06), alu, 0, 0.002, L / 2);
    mesh(hinge, boxG(1.16, 0.005, L - 0.08), glass, 0, 0, L / 2, false);
    attach.set(0, -0.015, L - 0.04);
    mesh(g, rbox(0.1, 0.07, 0.07, 0.01), dark, 0, 0.3, run / 2);
    fixed.set(0, 0.3, run / 2 - 0.02);
    area = { origin: v3(0, 0.62, 0), dir: v3(0, 1, -0.3).normalize(), a: v3(0.5, 0, 0), b: v3(0, 0.04, 0.18), travel: 0.62, length: 0.16 };
    maxAngle = 0.95;
  } else {
    // A wall section: posts, sill and header, a fixed lower pane and an upper sash hinged at the top.
    for (const x of [-0.65, 0.65]) mesh(g, boxG(0.05, 1.0, 0.05), alu, x, 0.5, 0);
    mesh(g, boxG(1.36, 0.05, 0.09), alu, 0, 0.025, 0);
    mesh(g, boxG(1.36, 0.05, 0.06), alu, 0, 1.0, 0);
    mesh(g, boxG(1.3, 0.04, 0.05), alu, 0, 0.47, 0);
    mesh(g, boxG(1.25, 0.4, 0.006), glass, 0, 0.26, 0, false);
    hinge.position.set(0, 0.97, 0.03);
    g.add(hinge);
    for (const x of [-0.6, 0.6]) mesh(hinge, boxG(0.03, 0.47, 0.03), alu, x, -0.245, 0);
    mesh(hinge, boxG(1.23, 0.03, 0.03), alu, 0, -0.015, 0);
    mesh(hinge, boxG(1.23, 0.035, 0.035), alu, 0, -0.475, 0);
    mesh(hinge, boxG(1.18, 0.44, 0.005), glass, 0, -0.245, 0, false);
    attach.set(0.42, -0.47, 0.02);
    mesh(g, rbox(0.07, 0.1, 0.07, 0.01), dark, 0.58, 0.32, 0.06);
    fixed.set(0.56, 0.36, 0.08);
    area = { origin: v3(0, 0.72, 0.62), dir: v3(0, -0.12, -1).normalize(), a: v3(0.5, 0, 0), b: v3(0, 0.15, 0), travel: 0.95, length: 0.18 };
    maxAngle = 0.9;
  }
  const sleeve = group(g);
  mesh(sleeve, new T.CylinderGeometry(0.016, 0.016, 1, 12), dark);
  const a = new T.Vector3();
  let open = 0;
  return {
    height: 0.9,
    footprint: side ? { x: 0, z: 0, w: 1.36, d: 0.3 } : { x: 0, z: 0, w: 1.3, d: 0.78 },
    beacon: side ? v3(0.58, 1.025, 0) : v3(0.63, 0.8, -0.36),
    update: (s, tick) => {
      const target = s.level;
      open = tick.still ? target : T.MathUtils.lerp(open, target, 0.08);
      hinge.rotation.x = -open * maxAngle;
      g.updateMatrixWorld(true);
      a.copy(attach).applyMatrix4(hinge.matrixWorld);
      g.worldToLocal(a);
      stretch(rod, fixed, a);
      const dir = a.clone().sub(fixed).normalize();
      stretch(sleeve, fixed, fixed.clone().addScaledVector(dir, 0.16));
      streak(open > 0.02 && !s.fault, area, open, 0.35 + 0.5 * open, k.palette.air, tick);
      return NONE;
    },
  };
}

function shade(g: T.Group, k: Kit): Built {
  const alu = k.dim(mat("#b9c1bd", { roughness: 0.35, metalness: 0.5 }));
  const dark = k.dim(mat("#3c4442", { roughness: 0.6, metalness: 0.2 }));
  const top = 1.02, W = 1.3;
  for (const x of [-W / 2 - 0.05, W / 2 + 0.05]) {
    mesh(g, boxG(0.035, top + 0.05, 0.05), alu, x, (top + 0.05) / 2, 0);
    mesh(g, rbox(0.05, 0.02, 0.2, 0.004), dark, x, 0.01, 0);
  }
  const roller = group(g, 0, top, 0);
  const tube = mesh(roller, cylX(1, W + 0.04, 28), dark);
  for (let i = 0; i < 3; i++) mesh(roller, boxG(W, 0.004, 0.004), alu, 0, 0, 1, false).userData.seam = i;
  mesh(g, cylX(0.045, 0.1, 20), dark, W / 2 + 0.11, top, 0);
  mesh(g, rbox(0.08, 0.1, 0.09, 0.01), dark, W / 2 + 0.2, top, 0);
  const tex = stripeTexture().clone();
  tex.needsUpdate = true;
  const cloth = k.dim(mat("#ffffff", { map: tex, roughness: 0.7, metalness: 0.2, side: T.DoubleSide, transparent: true, opacity: 0.96 }));
  const sheet = mesh(g, new T.PlaneGeometry(W - 0.02, 1).translate(0, -0.5, 0), cloth, 0, top, 0.05);
  const hem = mesh(g, rbox(W + 0.01, 0.026, 0.03, 0.006), alu, 0, top, 0.05);
  let open = -1;
  let spin = 0;
  return {
    // Framing height (the camera fits it): a little under the real 1.1 so the thin frame fills the stage.
    height: 0.88,
    footprint: { x: 0, z: 0, w: W + 0.1, d: 0.2 },
    beacon: v3(W / 2 + 0.2, top + 0.05, 0),
    update: (s, tick) => {
      const target = s.level;
      const prev = open < 0 ? target : open;
      open = tick.still || open < 0 ? target : T.MathUtils.lerp(open, target, 0.06);
      const len = 0.1 + open * 0.8;
      const r = 0.04 + 0.03 * (1 - open);
      tube.scale.set(1, r, r);
      roller.children.forEach((c) => { if (c.userData.seam !== undefined) { const t = spin + (c.userData.seam as number) * 2.1; c.position.set(0, Math.sin(t) * r, Math.cos(t) * r); } });
      // The roller turns as cloth leaves it: arc length over radius.
      spin -= ((open - prev) * 0.8) / r;
      sheet.position.z = r;
      sheet.scale.y = len;
      tex.repeat.set(4, len * 6);
      hem.position.set(0, top - len, r);
      return NONE;
    },
  };
}

function sensor(g: T.Group, k: Kit): { built: Built; led: (state: StatusState | "danger", tick: Tick) => void } {
  const galv = k.dim(mat("#a9b2ae", { roughness: 0.35, metalness: 0.55 }));
  const white = k.dim(mat("#eff1ed", { roughness: 0.55, side: T.DoubleSide }));
  const dark = k.dim(mat("#2f3634", { roughness: 0.7 }));
  mesh(g, new T.CylinderGeometry(0.14, 0.15, 0.03, 28), dark, 0, 0.015, 0);
  mesh(g, new T.CylinderGeometry(0.018, 0.018, 1.0, 14), galv, 0, 0.53, 0);
  // Radiation shield: stacked louvred plates on an arm, a dark core showing between them.
  const sx = 0.17, top = 0.9;
  mesh(g, cylX(0.01, sx, 10), galv, sx / 2, top + 0.02, 0);
  mesh(g, new T.CylinderGeometry(0.034, 0.034, 0.22, 14), dark, sx, top - 0.09, 0);
  const gill = new T.CylinderGeometry(0.05, 0.095, 0.022, 32, 1, true);
  for (let i = 0; i < 7; i++) mesh(g, gill, white, sx, top - 0.18 + i * 0.033, 0);
  mesh(g, new T.CylinderGeometry(0.1, 0.1, 0.012, 32), white, sx, top + 0.05, 0);
  for (let i = 0; i < 3; i++) {
    const t = (i / 3) * Math.PI * 2 + 0.5;
    mesh(g, new T.CylinderGeometry(0.004, 0.004, 0.25, 6), galv, sx + Math.cos(t) * 0.075, top - 0.07, Math.sin(t) * 0.075, false);
  }
  // Transmitter with antenna, display and status LED.
  const by = 0.5;
  mesh(g, rbox(0.13, 0.17, 0.07, 0.012), k.dim(mat("#d9dedb", { roughness: 0.45 })), 0, by, 0.05);
  mesh(g, boxG(0.132, 0.008, 0.072), k.dim(mat("#b7bfbb")), 0, by + 0.05, 0.05, false);
  mesh(g, new T.CylinderGeometry(0.004, 0.005, 0.2, 8), dark, 0.05, by + 0.18, 0.05);
  mesh(g, new T.SphereGeometry(0.008, 10, 8), dark, 0.05, by + 0.28, 0.05, false);
  const lcd = mat("#25302d", { emissive: LCD, emissiveIntensity: 0.5, roughness: 0.2 });
  mesh(g, boxG(0.085, 0.035, 0.003), lcd, 0, by + 0.012, 0.0865, false);
  const ledMat = mat("#59625f", { emissive: "#000000", roughness: 0.25 });
  mesh(g, new T.SphereGeometry(0.011, 14, 10), ledMat, 0.038, by + 0.058 - 0.02, 0.087, false);
  const halo = glowSprite(g, 0.08, 0.038, by + 0.038, 0.095);
  const cable = pipePath([v3(sx, top - 0.18, 0), v3(sx, by + 0.1, 0.02), v3(0.04, by + 0.1, 0.05)], 0.05);
  mesh(g, new T.TubeGeometry(cable, 30, 0.005, 6), dark, 0, 0, 0, false);
  for (const y of [by - 0.06, by + 0.06]) mesh(g, new T.TorusGeometry(0.022, 0.005, 6, 16).rotateX(Math.PI / 2), galv, 0, y, 0, false);
  return {
    built: { height: 0.92, footprint: { x: 0.05, z: 0, w: 0.34, d: 0.3 }, beacon: null, update: () => NONE },
    led: (state, tick) => {
      const c = state === "danger" ? STATUS.danger : statusColor(state === "off" ? "on" : state);
      const level = blink(state, tick);
      ledMat.color.copy(c);
      ledMat.emissive.copy(c);
      ledMat.emissiveIntensity = 0.25 + 1.6 * level;
      halo.material.color.copy(c);
      halo.material.opacity = 0.2 + 0.6 * level;
      lcd.emissive.copy(state === "fault" ? STATUS.danger : LCD);
    },
  };
}

function boundsOf(root: T.Object3D) {
  const box = new T.Box3(), part = new T.Box3();
  root.updateMatrixWorld(true);
  const walk = (o: T.Object3D) => {
    if (o.userData.fx) return;
    if (o instanceof T.Mesh) {
      if (o instanceof T.InstancedMesh) { o.computeBoundingBox(); part.copy(o.boundingBox!).applyMatrix4(o.matrixWorld); }
      else { if (!o.geometry.boundingBox) o.geometry.computeBoundingBox(); part.copy(o.geometry.boundingBox!).applyMatrix4(o.matrixWorld); }
      box.union(part);
    }
    o.children.forEach(walk);
  };
  walk(root);
  return box;
}

/** Builds one device alone on the workbench. y = 0 is the plate top. */
export function buildDevice(target: string | null, palette: Palette): DeviceModel {
  const g = new T.Group();
  const dimmed: T.MeshStandardMaterial[] = [];
  const kit: Kit = { palette, dim: (m) => { m.userData.base = m.color.clone(); dimmed.push(m); return m; } };
  let built: Built;
  let led: ((state: StatusState | "danger", tick: Tick) => void) | null = null;
  switch (target) {
    case "root_zone_chiller": built = chiller(g, kit); break;
    case "heater": built = heater(g, kit); break;
    case "irrigation_pump": built = pump(g, kit); break;
    case "ventilation_fan": built = fan(g, kit); break;
    case "roof_vent": built = vent(g, kit, false); break;
    case "side_vent": built = vent(g, kit, true); break;
    case "shade_curtain": built = shade(g, kit); break;
    default: { const s = sensor(g, kit); built = s.built; led = s.led; }
  }
  // Centre the device on the bench so the existing camera flight frames it evenly.
  const raw = boundsOf(g);
  const c = raw.getCenter(new T.Vector3());
  g.position.set(-c.x, 0, -c.z);
  const bounds = raw.translate(new T.Vector3(-c.x, 0, -c.z));
  const status = statusRig(g, built.footprint, built.beacon);
  let dim = 1;
  return {
    group: g,
    height: built.height,
    bounds,
    update: (spec, tick) => {
      const fault = spec.health === "fault";
      const state: StatusState = fault ? "fault" : spec.health === "suspect" || spec.tone === "attention" || spec.progress === "differs" ? "attention" : spec.progress === "settling" ? "settling" : spec.on ? "on" : "off";
      const level = Math.max(0, Math.min(1, (spec.percent ?? (spec.on ? 100 : 0)) / 100));
      const s: DevState = { spec, running: spec.on && !fault, level, fault, state };
      // A sensor has no on and off: it is always reporting, so it never dims.
      const want = led || spec.on ? 1 : 0.86;
      if (want !== dim) { dim = want; dimmed.forEach((m) => m.color.copy(m.userData.base as T.Color).multiplyScalar(dim)); }
      status(led && state === "off" ? "on" : state, tick);
      led?.(state, tick);
      return built.update(s, tick);
    },
  };
}

// ---------------------------------------------------------------- workbench plate

/** The plate under a single bed or device: bevelled slab, a thin groove and an inset work surface. */
export function buildWorkbench(parent: T.Object3D) {
  const g = group(parent);
  const base = mat("#343b38", { roughness: 0.85 });
  const groove = mat("#2a302d", { roughness: 0.9 });
  const inset = mat("#3a413e", { roughness: 0.8 });
  const slab = mesh(g, boxG(1, 1, 1), base, 0, 0, 0, false);
  const band = mesh(g, boxG(1, 1, 1), groove, 0, 0, 0, false);
  const top = mesh(g, boxG(1, 1, 1), inset, 0, 0, 0, false);
  let w = 0, d = 0;
  const TOP = 0.06;
  return {
    group: g,
    fit(width: number, depth: number, cx: number, cz: number) {
      g.position.set(cx, 0, cz);
      if (Math.abs(width - w) < 0.001 && Math.abs(depth - d) < 0.001) return;
      w = width; d = depth;
      for (const o of [slab, band, top]) o.geometry.dispose();
      slab.geometry = new RoundedBoxGeometry(w, 0.16, d, 3, 0.035);
      slab.position.y = TOP - 0.08;
      band.geometry = new RoundedBoxGeometry(w - 0.16, 0.004, d - 0.16, 2, 0.002);
      band.position.y = TOP + 0.001;
      top.geometry = new RoundedBoxGeometry(w - 0.19, 0.006, d - 0.19, 2, 0.003);
      top.position.y = TOP + 0.002;
    },
    setColor(color: T.Color) {
      base.color.copy(color).multiplyScalar(0.92);
      groove.color.copy(color).multiplyScalar(0.78);
      inset.color.copy(color).multiplyScalar(0.97);
    },
  };
}

// ---------------------------------------------------------------- the single bed

export type BedTray = { tier: number; min: T.Vector3; max: T.Vector3 };
/** One plant position from the source model: the group (for shown/growth flags), its base pivot and unscaled size. */
export type BedSlot = { tier: number; source: T.Object3D; pivot: T.Vector3; size: T.Vector3 };
export type BedLook = { lamp: number; wet: number; plantTone: Tone; fan: number; pump: boolean; fades: number[] };
export type BedDetail = {
  bedId: string;
  group: T.Group;
  /** One group per tier (index tier - 1), tagged with userData.tier so FarmMap fades it with the rack. */
  tiers: T.Group[];
  pickables: T.Object3D[];
  trays: BedTray[];
  syncPlants: () => void;
  update: (look: BedLook, tick: Tick) => void;
};

const LEAF_BASE = new T.Color("#4c8c42"), LEAF_VEIN = new T.Color("#93c476"), LEAF_EDGE = new T.Color("#2c5f28");
const LEAF_ATTENTION = new T.Color("#c9b24a"), LEAF_DANGER = new T.Color("#8a5a2b");
const PERLITE_DRY = new T.Color("#d9d4c6"), PERLITE_WET = new T.Color("#8d8574");
const GRAIN_DRY = new T.Color("#f3f1ea"), GRAIN_WET = new T.Color("#cfcabd");
const LAMP_OFF = new T.Color("#59625f"), LAMP_ON = new T.Color("#fff3d6");

/**
 * A reniform wasabi leaf: a polar grid around the petiole joint, so the veins
 * radiate from it as they do on the plant. Blade length 1 along +x, cupped.
 * aEdge (0 at the joint, 1 at the margin) lets a tint yellow the edges first.
 */
function wasabiLeafGeometry() {
  const NT = 24, NR = 5, tmax = 2.55;
  const pos: number[] = [], col: number[] = [], edge: number[] = [], idx: number[] = [];
  const c = new T.Color();
  pos.push(0, 0, 0); edge.push(0);
  c.copy(LEAF_BASE).lerp(LEAF_VEIN, 0.5); col.push(c.r, c.g, c.b);
  for (let r = 1; r <= NR; r++) {
    const rho = r / NR;
    for (let j = 0; j <= NT; j++) {
      const t = -tmax + (2 * tmax * j) / NT;
      const R = (1 - 0.34 * Math.pow(Math.abs(t) / tmax, 2.4)) * (1 + 0.02 * Math.sin(t * 22) * rho);
      const x = rho * R * Math.cos(t), z = rho * R * Math.sin(t);
      const y = 0.16 * Math.pow(rho * R, 2) * (1 + 0.35 * Math.abs(t) / tmax) + 0.025 * Math.sin(t * 6) * rho * rho;
      pos.push(x, y, z);
      edge.push(rho * rho);
      const vein = j % 4 === 0 && j !== 0 && j !== NT;
      c.copy(LEAF_BASE);
      if (vein) c.lerp(LEAF_VEIN, 0.6 * (1 - rho * 0.55));
      if (rho < 0.25) c.lerp(LEAF_VEIN, 0.35);
      c.lerp(LEAF_EDGE, Math.pow(rho, 3) * 0.65);
      col.push(c.r, c.g, c.b);
    }
  }
  const ring = (r: number, j: number) => 1 + (r - 1) * (NT + 1) + j;
  for (let j = 0; j < NT; j++) idx.push(0, ring(1, j + 1), ring(1, j));
  for (let r = 1; r < NR; r++)
    for (let j = 0; j < NT; j++) {
      const a = ring(r, j), b = ring(r, j + 1), c2 = ring(r + 1, j), d = ring(r + 1, j + 1);
      idx.push(a, b, c2, b, d, c2);
    }
  const geo = new T.BufferGeometry();
  geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
  geo.setAttribute("color", new T.Float32BufferAttribute(col, 3));
  geo.setAttribute("aEdge", new T.Float32BufferAttribute(edge, 1));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
function leafMaterial() {
  const m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0, side: T.DoubleSide });
  const uniforms = { uTint: { value: new T.Color() }, uTintAmt: { value: 0 } };
  m.userData.leaf = uniforms;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTint = uniforms.uTint;
    shader.uniforms.uTintAmt = uniforms.uTintAmt;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aEdge;\nvarying float vEdge;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEdge = aEdge;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uTint;\nuniform float uTintAmt;\nvarying float vEdge;")
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, uTint, clamp(uTintAmt * (0.25 + 0.95 * vEdge), 0.0, 1.0));");
  };
  m.customProgramCacheKey = () => "wasabi-leaf-v1";
  return m;
}
type LeafPlan = { phi: number; d: number; h: number; pitch: number; roll: number; s: number; sway: number; shade: number };
function plantPlan(D: number, H: number, rand: () => number) {
  const n = Math.max(3, Math.min(11, Math.round(2 + D * 22)));
  const leaves: LeafPlan[] = [];
  const start = rand() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = i / (n - 1);
    leaves.push({
      phi: start + i * 2.39996 + (rand() - 0.5) * 0.3,
      d: D * (0.27 - 0.13 * a),
      h: H * (0.5 + 0.38 * a) * (0.92 + rand() * 0.16),
      pitch: -0.28 + 0.62 * a + (rand() - 0.5) * 0.12,
      roll: (rand() - 0.5) * 0.3,
      s: D * (0.25 - 0.08 * a) * (0.9 + rand() * 0.2),
      sway: rand() * Math.PI * 2,
      shade: 0.84 + 0.3 * a + (rand() - 0.5) * 0.08,
    });
  }
  return { leaves, crownR: D * 0.055 + 0.004, crownH: H * (H > 0.2 ? 0.22 : 0.12) };
}

/** Builds the detailed single-bed dressing: substrate, drip lines, LED bars and wasabi plants for every tier. */
export function buildBedDetail(bedId: string, trays: BedTray[], slots: BedSlot[]): BedDetail {
  const root = new T.Group();
  const rand = seeded(bedId);
  const leafGeo = wasabiLeafGeometry();
  const petioleGeo = taperedTube(new T.QuadraticBezierCurve3(v3(0, 0, 0), v3(0.08, 0.82, 0), v3(1, 1, 0)), 10, 5, 0.05, 0.022);
  const crownGeo = new T.CylinderGeometry(0.72, 1, 1, 9).translate(0, 0.5, 0);
  const grainGeo = new T.IcosahedronGeometry(1, 0);
  const emitterGeo = rbox(0.022, 0.012, 0.016, 0.004);
  const stakeGeo = new T.CylinderGeometry(0.0022, 0.0022, 1, 5).translate(0, -0.5, 0);
  const wetGeo = new T.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  const tiers: T.Group[] = [];
  const pickables: T.Object3D[] = [];
  type TierParts = {
    tier: number; top: number; slab: T.MeshStandardMaterial; grain: T.MeshStandardMaterial; led: T.MeshStandardMaterial;
    pool: T.MeshBasicMaterial; beam: T.MeshBasicMaterial; wet: T.MeshBasicMaterial; leafMat: T.MeshStandardMaterial;
    leaves: T.InstancedMesh; petioles: T.InstancedMesh; crowns: T.InstancedMesh;
    plants: { slot: BedSlot; plan: ReturnType<typeof plantPlan> }[]; emitters: T.Vector3[];
    lineFlows: ((active: boolean, speed: number, tick: Tick) => void)[];
  };
  const parts: TierParts[] = [];
  const m4 = new T.Matrix4(), q = new T.Quaternion(), e = new T.Euler(), p = new T.Vector3(), sc = new T.Vector3(), c = new T.Color();
  for (const tray of trays) {
    const tg = new T.Group();
    tg.userData.tier = tray.tier;
    root.add(tg);
    tiers[tray.tier - 1] = tg;
    const cx = (tray.min.x + tray.max.x) / 2, cz = (tray.min.z + tray.max.z) / 2;
    const W = tray.max.x - tray.min.x - 0.02, Dp = tray.max.z - tray.min.z - 0.02;
    const top = tray.max.y + 0.02;
    const selection = { bedId, tier: tray.tier };
    // Substrate: a perlite bed whose colour carries the moisture reading, with granules on top.
    const slabMat = mat(PERLITE_DRY, { map: speckleTexture(), roughness: 0.95, metalness: 0 });
    const slab = mesh(tg, boxG(W, 0.04, Dp), slabMat, cx, top - 0.02, cz, false);
    slab.userData.selection = selection;
    pickables.push(slab);
    // The growing gutter that holds the perlite: a low dark rim.
    const rimMat = mat("#3b4240", { roughness: 0.7 });
    const rh = 0.055, rt = 0.012, ry = top - 0.04 + rh / 2;
    for (const s of [-1, 1]) {
      mesh(tg, boxG(W + rt * 2, rh, rt), rimMat, cx, ry, cz + s * (Dp / 2 + rt / 2), false);
      mesh(tg, boxG(rt, rh, Dp), rimMat, cx + s * (W / 2 + rt / 2), ry, cz, false);
    }
    const grainMat = mat(GRAIN_DRY, { roughness: 0.9, metalness: 0, flatShading: true });
    const GRAINS = 240;
    const grains = new T.InstancedMesh(grainGeo, grainMat, GRAINS);
    for (let i = 0; i < GRAINS; i++) {
      const r = 0.006 + rand() * 0.008;
      e.set(rand() * 6, rand() * 6, rand() * 6);
      m4.compose(p.set(cx + (rand() - 0.5) * (W - 0.03), top + r * 0.25, cz + (rand() - 0.5) * (Dp - 0.03)), q.setFromEuler(e), sc.set(r, r * 0.8, r));
      grains.setMatrixAt(i, m4);
      grains.setColorAt(i, c.setScalar(0.86 + rand() * 0.16));
    }
    grains.userData.noShadow = true;
    grains.receiveShadow = true;
    grains.frustumCulled = false;
    tg.add(grains);
    // Drip irrigation: two lines along the plant rows, an emitter and a stake at every plant.
    const tierSlots = slots.filter((s) => s.tier === tray.tier);
    const dripMat = mat("#2c3331", { roughness: 0.55 });
    const rows = [cz - 0.1, cz + 0.1];
    // The lines ride on small clips just above the perlite so the drips are seen landing.
    const dy = top + 0.045;
    for (const z of rows) mesh(tg, cylX(0.0055, W - 0.05, 8), dripMat, cx, dy, z, false);
    // While the pump runs, water visibly moves along both lines (the drippers themselves sit under the leaves).
    const lineFlows = rows.map((z) => pathFlow(tg, new T.LineCurve3(v3(cx - W / 2 + 0.03, dy, z), v3(cx + W / 2 - 0.03, dy, z)), 12, WATER, 8, 0.0055));
    mesh(tg, cylZ(0.0075, 0.22, 8), dripMat, tray.min.x + 0.035, dy, cz, false);
    mesh(tg, cylX(0.0075, 0.08, 8), dripMat, tray.min.x - 0.005, dy, cz, false);
    const emitters: T.Vector3[] = [];
    const emitterMesh = new T.InstancedMesh(emitterGeo, dripMat, Math.max(1, tierSlots.length));
    const stakes = new T.InstancedMesh(stakeGeo, dripMat, Math.max(1, tierSlots.length));
    const wetMat = new T.MeshBasicMaterial({ color: "#3a342b", map: glowTexture(), transparent: true, opacity: 0.12, depthWrite: false });
    wetMat.userData.selfFade = true;
    const wetSpots = new T.InstancedMesh(wetGeo, wetMat, Math.max(1, tierSlots.length));
    wetSpots.userData.selfFade = true;
    tierSlots.forEach((slot, i) => {
      const z = slot.pivot.z < cz ? rows[0] : rows[1];
      const ex = slot.pivot.x + 0.05;
      m4.makeTranslation(ex, dy, z);
      emitterMesh.setMatrixAt(i, m4);
      // Stake from the emitter down into the substrate beside the crown.
      const tip = v3(slot.pivot.x + 0.035, top - 0.01, slot.pivot.z + (z < slot.pivot.z ? -0.02 : 0.02));
      const from = v3(ex, dy, z);
      const dir = tip.clone().sub(from);
      q.setFromUnitVectors(v3(0, -1, 0), dir.clone().normalize());
      m4.compose(from, q, sc.set(1, dir.length(), 1));
      stakes.setMatrixAt(i, m4);
      m4.compose(p.set(ex, top + 0.004, z), q.identity(), sc.set(0.05, 1, 0.05));
      wetSpots.setMatrixAt(i, m4);
      emitters.push(v3(ex, dy - 0.008, z));
    });
    emitterMesh.count = stakes.count = wetSpots.count = tierSlots.length;
    for (const o of [emitterMesh, stakes, wetSpots]) { o.frustumCulled = false; o.userData.noShadow = true; tg.add(o); }
    // LED grow-light bars under the lamp hood of the source rack (its underside sits 0.259 above the tray),
    // a diffuser lip on the hood's front edge that shows from above, a faint light volume and a pool of light.
    const hoodY = tray.max.y + 0.259, hoodD = 0.42;
    const ledY = hoodY - 0.01;
    const alu = mat("#c7cdca", { roughness: 0.35, metalness: 0.55 });
    const ledMat = mat(LAMP_OFF, { emissive: "#fff0c8", emissiveIntensity: 0, roughness: 0.3 });
    for (const z of [cz - 0.1, cz + 0.1]) {
      mesh(tg, rbox(W - 0.1, 0.014, 0.036, 0.005), alu, cx, ledY, z, false);
      mesh(tg, boxG(W - 0.12, 0.004, 0.024), ledMat, cx, ledY - 0.008, z, false);
      for (const x of [cx - (W - 0.1) / 2, cx + (W - 0.1) / 2]) mesh(tg, boxG(0.012, 0.018, 0.04), mat("#3b4341"), x, ledY, z, false);
    }
    mesh(tg, boxG(W - 0.02, 0.009, 0.008), ledMat, cx, hoodY - 0.004, cz + hoodD / 2 + 0.004, false);
    const beamGeo = new T.BufferGeometry();
    {
      const t = hoodY - 0.02, b = top + 0.012, tw = (W - 0.08) / 2, td = hoodD / 2 - 0.02, bw = W / 2 - 0.02, bd = Dp / 2 - 0.03;
      const corners = [[-tw, t, -td], [tw, t, -td], [tw, t, td], [-tw, t, td], [-bw, b, -bd], [bw, b, -bd], [bw, b, bd], [-bw, b, bd]];
      beamGeo.setAttribute("position", new T.Float32BufferAttribute(corners.flatMap(([x, y, z]) => [cx + x, y, cz + z]), 3));
      beamGeo.setAttribute("color", new T.Float32BufferAttribute(corners.flatMap((_, i) => [1, 1, 1, i < 4 ? 1 : 0.15]), 4));
      beamGeo.setIndex([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]);
    }
    const beamMat = new T.MeshBasicMaterial({ color: "#fff1cf", vertexColors: true, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
    const beam = mesh(tg, beamGeo, beamMat, 0, 0, 0, false);
    beam.userData.selfFade = true;
    const poolMat = new T.MeshBasicMaterial({ color: "#ffe6a6", map: glowTexture(), transparent: true, opacity: 0, depthWrite: false });
    const pool = mesh(tg, new T.PlaneGeometry(W - 0.08, Dp - 0.04).rotateX(-Math.PI / 2), poolMat, cx, top + 0.006, cz, false);
    pool.userData.selfFade = true;
    // Plants: instanced leaves, petioles and crowns, one set per tier.
    const leafMat = leafMaterial();
    const plants = tierSlots.map((slot) => ({ slot, plan: plantPlan(Math.max(slot.size.x, slot.size.z), slot.size.y, rand) }));
    const cap = Math.max(1, plants.reduce((n, pl) => n + pl.plan.leaves.length, 0));
    const leaves = new T.InstancedMesh(leafGeo, leafMat, cap);
    const petioles = new T.InstancedMesh(petioleGeo, mat("#79a24e", { roughness: 0.55 }), cap);
    const crowns = new T.InstancedMesh(crownGeo, mat("#a9bf7c", { roughness: 0.7 }), Math.max(1, plants.length));
    for (const o of [leaves, petioles, crowns]) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; o.count = 0; tg.add(o); }
    leaves.userData.selection = selection;
    pickables.push(leaves);
    parts.push({ tier: tray.tier, top, slab: slabMat, grain: grainMat, led: ledMat, pool: poolMat, beam: beamMat, wet: wetMat, leafMat, leaves, petioles, crowns, plants, emitters, lineFlows });
  }
  root.userData.bedId = bedId;

  // Drops from each emitter while the pump runs.
  const DROPS = Math.max(1, parts.reduce((n, t) => n + t.emitters.length, 0));
  const dropGeo = new T.BufferGeometry();
  const dropPos = new Float32Array(DROPS * 3), dropCol = new Float32Array(DROPS * 4), dropPhase = new Float32Array(DROPS);
  for (let i = 0; i < DROPS; i++) dropPhase[i] = rand();
  dropGeo.setAttribute("position", new T.BufferAttribute(dropPos, 3));
  dropGeo.setAttribute("color", new T.BufferAttribute(dropCol, 4));
  const drops = new T.Points(dropGeo, new T.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, map: dotTexture() }));
  drops.frustumCulled = false;
  drops.visible = false;
  root.add(drops);

  let swayed = false;
  function writePlants(t: TierParts, clock: number, sway: number) {
    let li = 0, ci = 0;
    for (const { slot, plan } of t.plants) {
      if (!slot.source.userData.shown) continue;
      const f = (slot.source.userData.growth as number | undefined) ?? 1;
      const pv = slot.pivot;
      m4.compose(pv, q.identity(), sc.set(plan.crownR * f, plan.crownH * f, plan.crownR * f));
      t.crowns.setMatrixAt(ci++, m4);
      const cb = plan.crownH * 0.8;
      for (const leaf of plan.leaves) {
        const dx = Math.cos(leaf.phi), dz = Math.sin(leaf.phi);
        e.set(0, -leaf.phi, 0);
        m4.compose(p.set(pv.x, pv.y + cb * f, pv.z), q.setFromEuler(e), sc.set(leaf.d * f, Math.max(0.001, (leaf.h - cb) * f), ((leaf.d + leaf.h) / 2) * f));
        t.petioles.setMatrixAt(li, m4);
        t.petioles.setColorAt(li, c.setScalar(leaf.shade));
        const w = sway ? Math.sin(clock * 1.7 + leaf.sway) * 0.08 * sway : 0;
        const wr = sway ? Math.cos(clock * 1.3 + leaf.sway) * 0.06 * sway : 0;
        e.set(leaf.roll + wr, -leaf.phi, leaf.pitch + w, "YZX");
        m4.compose(p.set(pv.x + dx * leaf.d * f, pv.y + leaf.h * f, pv.z + dz * leaf.d * f), q.setFromEuler(e), sc.setScalar(leaf.s * f));
        t.leaves.setMatrixAt(li, m4);
        t.leaves.setColorAt(li, c.setScalar(leaf.shade));
        li++;
      }
    }
    t.leaves.count = t.petioles.count = li;
    t.crowns.count = ci;
    for (const o of [t.leaves, t.petioles, t.crowns]) {
      o.instanceMatrix.needsUpdate = true;
      if (o.instanceColor) o.instanceColor.needsUpdate = true;
    }
  }
  return {
    bedId,
    group: root,
    tiers,
    pickables,
    trays,
    syncPlants: () => parts.forEach((t) => writePlants(t, 0, 0)),
    update: (look, tick) => {
      const sway = look.fan > 0 && !tick.still ? look.fan : 0;
      let di = 0;
      for (const t of parts) {
        const fade = look.fades[t.tier - 1] ?? 1;
        t.slab.color.copy(PERLITE_DRY).lerp(PERLITE_WET, look.wet);
        t.grain.color.copy(GRAIN_DRY).lerp(GRAIN_WET, look.wet * 0.7);
        t.led.color.copy(LAMP_OFF).lerp(LAMP_ON, look.lamp);
        t.led.emissiveIntensity = T.MathUtils.lerp(t.led.emissiveIntensity, look.lamp * 1.7, tick.still ? 1 : 0.1);
        t.pool.opacity = 0.2 * look.lamp * fade;
        t.beam.opacity = 0.09 * look.lamp * fade;
        const u = look.plantTone === "danger" ? 0.62 : look.plantTone === "attention" ? 0.5 : 0;
        const uni = t.leafMat.userData.leaf as { uTint: { value: T.Color }; uTintAmt: { value: number } };
        uni.uTint.value.copy(look.plantTone === "danger" ? LEAF_DANGER : LEAF_ATTENTION);
        uni.uTintAmt.value = u;
        // Wet spots darken and spread a little while water drips.
        const wetPulse = look.pump ? (tick.still ? 0.8 : 0.65 + 0.35 * Math.sin(tick.clock * 2.4)) : 0;
        t.wet.opacity = (0.12 + 0.6 * wetPulse) * fade;
        if (sway) writePlants(t, tick.clock, sway);
        for (const flow of t.lineFlows) flow(look.pump && fade > 0.9, 0.3, tick);
        for (const em of t.emitters) {
          const i = di++;
          const show = look.pump && fade > 0.9;
          if (!tick.still && show) dropPhase[i] = (dropPhase[i] + tick.dt * 0.9) % 1;
          const k = dropPhase[i];
          dropPos[i * 3] = em.x; dropPos[i * 3 + 1] = em.y - k * (em.y - 0.004 - (t.top)); dropPos[i * 3 + 2] = em.z;
          dropCol[i * 4] = WATER.r; dropCol[i * 4 + 1] = WATER.g; dropCol[i * 4 + 2] = WATER.b;
          dropCol[i * 4 + 3] = show ? Math.min(1, (1 - k) * 2.2) : 0;
        }
      }
      if (swayed && !sway) parts.forEach((t) => writePlants(t, 0, 0));
      swayed = !!sway;
      drops.visible = look.pump;
      dropGeo.getAttribute("position").needsUpdate = true;
      dropGeo.getAttribute("color").needsUpdate = true;
    },
  };
}

// ---------------------------------------------------------------- the bed's sensor probe

/** A substrate probe wired to a transmitter clipped on the rack post, with a status LED. Origin: the chosen tray top. */
export function buildProbe(parent: T.Object3D) {
  const g = group(parent);
  const steel = mat("#9aa4a0", { roughness: 0.35, metalness: 0.6 });
  const dark = mat("#2f3634", { roughness: 0.7 });
  const px = 0.74, pz = -0.3;
  mesh(g, new T.CylinderGeometry(0.0035, 0.0035, 0.12, 8), steel, px - 0.008, -0.02, pz);
  mesh(g, new T.CylinderGeometry(0.0035, 0.0035, 0.12, 8), steel, px + 0.008, -0.02, pz);
  mesh(g, rbox(0.034, 0.03, 0.02, 0.005), dark, px, 0.052, pz);
  const cable = pipePath([v3(px, 0.066, pz), v3(px, 0.13, pz), v3(0.85, 0.16, -0.4)], 0.04);
  mesh(g, new T.TubeGeometry(cable, 20, 0.0028, 6), dark, 0, 0, 0, false);
  const bx = 0.855, by = 0.22, bz = -0.4;
  mesh(g, rbox(0.03, 0.022, 0.03, 0.004), dark, bx + 0.03, by, bz - 0.03);
  mesh(g, rbox(0.075, 0.11, 0.036, 0.008), mat("#dfe3e0", { roughness: 0.45 }), bx, by, bz);
  mesh(g, boxG(0.05, 0.018, 0.002), mat("#b9c1bd"), bx, by - 0.03, bz + 0.019, false);
  mesh(g, new T.CylinderGeometry(0.003, 0.004, 0.08, 8), dark, bx + 0.025, by + 0.095, bz);
  const ledMat = mat("#59625f", { emissive: "#000000", roughness: 0.25 });
  const ledAt = v3(bx - 0.015, by + 0.03, bz + 0.02);
  mesh(g, new T.SphereGeometry(0.0085, 14, 10), ledMat, ledAt.x, ledAt.y, ledAt.z, false);
  const halo = glowSprite(g, 0.07, ledAt.x, ledAt.y, ledAt.z + 0.005);
  const ringMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
  const ring = mesh(g, new T.RingGeometry(0.013, 0.017, 36), ringMat, ledAt.x, ledAt.y, ledAt.z + 0.006, false);
  return {
    group: g,
    /** Where the LED sits, relative to the tray top: the sensor chip points here. */
    ledAt,
    update(tone: Tone | null, tick: Tick) {
      const c = tone === "danger" ? STATUS.danger : tone === "attention" ? STATUS.warn : tone === "ok" ? STATUS.ok : STATUS.off;
      const level = tone ? blink(tone === "danger" ? "danger" : tone === "attention" ? "attention" : "on", tick) : 0;
      ledMat.color.copy(c);
      ledMat.emissive.copy(c);
      ledMat.emissiveIntensity = tone ? 0.25 + 1.6 * level : 0;
      halo.material.color.copy(c);
      halo.material.opacity = tone ? 0.18 + 0.6 * level : 0;
      ring.visible = tone === "danger";
      if (ring.visible) {
        ringMat.color.copy(c);
        const k = tick.still ? 0.45 : (tick.clock * 1.1) % 1;
        ring.scale.setScalar(1 + 2.8 * k);
        ringMat.opacity = 0.8 * (1 - k);
        ring.quaternion.copy(tick.camera.quaternion);
      }
    },
  };
}

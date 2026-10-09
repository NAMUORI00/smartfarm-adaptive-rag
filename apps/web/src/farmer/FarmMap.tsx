import { assetUrl } from "./asset-url";
import { useEffect, useRef, useState } from "react";
import * as T from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import mapping from "./model-map.json";
import type { FarmLayout, FarmSelection, CropCycle } from "../farm-spatial";
import {
  cycleAt,
  activePlantFraction,
} from "../farm-spatial";
import { FarmIcon } from "./FarmIcon";
import { L } from "./i18n";
import type { Cue, StageCues } from "./stage-cues";
import {
  buildBedDetail,
  buildDevice,
  buildProbe,
  buildWorkbench,
  glowTexture,
  type BedDetail,
  type BedSlot,
  type BedTray,
  type DeviceModel,
  type Flow,
  type Palette,
  type Tick,
} from "./farm-models";

/** One device on the workbench, drawn from its own report. */
export type DeviceSpec = {
  key: string;
  target: string | null;
  label: string;
  on: boolean;
  percent: number | null;
  tone: "ok" | "attention";
  /** fault: the device reports a fault or is offline; suspect: its own reading is not trusted. */
  health?: "ok" | "fault" | "suspect";
  /** A change still being applied, or an output that stays away from the request (device-progress.ts). */
  progress?: "settling" | "differs" | null;
};

type Props = {
  layout: FarmLayout;
  selection: FarmSelection | null;
  selectedZoneId?: string | null;
  alertZoneIds?: string[];
  cycles: CropCycle[];
  /** Plant scale per crop cycle (growth-display.ts): observation, else days against the harvest date or the guides. */
  plantScales?: Record<string, number>;
  focus: boolean;
  compact?: boolean;
  /** Live cues for the chosen bed: tints, lamps, flows and callouts. */
  cues?: StageCues | null;
  /** A device alone on the workbench instead of a bed. */
  device?: DeviceSpec | null;
  /** The person picked a tier on the single bed: move in to that tier and fade the others. */
  tierFocus?: boolean;
  /** False when live readings stopped: motion freezes and the model greys out. */
  live?: boolean;
  onSelect: (s: FarmSelection) => void;
  onCue?: (cue: Cue) => void;
  onEquipment: () => void;
  onFallback: () => void;
};

// Where each callout points on the bed, relative to the chosen tier's tray.
const CUE_OFFSETS: Record<Cue["part"], [number, number, number]> = {
  air: [0.15, 0.62, 0],
  root: [-0.6, -0.02, 0.5],
  substrate: [0.55, 0.02, 0.5],
  lamp: [-0.3, 0.24, 0.12],
  // The transmitter's status LED on the rack post (see buildProbe).
  sensor: [0.84, 0.25, -0.38],
  plants: [0.4, 0.24, -0.2],
  device: [-0.85, 0.5, -0.3],
};

// Flow colours: warm air, cool air, chilled root water, drops. Neutral air and mist follow the stage (see palette).
const FLOW = {
  warm: new T.Color("#ff9a4a"),
  warmSoft: new T.Color("#ffb87a"),
  cool: new T.Color("#8ac6ff"),
  chill: new T.Color("#6fb8ff"),
  rootHot: new T.Color("#ff7a55"),
  drop: new T.Color("#5fa8ff"),
};

type FlowSystem = { pts: T.Points; pos: Float32Array; col: Float32Array; a: Float32Array; b: Float32Array; phase: Float32Array; n: number };

// A readable clock-based illustration, not calculated sunrise or farm light telemetry.
export function farmLightingAt(now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const time = hour + minute / 60;
  const daylight = Math.max(0, Math.min(1, (time - 6) / 2, (19 - time) / 2));
  return { daylight, label: lightingName(daylight) };
}
/** The lighting mode name for a daylight level, in the current language. */
function lightingName(daylight: number) {
  return daylight === 1 ? L("낮 표현", "daytime lighting") : daylight === 0 ? L("밤 표현", "night lighting") : L("아침·저녁 표현", "dawn and dusk lighting");
}
/** The canvas label; set from the lighting loop and again on every render so a language change reaches it. */
function mapLabel(daylight: number) {
  const label = lightingName(daylight);
  return L(`농장 3D 지도, 한국 시각 기준 ${label}. 구역 목록으로도 선택할 수 있습니다`, `Farm 3D map, ${label} by Korea time. You can also choose from the zone list`);
}
const loadingText = () => L("농장 공간을 불러오는 중…", "Loading the farm space…");
const failureText = () => L("3D 공간을 불러오지 못했습니다. 구역 목록에서 계속할 수 있습니다.", "The 3D view could not be loaded. You can continue from the zone list.");
// Single-bed work view: only the chosen bed stays on stage; the whole farm is the other mode.
function workBeds(p: Props) {
  const bed = p.selection ? p.layout.beds.find((b) => b.id === p.selection?.bedId) : undefined;
  return bed ? [bed] : [];
}
export function FarmMap(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    current = useRef(props),
    cueRefs = useRef(new Map<string, HTMLButtonElement>());
  current.current = props;
  const [load, setLoad] = useState(loadingText),
    [attempt, setAttempt] = useState(0),
    [failed, setFailed] = useState(false);
  // The daylight level, not its name, so the name follows a language change.
  const [daylightLevel, setDaylightLevel] = useState(() => farmLightingAt(new Date()).daylight);
  useEffect(() => {
    host.current?.querySelector("canvas")?.setAttribute("aria-label", mapLabel(daylightLevel));
  });
  useEffect(() => {
    const el = host.current!;
    let disposed = false,
      frame = 0;
    let renderer: T.WebGLRenderer;
    const fail = () => {
      if (!disposed) {
        setLoad(failureText());
        setFailed(true);
      }
    };
    try {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      fail();
      return;
    }
    setFailed(false);
    setLoad(loadingText());
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.03;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      "aria-label",
      L("농장 3D 지도. 구역 목록으로도 선택할 수 있습니다", "Farm 3D map. You can also choose from the zone list"),
    );
    const scene = new T.Scene();
    scene.background = new T.Color("#e8ede2");
    const camera = new T.OrthographicCamera(-18, 18, 13, -13, 0.1, 140);
    camera.position.set(19, 19, 29);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.6, 1.4);
    controls.enableDamping = true;
    controls.enablePan = true;
    controls.minZoom = 0.55;
    controls.maxZoom = 8;
    controls.minPolarAngle = 0.23;
    controls.maxPolarAngle = Math.PI * 0.45;
    const ambient = new T.HemisphereLight("#f7fff4", "#9aa78b", 2);
    scene.add(ambient);
    const sun = new T.DirectionalLight("#fff4dd", 2.7);
    sun.position.set(-9, 20, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, {
      left: -24,
      right: 24,
      top: 24,
      bottom: -24,
    });
    sun.shadow.bias = -0.001;
    scene.add(sun);
    const fill = new T.DirectionalLight("#e0eaff", 1);
    fill.position.set(12, 8, -6);
    scene.add(fill);
    const structural: T.Object3D[] = [];
    function box(
      w: number,
      h: number,
      d: number,
      x: number,
      y: number,
      z: number,
      color: string,
    ) {
      const m = new T.Mesh(
        new T.BoxGeometry(w, h, d),
        new T.MeshStandardMaterial({ color, roughness: 0.85 }),
      );
      m.position.set(x, y, z);
      m.receiveShadow = true;
      scene.add(m);
      return m;
    }
    const ground = box(65, 0.08, 48, 0, -0.17, 0, "#9aaa80");
    let lightingMinute = -1;
    let lightingSingle = false;
    const nightBackground = new T.Color("#293d4b"), dayBackground = new T.Color("#e8ede2");
    // The single-bed workbench sits on a dark stage; the clock still drives the lamps.
    const stageBackground = new T.Color("#1b1f1e");
    const nightSky = new T.Color("#d4e7f4"), daySky = new T.Color("#f7fff4");
    const nightGround = new T.Color("#738792"), dayGround = new T.Color("#9aaa80");
    const nightSun = new T.Color("#d1e6ff"), daySun = new T.Color("#fff4dd");
    // The workbench background is the page's own stage token, so the canvas matches it in both themes.
    let stageToken = "";
    let tokenFrame = 0;
    let plateToken = "";
    // Neutral air and mist must read on the stage: darker on the light theme, lighter on the dark one.
    const palette: Palette = { air: new T.Color("#7f949c"), mist: new T.Color("#93b2c6") };
    let daylightNow = 1;
    function syncStageToken() {
      const token = getComputedStyle(el).getPropertyValue("--stage").trim();
      if (token && token !== stageToken) {
        stageToken = token;
        try { stageBackground.set(token); } catch { /* keep the default */ }
        const dark = stageBackground.getHSL({ h: 0, s: 0, l: 0 }).l < 0.4;
        palette.air.set(dark ? "#c9d4d0" : "#7f949c");
        palette.mist.set(dark ? "#cfe1f0" : "#8fb0c6");
        lightingMinute = -1;
      }
      // The plate under a single bed follows the theme too; it is built after the
      // first lighting pass, so keep trying until it exists.
      const plateColor = getComputedStyle(el).getPropertyValue("--stage-fill-2").trim();
      if (plateColor && plateColor !== plateToken) {
        try { plate.setColor(new T.Color(plateColor)); plateToken = plateColor; } catch { /* not built yet */ }
      }
    }
    function updateLighting(single = false) {
      if (tokenFrame++ % 30 === 0) syncStageToken();
      const now = new Date();
      const minute = Math.floor(now.getTime() / 60000);
      if (minute === lightingMinute && single === lightingSingle) return;
      lightingMinute = minute;
      lightingSingle = single;
      const { daylight, label } = farmLightingAt(now);
      daylightNow = daylight;
      if (single) (scene.background as T.Color).copy(stageBackground);
      else (scene.background as T.Color).copy(nightBackground).lerp(dayBackground, daylight);
      ambient.color.copy(nightSky).lerp(daySky, daylight);
      ambient.intensity = 1.6 + daylight * 0.4;
      ground.material.color.copy(nightGround).lerp(dayGround, daylight);
      sun.color.copy(nightSun).lerp(daySun, daylight);
      sun.intensity = 0.45 + daylight * 2.25;
      // Keep every tier legible at night; this is display fill, not a device command.
      fill.intensity = 1.65 - daylight * 0.65;
      renderer.toneMappingExposure = 1.08 - daylight * 0.05;
      el.dataset.lighting = label;
      renderer.domElement.setAttribute("aria-label", mapLabel(daylight));
      setDaylightLevel(daylight);
    }
    updateLighting();
    box(22, 0.09, 15, 0, 0, 0, "#dcdfd2");
    box(3, 0.08, 15, 12.3, 0, 0, "#c7d0bd");
    box(27, 0.04, 3.5, 0, -0.07, 9.3, "#d4c9ad");
    for (const z of [-2.25, 2.25]) box(20, 0.012, 1.75, 0, 0.056, z, "#ecebdf");
    for (const x of [-10.5, 10.5])
      for (const z of [-7, 0, 7])
        structural.push(box(0.07, 3.8, 0.07, x, 1.95, z, "#bdc8b7"));
    for (const z of [-7, 0, 7])
      structural.push(box(21, 0.07, 0.07, 0, 3.85, z, "#c6cebe"));
    for (const x of [-10.5, 0, 10.5])
      structural.push(box(0.06, 0.07, 14, x, 3.85, 0, "#c6cebe"));
    // Scenery follows the prototype; only registered rack geometry is operational.
    for (const [x, z] of [
      [-14, -10],
      [-8, -11],
      [0, -11],
      [8, -11],
      [16, -7],
      [17, 1],
      [-16, 4],
    ]) {
      const trunk = new T.Mesh(
        new T.CylinderGeometry(0.13, 0.18, 1.4, 7),
        new T.MeshStandardMaterial({ color: "#8c795a" }),
      );
      trunk.position.set(x, 0.7, z);
      scene.add(trunk);
      for (const [dx, y, dz, r] of [
        [0, 2, 0, 0.85],
        [-0.4, 1.8, 0.15, 0.6],
        [0.35, 1.9, -0.1, 0.7],
      ]) {
        const m = new T.Mesh(
          new T.IcosahedronGeometry(r, 1),
          new T.MeshStandardMaterial({ color: "#8ba46e", roughness: 1 }),
        );
        m.position.set(x + dx, y, z + dz);
        scene.add(m);
      }
    }
    box(3.5, 2.2, 2.5, -8.7, 1.1, 10.2, "#e3d8bc");
    box(3.85, 0.14, 2.8, -8.7, 2.25, 10.2, "#7f9175");
    box(1.3, 1.8, 0.025, -8.7, 0.91, 11.47, "#b2a17c");
    const scenery = scene.children.filter(o => !(o instanceof T.Light) && o !== ground);
    // Workbench plate: a shade lighter than the stage, barely wider than the bed; bevelled with an inset work surface.
    const plate = buildWorkbench(scene);
    plate.group.visible = false;
    // The sun follows the bench in the single views so leaf and part shadows stay crisp.
    scene.add(sun.target);
    function frameShadow(bounds: T.Box3 | null) {
      const cam = sun.shadow.camera;
      if (bounds && !bounds.isEmpty()) {
        const c = bounds.getCenter(new T.Vector3());
        const r = Math.max(1.4, bounds.getSize(new T.Vector3()).length() * 0.62);
        sun.target.position.copy(c);
        sun.position.copy(c).add(new T.Vector3(-9, 20, 12));
        Object.assign(cam, { left: -r, right: r, top: r, bottom: -r });
        sun.shadow.bias = -0.0004;
        sun.shadow.normalBias = 0.012;
      } else {
        sun.target.position.set(0, 0, 0);
        sun.position.set(-9, 20, 12);
        Object.assign(cam, { left: -24, right: 24, top: 24, bottom: -24 });
        sun.shadow.bias = -0.001;
        sun.shadow.normalBias = 0;
      }
      cam.updateProjectionMatrix();
    }
    let equipmentGroup: T.Object3D | undefined;

    // ---- live cues on the chosen bed: root glow and the sensor probe; lamps, substrate and plants are in the bed detail.
    const cueGroup = new T.Group();
    cueGroup.visible = false;
    scene.add(cueGroup);
    const rootGlow = new T.Mesh(new T.BoxGeometry(1.62, 0.07, 0.8), new T.MeshBasicMaterial({ color: "#ff7a55", transparent: true, opacity: 0, depthWrite: false }));
    rootGlow.position.set(0, -0.03, 0);
    cueGroup.add(rootGlow);
    const probe = buildProbe(cueGroup);

    // ---- flows: small points that rise, fall, drift or drop, coloured by what they are.
    function makeFlow(n: number, size: number): FlowSystem {
      const geo = new T.BufferGeometry();
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      const a = new Float32Array(n), b = new Float32Array(n), phase = new Float32Array(n);
      for (let i = 0; i < n; i++) { a[i] = Math.random(); b[i] = Math.random(); phase[i] = Math.random(); }
      geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      geo.setAttribute("color", new T.BufferAttribute(col, 3));
      const pts = new T.Points(geo, new T.PointsMaterial({ size, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, map: glowTexture() }));
      pts.visible = false;
      pts.frustumCulled = false;
      scene.add(pts);
      return { pts, pos, col, a, b, phase, n };
    }
    const airFlow = makeFlow(48, 5), rootFlow = makeFlow(36, 5), dropFlow = makeFlow(24, 5);
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    function stepFlow(sys: FlowSystem, flow: Flow | null, dt: number) {
      sys.pts.visible = !!flow;
      if (!flow) return;
      for (let i = 0; i < sys.n; i++) {
        if (!reduceMotion) sys.phase[i] = (sys.phase[i] + dt * flow.speed * (0.6 + 0.8 * sys.a[i])) % 1;
        const u = sys.phase[i], ox = (sys.a[i] * 2 - 1) * flow.spread[0], oz = (sys.b[i] * 2 - 1) * flow.spread[1];
        let x = flow.center.x + ox, y = flow.center.y, z = flow.center.z + oz;
        if (flow.dir === "up") { y += u * flow.height; x += Math.sin(u * 6 + sys.b[i] * 6) * 0.04; }
        else if (flow.dir === "down") { y += (1 - u) * flow.height; x += Math.sin(u * 6 + sys.b[i] * 6) * 0.04; }
        else if (flow.dir === "x") { x = flow.center.x - flow.spread[0] + u * 2 * flow.spread[0]; y += (sys.b[i] * 2 - 1) * flow.height; }
        else if (flow.dir === "z") { z = flow.center.z - flow.spread[1] + u * 2 * flow.spread[1]; y += (sys.b[i] * 2 - 1) * flow.height; }
        else { y += flow.height * (1 - u); }
        sys.pos[i * 3] = x; sys.pos[i * 3 + 1] = y; sys.pos[i * 3 + 2] = z;
        const fade = flow.dir === "x" || flow.dir === "z" ? 1 : 1 - u * 0.6;
        sys.col[i * 3] = flow.color.r * fade; sys.col[i * 3 + 1] = flow.color.g * fade; sys.col[i * 3 + 2] = flow.color.b * fade;
      }
      (sys.pts.geometry.getAttribute("position") as T.BufferAttribute).needsUpdate = true;
      (sys.pts.geometry.getAttribute("color") as T.BufferAttribute).needsUpdate = true;
    }

    // ---- device models: built once per kind (see farm-models), animated from the report each frame.
    const deviceModels = new Map<string, DeviceModel>();
    const deviceRoot = new T.Group();
    // y = 0 of every device is the top of the workbench plate.
    deviceRoot.position.y = 0.06;
    deviceRoot.visible = false;
    scene.add(deviceRoot);
    function deviceModel(target: string | null): DeviceModel {
      const key = target ?? "sensor";
      let model = deviceModels.get(key);
      if (!model) { model = buildDevice(target, palette); deviceRoot.add(model.group); deviceModels.set(key, model); }
      return model;
    }
    const pickables: T.Object3D[] = [],
      racks = new Map<string, T.Object3D>(),
      plants = new Map<string, T.Object3D[]>(),
      // Per bed: the tray water surfaces (bed:tier), and the source lamp strips and water planes the bed detail replaces.
      trayWater = new Map<string, T.Object3D>(),
      glbSwapped = new Map<string, T.Object3D[]>();
    // The detailed dressing of the one bed on the workbench; rebuilt when another bed is chosen.
    let detail: BedDetail | null = null;
    let plantsHiddenFor: string | null = null;
    function applyPlantVisibility() {
      plants.forEach((groups, key) => {
        const hide = !!plantsHiddenFor && key.startsWith(`${plantsHiddenFor}:`);
        groups.forEach((g) => { g.visible = !!g.userData.shown && !hide; });
      });
      glbSwapped.forEach((list, id) => list.forEach((o) => { o.visible = id !== plantsHiddenFor; }));
    }
    function ensureDetail(bedId: string): BedDetail | null {
      if (detail?.bedId === bedId) return detail;
      if (detail) { scene.remove(detail.group); disposeTree(detail.group); detail = null; }
      const rack = racks.get(bedId);
      if (!rack) return null;
      rack.updateMatrixWorld(true);
      const trays: BedTray[] = [], slots: BedSlot[] = [];
      for (let tier = 1; tier <= 4; tier++) {
        const water = trayWater.get(`${bedId}:${tier}`);
        if (water) { const b = new T.Box3().setFromObject(water); trays.push({ tier, min: b.min, max: b.max }); }
        for (const g of plants.get(`${bedId}:${tier}`) ?? [])
          slots.push({ tier, source: g, pivot: g.getWorldPosition(new T.Vector3()), size: (g.userData.size as T.Vector3 | undefined) ?? new T.Vector3(0.2, 0.15, 0.2) });
      }
      if (!trays.length) return null;
      detail = buildBedDetail(bedId, trays, slots);
      scene.add(detail.group);
      detail.syncPlants();
      return detail;
    }
    /** The chosen tier alone: its tray, plants and lamp, for the tier-focus camera and chips. */
    function tierBox(bedId: string, tier: number): T.Box3 | null {
      const tray = detail?.bedId === bedId ? detail.trays.find((t) => t.tier === tier) : undefined;
      if (!tray) return null;
      return new T.Box3(
        new T.Vector3(tray.min.x - 0.1, tray.max.y - 0.12, tray.min.z - 0.1),
        new T.Vector3(tray.max.x + 0.1, tray.max.y + 0.3, tray.max.z + 0.1),
      );
    }
    /** How opaque a rack part is: tiers above the focus fade strongly, below moderately in tier focus. */
    function tierFade(p: Props, bedId: string, tier: number | null | undefined, single: boolean) {
      const s = p.selection;
      if (!s || bedId !== s.bedId || !tier) return 1;
      if (single && p.tierFocus) return tier > s.tier ? 0.12 : tier < s.tier ? 0.35 : 1;
      return p.focus && tier > s.tier ? 0.12 : 1;
    }
    const occlusionRay = new T.Raycaster();
    let lastOcclusion = 0;
    const outline = new T.Box3Helper(new T.Box3(), new T.Color("#b27d26"));
    outline.visible = false;
    scene.add(outline);
    const zoneBounds = new Map<string, T.Box3>();
    const zoneOutlines = new Map<string, T.Box3Helper>();
    function updateZoneOutlines(selectedId: string | null | undefined, alertIds: string[]) {
      const wanted = new Set(alertIds.map((id) => `alert:${id}`));
      if (selectedId) wanted.add(`selected:${selectedId}`);
      for (const [key, helper] of zoneOutlines) {
        if (!wanted.has(key)) {
          scene.remove(helper);
          helper.geometry.dispose();
          (Array.isArray(helper.material) ? helper.material : [helper.material]).forEach((material) => material.dispose());
          zoneOutlines.delete(key);
        }
      }
      for (const key of wanted) {
        if (zoneOutlines.has(key)) continue;
        const selected = key.startsWith("selected:");
        const bounds = zoneBounds.get(key.slice(key.indexOf(":") + 1));
        if (!bounds || bounds.isEmpty()) continue;
        // One boundary describes the registered zone extent, not a bed-level reading.
        const helper = new T.Box3Helper(
          bounds.clone().expandByScalar(selected ? 0.18 : 0.08),
          new T.Color(selected ? "#176b72" : "#b76a13"),
        );
        (Array.isArray(helper.material) ? helper.material : [helper.material]).forEach((material) => { material.depthTest = false; });
        helper.renderOrder = 2;
        zoneOutlines.set(key, helper);
        scene.add(helper);
      }
    }
    function materials(o: T.Object3D, factor: number) {
      o.traverse((obj) => {
        if (obj instanceof T.Mesh && !obj.userData.selfFade) {
          const ms = Array.isArray(obj.material)
            ? obj.material
            : [obj.material];
          for (const m of ms) {
            m.opacity = (m.userData.opacity ?? 1) * factor;
            m.transparent = factor < 1 || m.userData.transparent;
            m.depthWrite = factor >= 0.9;
          }
          obj.castShadow = factor >= 0.9 && !obj.userData.plant && !obj.userData.noShadow;
        }
      });
    }
    const loader = new GLTFLoader();
    const loadTimer = window.setTimeout(fail, 30000);
    loader.load(
      assetUrl(mapping.model),
      (gltf) => {
        window.clearTimeout(loadTimer);
        if (disposed) {
          disposeTree(gltf.scene);
          return;
        }
        try {
          if (props.layout.beds.length !== mapping.beds.length)
            throw new Error("배치와 모델의 베드 수가 다릅니다.");
          for (const def of mapping.beds) {
            const bed = props.layout.beds.find((b) => b.id === def.bedId);
            const rack = gltf.scene.getObjectByName(def.node);
            if (
              !bed ||
              !rack ||
              bed.tiers.some((t) => t.tier < 1 || t.tier > 4)
            )
              throw new Error("모델 연결 정보를 확인하세요.");
            rack.position.set(
              def.position[0] - def.source[0],
              0,
              def.position[1] - def.source[1],
            );
            racks.set(bed.id, rack);
            for (const group of rack.children) {
              const match = group.name.match(/(?:tier_|plant_t)([1-4])/);
              const tier = match ? Number(match[1]) : null;
              group.userData.tier = tier;
              if (group.name === "cover") group.visible = false;
              if (group.name.startsWith("plant_t")) {
                const bounds = new T.Box3();
                group.traverse((o) => {
                  if (o instanceof T.Mesh) {
                    o.geometry = o.geometry.clone();
                    o.geometry.computeBoundingBox();
                    bounds.union(o.geometry.boundingBox!);
                  }
                });
                const pivot = bounds.getCenter(new T.Vector3());
                pivot.y = bounds.min.y;
                group.traverse((o) => {
                  if (o instanceof T.Mesh)
                    o.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
                });
                group.position.copy(pivot);
                group.userData.baseScale = group.scale.clone();
                // The unscaled plant size sets the procedural plant's spread and height on the workbench.
                group.userData.size = bounds.getSize(new T.Vector3());
                const key = `${bed.id}:${tier}`;
                plants.set(key, [...(plants.get(key) ?? []), group]);
              }
              group.traverse((o) => {
                if (o instanceof T.Mesh) {
                  o.material = Array.isArray(o.material)
                    ? o.material.map((m) => m.clone())
                    : o.material.clone();
                  for (const m of Array.isArray(o.material)
                    ? o.material
                    : [o.material]) {
                    m.userData.opacity = m.opacity;
                    m.userData.transparent = m.transparent;
                    if (tier && group.name.startsWith("tier_") && m.name === "water") trayWater.set(`${bed.id}:${tier}`, o);
                    if (tier && group.name.startsWith("tier_") && (m.name === "blue" || m.name === "water")) glbSwapped.set(bed.id, [...(glbSwapped.get(bed.id) ?? []), o]);
                  }
                  o.userData.focusGroup = group;
                  o.receiveShadow = true;
                  o.userData.plant = group.name.startsWith("plant_t");
                  if (tier) {
                    o.userData.selection = { bedId: bed.id, tier };
                    pickables.push(o);
                  }
                }
              });
            }
          }
          const env = gltf.scene.getObjectByName("environment");
          equipmentGroup = env;
          env?.children.forEach((group) => {
            if (!/^(tank|chiller)/.test(group.name)) {
              group.visible = false;
              return;
            }
            const n = Number(group.name.split("_").pop()),
              tank = group.name.startsWith("tank"),
              bounds = new T.Box3().setFromObject(group),
              center = bounds.getCenter(new T.Vector3());
            group.position.add(
              new T.Vector3(
                12.3 - center.x,
                0.02 - bounds.min.y,
                (tank ? -5 + (n - 1) * 1.6 : 2.1 + (n - 1) * 1.45) - center.z,
              ),
            );
            group.traverse((o) => {
              if (o instanceof T.Mesh) {
                o.userData.equipment = true;
                o.receiveShadow = true;
                pickables.push(o);
              }
            });
          });
          scene.add(gltf.scene);
          gltf.scene.updateMatrixWorld(true);
          for (const zone of props.layout.zones) {
            const bounds = new T.Box3();
            for (const bedId of zone.bed_ids) {
              const rack = racks.get(bedId);
              if (rack) bounds.union(new T.Box3().setFromObject(rack));
            }
            if (!bounds.isEmpty()) zoneBounds.set(zone.id, bounds);
          }
          setFailed(false);
          setLoad("");
        } catch {
          disposeTree(gltf.scene);
          fail();
        }
      },
      event => { if (!disposed) setLoad(event.total
        ? L(`농장 공간 ${Math.round(event.loaded / event.total * 100)}% 불러오는 중…`, `Loading the farm space, ${Math.round(event.loaded / event.total * 100)}%…`)
        : L(`농장 공간 ${(event.loaded / 1048576).toFixed(1)}MB 불러오는 중…`, `Loading the farm space, ${(event.loaded / 1048576).toFixed(1)} MB…`)); },
      fail,
    );
    const ray = new T.Raycaster(),
      mouse = new T.Vector2();
    let down = { x: 0, y: 0 };
    const pointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const pointerUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      const r = el.getBoundingClientRect();
      mouse.set(
        ((e.clientX - r.left) / r.width) * 2 - 1,
        (-(e.clientY - r.top) / r.height) * 2 + 1,
      );
      ray.setFromCamera(mouse, camera);
      const targets = detail?.group.visible ? [...pickables, ...detail.pickables] : pickables;
      // Faded tiers below a tier focus (0.35) stay pickable; strongly faded ones (0.12) let the click through.
      const hit = ray.intersectObjects(targets, false).find((h) => {
        const o = h.object as T.Mesh;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        let visible = o.visible; let parent = o.parent; while(parent){ visible = visible && parent.visible; parent = parent.parent; }
        return visible && m.opacity > 0.3;
      });
      if (hit?.object.userData.selection)
        current.current.onSelect(hit.object.userData.selection);
      // Decorative source-model equipment has no verified device identity.
    };
    renderer.domElement.addEventListener("pointerdown", pointerDown);
    renderer.domElement.addEventListener("pointerup", pointerUp);
    renderer.domElement.addEventListener("webglcontextlost", fail);
    const resize = () => {
      const w = el.clientWidth,
        h = el.clientHeight;
      if (!w || !h) return;
      camera.left = (-13 * w) / h;
      camera.right = (13 * w) / h;
      camera.top = 13;
      camera.bottom = -13;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    let lastKey = "",
      lastGrowth: CropCycle[] | null = null,
      lastScales: Record<string, number> | undefined = undefined,
      lastTime = performance.now(),
      lastLive = true,
      clock = 0,
      flight: { p: T.Vector3; t: T.Vector3; z: number } | null = null;
    // Stopped readings grey the model; the fade is skipped when motion is reduced.
    if (!reduceMotion) renderer.domElement.style.transition = "filter 400ms ease";
    el.dataset.live = "true";
    controls.addEventListener("start", () => {
      flight = null;
    });
    /** A camera flight that fits a box, by default from the usual three-quarter direction. */
    function fitFlight(box: T.Box3, kx: number, ky: number, dir = new T.Vector3(19, 19, 29)) {
      const target = box.getCenter(new T.Vector3());
      const position = target.clone().add(dir);
      const fitCamera = camera.clone();
      fitCamera.position.copy(position);
      fitCamera.lookAt(target);
      fitCamera.updateMatrixWorld(true);
      const viewBounds = new T.Box3();
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z])
            viewBounds.expandByPoint(new T.Vector3(x, y, z).applyMatrix4(fitCamera.matrixWorldInverse));
      const size = viewBounds.getSize(new T.Vector3());
      return {
        p: position,
        t: target,
        z: T.MathUtils.clamp(Math.min(
          (camera.right - camera.left) / Math.max(size.x * kx, 1),
          (camera.top - camera.bottom) / Math.max(size.y * ky, 1),
        ), controls.minZoom, controls.maxZoom),
      };
    }
    function applyFades(p: Props, single: boolean, hidden?: Set<T.Object3D>) {
      racks.forEach((rack, id) =>
        rack.children.forEach((g) => materials(g, hidden?.has(g) ? 0.12 : tierFade(p, id, g.userData.tier, single))),
      );
      const d = detail;
      if (d) d.tiers.forEach((g) => materials(g, tierFade(p, d.bedId, g.userData.tier, single)));
    }
    function animate() {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      const p = current.current,
        s = p.selection;
      updateLighting(!!p.compact && (!!s || !!p.device));
      const def = mapping.beds.find((b) => b.bedId === s?.bedId);
      const point =
        def && s
          ? new T.Vector3(
              def.position[0],
              0.61 + (s.tier - 1) * 0.4,
              def.position[1],
            )
          : new T.Vector3(0, 0.6, 1.4);
      const dev = p.device ?? null;
      const single = !!p.compact && (!!s || !!dev);
      const singleBed = single && !!s && !dev;
      const tierFocused = singleBed && !!p.tierFocus;
      const visibleBeds = new Set(single && !dev ? workBeds(p).map(b=>b.id) : []);
      const compactBounds = new T.Box3();
      if(single && !dev) for(const id of visibleBeds){ const rack=racks.get(id);if(rack)compactBounds.union(new T.Box3().setFromObject(rack)); }
      // A device stands alone at the origin of the workbench.
      const model = dev ? deviceModel(dev.target) : null;
      deviceRoot.visible = !!model;
      deviceModels.forEach((m) => { m.group.visible = m === model; });
      if (model) compactBounds.union(model.bounds.clone().translate(deviceRoot.position));
      const zone = single && !compactBounds.isEmpty() ? compactBounds : !s && p.selectedZoneId ? zoneBounds.get(p.selectedZoneId) : undefined;
      const key = `${s?.bedId}:${s?.tier}:${dev?.key}:${p.selectedZoneId}:${p.focus}:${single}:${tierFocused}:${racks.size}:${zone ? `${el.clientWidth}:${el.clientHeight}` : ""}`;
      if (key !== lastKey) {
        lastKey = key;
        racks.forEach((rack,id)=>{rack.visible = !single || visibleBeds.has(id);});
        scenery.forEach(o=>{o.visible = !single;});
        ground.visible = !single;
        if(equipmentGroup) equipmentGroup.visible = !single;
        // The detailed dressing replaces the source plants and lamp strips of the bed on the bench only.
        const bedDetail = singleBed && s ? ensureDetail(s.bedId) : null;
        if (detail) detail.group.visible = !!bedDetail;
        plantsHiddenFor = bedDetail?.bedId ?? null;
        applyPlantVisibility();
        // Close views need more zoom than the farm: a tier alone fills the stage.
        controls.maxZoom = single ? 30 : 8;
        plate.group.visible = single && !compactBounds.isEmpty();
        if (plate.group.visible) {
          const size = compactBounds.getSize(new T.Vector3()), center = compactBounds.getCenter(new T.Vector3());
          plate.fit(Math.max(size.x, 1.2) + 0.7, Math.max(size.z, 0.8) + 0.7, center.x, center.z);
        }
        frameShadow(plate.group.visible ? compactBounds : null);
        el.dataset.visibleBeds = String(single && !dev ? visibleBeds.size : dev ? 0 : racks.size);
        el.dataset.device = dev?.target ?? "";
        el.dataset.deviceHealth = dev?.health ?? "";
        el.dataset.tierFocus = String(tierFocused);
        flight =
          model
            ? {
                p: new T.Vector3(2.6, 1.9, 3.6),
                t: new T.Vector3(0, model.height * 0.45, 0),
                z: Math.min(7.5, 6.6 / Math.max(model.height, 0.6)),
              }
            : p.focus && s
            ? {
                p: point.clone().add(new T.Vector3(3.5, 2.7, 5.7)),
                t: point.clone().add(new T.Vector3(0, 0.22, 0)),
                z: single ? 6.4 : 5.0,
              }
            : {
                p: new T.Vector3(19, 19, 29),
                t: new T.Vector3(0, 0.6, 1.4),
                z: 1,
              };
        if (((p.focus || single) && zone && !(p.focus && s)) || (singleBed && zone))
          flight = fitFlight(zone, singleBed ? 2.1 : 1.25, singleBed ? 1.3 : 1.25);
        // Tier focus: move in and down until the chosen tray fills most of the stage, low enough
        // to see under the lamp hood: leaves on their petioles and the lit LED bars.
        const focusBox = tierFocused && s ? tierBox(s.bedId, s.tier) : null;
        if (focusBox) flight = fitFlight(focusBox, 1.28, 1.3, new T.Vector3(19, 12.6, 29));
        applyFades(p, single);
        structural.forEach((o) => materials(o, p.focus ? 0.15 : 1));
      }
      updateZoneOutlines(single ? null : p.selectedZoneId, single ? [] : p.alertZoneIds ?? []);
      const now = performance.now(), dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      // Stopped readings freeze every motion and grey the model: it shows the last known state.
      const live = p.live !== false;
      if (live !== lastLive) {
        lastLive = live;
        renderer.domElement.style.filter = live ? "" : "saturate(0.3) brightness(0.97)";
        el.dataset.live = String(live);
      }
      const still = reduceMotion || !live;
      const motionDt = still ? 0 : dt;
      clock += motionDt;
      const tick: Tick = { dt: motionDt, clock, still, camera };
      // ---- cues: what the chosen bed reports, drawn on the bed itself.
      const cues = singleBed ? p.cues ?? null : null;
      cueGroup.visible = !!cues;
      let airFlowSpec: Flow | null = null, rootFlowSpec: Flow | null = null, dropFlowSpec: Flow | null = null;
      const bench = singleBed && detail?.group.visible ? detail : null;
      if (bench && s) {
        const moisture = cues?.moisture ?? null;
        bench.update({
          lamp: cues?.lamp ?? daylightNow,
          wet: moisture === null ? 0.55 : Math.max(0, Math.min(1, moisture / 100)),
          plantTone: cues?.plantTone ?? "ok",
          fan: cues?.airflow.fan ?? 0,
          pump: !!cues?.airflow.pump,
          fades: [1, 2, 3, 4].map((t) => tierFade(p, s.bedId, t, single)),
        }, tick);
      }
      if (cues && s) {
        cueGroup.position.copy(point);
        const glow = rootGlow.material as T.MeshBasicMaterial;
        glow.color.copy(cues.root === "hot" ? FLOW.rootHot : cues.root === "cold" ? FLOW.cool : cues.airflow.chiller ? FLOW.chill : FLOW.rootHot);
        glow.opacity = T.MathUtils.lerp(glow.opacity, cues.root === "hot" || cues.root === "cold" ? 0.42 : cues.airflow.chiller ? 0.25 : 0, still ? 1 : 0.1);
        probe.update(cues.sensor, tick);
        const humid = cues.cues.some((c) => c.id === "humid_high");
        const color = cues.airflow.heater ? FLOW.warm : cues.air === "hot" ? FLOW.warmSoft : cues.air === "cold" ? FLOW.cool : humid ? palette.mist : cues.airflow.fan > 0 ? palette.air : null;
        if (color) {
          const drift = cues.airflow.fan > 0;
          airFlowSpec = { color, dir: drift ? "x" : cues.air === "cold" && !cues.airflow.heater ? "down" : "up", speed: drift ? 0.35 + cues.airflow.fan * 0.9 : cues.airflow.heater ? 0.45 : humid ? 0.15 : 0.3, center: point.clone().add(new T.Vector3(0, 0.12, 0)), spread: [0.85, 0.42], height: drift ? 0.25 : 0.5 };
        }
        if (cues.airflow.chiller) rootFlowSpec = { color: FLOW.chill, dir: "x", speed: 0.6, center: point.clone().add(new T.Vector3(0, 0.0, 0)), spread: [0.75, 0.3], height: 0.03 };
        else if (cues.root === "hot") rootFlowSpec = { color: FLOW.rootHot, dir: "up", speed: 0.25, center: point.clone().add(new T.Vector3(0, -0.02, 0)), spread: [0.7, 0.3], height: 0.14 };
        else if (cues.root === "cold") rootFlowSpec = { color: FLOW.cool, dir: "up", speed: 0.15, center: point.clone().add(new T.Vector3(0, -0.02, 0)), spread: [0.7, 0.3], height: 0.1 };
        // The bed detail drips from its own emitters; the falling drops remain the fallback without it.
        if (cues.airflow.pump && !bench) dropFlowSpec = { color: FLOW.drop, dir: "drop", speed: 0.8, center: point.clone().add(new T.Vector3(0, 0.02, 0)), spread: [0.7, 0.3], height: 0.34 };
      } else if (model && dev) {
        const flows = model.update(dev, tick);
        airFlowSpec = flows.air; rootFlowSpec = flows.root; dropFlowSpec = flows.drop;
      }
      stepFlow(airFlow, airFlowSpec, motionDt);
      stepFlow(rootFlow, rootFlowSpec, motionDt);
      stepFlow(dropFlow, dropFlowSpec, motionDt);
      // ---- callouts: HTML chips pinned to the part they describe.
      const shown = cues && s ? cues.cues.slice(0, 5) : [];
      const toScreen = (v: T.Vector3) => { const q = v.clone().project(camera); return { x: (q.x * 0.5 + 0.5) * el.clientWidth, y: (-q.y * 0.5 + 0.5) * el.clientHeight }; };
      // Chips sit beside what is framed: the whole bed, or only the chosen tier in tier focus.
      const chipBounds = (tierFocused && s ? tierBox(s.bedId, s.tier) : null) ?? compactBounds;
      let minX = Infinity, maxX = -Infinity;
      if (shown.length && !chipBounds.isEmpty()) {
        for (const x of [chipBounds.min.x, chipBounds.max.x])
          for (const y of [chipBounds.min.y, chipBounds.max.y])
            for (const z of [chipBounds.min.z, chipBounds.max.z]) {
              const q = toScreen(new T.Vector3(x, y, z));
              minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
            }
      }
      const RIGHT = new Set<Cue["part"]>(["sensor", "substrate", "plants"]);
      const placed = shown.map((cue) => {
        const [ox, oy, oz] = CUE_OFFSETS[cue.part];
        const at = toScreen(point.clone().add(new T.Vector3(ox, oy, oz)));
        return { cue, at, side: RIGHT.has(cue.part) ? "right" : "left" };
      });
      // Keep chips on one side at least 46px apart, in the order of the parts they point at.
      for (const side of ["left", "right"]) {
        let last = -Infinity;
        placed.filter((c) => c.side === side).sort((a, b) => a.at.y - b.at.y).forEach((c) => {
          const y = Math.max(c.at.y, last + 46);
          (c as { y?: number }).y = y;
          last = y;
        });
      }
      cueRefs.current.forEach((elm, id) => {
        const item = placed.find((c) => c.cue.id === id) as (typeof placed[number] & { y?: number }) | undefined;
        if (!item) { elm.style.display = "none"; return; }
        // Keep the whole chip on the stage: a left chip needs its own width of room.
        const width = elm.offsetWidth || 220;
        const edge = item.side === "right" ? Math.min(el.clientWidth - 16 - width, maxX + 28) : Math.max(16 + width, minX - 28);
        elm.style.display = "";
        elm.dataset.side = item.side;
        elm.style.left = `${edge}px`;
        elm.style.top = `${Math.max(40, Math.min(el.clientHeight - 70, item.y ?? item.at.y))}px`;
        elm.style.setProperty("--lead", `${Math.max(8, Math.abs(item.at.x - edge))}px`);
      });
      if (plants.size && (lastGrowth !== p.cycles || lastScales !== p.plantScales)) {
        lastGrowth = p.cycles;
        lastScales = p.plantScales;
        plants.forEach((groups, key) => {
          const [bedId, t] = key.split(":");
          const cycle = cycleAt(p.cycles, { bedId, tier: Number(t) });
          const scale = cycle ? p.plantScales?.[cycle.id] ?? null : null;
          groups.forEach((g, i) => {
            // Plants appear only where a growing cycle is registered: an empty tier looks empty.
            g.userData.shown =
              !!cycle &&
              i < Math.ceil(groups.length * activePlantFraction(cycle));
            g.userData.growth = scale ?? 1;
            g.scale
              .copy(g.userData.baseScale)
              .multiplyScalar(g.userData.growth);
          });
        });
        // The same flags and growth drive the source plants and the bench's procedural plants.
        applyPlantVisibility();
        detail?.syncPlants();
      }
      if (flight) {
        const k = matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 1
          : 0.14;
        camera.position.lerp(flight.p, k);
        controls.target.lerp(flight.t, k);
        camera.zoom = T.MathUtils.lerp(camera.zoom, flight.z, k);
        camera.updateProjectionMatrix();
        if (camera.position.distanceTo(flight.p) < 0.01) flight = null;
      }
      controls.update();
      if (performance.now() - lastOcclusion > 250) {
        lastOcclusion = performance.now();
        const hidden = new Set<T.Object3D>();
        if (p.focus && s) {
          for (const [x, z] of [
            [0, 0],
            [-0.65, -0.28],
            [0.65, -0.28],
            [-0.65, 0.28],
            [0.65, 0.28],
          ]) {
            const target = point.clone().add(new T.Vector3(x, 0.13, z));
            const projected = target.clone().project(camera);
            occlusionRay.setFromCamera(
              new T.Vector2(projected.x, projected.y),
              camera,
            );
            const max = occlusionRay.ray.origin.distanceTo(target);
            occlusionRay.far = max - 0.15;
            for (const hit of occlusionRay.intersectObjects(pickables, false)) {
              const g = hit.object.userData.focusGroup;
              if (g && hit.object.userData.selection?.bedId !== s.bedId)
                hidden.add(g);
            }
          }
        }
        applyFades(p, single, hidden);
      }
      // The tier outline is redundant when the tier alone fills the stage.
      outline.visible = !!s && !tierFocused;
      if (s) {
        outline.box.setFromCenterAndSize(
          point.clone().add(new T.Vector3(0, 0.07, 0)),
          new T.Vector3(1.78, 0.15, 0.88),
        );
      }
      renderer.render(scene, camera);
    }
    animate();
    return () => {
      disposed = true;
      window.clearTimeout(loadTimer);
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [props.layout, attempt]);
  return (
    <div className="fm-map" ref={host}>
      <span className="fm-map-lighting" title={L("한국 실제 시각에 맞춘 화면 표현입니다. 실제 일출·날씨·시설 조명 상태를 뜻하지 않습니다.", "Screen lighting follows the actual time in Korea. It does not reflect real sunrise, weather or facility lighting.")}>{L(`한국 시각 / ${lightingName(daylightLevel)}`, `Korea time / ${lightingName(daylightLevel)}`)}</span>
      {!load && props.selection && (props.cues?.cues ?? []).slice(0, 5).map((cue) => (
        <button
          key={cue.id}
          type="button"
          className={`fm-cue is-${cue.tone}`}
          title={cue.note}
          ref={(node) => { if (node) cueRefs.current.set(cue.id, node); else cueRefs.current.delete(cue.id); }}
          onClick={() => props.onCue?.(cue)}
        >
          <FarmIcon name={cue.icon} />{cue.label}
        </button>
      ))}
      {load && (
        <div className="fm-map-message" role={failed ? "alert" : "status"}>
          <p>{failed ? failureText() : load}</p>
          <button onClick={props.onFallback}>{L("목록으로 작업 계속", "Continue with the list")}</button>
          {failed && (
            <>
              <button onClick={() => setAttempt((n) => n + 1)}>
                {L("다시 불러오기", "Reload")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
function disposeTree(root: T.Object3D) {
  const geometries = new Set<T.BufferGeometry>(),
    materials = new Set<T.Material>();
  root.traverse((o) => {
    if (o instanceof T.Mesh || o instanceof T.LineSegments || o instanceof T.Points || o instanceof T.Sprite) {
      geometries.add(o.geometry);
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) =>
        materials.add(m),
      );
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}

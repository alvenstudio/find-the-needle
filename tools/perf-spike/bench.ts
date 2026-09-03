/**
 * Throwaway spike: does the heightfield-core + instanced-shell haystack hold
 * frame budget at Mother Lode scale, and does the dug face survive a 0.5 m
 * first-person close-up?
 */
import {
  ACESFilmicToneMapping,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import { Assets } from './core/Assets';
import { MaterialLibrary, advanceSharedUniforms, stylize } from './core/Materials';
import { Rng } from './core/Rng';
import { HayPile, overrideStrawGeometry } from './world/HayPile';

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => Number(params.get(key) ?? fallback);
const flag = (key: string, fallback: boolean) => (params.has(key) ? params.get(key) !== '0' : fallback);

const WIDTH = num('w', 1920);
const HEIGHT = num('h', 1080);
const SHADOWS = flag('shadows', true);
const SHADOW_MAP = num('shadowmap', 2048);
const POWER = (params.get('power') ?? 'high-performance') as WebGLPowerPreference;
const COUNTS = (params.get('counts') ?? '0,5000,10000,20000,30000,45000,60000,90000,120000')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v));
const RESOLUTION = num('res', 129);
const CAPTURE = flag('capture', true);
const BAND_COUNTS = (params.get('bands') ?? '8000,16000,32000')
  .split(',')
  .map((v) => Number(v.trim()))
  .filter((v) => Number.isFinite(v) && v > 0);
const TAG = params.get('tag') ?? 'run';
const PERF = flag('perf', true);
const BAND_SINK = num('bandsink', 0.14);
const BAND_SCALE = num('bandscale', 1);
const BAND_TILT = num('bandtilt', 0.7);
/** 'full' = the authored 28-triangle stalk; 'quad' = a two-triangle sliver. */
const STRAW_LOD = params.get('strawlod') ?? 'full';

// Mother Lode, from src/gameplay/Content.ts.
const RADIUS = num('radius', 12);
const PEAK = num('peak', 7.4);

const log = document.getElementById('log') as HTMLDivElement;
const lines: string[] = [];
function say(text: string): void {
  lines.push(text);
  log.textContent = lines.join('\n');
  console.log(text);
}

async function save(name: string, payload: { dataUrl?: string; json?: unknown }): Promise<void> {
  await fetch('/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, ...payload }),
  }).catch((error) => say('save failed for ' + name + ': ' + error));
}

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const renderer = new WebGLRenderer({
  canvas,
  antialias: flag('aa', true),
  powerPreference: POWER,
  stencil: false,
  depth: true,
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(WIDTH, HEIGHT, false);
renderer.outputColorSpace = 'srgb';
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = SHADOWS;
renderer.shadowMap.type = PCFSoftShadowMap;
renderer.info.autoReset = false;

const gl = renderer.getContext() as WebGL2RenderingContext;
const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)) : 'unknown';
const vendor = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)) : 'unknown';
const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as
  | { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }
  | null;

const scene = new Scene();
scene.background = new Color('#8fc9ef');
scene.fog = new Fog('#a9d6f2', 60, 320);

scene.add(new HemisphereLight('#cfe8ff', '#6b5a3a', 1.05));
const sun = new DirectionalLight('#fff2d2', 2.1);
sun.position.set(24, 34, 16);
sun.castShadow = SHADOWS;
sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 110;
sun.shadow.camera.left = -30;
sun.shadow.camera.right = 30;
sun.shadow.camera.top = 30;
sun.shadow.camera.bottom = -30;
sun.shadow.bias = -0.0009;
scene.add(sun);

const ground = new Mesh(
  new PlaneGeometry(400, 400),
  stylize(new MeshStandardMaterial({ color: '#8a6a3f', roughness: 1 }), { rim: 0.1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new PerspectiveCamera(72, WIDTH / HEIGHT, 0.06, 900);
camera.rotation.order = 'YXZ';

const assets = new Assets(new MaterialLibrary());

/**
 * A straw as two triangles.
 *
 * At the sizes a straw actually occupies on screen, the authored stalk's
 * twenty-eight triangles buy nothing but vertex work: it is a few pixels wide
 * and its silhouette is a sliver either way. This is the same 0.30 m length and
 * taper as the real mesh, flattened into one double-sided quad, and it exists to
 * measure how much of the pile's cost is the straw's own geometry.
 */
function buildQuadStraw(): BufferGeometry {
  const geometry = new BufferGeometry();
  const halfBase = 0.018;
  const halfTip = 0.004;
  const length = 0.3;
  // Laid out along +Y, matching the authored stalk's origin and axis.
  const positions = new Float32Array([
    -halfBase, 0, 0,
    halfBase, 0, 0,
    halfTip, length, 0,
    -halfBase, 0, 0,
    halfTip, length, 0,
    -halfTip, length, 0,
  ]);
  const normals = new Float32Array(18);
  for (let i = 0; i < 6; i++) normals[i * 3 + 2] = 1;
  const colors = new Float32Array(18).fill(1);
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

let quadStraw: BufferGeometry | null = null;

/** The geometry every straw instance uses, per the strawlod switch. */
function strawGeometryFor(): BufferGeometry {
  if (STRAW_LOD !== 'quad') return assets.geometryOf('straw');
  if (!quadStraw) quadStraw = buildQuadStraw();
  return quadStraw;
}

// ---------------------------------------------------------------- measuring
interface Sample {
  renderMs: number;
  gpuMs: number | null;
  burst: number;
  calls: number;
  triangles: number;
}

const EMPTY_SAMPLE: Sample = { renderMs: 0, gpuMs: null, burst: 0, calls: 0, triangles: 0 };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * A macrotask yield that survives a backgrounded tab. `setTimeout` is clamped
 * to one second in a hidden pane and `requestAnimationFrame` stops altogether,
 * so the spike paces itself on a MessageChannel instead.
 */
const channel = new MessageChannel();
const pending: (() => void)[] = [];
channel.port1.onmessage = () => pending.shift()?.();
const yieldTask = () =>
  new Promise<void>((resolve) => {
    pending.push(resolve);
    channel.port2.postMessage(0);
  });

/**
 * Throughput, not vsync.
 *
 * rAF deltas top out at the refresh rate and would hide all headroom, and a
 * four-render burst is short enough that driver-side queuing and a clock-gated
 * GPU dominate the number. So each rep renders the scene as many times as it
 * takes to fill ~350 ms of continuous work, blocks once on gl.finish(), and
 * divides. Long reps also drag the GPU out of its idle clock state, which is
 * what makes repeat runs agree with each other.
 */
async function measure(): Promise<Sample> {
  advanceSharedUniforms(performance.now() / 1000, 1);

  // Warm up first. The very first draw of a new material compiles its program,
  // which costs hundreds of milliseconds and would poison the measurement.
  for (let i = 0; i < 8; i++) renderer.render(scene, camera);
  gl.finish();
  await yieldTask();

  // Each rep renders flat out for a fixed slice of wall clock and divides by
  // the number of frames it managed. Time-bounded rather than count-bounded, so
  // a slow configuration takes the same wall time as a fast one, and long
  // enough that the GPU leaves its idle clock state.
  const BUDGET_MS = 320;
  const cpu: number[] = [];
  let frames = 0;
  for (let rep = 0; rep < 5; rep++) {
    const start = performance.now();
    let count = 0;
    do {
      for (let i = 0; i < 4; i++) renderer.render(scene, camera);
      count += 4;
    } while (performance.now() - start < BUDGET_MS);
    gl.finish();
    cpu.push((performance.now() - start) / count);
    frames = count;
    await yieldTask();
  }

  // A short, separately bracketed burst for the GPU timer: a query spanning
  // seconds of work is almost always reported disjoint.
  const gpuTimes: number[] = [];
  if (timerExt) {
    for (let rep = 0; rep < 5; rep++) {
      const query = gl.createQuery();
      if (!query) break;
      gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
      for (let i = 0; i < 16; i++) renderer.render(scene, camera);
      gl.endQuery(timerExt.TIME_ELAPSED_EXT);
      gl.finish();
      for (let attempt = 0; attempt < 400; attempt++) {
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        await yieldTask();
      }
      if (
        gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) &&
        !gl.getParameter(timerExt.GPU_DISJOINT_EXT)
      ) {
        gpuTimes.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6 / 16);
      }
      gl.deleteQuery(query);
      await yieldTask();
    }
  }

  renderer.info.reset();
  renderer.render(scene, camera);
  return {
    renderMs: median(cpu),
    gpuMs: gpuTimes.length ? median(gpuTimes) : null,
    burst: frames,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  };
}

// --------------------------------------------------- optional near-field band
/**
 * Fallback candidate: a dense band of real straw instances that follows the
 * player, so the metre in front of the face is genuine geometry while the rest
 * of the pile stays a cheap shell. Volume bookkeeping is untouched - these
 * straws are decoration sampled from the same height field.
 */
class DetailBand {
  readonly mesh: InstancedMesh;
  private readonly focus = new Vector3(1e9, 0, 1e9);
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly spin = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly normal = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly tmp = new Vector3();
  lastRebuildMs = 0;

  constructor(private readonly pile: HayPile, private readonly count: number, private readonly radius: number) {
    const material = stylize(new MeshStandardMaterial({ vertexColors: true, roughness: 0.88 }), {
      rim: 0.4,
      wind: 0.012,
      windAnchor: -0.5,
    });
    if (STRAW_LOD === 'quad') material.side = DoubleSide;
    this.mesh = new InstancedMesh(strawGeometryFor(), material, count);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.position.copy(pile.worldCenter);
    const tints = [0xfff0c0, 0xf5dfa0, 0xe8ca7d, 0xd8b463, 0xc9a352];
    const rng = new Rng(0x51ab21);
    const colour = new Color();
    for (let i = 0; i < count; i++) this.mesh.setColorAt(i, colour.setHex(rng.pick(tints)));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(worldFocus: Vector3, force = false): void {
    if (!force && this.focus.distanceTo(worldFocus) < 0.3) return;
    this.focus.copy(worldFocus);
    const start = performance.now();
    const field = this.pile.field;
    const cx = worldFocus.x - this.pile.worldCenter.x;
    const cz = worldFocus.z - this.pile.worldCenter.z;
    const rng = new Rng(0x2f19a7);
    for (let i = 0; i < this.count; i++) {
      // A disc around the focus, biased inward so the nearest half-metre gets
      // the lion's share of the budget.
      const angle = rng.range(0, Math.PI * 2);
      const r = this.radius * Math.pow(rng.next(), 0.72);
      const x = cx + Math.cos(angle) * r;
      const z = cz + Math.sin(angle) * r;
      const height = field.heightAt(x, z);
      if (height <= 0.03) {
        this.matrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.matrix);
        continue;
      }
      field.normalAt(x, z, this.normal);
      // Toward 0 the straw lies flat along the slope; toward 1 it stands up.
      this.tmp.copy(this.normal).lerp(this.up, rng.range(BAND_TILT * 0.15, BAND_TILT)).normalize();
      this.quaternion.setFromUnitVectors(this.up, this.tmp);
      this.spin.setFromAxisAngle(this.up, rng.range(0, Math.PI * 2));
      this.quaternion.multiply(this.spin);
      // Straws sit a few centimetres proud of and below the surface so the band
      // reads as a matted crust rather than a carpet of pins.
      this.position.set(x, height - rng.range(BAND_SINK * 0.3, BAND_SINK), z);
      this.scale.setScalar(rng.range(0.7, 1.35) * BAND_SCALE);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.lastRebuildMs = performance.now() - start;
  }
}

// -------------------------------------------------------------------- views
/** Where the crater gets dug, in pile-local metres. */
const CRATER = new Vector3(0, 0, 6.2);
/** The point on the crater wall every close-up is aimed at. */
const WALL = new Vector3(0, 0, 5.35);

/**
 * Scoop a bowl, not a shaft. Twelve overlapping passes at a fraction of a metre
 * each leave a crater about two metres deep in six metres of hay, so there is a
 * real dug face to photograph instead of a hole punched through to the dirt.
 */
function digCrater(pile: HayPile): void {
  const centre = pile.worldCenter.clone().add(CRATER);
  const passes = num('digpasses', 12);
  const depth = num('digdepth', 0.22);
  for (let i = 0; i < passes; i++) {
    const angle = i * 2.39996;
    const r = 1.15 * Math.sqrt(i / passes);
    pile.dig(centre.clone().add(new Vector3(Math.cos(angle) * r, 0, Math.sin(angle) * r)), 1.5, depth);
  }
}

/**
 * Park the camera a given distance off the surface along its own normal and
 * point it at the spot. Framing the shot off the geometry rather than off fixed
 * coordinates is what makes "0.5 m from the dug face" mean the same thing in
 * every variant.
 */
function aimAt(pile: HayPile, local: Vector3, distance: number, lift = 0): void {
  const height = pile.field.heightAt(local.x, local.z);
  const target = new Vector3(
    pile.worldCenter.x + local.x,
    pile.worldCenter.y + height,
    pile.worldCenter.z + local.z,
  );
  const normal = pile.field.normalAt(local.x, local.z, new Vector3());
  // Tilt the offset away from straight-up so a shallow slope is still seen
  // face-on rather than from directly overhead.
  normal.y *= 0.55;
  normal.z += 0.85;
  normal.normalize();
  camera.position.copy(target).addScaledVector(normal, distance);
  camera.position.y += lift;
  camera.lookAt(target);
}

/** How far the centre of the frame really is from the hay, in metres. */
function centreDistance(pile: HayPile): number {
  const direction = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  const hit = new Vector3();
  return pile.raycast(camera.position, direction, 40, hit);
}

interface View {
  name: string;
  apply: (pile: HayPile) => void;
}

const views: View[] = [
  {
    // Standing back from the pile: the whole silhouette in frame, the worst
    // case for on-screen instance count.
    name: 'overview',
    apply: (pile) => {
      camera.position.set(pile.worldCenter.x + 1.5, 1.68, pile.worldCenter.z + RADIUS + 9);
      camera.rotation.set(-0.13, 0, 0);
    },
  },
  {
    // The frame the player stares at while digging: a couple of metres off the
    // dug face, roughly where a first-person camera sits mid-swing.
    name: 'digface',
    apply: (pile) => aimAt(pile, WALL, num('digfacedist', 2.0)),
  },
  {
    // Face pressed into the wall. The art risk: half a metre from the hay.
    name: 'closeup05',
    apply: (pile) => aimAt(pile, WALL, num('closedist', 0.5)),
  },
];

async function capture(name: string): Promise<void> {
  if (!CAPTURE) return;
  renderer.render(scene, camera);
  await save(name + '.png', { dataUrl: canvas.toDataURL('image/png') });
}

// --------------------------------------------------------------------- main
async function main(): Promise<void> {
  say('gpu: ' + gpu);
  say('vendor: ' + vendor + '  power=' + POWER + '  timerQuery=' + (timerExt ? 'yes' : 'no'));
  say('canvas ' + WIDTH + 'x' + HEIGHT + '  shadows=' + SHADOWS + '@' + SHADOW_MAP + '  res=' + RESOLUTION);

  await assets.loadAll([{ name: 'straw', url: 'models/straw.glb', castShadow: false, receiveShadow: false }]);
  if (STRAW_LOD === 'quad') overrideStrawGeometry(() => strawGeometryFor());
  const strawGeometry = strawGeometryFor();
  const strawTris = (strawGeometry.getIndex()?.count ?? strawGeometry.getAttribute('position').count) / 3;
  say('straw mesh (' + STRAW_LOD + '): ' + strawTris + ' triangles, ' + strawGeometry.getAttribute('position').count + ' verts');

  const results: unknown[] = [];

  for (const count of COUNTS) {
    const buildStart = performance.now();
    const pile = new HayPile(assets, {
      radius: RADIUS,
      peak: PEAK,
      resolution: RESOLUTION,
      seed: 90210,
      strawBudget: count,
      strawDensity: 4000,
      position: new Vector3(0, 0, 0),
    });
    const buildMs = performance.now() - buildStart;
    scene.add(pile.group);

    const craterStart = performance.now();
    digCrater(pile);
    const craterMs = performance.now() - craterStart;

    // One "pull" of hay: the per-click CPU cost the game pays while digging.
    const centre = pile.worldCenter.clone().add(CRATER);
    const digStart = performance.now();
    for (let i = 0; i < 30; i++) pile.dig(centre.clone().add(new Vector3(0, 0, -0.02 * i)), 0.85, 0.06);
    const digMs = (performance.now() - digStart) / 30;
    pile.drainDislodged();

    for (const view of views) {
      view.apply(pile);
      const distance = centreDistance(pile);
      const sample = PERF ? await measure() : EMPTY_SAMPLE;
      const row = {
        count,
        band: 0,
        view: view.name,
        centreDistanceM: Number(distance.toFixed(3)),
        renderMs: Number(sample.renderMs.toFixed(3)),
        gpuMs: sample.gpuMs === null ? null : Number(sample.gpuMs.toFixed(3)),
        fps: sample.renderMs > 0 ? Number((1000 / sample.renderMs).toFixed(1)) : null,
        burst: sample.burst,
        calls: sample.calls,
        triangles: sample.triangles,
        digMsPerCall: Number(digMs.toFixed(3)),
        craterMs: Number(craterMs.toFixed(1)),
        buildMs: Number(buildMs.toFixed(1)),
      };
      results.push(row);
      say(JSON.stringify(row));
      if (CAPTURE) await capture('shot_' + TAG + '_' + view.name + '_shell' + count);
    }

    scene.remove(pile.group);
    pile.dispose();
  }

  // --------------------------------------------------- near-field band spike
  if (BAND_COUNTS.length > 0) {
    const pile = new HayPile(assets, {
      radius: RADIUS,
      peak: PEAK,
      resolution: RESOLUTION,
      seed: 90210,
      strawBudget: num('bandshell', 20000),
      strawDensity: 4000,
      position: new Vector3(0, 0, 0),
    });
    scene.add(pile.group);
    digCrater(pile);

    for (const bandCount of BAND_COUNTS) {
      const band = new DetailBand(pile, bandCount, num('bandradius', 2.6));
      scene.add(band.mesh);
      for (const view of views) {
        view.apply(pile);
        band.update(camera.position, true);
        const distance = centreDistance(pile);
        const sample = PERF ? await measure() : EMPTY_SAMPLE;
        const row = {
          count: num('bandshell', 20000),
          band: bandCount,
          view: view.name,
          centreDistanceM: Number(distance.toFixed(3)),
          renderMs: Number(sample.renderMs.toFixed(3)),
          gpuMs: sample.gpuMs === null ? null : Number(sample.gpuMs.toFixed(3)),
          fps: sample.renderMs > 0 ? Number((1000 / sample.renderMs).toFixed(1)) : null,
          burst: sample.burst,
          calls: sample.calls,
          triangles: sample.triangles,
          bandRebuildMs: Number(band.lastRebuildMs.toFixed(2)),
        };
        results.push(row);
        say(JSON.stringify(row));
        if (CAPTURE) await capture('shot_' + TAG + '_' + view.name + '_band' + bandCount);
      }
      scene.remove(band.mesh);
      band.mesh.dispose();
    }
    scene.remove(pile.group);
    pile.dispose();
  }

  await save('results_' + TAG + '.json', {
    json: {
      gpu,
      vendor,
      power: POWER,
      width: WIDTH,
      height: HEIGHT,
      shadows: SHADOWS,
      shadowMap: SHADOW_MAP,
      resolution: RESOLUTION,
      radius: RADIUS,
      peak: PEAK,
      strawTriangles: strawTris,
      results,
    },
  });
  say('DONE');
  (window as unknown as { __benchDone: boolean }).__benchDone = true;
}

main().catch((error) => {
  say('FAILED: ' + (error?.stack ?? error));
  (window as unknown as { __benchDone: boolean }).__benchDone = true;
});

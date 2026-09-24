import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Timer,
  Vector2,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { Signal } from './Signals';
import { clamp } from './MathX';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  /** Upper bound on the device pixel ratio we are willing to render at. */
  maxPixelRatio: number;
  shadows: boolean;
  /**
   * Side of the sun's shadow map, in texels.
   *
   * It covers the whole stack - about 120 m across - because the frustum is
   * fitted to the world rather than following the player, so these are chosen
   * for the resulting texel size on the ground: 39 mm at ultra and high, 59 mm
   * at medium. A shadow edge in this game is a chunky prop on flat dirt, and
   * four centimetres of it is below what anyone will look at; twelve, which is
   * what 1024 gave, is not.
   */
  shadowMapSize: number;
  /** Straw instances spread across the whole pile. */
  shellBudget: number;
  /** Straw instances packed into the detail band that follows the player. */
  bandBudget: number;
  bloom: boolean;
  bloomStrength: number;
  antialias: boolean;
  /** Metres at which scatter props stop being drawn. */
  scatterDistance: number;
  particleBudget: number;
  anisotropy: number;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  low: {
    maxPixelRatio: 1,
    shadows: false,
    shadowMapSize: 1024,
    shellBudget: 4500,
    bandBudget: 1800,
    bloom: false,
    bloomStrength: 0,
    antialias: false,
    scatterDistance: 60,
    particleBudget: 300,
    anisotropy: 1,
  },
  medium: {
    maxPixelRatio: 1.25,
    shadows: true,
    shadowMapSize: 2048,
    shellBudget: 9000,
    bandBudget: 3600,
    bloom: true,
    bloomStrength: 0.16,
    antialias: false,
    scatterDistance: 95,
    particleBudget: 600,
    anisotropy: 4,
  },
  high: {
    maxPixelRatio: 1.6,
    shadows: true,
    shadowMapSize: 3072,
    shellBudget: 15000,
    bandBudget: 6000,
    bloom: true,
    bloomStrength: 0.22,
    antialias: true,
    scatterDistance: 140,
    particleBudget: 1100,
    anisotropy: 8,
  },
  ultra: {
    maxPixelRatio: 2,
    shadows: true,
    shadowMapSize: 3072,
    shellBudget: 24000,
    bandBudget: 9000,
    bloom: true,
    bloomStrength: 0.26,
    antialias: true,
    scatterDistance: 200,
    particleBudget: 1800,
    anisotropy: 16,
  },
};

/** How far adaptive resolution is allowed to go before it stops helping. */
const RESOLUTION_FLOOR = 0.62;

/**
 * How long frames must stay long at the resolution floor before the engine
 * gives up a whole quality tier.
 *
 * Long enough that loading a new stack, an advert or a browser hiccup cannot
 * trigger it; short enough that a player on a machine that cannot hold sixty
 * is not left there for a minute.
 */
const TIER_DEMOTE_SECONDS = 6;

const LOWER_TIER: Record<QualityTier, QualityTier | null> = {
  ultra: 'high',
  high: 'medium',
  medium: 'low',
  low: null,
};

/** Fixed simulation rate. Rendering is decoupled and interpolates between steps. */
export const FIXED_STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

/**
 * Owns the renderer, the frame loop and the quality budget.
 *
 * The loop is a fixed-timestep accumulator: gameplay always advances in 1/60 s
 * increments so physics and economy tick identically on a 30 Hz laptop and a
 * 240 Hz monitor, while rendering happens once per animation frame with an
 * interpolation factor for smooth motion.
 */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;

  /** Deterministic gameplay tick. */
  readonly fixedUpdate = new Signal<number>();
  /** Per-frame visual update; payload is the frame's real delta in seconds. */
  readonly frameUpdate = new Signal<number>();
  /** Fired after the scene is drawn. */
  readonly afterRender = new Signal<number>();
  readonly qualityChanged = new Signal<QualityTier>();

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  // `Clock` is deprecated since r183; `Timer` is the core replacement and has
  // the useful property that getDelta() is stable within a step.
  private readonly timer = new Timer();
  private accumulator = 0;
  private rafHandle = 0;
  private running = false;

  private tier: QualityTier;
  private profile: QualityProfile;

  /** Adaptive resolution: 1 = native, scaled down when frames run long. */
  private resolutionScale = 1;
  private frameTimeAverage = FIXED_STEP;
  private adaptationCooldown = 0;
  adaptiveResolution = true;
  /**
   * Whether the engine may drop its own quality tier when frames stay long.
   *
   * Set by the game from the player's Quality setting: only "auto" gives the
   * engine permission to overrule itself. A player who chose Ultra and meant
   * it keeps Ultra.
   */
  adaptiveQuality = true;
  /** Seconds spent slow at the resolution floor, before stepping the tier. */
  private slowAtFloor = 0;

  /** Smoothed frames per second, for the debug overlay. */
  fps = 60;
  /** Interpolation factor between the previous and current simulation step. */
  alpha = 0;

  constructor(canvas: HTMLCanvasElement, tier?: QualityTier) {
    this.canvas = canvas;
    this.tier = tier ?? detectQualityTier();
    this.profile = QUALITY_PROFILES[this.tier];

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: this.profile.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = 'srgb';
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.profile.shadows;
    // PCFSoftShadowMap is deprecated in r185 and silently downgrades to
    // PCFShadowMap with a console warning, so ask for what we actually get.
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.camera = new PerspectiveCamera(72, 1, 0.06, 900);
    this.camera.rotation.order = 'YXZ';

    this.buildComposer();
    this.handleResize();
    window.addEventListener('resize', this.handleResize, { passive: true });
    window.addEventListener('orientationchange', this.handleResize, { passive: true });
    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  /** Current adaptive-resolution factor, 0.62..1. Read by the dev overlay. */
  get renderScale(): number {
    return this.resolutionScale;
  }

  get quality(): QualityTier {
    return this.tier;
  }

  get settings(): QualityProfile {
    return this.profile;
  }

  setQuality(tier: QualityTier): void {
    if (tier === this.tier) return;
    this.tier = tier;
    this.profile = QUALITY_PROFILES[tier];
    this.renderer.shadowMap.enabled = this.profile.shadows;
    this.renderer.shadowMap.needsUpdate = true;
    this.resolutionScale = 1;
    this.buildComposer();
    this.handleResize();
    this.qualityChanged.emit(tier);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    this.accumulator = 0;
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafHandle);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.composer?.dispose();
    this.renderer.dispose();
  }

  // ------------------------------------------------------------------ loop
  private readonly tick = (): void => {
    this.rafHandle = requestAnimationFrame(this.tick);
    if (!this.running) return;

    // A tab that was backgrounded returns a huge delta; clamping it stops the
    // simulation from trying to catch up through thousands of steps.
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), 0.25);
    this.frameTimeAverage += (delta - this.frameTimeAverage) * 0.08;
    this.fps = 1 / Math.max(this.frameTimeAverage, 1e-4);

    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.fixedUpdate.emit(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
    this.alpha = this.accumulator / FIXED_STEP;

    this.frameUpdate.emit(delta);

    this.renderer.info.reset();
    if (this.composer) this.composer.render(delta);
    else this.renderer.render(this.scene, this.camera);

    this.adapt(delta);
    this.afterRender.emit(delta);
  };

  /**
   * Nudge the internal render resolution to hold the frame budget.
   *
   * Dropping to 80 % linear resolution costs a third of the pixels and is far
   * less noticeable than a stutter, so this is the first lever we pull before
   * asking the player to turn anything off.
   */
  private adapt(delta: number): void {
    if (!this.adaptiveResolution) return;
    this.adaptationCooldown -= delta;

    const target = FIXED_STEP;
    const slow = this.frameTimeAverage > target * 1.35;
    const fast = this.frameTimeAverage < target * 0.82;

    // How long we have been slow with nothing left to give is counted every
    // frame, not every time the cooldown lapses: the cooldown is there to stop
    // the resolution oscillating, and letting it gate this clock as well made
    // six seconds of patience take a minute and a half to elapse.
    if (slow && this.resolutionScale <= RESOLUTION_FLOOR + 1e-3) this.slowAtFloor += delta;
    else if (!slow) this.slowAtFloor = 0;

    if (this.adaptationCooldown > 0) return;

    // Resolution is the first lever because it is the only one with no visual
    // discontinuity. But it only helps a renderer that is short of fill rate,
    // and a weak GPU is just as often short of vertex throughput or shadow
    // budget - in which case the frame stays long all the way down to the
    // floor and the picture is soft for nothing. So when the floor has been
    // held for several seconds and frames are still long, step the whole tier
    // down and hand the resolution back.
    if (this.adaptiveQuality && this.slowAtFloor >= TIER_DEMOTE_SECONDS) {
      const lower = LOWER_TIER[this.tier];
      if (lower) {
        this.slowAtFloor = 0;
        this.setQuality(lower);
        // Give the new tier a fair hearing rather than judging it on the
        // average the old one poisoned.
        this.frameTimeAverage = FIXED_STEP;
        this.adaptationCooldown = 2;
        return;
      }
    }

    let next = this.resolutionScale;
    if (slow) next = Math.max(RESOLUTION_FLOOR, this.resolutionScale - 0.08);
    else if (fast) next = Math.min(1, this.resolutionScale + 0.04);

    if (Math.abs(next - this.resolutionScale) > 0.001) {
      this.resolutionScale = next;
      this.applySize();
      this.adaptationCooldown = 0.7;
    } else {
      this.adaptationCooldown = 0.25;
    }
  }

  // --------------------------------------------------------------- plumbing
  private buildComposer(): void {
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    if (!this.profile.bloom) return;

    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    // A tight threshold keeps bloom on genuinely bright things - the sun, gem
    // glints, the needle's specular - instead of hazing the whole frame.
    const bloom = new UnrealBloomPass(new Vector2(1, 1), this.profile.bloomStrength, 0.55, 0.86);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
    this.bloomPass = bloom;
  }

  setBloomStrength(strength: number): void {
    if (this.bloomPass) this.bloomPass.strength = strength;
  }

  private readonly handleResize = (): void => {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applySize();
  };

  private applySize(): void {
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const ratio = clamp(window.devicePixelRatio || 1, 0.75, this.profile.maxPixelRatio) * this.resolutionScale;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    this.composer?.setPixelRatio(ratio);
    this.composer?.setSize(width, height);
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.stop();
  };

  private readonly onContextRestored = (): void => {
    this.buildComposer();
    this.handleResize();
    this.start();
  };
}

/**
 * Guess a starting quality tier.
 *
 * There is no reliable way to ask a browser how fast its GPU is, so this uses
 * the signals that correlate best in practice - memory, core count, whether the
 * device is a phone - and then adaptive resolution and the settings menu
 * handle the cases it gets wrong.
 */
export function detectQualityTier(): QualityTier {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarsePointer = matchMedia('(pointer: coarse)').matches;
  const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 720;

  let tier: QualityTier;
  if (coarsePointer && smallScreen) tier = memory >= 6 && cores >= 6 ? 'medium' : 'low';
  else if (memory >= 8 && cores >= 12) tier = 'ultra';
  else if (memory >= 8 && cores >= 8) tier = 'high';
  else if (memory >= 4 && cores >= 4) tier = 'medium';
  else tier = 'low';

  // RAM and core count describe the CPU, and nothing in this frame is waiting
  // on the CPU. A desktop with thirty-two gigabytes, sixteen threads and an
  // integrated GPU was being handed Ultra - a device pixel ratio of two, 3072
  // shadow maps and bloom - on the strength of specifications that have
  // nothing to do with any of them. So the renderer string gets a veto.
  const gpu = detectGpuClass();
  if (gpu === 'software') return 'low';
  if (gpu === 'integrated' && (tier === 'ultra' || tier === 'high')) return 'medium';
  return tier;
}

export type GpuClass = 'software' | 'integrated' | 'discrete' | 'unknown';

/**
 * Classify the GPU from its renderer string.
 *
 * Crude, and deliberately so: the only decisions riding on it are "do not
 * start this machine on Ultra" and "this is a software rasteriser, start at
 * the bottom", both of which adaptive quality will correct anyway if the
 * guess is wrong. It reads from a throwaway context and drops it immediately,
 * because the string is wanted before the real renderer exists.
 */
export function detectGpuClass(): GpuClass {
  let canvas: HTMLCanvasElement | null = null;
  try {
    canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    // Not being able to make a throwaway context is not evidence of a software
    // rasteriser - the game has already checked that WebGL 2 works, and
    // browsers cap how many live contexts a page may hold. Answering
    // "software" here would pin a perfectly good machine to the lowest tier
    // with no way back up but the settings menu.
    if (!gl) return 'unknown';
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(
      (debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    ).toLowerCase();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (!name) return 'unknown';
    if (/swiftshader|llvmpipe|software|basic render|microsoft basic/.test(name)) return 'software';
    if (/nvidia|geforce|rtx|gtx|radeon (rx|pro)|\bnavi\b|apple m\d/.test(name)) return 'discrete';
    if (/intel|uhd graphics|hd graphics|iris|vega \d|mali|adreno|powervr|videocore/.test(name)) {
      return 'integrated';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    canvas?.remove();
  }
}

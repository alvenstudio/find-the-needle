import {
  ACESFilmicToneMapping,
  Clock,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Vector2 } from 'three';

import { Signal } from './Signals';
import { clamp } from './MathX';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  /** Upper bound on the device pixel ratio we are willing to render at. */
  maxPixelRatio: number;
  shadows: boolean;
  shadowMapSize: number;
  /** Number of straw instances the haystack shell is allowed to keep alive. */
  strawBudget: number;
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
    strawBudget: 7000,
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
    shadowMapSize: 1024,
    strawBudget: 13000,
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
    shadowMapSize: 2048,
    strawBudget: 20000,
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
    strawBudget: 30000,
    bloom: true,
    bloomStrength: 0.26,
    antialias: true,
    scatterDistance: 200,
    particleBudget: 1800,
    anisotropy: 16,
  },
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
  private readonly clock = new Clock(false);
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
    this.renderer.shadowMap.type = PCFSoftShadowMap;
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
    this.clock.start();
    this.accumulator = 0;
    this.rafHandle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    this.clock.stop();
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
    const delta = Math.min(this.clock.getDelta(), 0.25);
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
    if (this.adaptationCooldown > 0) return;

    const target = FIXED_STEP;
    const slow = this.frameTimeAverage > target * 1.35;
    const fast = this.frameTimeAverage < target * 0.82;
    let next = this.resolutionScale;
    if (slow) next = Math.max(0.62, this.resolutionScale - 0.08);
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

  if (coarsePointer && smallScreen) return memory >= 6 && cores >= 6 ? 'medium' : 'low';
  if (memory >= 8 && cores >= 12) return 'ultra';
  if (memory >= 8 && cores >= 8) return 'high';
  if (memory >= 4 && cores >= 4) return 'medium';
  return 'low';
}

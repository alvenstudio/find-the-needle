import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Object3D,
  type PerspectiveCamera,
  type Scene,
} from 'three';

import type { Engine } from '../core/Engine';
import { advanceSharedUniforms, getSharedUniforms } from '../core/Materials';
import { damp } from '../core/MathX';
import { Sky, SKY_PRESETS, cloneSkyPreset, type SkyMood, type SkyPreset } from './Sky';

/**
 * Lighting, fog and mood.
 *
 * One directional sun plus one hemisphere fill is the whole rig. In a stylised
 * game that is not a compromise: a hemisphere light gives exactly the sky-above,
 * bounce-below gradient that hand-painted art fakes, and adding more lights
 * would flatten the silhouettes the models were built for.
 *
 * The interesting work is in the shadow camera, which is fitted once to the
 * whole yard rather than following the player around it.
 */

/** Slack around the fitted frustum, so nothing clips at the edge. */
const SHADOW_MARGIN = 2;
/** Fallback extent, used until a stack has said how big it is. */
const DEFAULT_CAST_RADIUS = 60;
const DEFAULT_CAST_TOP = 24;
const MOOD_FADE_SECONDS = 2.4;

export class Environment {
  readonly sky = new Sky();
  readonly sun = new DirectionalLight(0xffffff, 3);
  readonly fill = new HemisphereLight(0xbfe3ff, 0x7e9a54, 1.1);
  readonly sunTarget = new Object3D();

  private readonly fog = new FogExp2(0xd8ecf8, 0.005);
  private readonly current: SkyPreset;
  private readonly from: SkyPreset;
  private readonly to: SkyPreset;
  private mood: SkyMood = 'noon';
  private fade = 1;

  private castRadius = DEFAULT_CAST_RADIUS;
  private castTop = DEFAULT_CAST_TOP;
  private elapsed = 0;

  constructor(private readonly engine: Engine) {
    this.current = cloneSkyPreset(SKY_PRESETS.noon);
    this.from = cloneSkyPreset(SKY_PRESETS.noon);
    this.to = cloneSkyPreset(SKY_PRESETS.noon);

    const scene: Scene = engine.scene;
    scene.fog = this.fog;
    this.sky.addTo(scene);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.setScalar(engine.settings.shadowMapSize);
    // A small negative bias plus a normal bias kills acne on the haystack's
    // gentle slopes without producing peter-panning on the props.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.045;
    this.sun.target = this.sunTarget;

    scene.add(this.sun, this.sunTarget, this.fill);
    this.applyImmediate('noon');

    engine.qualityChanged.on(() => {
      this.sun.shadow.mapSize.setScalar(engine.settings.shadowMapSize);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
      this.sun.castShadow = engine.settings.shadows;
    });
  }

  get preset(): SkyPreset {
    return this.current;
  }

  get currentMood(): SkyMood {
    return this.mood;
  }

  /** Snap straight to a mood with no cross-fade. Used on first load. */
  applyImmediate(mood: SkyMood): void {
    this.mood = mood;
    Object.assign(this.current, SKY_PRESETS[mood]);
    Object.assign(this.from, SKY_PRESETS[mood]);
    Object.assign(this.to, SKY_PRESETS[mood]);
    this.fade = 1;
    this.pushPreset();
  }

  /**
   * How big the stack we are standing in is: a cylinder around the origin
   * containing everything in it that casts a shadow.
   */
  setCastExtent(radius: number, top: number): void {
    this.castRadius = Math.max(8, radius);
    this.castTop = Math.max(2, top);
  }

  /** Cross-fade to a new mood over a couple of seconds. */
  setMood(mood: SkyMood): void {
    if (mood === this.mood) return;
    Object.assign(this.from, this.current);
    Object.assign(this.to, SKY_PRESETS[mood]);
    this.mood = mood;
    this.fade = 0;
  }

  update(dt: number, camera: PerspectiveCamera): void {
    this.elapsed += dt;

    if (this.fade < 1) {
      this.fade = Math.min(1, this.fade + dt / MOOD_FADE_SECONDS);
      // Ease the blend so the transition starts and lands gently.
      const t = this.fade * this.fade * (3 - 2 * this.fade);
      Sky.blend(this.from, this.to, t, this.current);
      this.pushPreset();
    }

    this.sky.update(this.elapsed, camera);
    advanceSharedUniforms(this.elapsed, this.current.wind);
    this.updateShadowCamera();

    // A gentle exposure drift makes moving between tiers feel like the eye
    // adjusting rather than a hard cut.
    this.engine.renderer.toneMappingExposure = damp(
      this.engine.renderer.toneMappingExposure,
      this.current.exposure,
      3,
      dt,
    );
  }

  private pushPreset(): void {
    const preset = this.current;
    this.sky.apply(preset);

    this.sun.color.set(preset.sun);
    this.sun.intensity = preset.sunIntensity;
    this.fill.color.set(preset.ambientSky);
    this.fill.groundColor.set(preset.ambientGround);
    this.fill.intensity = preset.ambientIntensity;

    this.fog.color.set(preset.fog);
    this.fog.density = preset.fogDensity;
    this.engine.renderer.setClearColor(new Color(preset.horizon));
    this.engine.setBloomStrength(preset.bloom);
    getSharedUniforms().uRimColor.value.set(preset.haze);
  }

  /**
   * Fit the shadow frustum to the whole yard, and leave it there.
   *
   * It used to be a 26 m square that followed the player, snapped to the
   * shadow map's texel grid to stop the edges crawling. The snap worked; the
   * following did not. Twenty-six metres from the player does not reach the
   * tree line - the trees stand from 32 m out, and the yard measures 59 m from
   * the origin to its farthest caster - so a tree cast a shadow while you were
   * near it and stopped when you walked away, and a whole hillside switched
   * its shadows on and off as you crossed the yard.
   *
   * Nothing here needs to move. The world is a bounded disc, the player cannot
   * leave it, and the sun holds one elevation per stack. So the frustum is fitted
   * to the disc rather than to the player, and it is then simply correct: every
   * caster is inside it in every frame from every position, which is a stronger
   * guarantee than snapping could give. It needs no snapping either, because a
   * projection that never changes samples the same texels every frame by
   * construction.
   *
   * The fit is analytic rather than a loop over corners. The light's right axis
   * is horizontal, so a disc of radius R needs exactly +-R across it and height
   * contributes nothing. Its up axis is tilted by the sun's elevation, so the
   * same disc needs R*sin(elevation) along that axis and a caster of height h
   * adds h*cos(elevation) - which is why a low sun wants a *shorter* frustum in
   * that direction, not a longer one.
   */
  private updateShadowCamera(): void {
    const direction = this.sky.sunVector;
    const radius = this.castRadius + SHADOW_MARGIN;
    const half = this.castTop / 2 + SHADOW_MARGIN;
    // `sunVector` is a unit vector, so its y component is sin(elevation).
    const sinE = Math.abs(direction.y);
    const cosE = Math.sqrt(Math.max(0, 1 - sinE * sinE));

    const along = radius * sinE + half * cosE;
    const depth = radius * cosE + half * sinE;
    const distance = depth + 10;
    const centreY = this.castTop / 2;

    this.sunTarget.position.set(0, centreY, 0);
    this.sun.position.set(
      direction.x * distance,
      centreY + direction.y * distance,
      direction.z * distance,
    );

    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -radius;
    shadowCamera.right = radius;
    shadowCamera.top = along;
    shadowCamera.bottom = -along;
    shadowCamera.near = Math.max(0.5, distance - depth);
    shadowCamera.far = distance + depth;

    this.sun.updateMatrixWorld(true);
    this.sunTarget.updateMatrixWorld(true);
    shadowCamera.updateProjectionMatrix();
  }

  dispose(): void {
    this.sky.dispose();
    this.sun.dispose();
    this.fill.dispose();
  }
}

import {
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Matrix4,
  Object3D,
  Vector3,
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
 * The interesting work is in the shadow camera, which follows the player in a
 * tight frustum and is snapped to the shadow map's own texel grid. Without that
 * snap, shadow edges crawl and shimmer with every step - the single most
 * distracting artefact in an otherwise clean scene.
 */

const SHADOW_RADIUS = 26;
const SHADOW_DEPTH = 190;
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

  private readonly lightSpace = new Matrix4();
  private readonly snapped = new Vector3();
  private readonly focus = new Vector3();
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
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = SHADOW_DEPTH;
    this.sun.shadow.camera.left = -SHADOW_RADIUS;
    this.sun.shadow.camera.right = SHADOW_RADIUS;
    this.sun.shadow.camera.top = SHADOW_RADIUS;
    this.sun.shadow.camera.bottom = -SHADOW_RADIUS;
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

  /** Cross-fade to a new mood over a couple of seconds. */
  setMood(mood: SkyMood): void {
    if (mood === this.mood) return;
    Object.assign(this.from, this.current);
    Object.assign(this.to, SKY_PRESETS[mood]);
    this.mood = mood;
    this.fade = 0;
  }

  update(dt: number, camera: PerspectiveCamera, focus: Vector3): void {
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
    this.updateShadowCamera(focus);

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
   * Keep the shadow frustum on the player, snapped to the shadow map's texel
   * grid so the depth samples land in the same places from frame to frame.
   */
  private updateShadowCamera(focus: Vector3): void {
    this.focus.copy(focus);

    const direction = this.sky.sunVector;
    this.sun.position.copy(this.focus).addScaledVector(direction, SHADOW_DEPTH * 0.45);
    this.sunTarget.position.copy(this.focus);

    this.sun.updateMatrixWorld(true);
    this.sunTarget.updateMatrixWorld(true);
    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.updateMatrixWorld(true);

    // Round the focus point to whole shadow-map texels *in light space*, then
    // bring it back to world space and re-aim the light at it.
    const texelSize = (SHADOW_RADIUS * 2) / this.engine.settings.shadowMapSize;
    this.lightSpace.copy(shadowCamera.matrixWorldInverse);
    this.snapped.copy(this.focus).applyMatrix4(this.lightSpace);
    this.snapped.x = Math.round(this.snapped.x / texelSize) * texelSize;
    this.snapped.y = Math.round(this.snapped.y / texelSize) * texelSize;
    this.snapped.applyMatrix4(shadowCamera.matrixWorld);

    this.sunTarget.position.copy(this.snapped);
    this.sun.position.copy(this.snapped).addScaledVector(direction, SHADOW_DEPTH * 0.45);
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

import { Euler, Group, Object3D, Vector3, type PerspectiveCamera } from 'three';

import type { Assets } from '../core/Assets';
import { clamp01, damp, lerp, smoothstep, wobble } from '../core/MathX';
import type { ToolDefinition } from './Content';

/**
 * The tool in the player's hands.
 *
 * Every motion here is procedural. Baked animations would mean an authoring
 * round-trip per tool and a keyframe budget in the download, and they would
 * still not react to the things that actually sell a first-person weapon:
 * turning speed, walking speed, the exact moment a swing lands. A handful of
 * eased curves driven by live state does all of it and costs nothing.
 *
 * ORIENTATION: the Blender viewmodels point along -Y, which the glTF Y-up
 * conversion turns into +Z. The camera looks down -Z, so the holder is spun
 * half a turn to point the tool away from the player.
 */

export interface ViewmodelPose {
  /** Resting offset from the camera, in camera space. */
  position: Vector3;
  rotation: Euler;
  scale: number;
}

const POSES: Record<string, ViewmodelPose> = {
  hands: { position: new Vector3(0, -0.34, -0.42), rotation: new Euler(-0.16, 0, 0), scale: 1 },
  pitchfork: { position: new Vector3(0.19, -0.34, -0.52), rotation: new Euler(-0.5, 0.24, 0.16), scale: 0.92 },
  rake: { position: new Vector3(0.2, -0.36, -0.5), rotation: new Euler(-0.52, 0.26, 0.14), scale: 0.92 },
  leaf_blower: { position: new Vector3(0.24, -0.3, -0.46), rotation: new Euler(-0.1, 0.2, 0.06), scale: 0.95 },
  hay_vacuum: { position: new Vector3(0.23, -0.31, -0.5), rotation: new Euler(-0.12, 0.18, 0.05), scale: 0.95 },
  compressor: { position: new Vector3(0.26, -0.34, -0.56), rotation: new Euler(-0.08, 0.16, 0.04), scale: 0.9 },
  magnifier: { position: new Vector3(-0.16, -0.24, -0.38), rotation: new Euler(-0.24, -0.3, 0.1), scale: 1 },
  metal_detector: { position: new Vector3(0.2, -0.4, -0.5), rotation: new Euler(-0.34, 0.22, 0.1), scale: 0.9 },
};

const DEFAULT_POSE: ViewmodelPose = {
  position: new Vector3(0.2, -0.34, -0.5),
  rotation: new Euler(-0.3, 0.2, 0.1),
  scale: 1,
};

/** How far the model lags behind a fast turn, in radians of camera motion. */
const SWAY_STRENGTH = 0.22;
const SWAY_LIMIT = 0.1;
const SWAP_TIME = 0.34;

export class Viewmodel {
  readonly root = new Group();

  private readonly holder = new Group();
  private readonly offhand = new Group();
  private current: Object3D | null = null;
  private currentId = '';
  private offhandModel: Object3D | null = null;

  private readonly basePosition = new Vector3();
  private readonly baseRotation = new Euler();
  private baseScale = 1;

  private readonly sway = new Vector3();
  private readonly swayTarget = new Vector3();

  private swingTime = -1;
  private swingDuration = 0.4;
  private swingStyle: ToolDefinition['swingStyle'] = 'stab';

  private swapTime = 0;
  private pendingModel: string | null = null;

  private streamAmount = 0;
  private elapsed = 0;
  /** Raised while the magnifier is up, which stows the main tool. */
  private inspecting = false;
  private inspectAmount = 0;

  constructor(private readonly assets: Assets) {
    // Half a turn so the tool's business end points away from the camera.
    this.holder.rotation.y = Math.PI;
    this.offhand.rotation.y = Math.PI;
    this.root.add(this.holder, this.offhand);
    this.root.matrixAutoUpdate = false;
    this.applyPose('hands');
  }

  attachTo(camera: PerspectiveCamera): void {
    camera.add(this.root);
  }

  get toolId(): string {
    return this.currentId;
  }

  /** Swap the held tool, playing a lower/raise transition. */
  setTool(model: string): void {
    if (model === this.currentId && this.swapTime === 0) return;
    this.pendingModel = model;
    this.swapTime = SWAP_TIME;
  }

  /** Show or hide the magnifier in the off hand. */
  setInspecting(active: boolean): void {
    if (active === this.inspecting) return;
    this.inspecting = active;
    if (active && !this.offhandModel && this.assets.has('magnifier')) {
      const model = this.assets.instantiate('magnifier');
      configureViewmodelNode(model);
      const pose = POSES.magnifier;
      model.position.set(0, 0, 0);
      this.offhand.position.copy(pose.position);
      this.offhand.rotation.copy(pose.rotation);
      this.offhand.rotation.y += Math.PI;
      this.offhand.scale.setScalar(pose.scale);
      this.offhand.add(model);
      this.offhandModel = model;
    }
  }

  /** Start a swing. Ignored while one is already playing. */
  swing(style: ToolDefinition['swingStyle'], duration: number): void {
    if (this.swingTime >= 0 && this.swingTime < this.swingDuration * 0.55) return;
    this.swingStyle = style;
    // The animation is capped so a very fast tool still reads as a swing
    // rather than a blur, and floored so a slow one does not feel sluggish.
    this.swingDuration = Math.min(Math.max(duration * 0.85, 0.16), 0.5);
    this.swingTime = 0;
  }

  setStreaming(active: boolean): void {
    this.streamAmount = active ? 1 : 0;
  }

  /**
   * Drive the model.
   *
   * `lookDelta` is the camera's rotation this frame, `moveAmount` is how hard
   * the player is walking (0..1) and `bobPhase` is shared with the camera so
   * the tool and the view breathe together instead of beating against
   * each other.
   */
  update(dt: number, lookDelta: { yaw: number; pitch: number }, moveAmount: number, grounded: boolean): void {
    this.elapsed += dt;

    if (this.swapTime > 0) {
      this.swapTime -= dt;
      if (this.pendingModel && this.swapTime <= SWAP_TIME * 0.5) {
        this.mount(this.pendingModel);
        this.pendingModel = null;
      }
      if (this.swapTime < 0) this.swapTime = 0;
    }

    // Sway: the model lags a fast turn, then eases back to rest.
    this.swayTarget.set(
      clampMagnitude(-lookDelta.yaw * SWAY_STRENGTH * 12, SWAY_LIMIT),
      clampMagnitude(-lookDelta.pitch * SWAY_STRENGTH * 12, SWAY_LIMIT),
      0,
    );
    this.sway.x = damp(this.sway.x, this.swayTarget.x, 9, dt);
    this.sway.y = damp(this.sway.y, this.swayTarget.y, 9, dt);

    this.inspectAmount = damp(this.inspectAmount, this.inspecting ? 1 : 0, 11, dt);

    const walk = grounded ? clamp01(moveAmount) : 0;
    const bobX = Math.sin(this.elapsed * 8.2) * 0.018 * walk;
    const bobY = Math.sin(this.elapsed * 16.4) * 0.014 * walk;
    const idleX = wobble(this.elapsed, 0.42) * 0.008;
    const idleY = wobble(this.elapsed, 0.31, 3.3) * 0.006;

    // Swap and inspect both stow the tool downward and out of frame.
    const swapDip = this.swapTime > 0 ? Math.sin((1 - this.swapTime / SWAP_TIME) * Math.PI) : 0;
    const stow = Math.max(swapDip, this.inspectAmount * 0.75);

    const stream = this.streamAmount;
    const shakeX = stream * Math.sin(this.elapsed * 47) * 0.006;
    const shakeY = stream * Math.sin(this.elapsed * 61 + 1.7) * 0.005;

    this.holder.position.set(
      this.basePosition.x + this.sway.x + bobX + idleX + shakeX,
      this.basePosition.y + this.sway.y + bobY + idleY + shakeY - stow * 0.55,
      this.basePosition.z + stream * 0.02,
    );
    this.holder.rotation.set(
      this.baseRotation.x + this.sway.y * 1.4 - stow * 0.9,
      this.baseRotation.y + this.sway.x * 1.6 + Math.PI,
      this.baseRotation.z + this.sway.x * 2.2 + walk * Math.sin(this.elapsed * 8.2) * 0.02,
    );
    this.holder.scale.setScalar(this.baseScale);

    if (this.swingTime >= 0) {
      this.swingTime += dt;
      const t = this.swingTime / this.swingDuration;
      if (t >= 1) this.swingTime = -1;
      else this.applySwing(t);
    }

    this.offhand.visible = this.inspectAmount > 0.02;
    if (this.offhand.visible) {
      const raise = smoothstep(this.inspectAmount);
      this.offhand.position.set(
        POSES.magnifier.position.x + this.sway.x * 0.6,
        POSES.magnifier.position.y - (1 - raise) * 0.5 + this.sway.y * 0.6 + idleY,
        POSES.magnifier.position.z + (1 - raise) * 0.12,
      );
      this.offhand.rotation.x = POSES.magnifier.rotation.x - (1 - raise) * 0.7;
    }

    this.root.updateMatrix();
  }

  /**
   * Shape the swing.
   *
   * Each style is an anticipation, a fast strike and a settle. The strike is
   * deliberately much shorter than the wind-up: impact should feel like it
   * arrives, not like it is being lowered into place.
   */
  private applySwing(t: number): void {
    const anticipate = smoothstep(clamp01(t / 0.3));
    const strike = smoothstep(clamp01((t - 0.28) / 0.22));
    const settle = smoothstep(clamp01((t - 0.5) / 0.5));

    if (this.swingStyle === 'sweep') {
      const arc = lerp(anticipate * 0.5, 1, strike) - settle;
      this.holder.position.x += lerp(0.14, -0.26, clamp01(arc)) * 0.7;
      this.holder.position.y += Math.sin(clamp01(arc) * Math.PI) * 0.08;
      this.holder.rotation.z += lerp(0.35, -0.5, clamp01(arc));
      this.holder.rotation.y += lerp(0.2, -0.34, clamp01(arc));
    } else {
      const pull = anticipate - strike;
      const thrust = strike - settle;
      this.holder.position.z += pull * 0.18 - thrust * 0.34;
      this.holder.position.y += pull * 0.12 - thrust * 0.14;
      this.holder.rotation.x += pull * 0.42 - thrust * 0.6;
      this.holder.rotation.z += pull * 0.1;
    }
  }

  private mount(model: string): void {
    if (this.current) {
      this.holder.remove(this.current);
      this.current = null;
    }
    if (!this.assets.has(model)) {
      this.currentId = model;
      this.applyPose(model);
      return;
    }
    const object = this.assets.instantiate(model);
    configureViewmodelNode(object);
    this.holder.add(object);
    this.current = object;
    this.currentId = model;
    this.applyPose(model);
  }

  private applyPose(model: string): void {
    const pose = POSES[model] ?? DEFAULT_POSE;
    this.basePosition.copy(pose.position);
    this.baseRotation.copy(pose.rotation);
    this.baseScale = pose.scale;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.clear();
    this.current = null;
    this.offhandModel = null;
  }
}

/**
 * Viewmodels never cast or receive shadows.
 *
 * A shadow from a tool held 40 cm from the eye lands as a huge dark blob on
 * whatever is in front of the player, and its own shadow acne is unavoidable at
 * that scale. Every game does this; it is not a shortcut.
 */
function configureViewmodelNode(object: Object3D): void {
  object.traverse((node) => {
    node.castShadow = false;
    node.receiveShadow = false;
    node.frustumCulled = false;
  });
}

function clampMagnitude(value: number, limit: number): number {
  return value > limit ? limit : value < -limit ? -limit : value;
}

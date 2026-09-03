import type { PerspectiveCamera } from 'three';

import { clamp01, damp, wobble } from '../core/MathX';

/**
 * Camera feel.
 *
 * Shake, recoil kick and hit-stop are the difference between a swing that
 * removes hay and a swing that *lands*. All three are applied after the player
 * controller has posed the camera, so they never fight the movement code and
 * can be scaled to zero for players who ask for reduced motion.
 *
 * Shake is a sum of two out-of-phase wobbles rather than white noise: random
 * jitter reads as a broken renderer, whereas a couple of decaying oscillations
 * read as impact.
 */
export class ScreenEffects {
  /** Global scale, driven by the reduced-motion setting. */
  intensity = 1;

  private shakeAmount = 0;
  private shakeDecay = 4;
  private kickPitch = 0;
  private kickYaw = 0;
  private kickRoll = 0;
  private elapsed = 0;
  private fovOffset = 0;
  private fovTarget = 0;

  /** Seconds of frozen simulation remaining. */
  private hitStop = 0;

  shake(amount: number, decay = 5): void {
    this.shakeAmount = Math.min(0.9, this.shakeAmount + amount * this.intensity);
    this.shakeDecay = decay;
  }

  /** A directional impulse - used for swings and landings. */
  kick(pitch: number, yaw = 0, roll = 0): void {
    this.kickPitch += pitch * this.intensity;
    this.kickYaw += yaw * this.intensity;
    this.kickRoll += roll * this.intensity;
  }

  /** Punch the field of view, for a big reveal. */
  punchFov(amount: number): void {
    this.fovTarget = amount * this.intensity;
  }

  /**
   * Freeze the simulation for a few frames.
   *
   * Two or three frames on a heavy impact is imperceptible as a pause and very
   * perceptible as weight.
   */
  freeze(seconds: number): void {
    this.hitStop = Math.max(this.hitStop, seconds * this.intensity);
  }

  /** Returns the time scale for this frame: 0 while frozen, 1 otherwise. */
  consumeTimeScale(dt: number): number {
    if (this.hitStop <= 0) return 1;
    this.hitStop -= dt;
    return 0;
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.shakeAmount = Math.max(0, this.shakeAmount - this.shakeDecay * this.shakeAmount * dt - dt * 0.05);
    this.kickPitch = damp(this.kickPitch, 0, 11, dt);
    this.kickYaw = damp(this.kickYaw, 0, 11, dt);
    this.kickRoll = damp(this.kickRoll, 0, 9, dt);
    this.fovTarget = damp(this.fovTarget, 0, 4, dt);
    this.fovOffset = damp(this.fovOffset, this.fovTarget, 14, dt);
  }

  /** Fold the current impulses into an already-posed camera. */
  apply(camera: PerspectiveCamera, baseFov: number): void {
    const amount = this.shakeAmount;
    if (amount > 0.0005) {
      const t = this.elapsed;
      camera.rotation.x += wobble(t, 31) * amount * 0.05;
      camera.rotation.y += wobble(t, 27, 5.1) * amount * 0.05;
      camera.rotation.z += wobble(t, 19, 9.7) * amount * 0.035;
    }
    camera.rotation.x += this.kickPitch;
    camera.rotation.y += this.kickYaw;
    camera.rotation.z += this.kickRoll;

    const fov = baseFov + this.fovOffset;
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  reset(): void {
    this.shakeAmount = 0;
    this.kickPitch = this.kickYaw = this.kickRoll = 0;
    this.fovOffset = this.fovTarget = 0;
    this.hitStop = 0;
  }
}

/**
 * Full-screen colour washes, drawn as a DOM layer.
 *
 * A DOM element is genuinely the right tool here: it composites on the GPU for
 * free, needs no render target, and survives the post-processing chain without
 * being tone-mapped into something unintended.
 */
export class FlashLayer {
  private readonly element: HTMLElement;
  private strength = 0;
  private decay = 3;

  constructor(parent: HTMLElement) {
    this.element = document.createElement('div');
    this.element.className = 'flash-layer';
    this.element.setAttribute('aria-hidden', 'true');
    parent.appendChild(this.element);
  }

  flash(color: string, strength = 0.5, decay = 3): void {
    this.element.style.backgroundColor = color;
    this.strength = Math.max(this.strength, clamp01(strength));
    this.decay = decay;
  }

  update(dt: number): void {
    if (this.strength <= 0) return;
    this.strength = Math.max(0, this.strength - this.decay * dt);
    this.element.style.opacity = this.strength.toFixed(3);
  }

  dispose(): void {
    this.element.remove();
  }
}

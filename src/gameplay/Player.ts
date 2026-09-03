import { PerspectiveCamera, Vector2, Vector3 } from 'three';

import type { Input } from '../core/Input';
import { clamp, clamp01, damp, lerp, smoothstep, wobble } from '../core/MathX';
import type { CollisionWorld } from '../world/Collision';

/**
 * The first-person controller.
 *
 * Movement runs entirely inside the fixed 60 Hz step and stores the previous
 * position, so rendering can interpolate and the camera stays glass-smooth on a
 * 144 Hz display without the simulation ever seeing a variable timestep.
 *
 * The feel is deliberately arcade rather than simulation: high acceleration,
 * high friction, generous coyote time and a buffered jump. Digging through hay
 * should feel brisk, and a player who is fighting the controller is not
 * enjoying the haystack.
 */

export interface PlayerTuning {
  walkSpeed: number;
  sprintMultiplier: number;
  crouchMultiplier: number;
  acceleration: number;
  airAcceleration: number;
  friction: number;
  gravity: number;
  jumpSpeed: number;
  radius: number;
  height: number;
  eyeHeight: number;
  crouchEyeHeight: number;
  stepUp: number;
  /** Slope in radians above which the player starts sliding back down. */
  slopeLimit: number;
}

export const DEFAULT_TUNING: PlayerTuning = {
  walkSpeed: 4.35,
  sprintMultiplier: 1.62,
  crouchMultiplier: 0.52,
  acceleration: 52,
  airAcceleration: 9,
  friction: 13,
  gravity: 23,
  jumpSpeed: 6.0,
  radius: 0.34,
  height: 1.75,
  eyeHeight: 1.62,
  crouchEyeHeight: 1.02,
  stepUp: 0.58,
  slopeLimit: 0.92,
};

const COYOTE_TIME = 0.12;
const JUMP_BUFFER = 0.14;
const MAX_PITCH = Math.PI * 0.49;

export interface PlayerModifiers {
  /** Multiplier on walk speed from upgrades and rebirths. */
  speed: number;
  /** Multiplier on jump height. */
  jump: number;
}

export class Player {
  readonly position = new Vector3(0, 0, 0);
  readonly velocity = new Vector3();
  readonly forward = new Vector3(0, 0, -1);
  readonly right = new Vector3(1, 0, 0);

  yaw = 0;
  pitch = 0;
  grounded = false;
  sprinting = false;
  crouching = false;

  readonly tuning: PlayerTuning = { ...DEFAULT_TUNING };
  readonly modifiers: PlayerModifiers = { speed: 1, jump: 1 };

  /** Metres walked, for stats and the step-sound cadence. */
  distanceTravelled = 0;
  /** Fires when the feet touch down; payload is the landing impact speed. */
  onLand: ((impact: number) => void) | null = null;
  onStep: ((speed: number) => void) | null = null;

  /** Set false while a menu owns the input. */
  controlEnabled = true;

  private readonly previousPosition = new Vector3();
  private readonly moveInput = new Vector2();
  private readonly lookDelta = { yaw: 0, pitch: 0 };
  private readonly wishDirection = new Vector3();
  private readonly scratch = new Vector3();

  private coyote = 0;
  private jumpBuffered = 0;
  private eyeOffset = DEFAULT_TUNING.eyeHeight;
  private bobPhase = 0;
  private bobAmount = 0;
  private landingDip = 0;
  private stepAccumulator = 0;
  private slopeSpeedScale = 1;

  constructor(
    private readonly input: Input,
    private readonly world: CollisionWorld,
  ) {
    this.previousPosition.copy(this.position);
  }

  teleport(x: number, z: number, yaw = this.yaw): void {
    this.position.set(x, this.world.surfaceHeight(x, z), z);
    this.previousPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = true;
  }

  /** Current eye position, unsmoothed. Used for gameplay queries. */
  eyePosition(out = new Vector3()): Vector3 {
    return out.set(this.position.x, this.position.y + this.eyeOffset, this.position.z);
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /** How fast the player is going relative to their maximum, 0..1. */
  get speedFraction(): number {
    return clamp01(this.speed / (this.tuning.walkSpeed * this.tuning.sprintMultiplier * this.modifiers.speed));
  }

  // ------------------------------------------------------------------- step
  update(dt: number): void {
    this.previousPosition.copy(this.position);

    if (this.controlEnabled) {
      this.input.drainLook(this.lookDelta);
      this.yaw += this.lookDelta.yaw;
      this.pitch = clamp(this.pitch + this.lookDelta.pitch, -MAX_PITCH, MAX_PITCH);
      this.input.moveVector(this.moveInput);
      this.sprinting = this.input.isDown('sprint') && this.moveInput.y > 0.1;
      this.crouching = this.input.isDown('crouch');
      if (this.input.wasPressed('jump')) this.jumpBuffered = JUMP_BUFFER;
    } else {
      this.moveInput.set(0, 0);
      this.sprinting = false;
    }

    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.forward.set(-sinYaw, 0, -cosYaw);
    this.right.set(cosYaw, 0, -sinYaw);

    this.wishDirection
      .set(0, 0, 0)
      .addScaledVector(this.forward, this.moveInput.y)
      .addScaledVector(this.right, this.moveInput.x);
    const wishLength = this.wishDirection.length();
    if (wishLength > 1e-4) this.wishDirection.multiplyScalar(1 / wishLength);

    this.applyMovement(dt, wishLength);
    this.integrate(dt);
    this.updateCameraFeel(dt);

    this.coyote = this.grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    this.jumpBuffered = Math.max(0, this.jumpBuffered - dt);
  }

  private applyMovement(dt: number, wishLength: number): void {
    const tuning = this.tuning;
    let target = tuning.walkSpeed * this.modifiers.speed * this.slopeSpeedScale;
    if (this.sprinting) target *= tuning.sprintMultiplier;
    if (this.crouching && this.grounded) target *= tuning.crouchMultiplier;
    target *= clamp01(wishLength);

    const acceleration = this.grounded ? tuning.acceleration : tuning.airAcceleration;

    if (wishLength > 1e-4) {
      // Accelerate toward the wish velocity rather than snapping to it, and
      // only along the wish direction, so strafing does not add speed.
      const currentAlongWish = this.velocity.x * this.wishDirection.x + this.velocity.z * this.wishDirection.z;
      const add = Math.min(target - currentAlongWish, acceleration * dt);
      if (add > 0) {
        this.velocity.x += this.wishDirection.x * add;
        this.velocity.z += this.wishDirection.z * add;
      }
    }

    if (this.grounded) {
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > 1e-4) {
        // Friction is applied as a constant deceleration with a floor, which
        // stops the classic "ice skating" of a purely multiplicative model.
        const drop = Math.max(speed, 2) * tuning.friction * dt * (wishLength > 1e-4 ? 0.35 : 1);
        const scale = Math.max(0, speed - drop) / speed;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }

    if (this.jumpBuffered > 0 && this.coyote > 0) {
      this.velocity.y = tuning.jumpSpeed * this.modifiers.jump;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffered = 0;
    }

    this.velocity.y -= tuning.gravity * dt;
    // Terminal velocity keeps a long fall from tunnelling through the ground.
    if (this.velocity.y < -38) this.velocity.y = -38;
  }

  private integrate(dt: number): void {
    const tuning = this.tuning;
    const startY = this.position.y;

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.position.y += this.velocity.y * dt;

    const blocked = this.world.resolve(this.position, tuning.radius, tuning.height);
    if (blocked) {
      // Kill the component of velocity that went into the wall so the player
      // slides along it instead of vibrating.
      this.scratch.set(this.position.x - this.previousPosition.x, 0, this.position.z - this.previousPosition.z);
      const travelled = this.scratch.length();
      const intended = Math.hypot(this.velocity.x, this.velocity.z) * dt;
      if (intended > 1e-5 && travelled < intended) {
        const scale = travelled / intended;
        this.velocity.x *= scale;
        this.velocity.z *= scale;
      }
    }

    const terrain = this.world.surfaceHeight(this.position.x, this.position.z);
    const support = this.world.supportHeight(
      this.position.x,
      this.position.z,
      tuning.radius,
      startY,
      this.velocity.y <= 0 ? tuning.stepUp : 0,
    );
    const floor = Math.max(terrain, support === -Infinity ? terrain : support);

    if (this.position.y <= floor) {
      if (!this.grounded && this.velocity.y < -1.5) this.onLand?.(-this.velocity.y);
      if (!this.grounded) this.landingDip = clamp01(-this.velocity.y / 14);
      this.position.y = floor;
      this.velocity.y = 0;
      this.grounded = true;
    } else if (this.position.y - floor > 0.02) {
      this.grounded = false;
    }

    // Steep hay slows you down and, past the limit, slides you back.
    this.slopeSpeedScale = this.computeSlopeScale(floor);

    const stepDistance = Math.hypot(
      this.position.x - this.previousPosition.x,
      this.position.z - this.previousPosition.z,
    );
    this.distanceTravelled += stepDistance;
    if (this.grounded) {
      this.stepAccumulator += stepDistance;
      const stride = this.sprinting ? 2.3 : 1.85;
      if (this.stepAccumulator >= stride) {
        this.stepAccumulator = 0;
        this.onStep?.(this.speed);
      }
    }
  }

  /**
   * Sample the surface just ahead of the player to work out how steep the climb
   * is, then scale speed by it. Sampling ahead rather than underfoot means the
   * slowdown arrives as you start the climb, not a step into it.
   */
  private computeSlopeScale(floor: number): number {
    if (!this.grounded) return 1;
    const probe = 0.6;
    const ahead = this.world.surfaceHeight(
      this.position.x + this.forward.x * probe,
      this.position.z + this.forward.z * probe,
    );
    const rise = ahead - floor;
    if (rise <= 0.02) return 1;
    const slope = Math.atan2(rise, probe);
    if (slope > this.tuning.slopeLimit) {
      // Too steep to climb: give a gentle backslide instead of a hard wall.
      this.velocity.x -= this.forward.x * 2.4 * (slope - this.tuning.slopeLimit);
      this.velocity.z -= this.forward.z * 2.4 * (slope - this.tuning.slopeLimit);
      return 0.25;
    }
    return lerp(1, 0.55, clamp01(slope / this.tuning.slopeLimit));
  }

  private updateCameraFeel(dt: number): void {
    const tuning = this.tuning;
    const targetEye = this.crouching && this.grounded ? tuning.crouchEyeHeight : tuning.eyeHeight;
    this.eyeOffset = damp(this.eyeOffset, targetEye, 14, dt);

    const moving = this.grounded && this.speed > 0.6;
    this.bobAmount = damp(this.bobAmount, moving ? this.speedFraction : 0, 9, dt);
    if (moving) this.bobPhase += dt * (7.4 + this.speedFraction * 4.6);
    this.landingDip = damp(this.landingDip, 0, 7, dt);
  }

  // ----------------------------------------------------------------- camera
  /**
   * Drive the render camera.
   *
   * `alpha` is the interpolation factor between the last two simulation steps;
   * `bobScale` lets the settings menu turn head bob down without the controller
   * knowing that a settings menu exists.
   */
  applyToCamera(camera: PerspectiveCamera, alpha: number, elapsed: number, bobScale: number): void {
    const x = lerp(this.previousPosition.x, this.position.x, alpha);
    const y = lerp(this.previousPosition.y, this.position.y, alpha);
    const z = lerp(this.previousPosition.z, this.position.z, alpha);

    // Figure-of-eight bob: vertical at twice the horizontal frequency is what
    // makes a walk cycle read as footsteps rather than a bouncing ball.
    const bob = this.bobAmount * bobScale;
    const bobY = Math.sin(this.bobPhase * 2) * 0.045 * bob;
    const bobX = Math.sin(this.bobPhase) * 0.038 * bob;
    const roll = Math.sin(this.bobPhase) * 0.012 * bob;
    const idleSway = wobble(elapsed, 0.5) * 0.006 * (1 - bob);

    camera.position.set(
      x + this.right.x * bobX,
      y + this.eyeOffset + bobY - this.landingDip * 0.24 + idleSway,
      z + this.right.z * bobX,
    );
    camera.rotation.set(this.pitch, this.yaw, roll, 'YXZ');
  }

  /** Sprint widens the lens slightly; it is the cheapest speed cue there is. */
  desiredFov(baseFov: number): number {
    const sprintKick = this.sprinting && this.grounded ? 5.5 * smoothstep(this.speedFraction) : 0;
    return baseFov + sprintKick;
  }
}

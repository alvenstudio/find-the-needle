import { Vector3, type PerspectiveCamera } from 'three';

import { clamp01 } from '../core/MathX';
import { Signal } from '../core/Signals';
import type { HayPile } from '../world/HayPile';
import type { DerivedStats } from './Stats';

/**
 * Digging.
 *
 * The whole interaction is one ray-march against the height field per frame,
 * which gives an exact hit point on the hay for free - no mesh raycast, no
 * physics body, and no dependence on the pile's triangle count. Where that ray
 * lands drives the crosshair, the tool's reach check, and the crater.
 *
 * Swing tools and continuous tools share one code path: a swing is a single
 * `depth` applied on a cooldown, a blower is `depth` per second applied every
 * frame. Keeping them unified is what stops the late-game tools from needing
 * their own bespoke feel.
 */

export interface DigEvent {
  /** Where the tool bit into the hay. */
  point: Vector3;
  /** Straws removed from the pile by this bite. */
  straws: number;
  /** Straws that actually fit in the backpack. */
  collected: number;
  /** True when the backpack was already full. */
  overflow: boolean;
  /** Radius of the crater, for sizing the effect. */
  radius: number;
  /** 0..1 strength, for scaling sound and shake. */
  power: number;
  /** True for a discrete swing, false for a frame of continuous use. */
  discrete: boolean;
}

export type AimState = 'none' | 'hay' | 'far';

export class DigSystem {
  readonly dug = new Signal<DigEvent>();
  /** Fired once when a swing starts, before the hay is touched. */
  readonly swingStarted = new Signal<void>();
  /** Fired when a dig is attempted with a full backpack. */
  readonly backpackFull = new Signal<void>();
  /** Fired when the pile is emptied by this dig. */
  readonly pileCleared = new Signal<void>();

  /** Straws currently carried. */
  carried = 0;

  /**
   * Straws per cubic metre for the active stack.
   *
   * Each tier declares a straw count and a physical size; the game divides one
   * by the other and sets this, so the pile's volume and its advertised straw
   * count can never drift apart.
   */
  density = 1;

  private capacity = 1;

  /** Where the aim ray last hit, and how far away. */
  readonly aimPoint = new Vector3();
  aimDistance = -1;
  aimState: AimState = 'none';

  /** 0..1 progress toward the next swing being available. */
  cooldownRemaining = 0;
  /** True while a continuous tool is actually removing hay. */
  streaming = false;

  private readonly rayOrigin = new Vector3();
  private readonly rayDirection = new Vector3();

  constructor(private pile: HayPile) {}

  setPile(pile: HayPile): void {
    this.pile = pile;
    this.aimDistance = -1;
    this.aimState = 'none';
  }

  get capacityFraction(): number {
    return this.capacity <= 0 ? 0 : clamp01(this.carried / this.capacity);
  }

  /** How many straws this stack still holds. */
  get strawsLeft(): number {
    return this.pile.field.remainingVolume * this.density;
  }

  /**
   * Update aim and, if the player is digging, take a bite.
   *
   * Returns true when hay was removed this step.
   */
  update(dt: number, camera: PerspectiveCamera, stats: DerivedStats, digging: boolean): boolean {
    this.capacity = stats.capacity;
    this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);

    camera.getWorldPosition(this.rayOrigin);
    camera.getWorldDirection(this.rayDirection);
    // Look slightly past the tool's reach so the crosshair can tell the player
    // "you are aiming at hay, just not close enough".
    const probe = stats.reach + 6;
    this.aimDistance = this.pile.raycast(this.rayOrigin, this.rayDirection, probe, this.aimPoint);

    if (this.aimDistance < 0) {
      this.aimState = 'none';
    } else if (this.aimDistance <= stats.reach) {
      this.aimState = 'hay';
    } else {
      this.aimState = 'far';
    }

    this.streaming = false;
    if (!digging || this.aimState !== 'hay') return false;

    if (stats.tool.continuous) {
      this.streaming = true;
      return this.bite(stats, stats.digDepth * dt, false);
    }

    if (this.cooldownRemaining > 0) return false;
    this.cooldownRemaining = stats.cooldown;
    this.swingStarted.emit();
    return this.bite(stats, stats.digDepth, true);
  }

  /**
   * Remove hay and account for it.
   *
   * A full backpack does not block the dig - the hay still comes out of the
   * pile, it just falls on the floor. Blocking would be more "correct" and much
   * more annoying; this way a player who forgets to sell loses money, not
   * progress, and the HUD nag does the teaching.
   */
  private bite(stats: DerivedStats, depth: number, discrete: boolean): boolean {
    if (depth <= 0) return false;
    const volume = this.pile.dig(this.aimPoint, stats.digRadius, depth);
    if (volume <= 0) return false;

    const straws = volume * this.density;
    const room = Math.max(0, this.capacity - this.carried);
    const collected = Math.min(straws, room);
    this.carried += collected;

    const overflow = collected < straws - 1e-6;
    if (overflow && discrete) this.backpackFull.emit();

    this.dug.emit({
      point: this.aimPoint,
      straws,
      collected,
      overflow,
      radius: stats.digRadius,
      power: clamp01(depth / Math.max(stats.tool.depth, 1e-3)),
      discrete,
    });

    if (this.pile.field.remainingVolume <= 1e-4) this.pileCleared.emit();
    return true;
  }

  /** Empty the backpack, returning what was in it. */
  unload(): number {
    const amount = this.carried;
    this.carried = 0;
    return amount;
  }

  reset(): void {
    this.carried = 0;
    this.cooldownRemaining = 0;
    this.streaming = false;
    this.aimDistance = -1;
    this.aimState = 'none';
  }
}

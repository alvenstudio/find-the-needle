import { Group, Object3D, Vector3 } from 'three';

import type { Assets } from '../core/Assets';
import { clamp01, smoothstep } from '../core/MathX';
import { Rng } from '../core/Rng';
import { Signal } from '../core/Signals';
import type { HayPile } from '../world/HayPile';
import { HUNCH, RARITY_WEIGHTS, TREASURES, type TierDefinition, type TreasureDefinition } from './Content';

/**
 * The things hidden in the hay.
 *
 * An item is *exposed* the moment the surface above it drops below its own
 * height - no collision, no triggers, just a height-field lookup per item per
 * frame, which is why a stack can hide a dozen of them for free.
 *
 * Exposure is not collection. An exposed item pops out of the hay and hovers,
 * spinning, until the player walks into it. That extra beat is what turns "a
 * number went up" into "I found something", and it gives the celebration
 * somewhere to happen.
 */

export type BuriedKind = 'needle' | 'treasure';

export interface BuriedItem {
  id: string;
  kind: BuriedKind;
  /** Local position within the pile; y is measured from the pile's base. */
  position: Vector3;
  definition: TreasureDefinition | null;
  model: string;
  claimed: boolean;
  exposed: boolean;
  /** Seconds since exposure, driving the pop-out and hover animation. */
  age: number;
  object: Object3D | null;
}

export interface BuriedRevealEvent {
  item: BuriedItem;
  worldPosition: Vector3;
}

const POP_DURATION = 0.55;
const POP_HEIGHT = 0.85;
const COLLECT_RADIUS = 2.1;
const HOVER_HEIGHT = 1.0;

export class BuriedField {
  readonly group = new Group();
  /** Fired the instant an item breaks the surface. */
  readonly revealed = new Signal<BuriedRevealEvent>();
  /** Fired when the player walks into an exposed item. */
  readonly collected = new Signal<BuriedRevealEvent>();

  readonly items: BuriedItem[] = [];
  /** The fraction of the stack that has to go before the needle surfaces. */
  readonly needleQuantile: number;

  private readonly scratch = new Vector3();
  private elapsed = 0;

  constructor(
    private readonly assets: Assets,
    private readonly pile: HayPile,
    tier: TierDefinition,
    seed: number,
    luck: number,
    alreadyClaimed: readonly string[],
  ) {
    const rng = new Rng(seed ^ 0x7f4a1c3);
    const claimed = new Set(alreadyClaimed);

    this.needleQuantile = rng.range(tier.needleQuantile[0], tier.needleQuantile[1]);
    this.items.push(this.placeNeedle(rng, this.needleQuantile));
    for (let i = 0; i < tier.treasures; i++) {
      this.items.push(this.placeTreasure(rng, i, luck));
    }
    for (const item of this.items) {
      if (claimed.has(item.id)) item.claimed = true;
    }
  }

  /**
   * Put the needle exactly where it needs to be.
   *
   * Burying it at a random depth *looks* like the fair way to do it, and it is
   * a trap: because a digger works down through the volume, the fraction of the
   * stack cleared when the needle surfaces is precisely the needle's volume
   * quantile, so a uniform burial depth gives a uniform run length with a
   * median of exactly 50 % and a long, miserable tail out past 95 %.
   *
   * So the run length is authored instead. Pick the target quantile first, find
   * the flat-top level at which that much of the stack is gone, and put the
   * needle there. The player still has no idea where it is; the designer just
   * gets to decide how long a stack takes.
   */
  private placeNeedle(rng: Rng, quantile: number): BuriedItem {
    const field = this.pile.field;
    const targetRemaining = field.originalVolume * (1 - quantile);
    const level = findCutLevel(field.original, field.cellArea, targetRemaining, field.peak);

    // Any column still standing at that level is a valid hiding place; pick one
    // away from the very rim so the needle is never in the first swing.
    const candidates: number[] = [];
    const resolution = field.resolution;
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        const index = iy * resolution + ix;
        if (field.original[index] <= level + 0.02) continue;
        const x = field.cellToWorldX(ix);
        const z = field.cellToWorldZ(iy);
        if (Math.hypot(x, z) > field.radius * 0.88) continue;
        candidates.push(index);
      }
    }

    let position: Vector3;
    if (candidates.length === 0) {
      position = new Vector3(0, Math.max(level, field.originalHeightAt(0, 0) * 0.5), 0);
    } else {
      const index = candidates[rng.int(0, candidates.length - 1)];
      const ix = index % resolution;
      const iy = Math.floor(index / resolution);
      position = new Vector3(field.cellToWorldX(ix), Math.max(level - 0.05, 0.05), field.cellToWorldZ(iy));
    }

    return {
      id: 'needle',
      kind: 'needle',
      position,
      definition: null,
      model: 'needle',
      claimed: false,
      exposed: false,
      age: 0,
      object: null,
    };
  }

  private placeTreasure(rng: Rng, index: number, luck: number): BuriedItem {
    const definition = pickTreasure(rng, luck);
    const position = this.samplePosition(rng, 0.08, 0.9, 0.12, 0.86);
    return {
      id: `treasure_${index}`,
      kind: 'treasure',
      position,
      definition,
      model: definition.model,
      claimed: false,
      exposed: false,
      age: 0,
      object: null,
    };
  }

  /** A point inside the pile volume, expressed in the pile's local frame. */
  private samplePosition(
    rng: Rng,
    minRadiusFraction: number,
    maxRadiusFraction: number,
    minDepthFraction: number,
    maxDepthFraction: number,
  ): Vector3 {
    const field = this.pile.field;
    for (let attempt = 0; attempt < 64; attempt++) {
      const angle = rng.range(0, Math.PI * 2);
      const radius =
        Math.sqrt(rng.range(minRadiusFraction * minRadiusFraction, maxRadiusFraction * maxRadiusFraction)) *
        field.radius;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const depth = field.originalHeightAt(x, z);
      if (depth < 0.4) continue;
      return new Vector3(x, depth * rng.range(minDepthFraction, maxDepthFraction), z);
    }
    return new Vector3(0, field.originalHeightAt(0, 0) * 0.5, 0);
  }

  // --------------------------------------------------------------- queries
  worldPosition(item: BuriedItem, out = new Vector3()): Vector3 {
    return out.copy(item.position).add(this.pile.group.position);
  }

  get needle(): BuriedItem | undefined {
    return this.items.find((item) => item.kind === 'needle');
  }

  get needleFound(): boolean {
    return this.needle?.claimed ?? false;
  }

  /**
   * A direction toward the needle, blurred by the Hunch's angular error.
   *
   * Returns null once the needle is gone. The error is deterministic per call
   * seed so the arrow does not wander while it is on screen.
   */
  hunchDirection(from: Vector3, rng: Rng, out = new Vector3()): Vector3 | null {
    const needle = this.needle;
    if (!needle || needle.claimed) return null;
    this.worldPosition(needle, out).sub(from);
    out.y = 0;
    if (out.lengthSq() < 1e-6) return null;
    out.normalize();

    const spread = (HUNCH.spreadDegrees * Math.PI) / 180;
    const error = rng.range(-spread, spread);
    const cos = Math.cos(error);
    const sin = Math.sin(error);
    return out.set(out.x * cos - out.z * sin, 0, out.x * sin + out.z * cos);
  }

  /**
   * The closest still-buried treasure within `range`, for the glint hint.
   *
   * Needles are never returned: a sense that finds the needle would end the
   * search inside a minute, because the player takes hundreds of pulls per
   * stack and every one is a fresh probe from a new position.
   */
  nearestBuriedTreasure(from: Vector3, range: number, out = new Vector3()): number {
    let bestDistance = Infinity;
    for (const item of this.items) {
      if (item.claimed || item.exposed || item.kind !== 'treasure') continue;
      const distance = this.worldPosition(item, this.scratch).distanceTo(from);
      if (distance < bestDistance && distance <= range) {
        bestDistance = distance;
        out.copy(this.scratch);
      }
    }
    return bestDistance;
  }

  get remainingCount(): number {
    return this.items.reduce((total, item) => total + (item.claimed ? 0 : 1), 0);
  }

  claimedIds(): string[] {
    return this.items.filter((item) => item.claimed).map((item) => item.id);
  }

  // ------------------------------------------------------------------ tick
  update(dt: number, playerPosition: Vector3): void {
    this.elapsed += dt;
    const field = this.pile.field;

    for (const item of this.items) {
      if (item.claimed) continue;

      if (!item.exposed) {
        const surface = field.heightAt(item.position.x, item.position.z);
        if (surface > item.position.y) continue;
        this.expose(item);
      }

      item.age += dt;
      const object = item.object;
      if (!object) continue;

      // Pop out of the hay, then settle into a slow hover and spin.
      const pop = smoothstep(item.age / POP_DURATION);
      const settled = clamp01((item.age - POP_DURATION) / 1.2);
      const bob = Math.sin(this.elapsed * 1.9 + item.position.x) * 0.09 * settled;
      const rise = POP_HEIGHT * pop * (1 - 0.35 * settled) + HOVER_HEIGHT * settled;

      const surface = Math.max(field.heightAt(item.position.x, item.position.z), 0);
      object.position.set(
        item.position.x + this.pile.group.position.x,
        this.pile.group.position.y + Math.max(item.position.y, surface) + rise + bob,
        item.position.z + this.pile.group.position.z,
      );
      object.rotation.y += dt * (item.kind === 'needle' ? 1.15 : 0.85);
      const scale = 0.25 + 0.75 * pop;
      object.scale.setScalar(scale * (item.kind === 'needle' ? 1.7 : 1.3));
      object.updateMatrix();

      if (item.age > POP_DURATION * 0.7 && object.position.distanceTo(playerPosition) < COLLECT_RADIUS) {
        this.collect(item);
      }
    }
  }

  /** Collect everything already out of the hay - used when a stack is cleared. */
  collectAllExposed(): void {
    for (const item of this.items) {
      if (!item.claimed && item.exposed) this.collect(item);
    }
  }

  private expose(item: BuriedItem): void {
    item.exposed = true;
    item.age = 0;
    if (this.assets.has(item.model)) {
      const object = this.assets.instantiate(item.model);
      object.matrixAutoUpdate = false;
      object.traverse((node) => {
        node.castShadow = false;
        node.receiveShadow = false;
      });
      this.group.add(object);
      item.object = object;
    }
    this.revealed.emit({ item, worldPosition: this.worldPosition(item) });
  }

  private collect(item: BuriedItem): void {
    item.claimed = true;
    const worldPosition = item.object ? item.object.position.clone() : this.worldPosition(item);
    if (item.object) {
      this.group.remove(item.object);
      item.object = null;
    }
    this.collected.emit({ item, worldPosition });
  }

  dispose(): void {
    for (const item of this.items) item.object = null;
    this.group.clear();
    this.revealed.clear();
    this.collected.clear();
  }
}

/**
 * Bisect for the flat-top height at which the pile still holds `target` volume.
 *
 * Shaving the top off a mound is monotone in the cut level, so twenty-eight
 * halvings resolve the level to well under a millimetre regardless of the
 * stack's size.
 */
export function findCutLevel(
  original: Float32Array,
  cellArea: number,
  targetVolume: number,
  peak: number,
): number {
  const volumeAt = (level: number): number => {
    let total = 0;
    for (let i = 0; i < original.length; i++) {
      total += original[i] < level ? original[i] : level;
    }
    return total * cellArea;
  };

  let low = 0;
  let high = peak * 1.05;
  for (let iteration = 0; iteration < 28; iteration++) {
    const mid = (low + high) * 0.5;
    if (volumeAt(mid) < targetVolume) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

/**
 * Roll a treasure.
 *
 * Luck multiplies the weight of everything above common, so a Lucky Rake makes
 * the tail fatter without ever making a legendary guaranteed - the curve keeps
 * its shape, it just leans.
 */
export function pickTreasure(rng: Rng, luck: number): TreasureDefinition {
  let total = 0;
  const weights = TREASURES.map((treasure) => {
    const rarityWeight = RARITY_WEIGHTS[treasure.rarity];
    const lucked = treasure.rarity === 'common' ? rarityWeight : rarityWeight * luck;
    const weight = lucked * treasure.weight;
    total += weight;
    return weight;
  });

  let roll = rng.next() * total;
  for (let i = 0; i < TREASURES.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return TREASURES[i];
  }
  return TREASURES[0];
}

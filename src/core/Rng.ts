/**
 * Deterministic pseudo-randomness.
 *
 * Every haystack is generated from a seed so that a "Daily Stack" is the same
 * for everyone, a shared seed can be replayed, and a reload restores exactly
 * the pile the player left. `Math.random` is never used for anything the save
 * file has to reproduce.
 */

/** Mulberry32 - 32 bits of state, excellent distribution, ~2 ns per call. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Uniform in [-magnitude, magnitude]. */
  signed(magnitude = 1): number {
    return (this.next() * 2 - 1) * magnitude;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /**
   * A uniformly distributed point inside the unit disc, via the concentric map
   * (cheaper and lower-distortion than rejection sampling or naive sqrt-polar).
   */
  discPoint(out: { x: number; y: number }): { x: number; y: number } {
    const a = 2 * this.next() - 1;
    const b = 2 * this.next() - 1;
    if (a === 0 && b === 0) {
      out.x = out.y = 0;
      return out;
    }
    let r: number;
    let theta: number;
    if (a * a > b * b) {
      r = a;
      theta = (Math.PI / 4) * (b / a);
    } else {
      r = b;
      theta = Math.PI / 2 - (Math.PI / 4) * (a / b);
    }
    out.x = r * Math.cos(theta);
    out.y = r * Math.sin(theta);
    return out;
  }

  fork(salt: number): Rng {
    return new Rng((Math.imul(this.state ^ salt, 0x85ebca6b) ^ 0x27d4eb2f) >>> 0);
  }
}

/** Hash an arbitrary string into a 32-bit seed (FNV-1a). */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seed that changes once per UTC day - used for the daily haystack. */
export function dailySeed(now = Date.now()): number {
  return hashSeed(new Date(now).toISOString().slice(0, 10));
}

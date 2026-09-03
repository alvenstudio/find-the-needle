import { Vector3 } from 'three';

import { clamp01, smoothstep } from '../core/MathX';
import { Rng } from '../core/Rng';

/**
 * The haystack, as data.
 *
 * A pile is a square grid of surface heights above the ground plane. Digging
 * subtracts a smooth crater; walking queries the interpolated surface; the
 * needle is buried at a point that is exposed the moment the surface drops
 * below it. Everything the gameplay needs is a cheap array lookup, and the
 * renderer is a pure function of this data.
 *
 * Keeping the simulation in a plain typed array (rather than in mesh vertices)
 * means a save file is a few kilobytes of run-length-encoded heights and the
 * pile survives a reload exactly as the player left it.
 */

export interface HeightFieldOptions {
  /** Footprint half-extent in metres. The grid covers a 2R x 2R square. */
  radius: number;
  /** Peak height at the centre. */
  peak: number;
  /** Cells per side. Must be at least 16. */
  resolution: number;
  seed: number;
  /** Roughness of the generated lumps, 0..1. */
  lumpiness?: number;
  /** Shape exponents: larger `falloff` = steeper sides, larger `shoulder` = flatter top. */
  falloff?: number;
  shoulder?: number;
}

/** A rectangle of grid indices touched by an edit, for partial GPU uploads. */
export interface DirtyRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  dirty: boolean;
}

const MIN_RESOLUTION = 16;

export class HeightField {
  readonly resolution: number;
  readonly radius: number;
  readonly peak: number;
  /** Metres per cell. */
  readonly cellSize: number;
  readonly cellArea: number;

  /** Current surface height per cell, in metres above the ground plane. */
  readonly heights: Float32Array;
  /** The pristine generated heights, kept for progress reporting and reset. */
  readonly original: Float32Array;

  /** Volume of the untouched pile, in cubic metres. */
  readonly originalVolume: number;
  private volume: number;

  readonly dirty: DirtyRect = { minX: 0, minY: 0, maxX: 0, maxY: 0, dirty: false };

  constructor(private readonly options: HeightFieldOptions) {
    this.resolution = Math.max(MIN_RESOLUTION, Math.floor(options.resolution));
    this.radius = options.radius;
    this.peak = options.peak;
    this.cellSize = (this.radius * 2) / (this.resolution - 1);
    this.cellArea = this.cellSize * this.cellSize;

    const count = this.resolution * this.resolution;
    this.heights = new Float32Array(count);
    this.original = new Float32Array(count);
    this.generate();
    this.original.set(this.heights);
    this.originalVolume = this.computeVolume();
    this.volume = this.originalVolume;
    this.markAll();
  }

  // ------------------------------------------------------------- generation
  /**
   * A haystack silhouette: a rounded mound with a flared skirt, roughened by
   * three octaves of value noise and given a few deliberate lumps so it never
   * looks like a maths function.
   */
  private generate(): void {
    const { resolution, radius, peak } = this;
    const falloff = this.options.falloff ?? 2.15;
    const shoulder = this.options.shoulder ?? 0.72;
    const lumpiness = this.options.lumpiness ?? 1;
    const rng = new Rng(this.options.seed);

    // Pre-roll the noise lattices so the field is a pure function of the seed.
    const octaves = [
      { frequency: 1.7, amplitude: 0.13 * lumpiness, table: buildLattice(rng, 8) },
      { frequency: 4.1, amplitude: 0.06 * lumpiness, table: buildLattice(rng, 12) },
      { frequency: 9.3, amplitude: 0.025 * lumpiness, table: buildLattice(rng, 16) },
    ];

    // Three or four soft bulges break the radial symmetry.
    const bulges = Array.from({ length: rng.int(3, 4) }, () => {
      const angle = rng.range(0, Math.PI * 2);
      const distance = rng.range(0.25, 0.62) * radius;
      return {
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        strength: rng.range(0.06, 0.16) * peak * lumpiness,
        spread: rng.range(0.24, 0.44) * radius,
      };
    });

    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        const x = this.cellToWorldX(ix);
        const z = this.cellToWorldZ(iy);
        const distance = Math.hypot(x, z) / radius;

        let height = 0;
        if (distance < 1) {
          // (1 - d^falloff)^shoulder: a dome that meets the ground tangentially.
          height = peak * Math.pow(1 - Math.pow(distance, falloff), shoulder);
          let noise = 0;
          for (const octave of octaves) {
            noise += sampleLattice(octave.table, x * octave.frequency / radius, z * octave.frequency / radius) *
              octave.amplitude;
          }
          // Fade the noise out at the rim so the skirt stays clean.
          height += noise * peak * smoothstep(1 - distance);
          for (const bulge of bulges) {
            const d = Math.hypot(x - bulge.x, z - bulge.z) / bulge.spread;
            if (d < 1) height += bulge.strength * (1 - d * d) * (1 - d * d);
          }
        }
        this.heights[iy * resolution + ix] = Math.max(0, height);
      }
    }
  }

  // ---------------------------------------------------------------- queries
  cellToWorldX(ix: number): number {
    return -this.radius + ix * this.cellSize;
  }

  cellToWorldZ(iy: number): number {
    return -this.radius + iy * this.cellSize;
  }

  worldToCellX(x: number): number {
    return (x + this.radius) / this.cellSize;
  }

  worldToCellZ(z: number): number {
    return (z + this.radius) / this.cellSize;
  }

  /** Bilinearly interpolated surface height, in local pile space. */
  heightAt(x: number, z: number): number {
    const { resolution } = this;
    const fx = this.worldToCellX(x);
    const fz = this.worldToCellZ(z);
    if (fx < 0 || fz < 0 || fx > resolution - 1 || fz > resolution - 1) return 0;

    const ix = Math.min(resolution - 2, Math.floor(fx));
    const iy = Math.min(resolution - 2, Math.floor(fz));
    const tx = fx - ix;
    const tz = fz - iy;
    const row = iy * resolution + ix;
    const h00 = this.heights[row];
    const h10 = this.heights[row + 1];
    const h01 = this.heights[row + resolution];
    const h11 = this.heights[row + resolution + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  /** Surface normal from central differences. */
  normalAt(x: number, z: number, out = new Vector3()): Vector3 {
    const step = this.cellSize;
    const dx = this.heightAt(x + step, z) - this.heightAt(x - step, z);
    const dz = this.heightAt(x, z + step) - this.heightAt(x, z - step);
    return out.set(-dx, 2 * step, -dz).normalize();
  }

  /** Height of the untouched pile - how deep the hay was here originally. */
  originalHeightAt(x: number, z: number): number {
    const { resolution } = this;
    const ix = Math.round(this.worldToCellX(x));
    const iy = Math.round(this.worldToCellZ(z));
    if (ix < 0 || iy < 0 || ix >= resolution || iy >= resolution) return 0;
    return this.original[iy * resolution + ix];
  }

  get remainingVolume(): number {
    return this.volume;
  }

  get clearedFraction(): number {
    return this.originalVolume <= 0 ? 1 : clamp01(1 - this.volume / this.originalVolume);
  }

  // ----------------------------------------------------------------- edits
  /**
   * Carve a crater and report the volume removed.
   *
   * The profile is a squared cosine falloff, which removes most of its material
   * near the centre and tapers to nothing at the rim - it feels like a scoop
   * rather than a cylinder punched out of the pile.
   */
  dig(x: number, z: number, radius: number, depth: number): number {
    const { resolution } = this;
    const minX = Math.max(0, Math.floor(this.worldToCellX(x - radius)));
    const maxX = Math.min(resolution - 1, Math.ceil(this.worldToCellX(x + radius)));
    const minY = Math.max(0, Math.floor(this.worldToCellZ(z - radius)));
    const maxY = Math.min(resolution - 1, Math.ceil(this.worldToCellZ(z + radius)));
    if (minX > maxX || minY > maxY) return 0;

    const invRadius = 1 / Math.max(radius, 1e-4);
    let removed = 0;

    for (let iy = minY; iy <= maxY; iy++) {
      const wz = this.cellToWorldZ(iy);
      const dz = wz - z;
      const row = iy * resolution;
      for (let ix = minX; ix <= maxX; ix++) {
        const dx = this.cellToWorldX(ix) - x;
        const distance = Math.hypot(dx, dz) * invRadius;
        if (distance >= 1) continue;
        const falloff = smoothstep(1 - distance);
        const index = row + ix;
        const current = this.heights[index];
        if (current <= 0) continue;
        const cut = Math.min(current, depth * falloff * falloff);
        if (cut <= 0) continue;
        this.heights[index] = current - cut;
        removed += cut;
      }
    }

    if (removed > 0) {
      this.volume -= removed * this.cellArea;
      this.markDirty(minX, minY, maxX, maxY);
    }
    return removed * this.cellArea;
  }

  /** Flatten everything - used by the "clear the last of it" finale. */
  clearAll(): number {
    const removed = this.volume;
    this.heights.fill(0);
    this.volume = 0;
    this.markAll();
    return removed;
  }

  /**
   * Restore to the generated shape, then replay a recorded removal volume by
   * shaving the pile uniformly. Used when loading a save: the exact crater
   * shape is not worth persisting, but the silhouette and the numbers are.
   */
  restoreTo(removedVolume: number): void {
    this.heights.set(this.original);
    this.volume = this.originalVolume;
    this.markAll();
    if (removedVolume <= 0) return;

    // Shave from the top down by bisecting on a "cut plane" height. This
    // reproduces the flat-topped look of a pile that has been worked at.
    let low = 0;
    let high = this.peak * 1.5;
    for (let iteration = 0; iteration < 24; iteration++) {
      const mid = (low + high) * 0.5;
      if (this.volumeAboveCut(mid) > this.originalVolume - removedVolume) low = mid;
      else high = mid;
    }
    const cut = (low + high) * 0.5;
    for (let i = 0; i < this.heights.length; i++) {
      this.heights[i] = Math.max(0, this.original[i] - cut);
    }
    this.volume = this.computeVolume();
  }

  private volumeAboveCut(cut: number): number {
    let total = 0;
    for (let i = 0; i < this.original.length; i++) {
      const height = this.original[i] - cut;
      if (height > 0) total += height;
    }
    return total * this.cellArea;
  }

  private computeVolume(): number {
    let total = 0;
    for (let i = 0; i < this.heights.length; i++) total += this.heights[i];
    return total * this.cellArea;
  }

  // -------------------------------------------------------------- raycasting
  /**
   * March a ray against the surface.
   *
   * Sphere-trace style: step by half the current clearance, which is large in
   * open air and shrinks as the ray approaches the hay, so a 40 m ray costs a
   * couple of dozen samples instead of hundreds of fixed steps.
   */
  raycast(
    originX: number,
    originY: number,
    originZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    maxDistance: number,
    out: Vector3,
  ): number {
    // Clip the march to the footprint so a ray aimed at the sky costs nothing.
    const span = this.footprintSpan(originX, originZ, dirX, dirZ);
    if (!span) return -1;
    const [enter, exit] = span;
    const limit = Math.min(maxDistance, exit);
    if (enter > limit) return -1;

    let travelled = enter;
    let previousClearance =
      originY + dirY * travelled - this.heightAt(originX + dirX * travelled, originZ + dirZ * travelled);
    if (previousClearance <= 0) {
      out.set(originX + dirX * travelled, originY + dirY * travelled, originZ + dirZ * travelled);
      return travelled;
    }

    const minStep = this.cellSize * 0.5;
    for (let iteration = 0; iteration < 160 && travelled < limit; iteration++) {
      const next = Math.min(limit, travelled + Math.max(minStep, previousClearance * 0.6));
      const clearance =
        originY + dirY * next - this.heightAt(originX + dirX * next, originZ + dirZ * next);
      if (clearance <= 0) {
        // Linear refinement between the last two samples is accurate to well
        // under a centimetre at our cell size.
        const t = previousClearance / (previousClearance - clearance);
        const hit = travelled + (next - travelled) * t;
        out.set(originX + dirX * hit, originY + dirY * hit, originZ + dirZ * hit);
        return hit;
      }
      if (next >= limit) break;
      travelled = next;
      previousClearance = clearance;
    }
    return -1;
  }

  /** Slab test against the footprint square; returns [enter, exit] distances. */
  private footprintSpan(x: number, z: number, dirX: number, dirZ: number): [number, number] | null {
    const limit = this.radius + this.cellSize;
    let near = 0;
    let far = Infinity;
    for (const [origin, direction] of [
      [x, dirX],
      [z, dirZ],
    ] as const) {
      if (Math.abs(direction) < 1e-6) {
        if (Math.abs(origin) > limit) return null;
        continue;
      }
      const t1 = (-limit - origin) / direction;
      const t2 = (limit - origin) / direction;
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
    }
    return near <= far ? [Math.max(near, 0), far] : null;
  }

  // ------------------------------------------------------------------ dirty
  private markDirty(minX: number, minY: number, maxX: number, maxY: number): void {
    const rect = this.dirty;
    if (!rect.dirty) {
      rect.minX = minX;
      rect.minY = minY;
      rect.maxX = maxX;
      rect.maxY = maxY;
      rect.dirty = true;
      return;
    }
    rect.minX = Math.min(rect.minX, minX);
    rect.minY = Math.min(rect.minY, minY);
    rect.maxX = Math.max(rect.maxX, maxX);
    rect.maxY = Math.max(rect.maxY, maxY);
  }

  private markAll(): void {
    this.markDirty(0, 0, this.resolution - 1, this.resolution - 1);
  }

  consumeDirty(): DirtyRect | null {
    if (!this.dirty.dirty) return null;
    const snapshot = { ...this.dirty };
    this.dirty.dirty = false;
    return snapshot;
  }
}

// ---------------------------------------------------------------- noise
/** A small periodic lattice of random values, sampled with smooth interpolation. */
function buildLattice(rng: Rng, size: number): { size: number; values: Float32Array } {
  const values = new Float32Array(size * size);
  for (let i = 0; i < values.length; i++) values[i] = rng.next() * 2 - 1;
  return { size, values };
}

function sampleLattice(table: { size: number; values: Float32Array }, x: number, y: number): number {
  const { size, values } = table;
  const fx = x * size;
  const fy = y * size;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = smoothstep(fx - ix);
  const ty = smoothstep(fy - iy);
  const wrap = (n: number) => ((n % size) + size) % size;
  const x0 = wrap(ix);
  const x1 = wrap(ix + 1);
  const y0 = wrap(iy) * size;
  const y1 = wrap(iy + 1) * size;
  const v00 = values[y0 + x0];
  const v10 = values[y0 + x1];
  const v01 = values[y1 + x0];
  const v11 = values[y1 + x1];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/** Clamp a point to the footprint, used when placing buried objects. */
export function clampToFootprint(x: number, z: number, radius: number): [number, number] {
  const distance = Math.hypot(x, z);
  if (distance <= radius) return [x, z];
  const scale = radius / distance;
  return [x * scale, z * scale];
}

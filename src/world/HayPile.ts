import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';

import type { Assets } from '../core/Assets';
import { clamp01 } from '../core/MathX';
import { getSharedUniforms, stylize } from '../core/Materials';
import { Rng } from '../core/Rng';
import { HeightField, type HeightFieldOptions } from './HeightField';

/**
 * The haystack, as pixels.
 *
 * Two layers stack into something that reads as a million individual straws
 * without ever simulating one:
 *
 *   1. a **packed core** - the height field drawn as a mesh, shaded by a
 *      procedural fibre pattern so a close-up of the dug face looks like
 *      compressed straw rather than a smooth blob; and
 *   2. a **loose shell** - thousands of real straw instances anchored to fixed
 *      ground positions whose height tracks the surface. Dig, and the straws in
 *      the crater sink out of existence; the pile is visibly, physically lower.
 *
 * The shell is sorted by grid cell, so an edit to a 2 m crater re-uploads a few
 * contiguous ranges of instance matrices instead of the whole buffer.
 */

export interface HayPileOptions extends HeightFieldOptions {
  /** How many straw instances the shell may use. */
  strawBudget: number;
  /** Straws per square metre of footprint at full budget. */
  strawDensity?: number;
  position?: Vector3;
}

/** A straw that just left the pile, handed to the collection effect. */
export interface DislodgedStraw {
  x: number;
  y: number;
  z: number;
  tint: number;
}

const STRAW_SINK = 0.055;
const MIN_VISIBLE_HEIGHT = 0.035;

const STRAW_TINTS = [0xfff0c0, 0xf5dfa0, 0xe8ca7d, 0xd8b463, 0xc9a352];

export class HayPile {
  readonly group = new Group();
  readonly field: HeightField;

  private readonly core: Mesh;
  private readonly coreGeometry: BufferGeometry;
  private readonly shell: InstancedMesh;

  /** Anchor data, sorted by grid cell so dirty rects map to contiguous runs. */
  private readonly anchorX: Float32Array;
  private readonly anchorZ: Float32Array;
  private readonly anchorYaw: Float32Array;
  private readonly anchorTilt: Float32Array;
  private readonly anchorScale: Float32Array;
  /** Prefix-sum offsets: straws for cell c are [cellOffset[c], cellOffset[c+1]). */
  private readonly cellOffset: Uint32Array;
  /** Whether each instance is currently drawn - used to detect fresh removals. */
  private readonly visible: Uint8Array;

  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly spin = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly normal = new Vector3();
  private readonly up = new Vector3(0, 1, 0);
  private readonly tmpVector = new Vector3();

  /** Straws dislodged since the last drain, for the collection burst. */
  private readonly dislodged: DislodgedStraw[] = [];

  constructor(assets: Assets, private readonly options: HayPileOptions) {
    this.field = new HeightField(options);
    if (options.position) this.group.position.copy(options.position);

    this.coreGeometry = this.buildCoreGeometry();
    this.core = new Mesh(this.coreGeometry, createCoreMaterial());
    this.core.castShadow = true;
    this.core.receiveShadow = true;
    this.core.frustumCulled = true;
    this.core.matrixAutoUpdate = false;
    this.core.updateMatrix();
    this.group.add(this.core);

    const density = options.strawDensity ?? 62;
    const footprint = Math.PI * options.radius * options.radius;
    const count = Math.min(options.strawBudget, Math.ceil(footprint * density));

    this.anchorX = new Float32Array(count);
    this.anchorZ = new Float32Array(count);
    this.anchorYaw = new Float32Array(count);
    this.anchorTilt = new Float32Array(count);
    this.anchorScale = new Float32Array(count);
    this.visible = new Uint8Array(count);
    this.cellOffset = new Uint32Array(this.field.resolution * this.field.resolution + 1);

    this.shell = new InstancedMesh(assets.geometryOf('straw'), createShellMaterial(), count);
    this.shell.instanceMatrix.setUsage(DynamicDrawUsage);
    // The shell is a detail layer; the core mesh already casts the pile's
    // shadow, and shadowing 20 000 straws would double the vertex cost.
    this.shell.castShadow = false;
    this.shell.receiveShadow = false;
    this.shell.frustumCulled = false;
    this.shell.matrixAutoUpdate = false;
    this.shell.updateMatrix();
    this.group.add(this.shell);

    this.scatterAnchors();
    this.refreshRegion(0, 0, this.field.resolution - 1, this.field.resolution - 1, false);
    this.syncCore(0, 0, this.field.resolution - 1, this.field.resolution - 1);
  }

  // ------------------------------------------------------------- public API
  get worldCenter(): Vector3 {
    return this.group.position;
  }

  get remainingFraction(): number {
    return 1 - this.field.clearedFraction;
  }

  /** Convert a world-space point into the pile's local frame. */
  toLocal(point: Vector3, out = new Vector3()): Vector3 {
    return out.copy(point).sub(this.group.position);
  }

  /** Surface height in world space at a world-space column. */
  surfaceHeightAt(worldX: number, worldZ: number): number {
    return this.group.position.y + this.field.heightAt(worldX - this.group.position.x, worldZ - this.group.position.z);
  }

  /**
   * Ray-march the surface. Returns the distance to the hit, or -1.
   * `out` receives the world-space hit point.
   */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number, out: Vector3): number {
    const distance = this.field.raycast(
      origin.x - this.group.position.x,
      origin.y - this.group.position.y,
      origin.z - this.group.position.z,
      direction.x,
      direction.y,
      direction.z,
      maxDistance,
      out,
    );
    if (distance >= 0) out.add(this.group.position);
    return distance;
  }

  /**
   * Carve a crater at a world-space point.
   *
   * Returns the volume removed in cubic metres; the caller converts that into
   * straws, money and particles.
   */
  dig(worldPoint: Vector3, radius: number, depth: number): number {
    const removed = this.field.dig(
      worldPoint.x - this.group.position.x,
      worldPoint.z - this.group.position.z,
      radius,
      depth,
    );
    if (removed > 0) this.flushDirty();
    return removed;
  }

  clearAll(): number {
    const removed = this.field.clearAll();
    this.flushDirty();
    return removed;
  }

  restoreTo(removedVolume: number): void {
    this.field.restoreTo(removedVolume);
    this.flushDirty();
  }

  /** Hand over (and clear) the straws that left the pile since the last call. */
  drainDislodged(): DislodgedStraw[] {
    if (this.dislodged.length === 0) return [];
    const batch = this.dislodged.slice();
    this.dislodged.length = 0;
    return batch;
  }

  dispose(): void {
    this.coreGeometry.dispose();
    (this.core.material as MeshStandardMaterial).dispose();
    this.shell.dispose();
    (this.shell.material as MeshStandardMaterial).dispose();
    this.group.clear();
  }

  // -------------------------------------------------------------- internals
  private flushDirty(): void {
    const rect = this.field.consumeDirty();
    if (!rect) return;
    this.syncCore(rect.minX, rect.minY, rect.maxX, rect.maxY);
    this.refreshRegion(rect.minX, rect.minY, rect.maxX, rect.maxY, true);
  }

  private buildCoreGeometry(): BufferGeometry {
    const { resolution } = this.field;
    const vertexCount = resolution * resolution;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    const quadCount = (resolution - 1) * (resolution - 1);
    const indices = vertexCount > 65535 ? new Uint32Array(quadCount * 6) : new Uint16Array(quadCount * 6);
    let cursor = 0;
    for (let iy = 0; iy < resolution - 1; iy++) {
      for (let ix = 0; ix < resolution - 1; ix++) {
        const a = iy * resolution + ix;
        const b = a + 1;
        const c = a + resolution;
        const d = c + 1;
        indices[cursor++] = a;
        indices[cursor++] = c;
        indices[cursor++] = b;
        indices[cursor++] = b;
        indices[cursor++] = c;
        indices[cursor++] = d;
      }
    }

    const geometry = new BufferGeometry();
    const positionAttribute = new BufferAttribute(positions, 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    const normalAttribute = new BufferAttribute(normals, 3);
    normalAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('normal', normalAttribute);
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));

    // Colour varies with height so the crown reads lighter than the shaded skirt.
    const light = new Color(0xf5dfa4);
    const dark = new Color(0xb38f47);
    const tint = new Color();
    for (let iy = 0; iy < resolution; iy++) {
      for (let ix = 0; ix < resolution; ix++) {
        const index = iy * resolution + ix;
        const t = clamp01(this.field.heights[index] / Math.max(this.field.peak, 0.001));
        tint.copy(dark).lerp(light, 0.35 + t * 0.65).convertSRGBToLinear();
        colors[index * 3] = tint.r;
        colors[index * 3 + 1] = tint.g;
        colors[index * 3 + 2] = tint.b;
      }
    }

    geometry.boundingSphere = null;
    return geometry;
  }

  /** Rewrite the position and normal attributes for a rectangle of cells. */
  private syncCore(minX: number, minY: number, maxX: number, maxY: number): void {
    const { resolution, heights } = this.field;
    const positionAttribute = this.coreGeometry.getAttribute('position') as BufferAttribute;
    const normalAttribute = this.coreGeometry.getAttribute('normal') as BufferAttribute;
    const positions = positionAttribute.array as Float32Array;
    const normals = normalAttribute.array as Float32Array;

    // Normals need one cell of margin on each side to stay continuous.
    const nMinX = Math.max(0, minX - 1);
    const nMaxX = Math.min(resolution - 1, maxX + 1);
    const nMinY = Math.max(0, minY - 1);
    const nMaxY = Math.min(resolution - 1, maxY + 1);
    const cell = this.field.cellSize;

    for (let iy = nMinY; iy <= nMaxY; iy++) {
      const row = iy * resolution;
      for (let ix = nMinX; ix <= nMaxX; ix++) {
        const index = row + ix;
        const base = index * 3;
        positions[base] = this.field.cellToWorldX(ix);
        positions[base + 1] = heights[index];
        positions[base + 2] = this.field.cellToWorldZ(iy);

        const left = heights[row + Math.max(0, ix - 1)];
        const right = heights[row + Math.min(resolution - 1, ix + 1)];
        const back = heights[Math.max(0, iy - 1) * resolution + ix];
        const front = heights[Math.min(resolution - 1, iy + 1) * resolution + ix];
        const nx = left - right;
        const nz = back - front;
        const ny = 2 * cell;
        const length = Math.hypot(nx, ny, nz) || 1;
        normals[base] = nx / length;
        normals[base + 1] = ny / length;
        normals[base + 2] = nz / length;
      }
    }

    // Rows are contiguous, so one range covering whole rows is the cheapest
    // upload that still avoids re-sending the untouched majority of the mesh.
    const start = nMinY * resolution * 3;
    const count = (nMaxY - nMinY + 1) * resolution * 3;
    positionAttribute.addUpdateRange(start, count);
    positionAttribute.needsUpdate = true;
    normalAttribute.addUpdateRange(start, count);
    normalAttribute.needsUpdate = true;
    this.coreGeometry.boundingSphere = null;
    this.coreGeometry.computeBoundingSphere();
  }

  /**
   * Lay out straw anchors on a jittered grid, then sort them by cell.
   *
   * A jittered grid beats uniform random sampling here: pure random leaves
   * visible clumps and bald patches at this density, and Poisson-disc sampling
   * costs far more than the even coverage is worth.
   */
  private scatterAnchors(): void {
    const rng = new Rng(this.options.seed ^ 0x5bf03635);
    const count = this.anchorX.length;
    const { radius, resolution } = this.field;

    const columns = Math.ceil(Math.sqrt((count * 4) / Math.PI));
    const step = (radius * 2) / columns;
    const candidates: { x: number; z: number; cell: number }[] = [];

    for (let gy = 0; gy < columns && candidates.length < count * 2; gy++) {
      for (let gx = 0; gx < columns; gx++) {
        const x = -radius + (gx + 0.5 + rng.signed(0.42)) * step;
        const z = -radius + (gy + 0.5 + rng.signed(0.42)) * step;
        if (Math.hypot(x, z) > radius * 0.995) continue;
        const cx = Math.min(resolution - 1, Math.max(0, Math.round(this.field.worldToCellX(x))));
        const cz = Math.min(resolution - 1, Math.max(0, Math.round(this.field.worldToCellZ(z))));
        candidates.push({ x, z, cell: cz * resolution + cx });
      }
    }
    rng.shuffle(candidates);
    candidates.length = Math.min(candidates.length, count);
    candidates.sort((a, b) => a.cell - b.cell);

    const cellCounts = new Uint32Array(resolution * resolution);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      this.anchorX[i] = candidate.x;
      this.anchorZ[i] = candidate.z;
      this.anchorYaw[i] = rng.range(0, Math.PI * 2);
      this.anchorTilt[i] = rng.range(0.25, 1.35);
      this.anchorScale[i] = rng.range(0.78, 1.4);
      cellCounts[candidate.cell]++;
      this.shell.setColorAt(i, new Color(rng.pick(STRAW_TINTS)));
    }
    // Any slots we could not fill get parked outside the footprint and stay hidden.
    for (let i = candidates.length; i < count; i++) {
      this.anchorX[i] = radius * 4;
      this.anchorZ[i] = radius * 4;
      this.anchorScale[i] = 0;
    }
    if (this.shell.instanceColor) this.shell.instanceColor.needsUpdate = true;

    let running = 0;
    for (let cell = 0; cell < cellCounts.length; cell++) {
      this.cellOffset[cell] = running;
      running += cellCounts[cell];
    }
    this.cellOffset[cellCounts.length] = running;
  }

  /**
   * Re-place every straw whose cell falls inside the rectangle.
   *
   * `emit` is false during construction and load, when nothing should spray
   * out of the pile.
   */
  private refreshRegion(minX: number, minY: number, maxX: number, maxY: number, emit: boolean): void {
    const { resolution } = this.field;
    const attribute = this.shell.instanceMatrix;

    for (let iy = minY; iy <= maxY; iy++) {
      const rowStart = this.cellOffset[iy * resolution + minX];
      const rowEnd = this.cellOffset[iy * resolution + maxX + 1];
      if (rowEnd <= rowStart) continue;

      for (let i = rowStart; i < rowEnd; i++) this.placeStraw(i, emit);
      attribute.addUpdateRange(rowStart * 16, (rowEnd - rowStart) * 16);
    }
    attribute.needsUpdate = true;
  }

  private placeStraw(index: number, emit: boolean): void {
    const x = this.anchorX[index];
    const z = this.anchorZ[index];
    const height = this.field.heightAt(x, z);
    const wasVisible = this.visible[index] === 1;
    const scale = this.anchorScale[index];

    if (height <= MIN_VISIBLE_HEIGHT || scale <= 0) {
      if (wasVisible) {
        this.visible[index] = 0;
        if (emit) {
          this.dislodged.push({
            x: this.group.position.x + x,
            y: this.group.position.y + Math.max(height, 0) + 0.08,
            z: this.group.position.z + z,
            tint: index % STRAW_TINTS.length,
          });
        }
        this.matrix.makeScale(0, 0, 0);
        this.shell.setMatrixAt(index, this.matrix);
      }
      return;
    }

    this.visible[index] = 1;
    this.field.normalAt(x, z, this.normal);
    // Straws lie along the slope but never stand perfectly upright: blending
    // the surface normal toward vertical by the anchor's tilt gives the pile a
    // shaggy, non-uniform coat.
    this.tmpVector.copy(this.normal).lerp(this.up, 1 - this.anchorTilt[index] * 0.55).normalize();
    this.quaternion.setFromUnitVectors(this.up, this.tmpVector);
    this.spin.setFromAxisAngle(this.up, this.anchorYaw[index]);
    this.quaternion.multiply(this.spin);

    this.position.set(x, height - STRAW_SINK, z);
    this.scale.setScalar(scale);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.shell.setMatrixAt(index, this.matrix);
  }
}

// ---------------------------------------------------------------- materials

/**
 * The packed-core shader.
 *
 * A per-cell random direction drives a stripe pattern, which reads as densely
 * matted straw fibres from any angle and at any distance without a single
 * texture fetch. Two extra octaves at different scales stop the pattern from
 * tiling visibly when the player presses their face into the pile.
 */
const CORE_FRAGMENT = /* glsl */ `
float ftnHash(vec2 p) {
  p = fract(p * vec2(127.31, 311.7));
  p += dot(p, p + 34.19);
  return fract(p.x * p.y);
}

float ftnFibre(vec2 uv, float frequency) {
  vec2 scaled = uv * frequency;
  vec2 cell = floor(scaled);
  float angle = ftnHash(cell) * 6.2831853;
  vec2 dir = vec2(cos(angle), sin(angle));
  float stripe = fract(dot(fract(scaled) - 0.5, dir) * 3.4 + ftnHash(cell + 17.3) * 5.0);
  return smoothstep(0.06, 0.5, abs(stripe - 0.5));
}
`;

function createCoreMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    // The pile's rim sits at exactly ground level; nudging it toward the camera
    // avoids z-fighting with the dirt patch underneath.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  return stylize(material, {
    rim: 0.22,
    cacheKey: 'haycore',
    extend: (shader) => {
      shader.uniforms.uTime = getSharedUniforms().uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>
varying vec3 vFtnWorld;')
        .replace(
          '#include <fog_vertex>',
          '#include <fog_vertex>
  vFtnWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vFtnWorld;
${CORE_FRAGMENT}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  vec2 ftnUv = vFtnWorld.xz + vFtnWorld.y * 0.45;
  float ftnDetail = ftnFibre(ftnUv, 7.0) * 0.55 + ftnFibre(ftnUv + 3.7, 19.0) * 0.31
                  + ftnFibre(ftnUv - 1.3, 47.0) * 0.14;
  diffuseColor.rgb *= mix(0.74, 1.16, ftnDetail);`,
        );
    },
  });
}

function createShellMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0,
  });
  // A whisper of wind so the loose coat shimmers; the core stays rigid.
  return stylize(material, { rim: 0.4, wind: 0.012, windAnchor: -0.5 });
}

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
 * Three layers stack into something that reads as a million individual straws
 * without ever simulating one:
 *
 *   1. a **packed core** - the height field drawn as a mesh, shaded by a
 *      procedural fibre pattern that carries the mid and far distance;
 *   2. a **shell** - thousands of real straw instances anchored to fixed ground
 *      positions across the whole footprint, whose height tracks the surface.
 *      Dig, and the straws in the crater sink out of existence; the pile is
 *      visibly, physically lower; and
 *   3. a **detail band** - a much denser patch of straws that follows the
 *      player, because the density that reads correctly at forty centimetres is
 *      an order of magnitude higher than the density that is affordable across
 *      a forty-metre stack.
 *
 * That third layer is not a nicety. Measured against the real thing, a uniform
 * shell dense enough for a close-up costs several times the frame budget at
 * Mother Lode scale, and a shell cheap enough to afford looks like sand with
 * sprinkles the moment the player leans in. Splitting the two is close to free:
 * the pile is bound by total instance count, so moving instances from
 * "everywhere" to "where the player is standing" changes where they are, not
 * how many.
 *
 * The shell is sorted by grid cell, so a crater re-uploads a few contiguous
 * ranges of instance matrices instead of the whole buffer.
 */

export interface HayPileOptions extends HeightFieldOptions {
  /** Instances the wide shell may use. */
  shellBudget: number;
  /** Instances the near-field detail band may use. */
  bandBudget: number;
  /** Shell straws per square metre of footprint, before the budget cap. */
  shellDensity?: number;
  /** Radius of the detail band around the player. */
  bandRadius?: number;
  position?: Vector3;
}

/** A straw that just left the pile, handed to the collection effect. */
export interface DislodgedStraw {
  x: number;
  y: number;
  z: number;
}

const STRAW_SINK = 0.05;
const MIN_VISIBLE_HEIGHT = 0.03;
/** How far the player must move before the detail band is re-seeded. */
const BAND_REBUILD_DISTANCE = 0.42;

const STRAW_TINTS = [0xfff0c0, 0xf7e0a4, 0xe8ca7d, 0xd8b463, 0xc9a352, 0xb99544];

export class HayPile {
  readonly group = new Group();
  readonly field: HeightField;

  private readonly core: Mesh;
  private readonly coreGeometry: BufferGeometry;
  private readonly shell: InstancedMesh;
  private readonly band: InstancedMesh | null;

  /** Shell anchors, sorted by grid cell so dirty rects map to contiguous runs. */
  private readonly anchorX: Float32Array;
  private readonly anchorZ: Float32Array;
  private readonly anchorScale: Float32Array;
  private readonly anchorQuat: Float32Array;
  /** Prefix-sum offsets: straws for cell c are [cellOffset[c], cellOffset[c+1]). */
  private readonly cellOffset: Uint32Array;
  /** Whether each shell instance is currently drawn, to detect fresh removals. */
  private readonly visible: Uint8Array;

  /** Band slots: fixed offsets from the player, re-seeded as they move. */
  private readonly bandOffsetX: Float32Array;
  private readonly bandOffsetZ: Float32Array;
  private readonly bandScale: Float32Array;
  private readonly bandQuat: Float32Array;
  private readonly bandAnchor = new Vector3(Infinity, 0, Infinity);
  private readonly bandRadius: number;

  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();

  private readonly dislodged: DislodgedStraw[] = [];

  constructor(assets: Assets, options: HayPileOptions) {
    this.field = new HeightField(options);
    if (options.position) this.group.position.copy(options.position);

    this.coreGeometry = this.buildCoreGeometry();
    this.core = new Mesh(this.coreGeometry, createCoreMaterial());
    this.core.castShadow = true;
    this.core.receiveShadow = true;
    this.core.matrixAutoUpdate = false;
    this.core.updateMatrix();
    // Heights only ever decrease, so the sphere computed for the pristine pile
    // bounds every state it will ever be in. Recomputing it per dig measured at
    // up to 2.8 ms a click on a large stack, for no benefit at all.
    this.coreGeometry.computeBoundingSphere();
    this.group.add(this.core);

    const geometry = assets.geometryOf('straw');
    const material = createStrawMaterial();
    const footprint = Math.PI * options.radius * options.radius;
    const shellCount = Math.max(
      256,
      Math.min(options.shellBudget, Math.ceil(footprint * (options.shellDensity ?? 30))),
    );

    this.anchorX = new Float32Array(shellCount);
    this.anchorZ = new Float32Array(shellCount);
    this.anchorScale = new Float32Array(shellCount);
    this.anchorQuat = new Float32Array(shellCount * 4);
    this.visible = new Uint8Array(shellCount);
    this.cellOffset = new Uint32Array(this.field.resolution * this.field.resolution + 1);

    this.shell = new InstancedMesh(geometry, material, shellCount);
    this.shell.instanceMatrix.setUsage(DynamicDrawUsage);
    // The core already casts the pile's shadow; shadowing every straw would
    // double the vertex cost of the most expensive object in the scene.
    this.shell.castShadow = false;
    this.shell.receiveShadow = false;
    this.shell.frustumCulled = false;
    this.shell.matrixAutoUpdate = false;
    this.shell.updateMatrix();
    this.group.add(this.shell);

    this.bandRadius = options.bandRadius ?? 6.5;
    const bandCount = Math.max(0, options.bandBudget);
    this.bandOffsetX = new Float32Array(bandCount);
    this.bandOffsetZ = new Float32Array(bandCount);
    this.bandScale = new Float32Array(bandCount);
    this.bandQuat = new Float32Array(bandCount * 4);
    if (bandCount > 0) {
      this.band = new InstancedMesh(geometry, material, bandCount);
      this.band.instanceMatrix.setUsage(DynamicDrawUsage);
      this.band.castShadow = false;
      this.band.receiveShadow = false;
      this.band.frustumCulled = false;
      this.band.matrixAutoUpdate = false;
      this.band.updateMatrix();
      this.group.add(this.band);
    } else {
      this.band = null;
    }

    const rng = new Rng(options.seed ^ 0x5bf03635);
    this.scatterShell(rng);
    this.scatterBand(rng);
    this.refreshShell(0, 0, this.field.resolution - 1, this.field.resolution - 1, false);
    this.syncCore(0, 0, this.field.resolution - 1, this.field.resolution - 1);
  }

  // ------------------------------------------------------------- public API
  get remainingFraction(): number {
    return 1 - this.field.clearedFraction;
  }

  get instanceCount(): number {
    return this.shell.count + (this.band?.count ?? 0);
  }

  /** Surface height in world space at a world-space column. */
  surfaceHeightAt(worldX: number, worldZ: number): number {
    return (
      this.group.position.y +
      this.field.heightAt(worldX - this.group.position.x, worldZ - this.group.position.z)
    );
  }

  /** Ray-march the surface. Returns the hit distance, or -1. */
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

  /** Carve a crater at a world-space point; returns the volume removed. */
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

  /**
   * Keep the detail band under the player.
   *
   * Re-seeding is gated on a distance threshold rather than done every frame.
   * A full rebuild is a few hundred microseconds, and at walking pace this
   * fires about ten times a second, so the band costs well under one per cent
   * of the frame budget while looking, to the player, continuous.
   */
  update(playerPosition: Vector3): void {
    if (!this.band) return;
    const dx = playerPosition.x - this.bandAnchor.x;
    const dz = playerPosition.z - this.bandAnchor.z;
    if (dx * dx + dz * dz < BAND_REBUILD_DISTANCE * BAND_REBUILD_DISTANCE) return;
    this.bandAnchor.copy(playerPosition);
    this.rebuildBand();
  }

  dispose(): void {
    this.coreGeometry.dispose();
    (this.core.material as MeshStandardMaterial).dispose();
    (this.shell.material as MeshStandardMaterial).dispose();
    this.shell.dispose();
    this.band?.dispose();
    this.group.clear();
  }

  // -------------------------------------------------------------- internals
  private flushDirty(): void {
    const rect = this.field.consumeDirty();
    if (!rect) return;
    this.syncCore(rect.minX, rect.minY, rect.maxX, rect.maxY);
    this.refreshShell(rect.minX, rect.minY, rect.maxX, rect.maxY, true);
    // A crater under the band invalidates it now, not on the next step.
    this.bandAnchor.set(Infinity, 0, Infinity);
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
    const light = new Color(0xf3dda2);
    const dark = new Color(0xa8853f);
    const tint = new Color();
    for (let index = 0; index < vertexCount; index++) {
      const t = clamp01(this.field.heights[index] / Math.max(this.field.peak, 0.001));
      tint.copy(dark).lerp(light, 0.3 + t * 0.7);
      colors[index * 3] = tint.r;
      colors[index * 3 + 1] = tint.g;
      colors[index * 3 + 2] = tint.b;
    }
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
      const rowAbove = Math.max(0, iy - 1) * resolution;
      const rowBelow = Math.min(resolution - 1, iy + 1) * resolution;
      for (let ix = nMinX; ix <= nMaxX; ix++) {
        const index = row + ix;
        const base = index * 3;
        positions[base] = this.field.cellToWorldX(ix);
        positions[base + 1] = heights[index];
        positions[base + 2] = this.field.cellToWorldZ(iy);

        const nx = heights[row + Math.max(0, ix - 1)] - heights[row + Math.min(resolution - 1, ix + 1)];
        const nz = heights[rowAbove + ix] - heights[rowBelow + ix];
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
  }

  /**
   * Lay out shell anchors on a jittered grid, then sort them by cell.
   *
   * A jittered grid beats uniform random sampling here: pure random leaves
   * visible clumps and bald patches at this density, and Poisson-disc sampling
   * costs far more than the even coverage is worth.
   */
  private scatterShell(rng: Rng): void {
    const count = this.anchorX.length;
    const { radius, resolution } = this.field;

    const columns = Math.ceil(Math.sqrt((count * 4) / Math.PI));
    const step = (radius * 2) / columns;
    const candidates: { x: number; z: number; cell: number }[] = [];

    for (let gy = 0; gy < columns; gy++) {
      for (let gx = 0; gx < columns; gx++) {
        const x = -radius + (gx + 0.5 + rng.signed(0.45)) * step;
        const z = -radius + (gy + 0.5 + rng.signed(0.45)) * step;
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
    const tint = new Color();
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      this.anchorX[i] = candidate.x;
      this.anchorZ[i] = candidate.z;
      this.anchorScale[i] = rng.range(0.82, 1.5);
      writeRandomLie(rng, this.anchorQuat, i);
      cellCounts[candidate.cell]++;
      this.shell.setColorAt(i, tint.set(rng.pick(STRAW_TINTS)));
    }
    // Slots we could not fill are parked outside the footprint and stay hidden.
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

  /** Pre-roll the band's relative offsets and orientations once. */
  private scatterBand(rng: Rng): void {
    const band = this.band;
    if (!band) return;
    const point = { x: 0, y: 0 };
    const tint = new Color();
    for (let i = 0; i < this.bandOffsetX.length; i++) {
      rng.discPoint(point);
      // Bias inward so the densest straw sits where the player is working.
      const bias = 0.55 + 0.45 * rng.next();
      this.bandOffsetX[i] = point.x * this.bandRadius * bias;
      this.bandOffsetZ[i] = point.y * this.bandRadius * bias;
      this.bandScale[i] = rng.range(0.78, 1.4);
      writeRandomLie(rng, this.bandQuat, i);
      band.setColorAt(i, tint.set(rng.pick(STRAW_TINTS)));
    }
    if (band.instanceColor) band.instanceColor.needsUpdate = true;
  }

  /** Drop every band straw onto the surface around the current anchor. */
  private rebuildBand(): void {
    const band = this.band;
    if (!band) return;
    const originX = this.bandAnchor.x - this.group.position.x;
    const originZ = this.bandAnchor.z - this.group.position.z;
    const baseY = this.group.position.y;

    for (let i = 0; i < this.bandOffsetX.length; i++) {
      const x = originX + this.bandOffsetX[i];
      const z = originZ + this.bandOffsetZ[i];
      const height = this.field.heightAt(x, z);
      if (height <= MIN_VISIBLE_HEIGHT) {
        this.matrix.makeScale(0, 0, 0);
        band.setMatrixAt(i, this.matrix);
        continue;
      }
      const base = i * 4;
      this.quaternion.set(
        this.bandQuat[base],
        this.bandQuat[base + 1],
        this.bandQuat[base + 2],
        this.bandQuat[base + 3],
      );
      // Sit a shade above the shell so the two layers interleave rather than
      // z-fight where they overlap.
      this.position.set(
        x + this.group.position.x,
        baseY + height - STRAW_SINK * 0.5,
        z + this.group.position.z,
      );
      this.scale.setScalar(this.bandScale[i]);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      band.setMatrixAt(i, this.matrix);
    }
    band.instanceMatrix.needsUpdate = true;
  }

  /** Re-place every shell straw whose cell falls inside the rectangle. */
  private refreshShell(minX: number, minY: number, maxX: number, maxY: number, emit: boolean): void {
    const { resolution } = this.field;
    const attribute = this.shell.instanceMatrix;

    for (let iy = minY; iy <= maxY; iy++) {
      const rowStart = this.cellOffset[iy * resolution + minX];
      const rowEnd = this.cellOffset[iy * resolution + maxX + 1];
      if (rowEnd <= rowStart) continue;
      for (let i = rowStart; i < rowEnd; i++) this.placeShellStraw(i, emit);
      attribute.addUpdateRange(rowStart * 16, (rowEnd - rowStart) * 16);
    }
    attribute.needsUpdate = true;
  }

  private placeShellStraw(index: number, emit: boolean): void {
    const x = this.anchorX[index];
    const z = this.anchorZ[index];
    const scale = this.anchorScale[index];
    const height = this.field.heightAt(x, z);

    if (height <= MIN_VISIBLE_HEIGHT || scale <= 0) {
      if (this.visible[index] === 1) {
        this.visible[index] = 0;
        if (emit) {
          this.dislodged.push({
            x: this.group.position.x + x,
            y: this.group.position.y + Math.max(height, 0) + 0.08,
            z: this.group.position.z + z,
          });
        }
        this.matrix.makeScale(0, 0, 0);
        this.shell.setMatrixAt(index, this.matrix);
      }
      return;
    }

    this.visible[index] = 1;
    const base = index * 4;
    this.quaternion.set(
      this.anchorQuat[base],
      this.anchorQuat[base + 1],
      this.anchorQuat[base + 2],
      this.anchorQuat[base + 3],
    );
    this.position.set(x, height - STRAW_SINK, z);
    this.scale.setScalar(scale);
    this.matrix.compose(this.position, this.quaternion, this.scale);
    this.shell.setMatrixAt(index, this.matrix);
  }
}

/**
 * A random orientation, mostly flat.
 *
 * Straws lie on the surface rather than standing up, so the rotation is a full
 * spin about Y plus a modest tilt about a random horizontal axis. Baking it
 * once per anchor keeps re-placing a straw down to a height lookup and a matrix
 * compose, instead of a normal lookup and a `setFromUnitVectors`.
 */
function writeRandomLie(rng: Rng, out: Float32Array, index: number): void {
  const yaw = rng.range(0, Math.PI * 2);
  const tilt = rng.range(-0.42, 0.42);
  const tiltAxis = rng.range(0, Math.PI * 2);

  const halfYaw = yaw * 0.5;
  const yawX = 0;
  const yawY = Math.sin(halfYaw);
  const yawZ = 0;
  const yawW = Math.cos(halfYaw);

  const halfTilt = tilt * 0.5;
  const sinTilt = Math.sin(halfTilt);
  const tiltX = Math.cos(tiltAxis) * sinTilt;
  const tiltY = 0;
  const tiltZ = Math.sin(tiltAxis) * sinTilt;
  const tiltW = Math.cos(halfTilt);

  // Hamilton product tilt * yaw, written straight into the packed array.
  const base = index * 4;
  out[base] = tiltW * yawX + tiltX * yawW + tiltY * yawZ - tiltZ * yawY;
  out[base + 1] = tiltW * yawY - tiltX * yawZ + tiltY * yawW + tiltZ * yawX;
  out[base + 2] = tiltW * yawZ + tiltX * yawY - tiltY * yawX + tiltZ * yawW;
  out[base + 3] = tiltW * yawW - tiltX * yawX - tiltY * yawY - tiltZ * yawZ;
}

// ---------------------------------------------------------------- materials

/**
 * The packed-core shader.
 *
 * A per-cell random direction drives a stripe pattern that reads as densely
 * matted fibre without a single texture fetch. The high-frequency octaves fade
 * out with distance: left running, they alias into a herringbone moire from
 * about two metres out, which is worse than no detail at all.
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
    roughness: 0.95,
    metalness: 0,
    // The pile's rim sits at exactly ground level; nudging it toward the camera
    // avoids z-fighting with the dirt patch underneath.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  return stylize(material, {
    rim: 0.2,
    cacheKey: 'haycore',
    extend: (shader) => {
      shader.uniforms.uTime = getSharedUniforms().uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFtnWorld;')
        .replace(
          '#include <fog_vertex>',
          '#include <fog_vertex>\n  vFtnWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vFtnWorld;\n${CORE_FRAGMENT}`)
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
  {
    float ftnDist = length(vViewPosition);
    vec2 ftnUv = vFtnWorld.xz + vFtnWorld.y * 0.45;
    float ftnFade = 1.0 - smoothstep(3.0, 14.0, ftnDist);
    float ftnDetail = ftnFibre(ftnUv, 5.5) * 0.6
                    + ftnFibre(ftnUv + 3.7, 13.0) * 0.28 * ftnFade
                    + ftnFibre(ftnUv - 1.3, 31.0) * 0.12 * ftnFade * ftnFade;
    diffuseColor.rgb *= mix(0.78, 1.14, ftnDetail);
  }`,
        );
    },
  });
}

function createStrawMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
  });
  // A whisper of wind so the loose coat shimmers; the core stays rigid.
  return stylize(material, { rim: 0.42, wind: 0.01, windAnchor: -0.5, cacheKey: 'straw' });
}

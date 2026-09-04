import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';

import { clamp01, smoothstep } from '../core/MathX';
import { stylize } from '../core/Materials';
import { Rng } from '../core/Rng';

/**
 * The ground the farm sits on.
 *
 * A single radial mesh: dense and dead flat where the player actually works,
 * then rolling and progressively coarser as it runs out to the horizon. The
 * flat working area matters more than it sounds - the haystack is a height
 * field anchored at y = 0, and a lumpy floor underneath it would make craters
 * bottom out at different depths depending on where you stood.
 *
 * Radial topology also means the mesh gets cheaper exactly where detail stops
 * mattering, and the outer ring can be pushed 300 m out for a horizon without
 * costing a single extra vertex in the play space.
 */

export interface TerrainOptions {
  seed: number;
  /** Everything inside this radius is perfectly flat. */
  flatRadius: number;
  /** Where the mesh ends. */
  outerRadius: number;
  /** Rings of vertices from centre to edge. */
  rings: number;
  /** Vertices around each ring. */
  segments: number;
  /** Peak hill height out at the rim. */
  hillHeight: number;
  grass: string;
  grassDark: string;
  dirt: string;
  /** Radius of the bare dirt patch under the haystack. */
  dirtRadius: number;
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  seed: 1,
  flatRadius: 34,
  outerRadius: 320,
  rings: 46,
  segments: 96,
  hillHeight: 16,
  grass: '#6fbf3f',
  grassDark: '#4e9a2e',
  dirt: '#9a6a3c',
  dirtRadius: 9,
};

export class Terrain {
  readonly mesh: Mesh;
  readonly options: TerrainOptions;

  private readonly geometry: BufferGeometry;
  private readonly hills: { x: number; z: number; radius: number; height: number }[] = [];
  /** Extra bare-dirt discs stamped into the ground colour. */
  private readonly patches: { x: number; z: number; radius: number }[] = [];

  constructor(options: Partial<TerrainOptions> = {}) {
    this.options = { ...DEFAULT_TERRAIN, ...options };
    const rng = new Rng(this.options.seed);

    // Hills are explicit bumps rather than noise so `heightAt` is an exact,
    // cheap analytic function instead of a texture lookup.
    const hillCount = 22;
    for (let i = 0; i < hillCount; i++) {
      const angle = rng.range(0, Math.PI * 2);
      const distance = rng.range(this.options.flatRadius + 18, this.options.outerRadius * 0.72);
      this.hills.push({
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        radius: rng.range(28, 78),
        height: rng.range(0.35, 1) * this.options.hillHeight,
      });
    }

    this.geometry = this.build();
    const material = stylize(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0 }),
      { rim: 0.05 },
    );
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  /**
   * Surface height at a world column.
   *
   * Matches the mesh exactly because both evaluate the same closed form, which
   * is why the player never floats above or sinks into a hillside.
   */
  heightAt(x: number, z: number): number {
    const distance = Math.hypot(x, z);
    if (distance <= this.options.flatRadius) return 0;

    // Ease out of the flat zone so there is no crease at its edge.
    const blend = smoothstep((distance - this.options.flatRadius) / 22);
    let height = 0;
    for (const hill of this.hills) {
      const d = Math.hypot(x - hill.x, z - hill.z) / hill.radius;
      if (d >= 1) continue;
      const falloff = 1 - d * d;
      height += hill.height * falloff * falloff;
    }
    return height * blend;
  }

  /** Stamp a bare-earth disc, e.g. under a kiosk or along a path. */
  addDirtPatch(x: number, z: number, radius: number): void {
    this.patches.push({ x, z, radius });
  }

  /** Re-run vertex colouring after patches have been added. */
  refreshColors(): void {
    this.paint(this.geometry);
    (this.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  private build(): BufferGeometry {
    const { rings, segments, outerRadius } = this.options;
    const vertexCount = rings * segments + 1;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    // Ring radii ramp quadratically: tight spacing where the player walks,
    // wide spacing out at the horizon.
    const radiusAt = (ring: number): number => {
      const t = ring / rings;
      const eased = t * t * 0.86 + t * 0.14;
      return eased * outerRadius;
    };

    positions[0] = 0;
    positions[1] = 0;
    positions[2] = 0;
    for (let ring = 0; ring < rings; ring++) {
      const radius = radiusAt(ring + 1);
      for (let segment = 0; segment < segments; segment++) {
        const index = 1 + ring * segments + segment;
        const angle = (segment / segments) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        positions[index * 3] = x;
        positions[index * 3 + 1] = this.heightAt(x, z);
        positions[index * 3 + 2] = z;
      }
    }

    // Winding matters: the ring vertices run anticlockwise in XZ, so a naive
    // (centre, a, b) fan faces *down* and the whole terrain gets back-face
    // culled. Reversing it puts the front faces up, which also makes
    // computeVertexNormals point them at the sky.
    const triangles: number[] = [];
    for (let segment = 0; segment < segments; segment++) {
      const a = 1 + segment;
      const b = 1 + ((segment + 1) % segments);
      triangles.push(0, b, a);
    }
    for (let ring = 0; ring < rings - 1; ring++) {
      const inner = 1 + ring * segments;
      const outer = 1 + (ring + 1) * segments;
      for (let segment = 0; segment < segments; segment++) {
        const next = (segment + 1) % segments;
        triangles.push(inner + segment, inner + next, outer + segment);
        triangles.push(inner + next, outer + next, outer + segment);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setAttribute('color', new BufferAttribute(colors, 3));
    geometry.setIndex(
      vertexCount > 65535 ? new BufferAttribute(new Uint32Array(triangles), 1) : new BufferAttribute(new Uint16Array(triangles), 1),
    );
    geometry.computeVertexNormals();
    this.paint(geometry);
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Vertex colours: grass tinted by slope and height, going bare where the
   * player has trodden a patch flat.
   */
  private paint(geometry: BufferGeometry): void {
    const positions = geometry.getAttribute('position') as BufferAttribute;
    const colors = geometry.getAttribute('color') as BufferAttribute;
    const grass = new Color(this.options.grass);
    const grassDark = new Color(this.options.grassDark);
    const dirt = new Color(this.options.dirt);
    const tint = new Color();
    const rng = new Rng(this.options.seed ^ 0x1f3a5c7);

    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const y = positions.getY(i);
      const z = positions.getZ(i);

      // Hilltops catch more light; hollows stay in shadow.
      const heightTint = clamp01(y / Math.max(this.options.hillHeight, 1));
      tint.copy(grassDark).lerp(grass, 0.45 + heightTint * 0.55);
      // A little per-vertex variation stops the plain from looking laminated.
      tint.multiplyScalar(0.92 + rng.next() * 0.16);

      let bare = 1 - clamp01((Math.hypot(x, z) - this.options.dirtRadius) / 4.5);
      for (const patch of this.patches) {
        const local = 1 - clamp01((Math.hypot(x - patch.x, z - patch.z) - patch.radius) / 3.2);
        if (local > bare) bare = local;
      }
      if (bare > 0) tint.lerp(dirt, smoothstep(bare));

      colors.setXYZ(i, tint.r, tint.g, tint.b);
    }
  }

  /** A uniformly random point on the ground between two radii. */
  samplePoint(rng: Rng, minRadius: number, maxRadius: number, out = new Vector3()): Vector3 {
    const angle = rng.range(0, Math.PI * 2);
    // sqrt keeps the distribution uniform by area rather than clumping inward.
    const radius = Math.sqrt(rng.range(minRadius * minRadius, maxRadius * maxRadius));
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    return out.set(x, this.heightAt(x, z), z);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
  }
}

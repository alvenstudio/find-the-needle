import { BufferAttribute, BufferGeometry, Color, Mesh, MeshStandardMaterial, Vector3 } from 'three';

import { clamp01, smoothstep } from '../core/MathX';
import { stylize } from '../core/Materials';
import { Rng } from '../core/Rng';

/**
 * The ground the farm sits on.
 *
 * A single radial mesh in three bands: dead flat where the player works, then
 * a **rampart** - a ring of hills that rises out of the flat edge and closes
 * the horizon in every direction - and then a short tail of rolling ground
 * behind it so the ridge has something to sit on.
 *
 * The rampart is the whole design. An open plain running to a distant horizon
 * has to be *big*, and a big plain is expensive twice over: in the mesh, and in
 * the scenery it has to be dressed with to not look empty. A bowl the player
 * cannot see out of is a hundred metres across instead of six hundred, closes
 * the world without a visible wall, and gives the fence a reason to be there.
 *
 * The flat working area matters more than it sounds: the haystack is a height
 * field anchored at y = 0, and a lumpy floor underneath it would make craters
 * bottom out at different depths depending on where you stood.
 *
 * Radial topology also means the mesh gets cheaper exactly where detail stops
 * mattering, and the rim can be pushed out for a horizon without costing a
 * single extra vertex in the play space.
 */

export interface TerrainOptions {
  seed: number;
  /** Everything inside this radius is perfectly flat. This is the play area. */
  flatRadius: number;
  /** Where the mesh ends. */
  outerRadius: number;
  /** Metres of slope between the flat edge and the top of the rampart. */
  rampWidth: number;
  /** Height of the ring of hills that closes the horizon. */
  rampHeight: number;
  /** Rings of vertices from centre to edge. */
  rings: number;
  /** Vertices around each ring. */
  segments: number;
  grass: string;
  grassDark: string;
  dirt: string;
  /** Radius of the bare dirt patch under the haystack. */
  dirtRadius: number;
}

export const DEFAULT_TERRAIN: TerrainOptions = {
  seed: 1,
  // Sized so the largest stack's boundary fence still stands on flat ground.
  flatRadius: 38,
  outerRadius: 116,
  rampWidth: 34,
  rampHeight: 21,
  rings: 30,
  segments: 80,
  grass: '#6fbf3f',
  grassDark: '#4e9a2e',
  dirt: '#9a6a3c',
  dirtRadius: 9,
};

/** One lump on the rampart, so the ridge is not a lathe-turned cone. */
interface Knoll {
  x: number;
  z: number;
  radius: number;
  height: number;
}

export class Terrain {
  readonly mesh: Mesh;
  readonly options: TerrainOptions;

  private readonly geometry: BufferGeometry;
  private readonly knolls: Knoll[] = [];
  /** Angular harmonics that give the ridge line its wander. */
  private readonly waves: { frequency: number; amplitude: number; phase: number }[] = [];
  /** Extra bare-dirt discs stamped into the ground colour. */
  private readonly patches: { x: number; z: number; radius: number }[] = [];

  constructor(options: Partial<TerrainOptions> = {}) {
    this.options = { ...DEFAULT_TERRAIN, ...options };
    const rng = new Rng(this.options.seed);

    // Three harmonics: one that gives the ring two or three broad shoulders,
    // and two finer ones for the silhouette. Analytic, so `heightAt` stays an
    // exact closed form the collider and the mesh both agree on.
    for (const frequency of [3, 5, 8]) {
      this.waves.push({
        frequency,
        amplitude: rng.range(0.1, 0.26) * (frequency === 3 ? 1.4 : 1),
        phase: rng.range(0, Math.PI * 2),
      });
    }

    // A few peaks sitting on the ridge, out where the player can only look at
    // them. They are what stops the rampart reading as a wall.
    const knollCount = 14;
    const ridge = this.options.flatRadius + this.options.rampWidth;
    for (let i = 0; i < knollCount; i++) {
      const angle = (i / knollCount) * Math.PI * 2 + rng.signed(0.18);
      const distance = rng.range(ridge - 6, Math.min(this.options.outerRadius - 12, ridge + 34));
      this.knolls.push({
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        radius: rng.range(16, 34),
        height: rng.range(2.5, 9),
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

  /** The radius inside which the ground is flat - the whole playable yard. */
  get playRadius(): number {
    return this.options.flatRadius;
  }

  /**
   * Surface height at a world column.
   *
   * Matches the mesh exactly because both evaluate this same closed form, which
   * is why the player never floats above or sinks into a hillside.
   */
  heightAt(x: number, z: number): number {
    const { flatRadius, rampWidth, rampHeight } = this.options;
    const distance = Math.hypot(x, z);
    if (distance <= flatRadius) return 0;

    // The ramp eases out of the flat zone, so there is no crease at its edge,
    // and holds its full height past the ridge so the horizon stays closed.
    const ramp = smoothstep((distance - flatRadius) / rampWidth);
    let angular = 1;
    const angle = Math.atan2(z, x);
    for (const wave of this.waves) angular += Math.sin(angle * wave.frequency + wave.phase) * wave.amplitude;

    let height = rampHeight * ramp * Math.max(0.35, angular);
    for (const knoll of this.knolls) {
      const d = Math.hypot(x - knoll.x, z - knoll.z) / knoll.radius;
      if (d >= 1) continue;
      const falloff = 1 - d * d;
      height += knoll.height * falloff * falloff * ramp;
    }
    return height;
  }

  /** Stamp a bare-earth disc, e.g. under a kiosk or along a path. */
  addDirtPatch(x: number, z: number, radius: number): void {
    this.patches.push({ x, z, radius });
  }

  /** Forget every stamped patch, so a rebuilt scenery does not inherit the old one. */
  clearDirtPatches(): void {
    this.patches.length = 0;
  }

  /** Re-run vertex colouring after patches have been added. */
  refreshColors(): void {
    this.paint(this.geometry);
    (this.geometry.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  private build(): BufferGeometry {
    const { rings, segments, outerRadius, flatRadius } = this.options;
    const vertexCount = rings * segments + 1;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const colors = new Float32Array(vertexCount * 3);

    // Rings are spaced so that half of them land inside the flat play area -
    // which is where shadows and the dirt patches need resolution - and the
    // rest stretch out over the rampart, where a 4 m triangle is invisible.
    const insideRings = Math.round(rings * 0.45);
    const radiusAt = (ring: number): number => {
      if (ring <= insideRings) return (ring / insideRings) * flatRadius;
      const t = (ring - insideRings) / (rings - insideRings);
      return flatRadius + (t * t * 0.62 + t * 0.38) * (outerRadius - flatRadius);
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
      vertexCount > 65535
        ? new BufferAttribute(new Uint32Array(triangles), 1)
        : new BufferAttribute(new Uint16Array(triangles), 1),
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
      const heightTint = clamp01(y / Math.max(this.options.rampHeight, 1));
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

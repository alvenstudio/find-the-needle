import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Object3D,
  Quaternion,
  StaticDrawUsage,
  Vector3,
} from 'three';

import type { Assets } from '../core/Assets';
import { Rng } from '../core/Rng';
import type { CollisionWorld } from './Collision';
import type { Terrain } from './Terrain';

/**
 * Everything in the world that is not the haystack.
 *
 * Scenery is laid out procedurally from the tier's seed around a ring whose
 * radius follows the pile, so the same code dresses a five-metre home stack and
 * a forty-metre Mother Lode without a hand-authored layout per tier. What
 * changes between tiers is the *palette* of props, which is what makes the
 * Barn Loft and the Moonlit Meadow feel like different places rather than the
 * same field with different lighting.
 *
 * Scattered vegetation goes through `ScatterLayer`, one `InstancedMesh` per
 * prop type. Ten thousand grass tufts cost one draw call and one matrix upload
 * at load time; after that they are free.
 */

export type SceneKind = 'yard' | 'loft' | 'field' | 'silo' | 'meadow' | 'canyon';

export interface ScenePalette {
  /** Buildings placed on the outer ring, in draw order. */
  buildings: string[];
  /** Scatter props and their density per square metre. */
  scatter: { model: string; density: number; scale: [number, number]; tiltDeg: number; jitterColor: number }[];
  /** Clutter props dropped in ones and twos near the working area. */
  clutter: string[];
  /** Livestock that wanders the yard. */
  animals: { model: string; count: number }[];
  /** How many fence spans ring the working area. 0 disables the fence. */
  fenceSpans: number;
  treeLine: { model: string; count: number }[];
}

export const SCENE_PALETTES: Readonly<Record<SceneKind, ScenePalette>> = {
  yard: {
    buildings: ['barn', 'silo', 'chicken_coop', 'shed'],
    scatter: [
      { model: 'grass_tuft', density: 0.55, scale: [0.7, 1.35], tiltDeg: 9, jitterColor: 0.16 },
      { model: 'flower_patch', density: 0.02, scale: [0.8, 1.2], tiltDeg: 6, jitterColor: 0.1 },
      { model: 'rock', density: 0.006, scale: [0.25, 0.6], tiltDeg: 180, jitterColor: 0.12 },
      { model: 'mushroom', density: 0.004, scale: [0.7, 1.2], tiltDeg: 8, jitterColor: 0.1 },
    ],
    clutter: ['bale_square', 'bale_round', 'bucket', 'crate', 'barrel', 'wheelbarrow', 'milk_can', 'apple_crate'],
    animals: [
      { model: 'cow', count: 2 },
      { model: 'chicken', count: 5 },
      { model: 'cat', count: 1 },
    ],
    fenceSpans: 18,
    treeLine: [
      { model: 'tree_oak', count: 9 },
      { model: 'tree_pine', count: 7 },
      { model: 'bush', count: 14 },
    ],
  },
  loft: {
    buildings: ['barn', 'hay_barn', 'water_tower', 'shed'],
    scatter: [
      { model: 'grass_tuft', density: 0.3, scale: [0.6, 1.1], tiltDeg: 10, jitterColor: 0.2 },
      { model: 'rock', density: 0.01, scale: [0.25, 0.7], tiltDeg: 180, jitterColor: 0.14 },
    ],
    clutter: ['bale_square', 'bale_square', 'bale_round', 'crate', 'barrel', 'hay_cart', 'log'],
    animals: [
      { model: 'chicken', count: 6 },
      { model: 'cat', count: 2 },
    ],
    fenceSpans: 14,
    treeLine: [
      { model: 'tree_pine', count: 12 },
      { model: 'bush', count: 10 },
    ],
  },
  field: {
    buildings: ['hay_barn', 'windmill', 'shed', 'well'],
    scatter: [
      { model: 'grass_tuft', density: 0.8, scale: [0.8, 1.6], tiltDeg: 12, jitterColor: 0.22 },
      { model: 'flower_patch', density: 0.05, scale: [0.9, 1.4], tiltDeg: 8, jitterColor: 0.14 },
      { model: 'sunflower', density: 0.012, scale: [0.8, 1.25], tiltDeg: 7, jitterColor: 0.1 },
    ],
    clutter: ['bale_round', 'bale_round', 'bale_square', 'hay_cart', 'scarecrow', 'pumpkin', 'crate'],
    animals: [
      { model: 'cow', count: 3 },
      { model: 'crow', count: 4 },
    ],
    fenceSpans: 22,
    treeLine: [
      { model: 'tree_oak', count: 12 },
      { model: 'tree_stump', count: 4 },
      { model: 'bush', count: 16 },
    ],
  },
  silo: {
    buildings: ['silo', 'silo', 'water_tower', 'hay_barn', 'shed'],
    scatter: [
      { model: 'grass_tuft', density: 0.34, scale: [0.6, 1.1], tiltDeg: 14, jitterColor: 0.2 },
      { model: 'rock_cluster', density: 0.008, scale: [0.4, 0.9], tiltDeg: 180, jitterColor: 0.16 },
      { model: 'rock', density: 0.016, scale: [0.25, 0.75], tiltDeg: 180, jitterColor: 0.16 },
    ],
    clutter: ['barrel', 'barrel', 'crate', 'milk_can', 'wheelbarrow', 'bale_square', 'log'],
    animals: [{ model: 'crow', count: 6 }],
    fenceSpans: 16,
    treeLine: [
      { model: 'tree_pine', count: 16 },
      { model: 'tree_stump', count: 6 },
    ],
  },
  meadow: {
    buildings: ['windmill', 'well', 'hay_barn', 'chicken_coop'],
    scatter: [
      { model: 'grass_tuft', density: 0.7, scale: [0.7, 1.4], tiltDeg: 11, jitterColor: 0.24 },
      { model: 'flower_patch', density: 0.06, scale: [0.9, 1.5], tiltDeg: 9, jitterColor: 0.2 },
      { model: 'cattail', density: 0.02, scale: [0.8, 1.3], tiltDeg: 10, jitterColor: 0.12 },
      { model: 'mushroom', density: 0.02, scale: [0.8, 1.6], tiltDeg: 10, jitterColor: 0.16 },
    ],
    clutter: ['bale_round', 'log', 'log', 'crate', 'scarecrow', 'gnome'],
    animals: [
      { model: 'cow', count: 2 },
      { model: 'cat', count: 2 },
      { model: 'crow', count: 5 },
    ],
    fenceSpans: 24,
    treeLine: [
      { model: 'tree_pine', count: 14 },
      { model: 'tree_oak', count: 10 },
      { model: 'bush', count: 18 },
    ],
  },
  canyon: {
    buildings: ['barn', 'silo', 'windmill', 'water_tower', 'hay_barn'],
    scatter: [
      { model: 'grass_tuft', density: 0.28, scale: [0.5, 1.0], tiltDeg: 16, jitterColor: 0.26 },
      { model: 'rock', density: 0.05, scale: [0.3, 1.5], tiltDeg: 180, jitterColor: 0.2 },
      { model: 'rock_cluster', density: 0.02, scale: [0.5, 1.8], tiltDeg: 180, jitterColor: 0.2 },
    ],
    clutter: ['bale_round', 'bale_square', 'hay_cart', 'barrel', 'crate', 'chest', 'scarecrow'],
    animals: [{ model: 'crow', count: 8 }],
    fenceSpans: 0,
    treeLine: [
      { model: 'tree_stump', count: 10 },
      { model: 'tree_pine', count: 8 },
    ],
  },
};

interface ScatterSpec {
  model: string;
  density: number;
  scale: [number, number];
  tiltDeg: number;
  jitterColor: number;
}

/**
 * One `InstancedMesh` per scattered prop.
 *
 * Instances are placed once at load, never updated, so the matrix buffer is
 * static and the whole layer is a single draw call with no per-frame cost.
 */
class ScatterLayer {
  readonly mesh: InstancedMesh;

  constructor(assets: Assets, spec: ScatterSpec, count: number) {
    const geometry = assets.geometryOf(spec.model);
    const material = assets.materialOf(spec.model);
    this.mesh = new InstancedMesh(geometry, material, count);
    this.mesh.instanceMatrix.setUsage(StaticDrawUsage);
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

export interface SceneryOptions {
  seed: number;
  scene: SceneKind;
  /** Radius of the haystack this scenery surrounds. */
  pileRadius: number;
  /** Metres beyond the pile where the working ring sits. */
  ringMargin: number;
  /** Distance at which scattered props stop being placed at all. */
  scatterRadius: number;
}

export class Scenery {
  readonly group = new Group();

  private readonly layers: ScatterLayer[] = [];
  private readonly props: Object3D[] = [];
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly axis = new Vector3();
  private readonly spin = new Quaternion();
  private readonly tint = new Color();
  /** Props that rotate every frame - windmill sails, so far. */
  private readonly spinners: Object3D[] = [];

  constructor(
    private readonly assets: Assets,
    private readonly terrain: Terrain,
    private readonly collision: CollisionWorld,
    private readonly options: SceneryOptions,
  ) {
    const palette = SCENE_PALETTES[options.scene];
    const rng = new Rng(options.seed ^ 0x2c1b3f9);

    this.placeBuildings(palette, rng.fork(1));
    this.placeTreeLine(palette, rng.fork(2));
    this.placeFence(palette, rng.fork(3));
    this.placeClutter(palette, rng.fork(4));
    this.scatter(palette, rng.fork(5));
  }

  /** Radius of the ring where kiosks and the sell point live. */
  get ringRadius(): number {
    return this.options.pileRadius + this.options.ringMargin;
  }

  // ---------------------------------------------------------------- placing
  /**
   * Add a prop, drop it onto the terrain and register a collider for it.
   *
   * `collider` is sized from the model's own bounds, shrunk slightly: a capsule
   * that grazes a fence post should slide past rather than catch, and props
   * read as solid long before their bounding box does.
   */
  private place(
    model: string,
    x: number,
    z: number,
    yaw: number,
    scale = 1,
    solid: 'box' | 'cylinder' | 'none' = 'box',
  ): Object3D | null {
    if (!this.assets.has(model)) return null;
    const loaded = this.assets.model(model);
    const object = this.assets.instantiate(model);
    const y = this.terrain.heightAt(x, z);
    object.position.set(x, y, z);
    object.rotation.y = yaw;
    object.scale.setScalar(scale);
    object.matrixAutoUpdate = false;
    object.updateMatrix();
    this.group.add(object);
    this.props.push(object);

    if (solid !== 'none') {
      const size = loaded.size;
      const halfX = Math.max(0.12, (size.x * scale) / 2 - 0.08);
      const halfZ = Math.max(0.12, (size.z * scale) / 2 - 0.08);
      const top = y + size.y * scale * 0.98;
      if (solid === 'cylinder') {
        this.collision.addCylinder(x, z, Math.max(halfX, halfZ), y, top);
      } else {
        this.collision.addBox(new Vector3(x, y, z), halfX, halfZ, y, top, yaw);
      }
    }
    return object;
  }

  private placeBuildings(palette: ScenePalette, rng: Rng): void {
    const radius = this.ringRadius + 13;
    const count = palette.buildings.length;
    palette.buildings.forEach((model, index) => {
      // Spread the buildings around the back half of the ring, leaving the
      // front open so the player always faces the stack across clear ground.
      const angle = Math.PI * 0.28 + (index / Math.max(count - 1, 1)) * Math.PI * 1.44 + rng.signed(0.1);
      const distance = radius + rng.range(-2.5, 7);
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      const placed = this.place(model, x, z, Math.atan2(-x, -z) + rng.signed(0.22), 1, 'box');
      if (placed) this.terrain.addDirtPatch(x, z, 3.2);

      if (model === 'windmill' && this.assets.has('windmill_blades')) {
        const blades = this.assets.instantiate('windmill_blades');
        const height = this.assets.model('windmill').size.y;
        blades.position.set(x, this.terrain.heightAt(x, z) + height * 0.88, z);
        blades.rotation.y = Math.atan2(-x, -z);
        blades.userData.spin = rng.range(0.35, 0.6);
        this.group.add(blades);
        this.spinners.push(blades);
      }
    });
  }

  private placeTreeLine(palette: ScenePalette, rng: Rng): void {
    const inner = this.ringRadius + 22;
    const outer = Math.min(this.options.scatterRadius, inner + 55);
    for (const entry of palette.treeLine) {
      for (let i = 0; i < entry.count; i++) {
        const point = this.terrain.samplePoint(rng, inner, outer, this.position);
        this.place(entry.model, point.x, point.z, rng.range(0, Math.PI * 2), rng.range(0.8, 1.35), 'cylinder');
      }
    }
  }

  private placeFence(palette: ScenePalette, rng: Rng): void {
    if (palette.fenceSpans <= 0 || !this.assets.has('fence_section')) return;
    const radius = this.ringRadius + 6.5;
    const spans = palette.fenceSpans;
    // Leave a gap where the player walks in from the spawn pad.
    const gapStart = Math.PI * 1.42;
    const gapWidth = Math.PI * 0.34;

    for (let i = 0; i < spans; i++) {
      const angle = (i / spans) * Math.PI * 2;
      if (angle > gapStart && angle < gapStart + gapWidth) continue;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      // Fence sections run along their local X, so the yaw is the tangent.
      this.place('fence_section', x, z, angle + Math.PI / 2 + rng.signed(0.02), 1, 'box');
    }
  }

  private placeClutter(palette: ScenePalette, rng: Rng): void {
    const inner = this.options.pileRadius + 3.5;
    const outer = this.ringRadius + 5;
    for (const model of palette.clutter) {
      const point = this.terrain.samplePoint(rng, inner, outer, this.position);
      this.place(model, point.x, point.z, rng.range(0, Math.PI * 2), rng.range(0.9, 1.15), 'box');
    }
  }

  /**
   * Fill the ground with vegetation.
   *
   * Placement uses rejection sampling against the pile footprint and the
   * working ring, and density falls off with distance so the far field is not
   * paying for tufts nobody will ever stand next to.
   */
  private scatter(palette: ScenePalette, rng: Rng): void {
    const { pileRadius, scatterRadius } = this.options;
    const clearRadius = pileRadius + 1.5;

    for (const spec of palette.scatter) {
      if (!this.assets.has(spec.model)) continue;
      const area = Math.PI * (scatterRadius * scatterRadius - clearRadius * clearRadius);
      const wanted = Math.min(24000, Math.round(area * spec.density));
      if (wanted <= 0) continue;

      const layer = new ScatterLayer(this.assets, spec, wanted);
      const isFlatProp = spec.tiltDeg >= 180;
      let placed = 0;
      let attempts = 0;

      while (placed < wanted && attempts < wanted * 4) {
        attempts++;
        const angle = rng.range(0, Math.PI * 2);
        // Bias the radius so density thins out gently toward the horizon.
        const t = Math.pow(rng.next(), 0.62);
        const radius = clearRadius + t * (scatterRadius - clearRadius);
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;

        this.position.set(x, this.terrain.heightAt(x, z) - 0.02, z);
        const uniform = rng.range(spec.scale[0], spec.scale[1]);
        this.scale.set(uniform, uniform * rng.range(0.9, 1.12), uniform);

        if (isFlatProp) {
          // Rocks and debris take a fully random orientation.
          this.axis.set(rng.signed(1), rng.signed(1), rng.signed(1)).normalize();
          this.quaternion.setFromAxisAngle(this.axis, rng.range(0, Math.PI * 2));
        } else {
          this.axis.set(rng.signed(1), 0, rng.signed(1)).normalize();
          this.quaternion.setFromAxisAngle(this.axis, rng.range(0, (spec.tiltDeg * Math.PI) / 180));
          this.spin.setFromAxisAngle(UP, rng.range(0, Math.PI * 2));
          this.quaternion.multiply(this.spin);
        }

        this.matrix.compose(this.position, this.quaternion, this.scale);
        layer.mesh.setMatrixAt(placed, this.matrix);

        const shift = 1 + rng.signed(spec.jitterColor);
        this.tint.setRGB(shift, shift * (1 + rng.signed(spec.jitterColor * 0.4)), shift);
        layer.mesh.setColorAt(placed, this.tint);
        placed++;
      }

      layer.mesh.count = placed;
      layer.mesh.instanceMatrix.needsUpdate = true;
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
      layer.mesh.computeBoundingSphere();
      this.layers.push(layer);
      this.group.add(layer.mesh);
    }
  }

  /** Animate the few props that move on their own. */
  update(dt: number): void {
    for (const spinner of this.spinners) {
      spinner.rotation.z += dt * (spinner.userData.spin as number);
      spinner.updateMatrix();
    }
  }

  /**
   * Drop the scenery.
   *
   * Instanced layers own their `InstancedMesh` and must be disposed; placed
   * props are shallow clones that share geometry and materials with the asset
   * library, so releasing the group is all they need.
   */
  dispose(): void {
    for (const layer of this.layers) layer.dispose();
    this.layers.length = 0;
    this.props.length = 0;
    this.spinners.length = 0;
    this.group.clear();
  }
}

const UP = new Vector3(0, 1, 0);

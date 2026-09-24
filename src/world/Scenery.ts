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
  /** Metres beyond the working ring where the boundary fence stands. */
  boundaryMargin: number;
  /** Distance at which scattered props stop being placed at all. */
  scatterRadius: number;
}

export class Scenery {
  readonly group = new Group();

  private readonly layers: ScatterLayer[] = [];
  private fenceMesh: InstancedMesh | null = null;
  /**
   * Footprints the scatter must leave alone.
   *
   * Grass is placed by rejection sampling, and without this the tufts grow
   * happily through the barn floor and out of the shed roof. Only props with a
   * real footprint get one; a tuft inside a crate is nobody's problem.
   */
  private readonly clearings: { x: number; z: number; radius: number }[] = [];
  private readonly props: Object3D[] = [];
  /** Farthest edge and highest point of anything placed, from the world origin. */
  private castRadius = 0;
  private castTop = 0;
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
    this.placeFence(rng.fork(3));
    this.placeClutter(palette, rng.fork(4));
    this.scatter(palette, rng.fork(5));
  }

  /** Radius of the ring where kiosks and the sell point live. */
  get ringRadius(): number {
    return this.options.pileRadius + this.options.ringMargin;
  }

  /**
   * Radius of the boundary fence - the edge of the world.
   *
   * Everything the player can walk to is inside this: the stack, the kiosks,
   * the barn and the yard clutter. `CollisionWorld.boundaryRadius` is set from
   * it, which is what actually stops them leaving.
   */
  get boundaryRadius(): number {
    return this.ringRadius + this.options.boundaryMargin;
  }

  /**
   * A cylinder around the origin containing everything the scenery put down,
   * trees on the far hillside included.
   *
   * The shadow camera is fitted to this. It is measured rather than derived
   * from the ring radii because the tree line is scattered with a random
   * radius and the terrain it lands on is a hill, so the only honest answer is
   * where the props actually ended up.
   */
  get castExtent(): { radius: number; top: number } {
    return { radius: this.castRadius, top: this.castTop };
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
    solid: SolidKind = 'box',
  ): Object3D | null {
    if (!this.assets.has(model)) return null;
    const loaded = this.assets.model(model);
    const object = this.assets.instantiate(model);
    const y = this.terrain.heightAt(x, z);
    const spread = (Math.max(loaded.size.x, loaded.size.z) * scale) / 2;
    this.castRadius = Math.max(this.castRadius, Math.hypot(x, z) + spread);
    this.castTop = Math.max(this.castTop, y + loaded.size.y * scale);
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
      if (Math.max(halfX, halfZ) > 1.2) {
        this.clearings.push({ x, z, radius: Math.hypot(halfX, halfZ) * 0.94 });
      }
      if (solid === 'cylinder') {
        this.collision.addCylinder(x, z, Math.max(halfX, halfZ), y, top);
      } else if (solid === 'shell') {
        this.addShellColliders(model, x, y, z, yaw, halfX, halfZ, top);
      } else if (solid === 'frame') {
        this.addFrameColliders(FRAME_PARTS[model] ?? [], x, y, z, yaw, scale);
      } else {
        this.collision.addBox(new Vector3(x, y, z), halfX, halfZ, y, top, yaw);
      }
    }
    return object;
  }

  /**
   * Collide a building as four walls with a doorway, not as a solid block.
   *
   * The barn is modelled with a real 3 x 3.4 m opening in its front wall, and
   * a bounding box across the whole footprint is the only reason a player
   * cannot walk through it. Five slabs cost five colliders instead of one and
   * turn the biggest building on the farm from scenery into a place.
   */
  private addShellColliders(
    model: string,
    x: number,
    y: number,
    z: number,
    yaw: number,
    halfX: number,
    halfZ: number,
    top: number,
  ): void {
    const doorWidth = DOOR_WIDTHS[model] ?? 3;
    const t = WALL_HALF_THICKNESS;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Local (x, z) -> world, matching three.js's rotation about Y.
    const toWorld = (lx: number, lz: number): Vector3 =>
      this.position.set(x + lx * cos + lz * sin, y, z - lx * sin + lz * cos);

    // Back wall and the two sides are unbroken; the door is in local +z, which
    // is the face the model is authored to open through and the one `place`
    // turns toward the yard.
    this.collision.addBox(toWorld(0, -(halfZ - t)), halfX, t, y, top, yaw);
    this.collision.addBox(toWorld(-(halfX - t), 0), t, halfZ, y, top, yaw);
    this.collision.addBox(toWorld(halfX - t, 0), t, halfZ, y, top, yaw);

    const jamb = Math.max(0, halfX - doorWidth / 2) / 2;
    if (jamb > 0.05) {
      const offset = doorWidth / 2 + jamb;
      this.collision.addBox(toWorld(-offset, halfZ - t), jamb, t, y, top, yaw);
      this.collision.addBox(toWorld(offset, halfZ - t), jamb, t, y, top, yaw);
    }
  }

  /**
   * Collide a building that is mostly air as the few pieces that are not.
   *
   * Parts are authored in the model's own metres, so the table reads like the
   * building: a wall across the back, a post at each corner of the bay.
   */
  private addFrameColliders(
    parts: readonly FramePart[],
    x: number,
    y: number,
    z: number,
    yaw: number,
    scale: number,
  ): void {
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    for (const part of parts) {
      const lx = part.x * scale;
      const lz = part.z * scale;
      this.position.set(x + lx * cos + lz * sin, y, z - lx * sin + lz * cos);
      this.collision.addBox(
        this.position,
        part.halfX * scale,
        part.halfZ * scale,
        y,
        y + part.height * scale,
        yaw,
      );
    }
  }

  private placeBuildings(palette: ScenePalette, rng: Rng): void {
    // Inside the fence, and close enough that walking to the barn is a
    // ten-second detour rather than a hike across an empty field.
    const radius = this.ringRadius + 8.5;
    const count = palette.buildings.length;
    palette.buildings.forEach((model, index) => {
      // Spread the buildings around the back half of the ring, leaving the
      // front open so the player always faces the stack across clear ground.
      const angle = Math.PI * 0.28 + (index / Math.max(count - 1, 1)) * Math.PI * 1.44 + rng.signed(0.1);
      const distance = radius + rng.range(-1.5, 3.5);
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      // A building you can walk into has to face the yard squarely, or the
      // doorway ends up pointing at the fence.
      const solid: SolidKind = model in DOOR_WIDTHS ? 'shell' : model in FRAME_PARTS ? 'frame' : 'box';
      // A building whose collision is a hand-authored list of pieces has to
      // stand where the model stands, or the pieces land beside the walls.
      const jitter = solid === 'box' ? rng.signed(0.22) : 0;
      const yaw = Math.atan2(-x, -z) + jitter;
      const placed = this.place(model, x, z, yaw, 1, solid);
      if (placed) this.terrain.addDirtPatch(x, z, solid === 'shell' ? 5.5 : 3.2);
      if (placed && solid === 'shell') this.dressInterior(model, x, z, yaw, rng);

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

  /**
   * Put something in the building worth walking in for.
   *
   * Bales and crates against the back wall, clear of the doorway and clear of
   * each other. An empty shed is a disappointment the first time and invisible
   * every time after.
   */
  private dressInterior(model: string, x: number, z: number, yaw: number, rng: Rng): void {
    const size = this.assets.model(model).size;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const halfX = size.x / 2 - 1.2;
    const back = -(size.z / 2 - 1.4);

    INTERIOR_PROPS.forEach((prop, index) => {
      if (!this.assets.has(prop)) return;
      const lx = (index / Math.max(INTERIOR_PROPS.length - 1, 1) - 0.5) * 2 * halfX + rng.signed(0.4);
      const lz = back + rng.range(0, 1.6);
      this.place(
        prop,
        x + lx * cos + lz * sin,
        z - lx * sin + lz * cos,
        yaw + rng.signed(0.5),
        rng.range(0.92, 1.08),
        'box',
      );
    });
  }

  /**
   * Trees, on the slope outside the fence.
   *
   * They get no colliders: the player cannot reach them, and a hundred
   * cylinders in the broadphase for scenery nobody can touch is pure cost.
   */
  private placeTreeLine(palette: ScenePalette, rng: Rng): void {
    const inner = this.boundaryRadius + 2.5;
    const outer = Math.min(this.options.scatterRadius, inner + 26);
    for (const entry of palette.treeLine) {
      for (let i = 0; i < entry.count; i++) {
        const point = this.terrain.samplePoint(rng, inner, outer, this.position);
        this.place(entry.model, point.x, point.z, rng.range(0, Math.PI * 2), rng.range(0.85, 1.4), 'none');
      }
    }
  }

  /**
   * The boundary fence: one closed ring of post-and-rail around the yard.
   *
   * Drawn as a single `InstancedMesh` because the ring is eighty-odd spans and
   * eighty draw calls for a fence is not a trade worth making. It carries no
   * colliders either - `CollisionWorld.boundaryRadius` is the wall, and one
   * analytic circle cannot develop the gap that a ring of boxes eventually
   * will.
   */
  private placeFence(rng: Rng): void {
    if (!this.assets.has('fence_section')) return;
    const radius = this.boundaryRadius;
    // Sections are authored 2.4 m long and chain end post to end post, so the
    // count is the circumference over the span, rounded up so they overlap
    // very slightly rather than leaving a slot.
    const span = this.assets.model('fence_section').size.x || FENCE_SPAN;
    const count = Math.max(12, Math.ceil((Math.PI * 2 * radius) / span));

    const mesh = new InstancedMesh(
      this.assets.geometryOf('fence_section'),
      this.assets.materialOf('fence_section'),
      count,
    );
    mesh.instanceMatrix.setUsage(StaticDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      this.position.set(x, this.terrain.heightAt(x, z), z);
      // Sections run along their local X, so the yaw is the ring's tangent.
      this.quaternion.setFromAxisAngle(UP, -angle + Math.PI / 2 + rng.signed(0.012));
      // Chord length is a hair under the arc, so widen each span to close the
      // joint instead of leaving a sliver of daylight at every post.
      this.scale.set(1.02, 1, 1);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      mesh.setMatrixAt(i, this.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.castRadius = Math.max(this.castRadius, radius + span);
    this.castTop = Math.max(this.castTop, this.assets.model('fence_section').size.y);
    this.fenceMesh = mesh;
    this.group.add(mesh);
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
    const { pileRadius } = this.options;
    const clearRadius = pileRadius + 1.5;
    // Vegetation stops a little way past the fence. Beyond that it is on a
    // hillside the player will never stand on, where one tuft in a thousand
    // covers a pixel.
    const scatterRadius = Math.min(this.options.scatterRadius, this.boundaryRadius + 22);

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
        if (this.isCleared(x, z)) continue;

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

  private isCleared(x: number, z: number): boolean {
    for (const clearing of this.clearings) {
      const dx = x - clearing.x;
      const dz = z - clearing.z;
      if (dx * dx + dz * dz < clearing.radius * clearing.radius) return true;
    }
    return false;
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
    this.fenceMesh?.dispose();
    this.fenceMesh = null;
    this.clearings.length = 0;
    this.props.length = 0;
    this.spinners.length = 0;
    this.group.clear();
  }
}

/** How a prop blocks the player. */
type SolidKind = 'box' | 'cylinder' | 'shell' | 'frame' | 'none';

/** One solid piece of an open-framed building, in the model's local metres. */
interface FramePart {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  height: number;
}

/**
 * Buildings modelled with a real doorway, and how wide it is.
 *
 * These get wall colliders instead of a bounding box, so the opening the model
 * already has is an opening in the collision too.
 */
const DOOR_WIDTHS: Readonly<Record<string, number>> = {
  barn: 3,
};

/**
 * Buildings that are mostly air, as the pieces of them that are not.
 *
 * A pole barn is a roof on six posts with one wall across the back, so boxing
 * its footprint would make the shelter you are meant to walk under into a
 * solid block. It used to carry no collision at all instead, and that is worse
 * than either: measured across the five scenes it stands in, a player could
 * walk into the middle of it from 17 or 18 of 18 compass headings, straight
 * through an eight-metre plank wall and through every post on the way. An
 * open-sided building is open on the sides that are open.
 *
 * Numbers are the model's own, read back off the exported mesh: the wall runs
 * x -4..4 at z -2.7, the posts stand at x -3.7, 0, 3.7 on both z -2.7 and
 * 2.7. The wall collider is twice the thickness of the plank it stands for,
 * six centimetres proud on each side, which no one will ever feel and which
 * leaves no doubt about a capsule crossing it in one step.
 */
const POLE_BARN_POSTS: readonly FramePart[] = [-3.7, 0, 3.7].flatMap((x) =>
  [-2.7, 2.7].map((z) => ({ x, z, halfX: 0.12, halfZ: 0.12, height: 3.45 })),
);

const FRAME_PARTS: Readonly<Record<string, readonly FramePart[]>> = {
  hay_barn: [{ x: 0, z: -2.7, halfX: 4, halfZ: 0.12, height: 3.7 }, ...POLE_BARN_POSTS],
};

/** Authored length of one fence span, as a fallback if the model is missing. */
const FENCE_SPAN = 2.4;
/** Half the thickness of a building's wall collider, in metres. */
const WALL_HALF_THICKNESS = 0.2;

/** What stands inside a building the player can walk into. */
const INTERIOR_PROPS: readonly string[] = ['bale_square', 'bale_round', 'crate', 'barrel'];

const UP = new Vector3(0, 1, 0);

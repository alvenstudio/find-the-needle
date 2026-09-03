import { Box3, Vector3 } from 'three';

/**
 * Collision for a farmyard.
 *
 * The world is flat-ish ground with a handful of solid boxes and cylinders on
 * it, so a full physics engine would be several hundred kilobytes spent solving
 * a problem we do not have. Instead: ground height is a function, obstacles are
 * a static list in a uniform grid, and the player is a vertical capsule pushed
 * out of anything it overlaps.
 *
 * Everything here is deterministic and allocation-free on the hot path.
 */

export interface GroundSampler {
  /** Surface height at a world column, in metres. */
  (x: number, z: number): number;
}

export interface BoxCollider {
  kind: 'box';
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Vertical span; the player can walk over anything below `top` if it is a step. */
  bottom: number;
  top: number;
  /** Rotation around Y, in radians. Boxes are OBBs in the XZ plane. */
  yaw: number;
  /** Precomputed centre, used for the rotated overlap test. */
  centreX: number;
  centreZ: number;
  halfX: number;
  halfZ: number;
}

export interface CylinderCollider {
  kind: 'cylinder';
  x: number;
  z: number;
  radius: number;
  bottom: number;
  top: number;
}

export type Collider = BoxCollider | CylinderCollider;

const CELL_SIZE = 4;

export class CollisionWorld {
  /** Height of walkable ground, before any hay is taken into account. */
  groundHeight: GroundSampler = () => 0;

  private readonly colliders: Collider[] = [];
  private readonly buckets = new Map<number, number[]>();
  private readonly bounds = new Box3();

  /** Extra ground layers, e.g. the hay pile, sampled as a max over the base. */
  private readonly elevators: GroundSampler[] = [];

  addElevator(sampler: GroundSampler): () => void {
    this.elevators.push(sampler);
    return () => {
      const index = this.elevators.indexOf(sampler);
      if (index >= 0) this.elevators.splice(index, 1);
    };
  }

  /** Walkable height including hay, ramps and anything else stacked on the ground. */
  surfaceHeight(x: number, z: number): number {
    let height = this.groundHeight(x, z);
    for (const elevator of this.elevators) {
      const candidate = elevator(x, z);
      if (candidate > height) height = candidate;
    }
    return height;
  }

  addBox(centre: Vector3, halfX: number, halfZ: number, bottom: number, top: number, yaw = 0): BoxCollider {
    const extent = Math.hypot(halfX, halfZ);
    const collider: BoxCollider = {
      kind: 'box',
      centreX: centre.x,
      centreZ: centre.z,
      halfX,
      halfZ,
      yaw,
      bottom,
      top,
      minX: centre.x - extent,
      maxX: centre.x + extent,
      minZ: centre.z - extent,
      maxZ: centre.z + extent,
    };
    this.register(collider, collider.minX, collider.minZ, collider.maxX, collider.maxZ);
    return collider;
  }

  addCylinder(x: number, z: number, radius: number, bottom: number, top: number): CylinderCollider {
    const collider: CylinderCollider = { kind: 'cylinder', x, z, radius, bottom, top };
    this.register(collider, x - radius, z - radius, x + radius, z + radius);
    return collider;
  }

  private register(collider: Collider, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const index = this.colliders.push(collider) - 1;
    this.bounds.expandByPoint(new Vector3(minX, 0, minZ));
    this.bounds.expandByPoint(new Vector3(maxX, 0, maxZ));
    const x0 = Math.floor(minX / CELL_SIZE);
    const x1 = Math.floor(maxX / CELL_SIZE);
    const z0 = Math.floor(minZ / CELL_SIZE);
    const z1 = Math.floor(maxZ / CELL_SIZE);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = cellKey(cx, cz);
        const bucket = this.buckets.get(key);
        if (bucket) bucket.push(index);
        else this.buckets.set(key, [index]);
      }
    }
  }

  clear(): void {
    this.colliders.length = 0;
    this.buckets.clear();
    this.bounds.makeEmpty();
  }

  get colliderCount(): number {
    return this.colliders.length;
  }

  /**
   * Push a capsule out of every obstacle it overlaps.
   *
   * Iterated three times because resolving one contact can push the capsule
   * into another; three passes settles every corner case a farmyard produces
   * and costs nothing at this collider count.
   */
  resolve(position: Vector3, radius: number, height: number): boolean {
    let touched = false;
    const feet = position.y;
    const head = position.y + height;

    for (let pass = 0; pass < 3; pass++) {
      let movedThisPass = false;
      const cx = Math.floor(position.x / CELL_SIZE);
      const cz = Math.floor(position.z / CELL_SIZE);

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = this.buckets.get(cellKey(cx + dx, cz + dz));
          if (!bucket) continue;
          for (const index of bucket) {
            const collider = this.colliders[index];
            // A collider entirely below our feet or above our head is not in the way.
            if (collider.top <= feet + 0.02 || collider.bottom >= head) continue;
            if (collider.kind === 'cylinder') {
              if (pushOutOfCylinder(position, radius, collider)) movedThisPass = true;
            } else if (pushOutOfBox(position, radius, collider)) {
              movedThisPass = true;
            }
          }
        }
      }
      if (movedThisPass) touched = true;
      else break;
    }
    return touched;
  }

  /**
   * The height of the highest collider top the capsule is standing on, or
   * `-Infinity` if it is standing on open ground. Lets the player walk up onto
   * a cart or a bale without a full physics solver.
   */
  supportHeight(x: number, z: number, radius: number, feet: number, stepUp: number): number {
    let best = -Infinity;
    const cx = Math.floor(x / CELL_SIZE);
    const cz = Math.floor(z / CELL_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.buckets.get(cellKey(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const index of bucket) {
          const collider = this.colliders[index];
          if (collider.top > feet + stepUp || collider.top <= best) continue;
          if (collider.kind === 'cylinder') {
            if (Math.hypot(x - collider.x, z - collider.z) <= collider.radius + radius) best = collider.top;
          } else if (insideBox(x, z, radius, collider)) {
            best = collider.top;
          }
        }
      }
    }
    return best;
  }
}

function cellKey(x: number, z: number): number {
  // Two 16-bit halves packed into one number; the world is far smaller than
  // the +-32 km this covers.
  return ((x & 0xffff) << 16) | (z & 0xffff);
}

function pushOutOfCylinder(position: Vector3, radius: number, collider: CylinderCollider): boolean {
  const dx = position.x - collider.x;
  const dz = position.z - collider.z;
  const combined = collider.radius + radius;
  const distanceSquared = dx * dx + dz * dz;
  if (distanceSquared >= combined * combined) return false;

  const distance = Math.sqrt(distanceSquared);
  if (distance < 1e-5) {
    position.x = collider.x + combined;
    return true;
  }
  const scale = combined / distance;
  position.x = collider.x + dx * scale;
  position.z = collider.z + dz * scale;
  return true;
}

function pushOutOfBox(position: Vector3, radius: number, collider: BoxCollider): boolean {
  // Work in the box's local frame so a rotated fence still collides correctly.
  const cos = Math.cos(-collider.yaw);
  const sin = Math.sin(-collider.yaw);
  const rx = position.x - collider.centreX;
  const rz = position.z - collider.centreZ;
  const localX = rx * cos - rz * sin;
  const localZ = rx * sin + rz * cos;

  const overlapX = collider.halfX + radius - Math.abs(localX);
  const overlapZ = collider.halfZ + radius - Math.abs(localZ);
  if (overlapX <= 0 || overlapZ <= 0) return false;

  // Escape along the shallower axis - the minimum translation vector.
  let outX = localX;
  let outZ = localZ;
  if (overlapX < overlapZ) outX += Math.sign(localX || 1) * overlapX;
  else outZ += Math.sign(localZ || 1) * overlapZ;

  const backCos = Math.cos(collider.yaw);
  const backSin = Math.sin(collider.yaw);
  position.x = collider.centreX + (outX * backCos - outZ * backSin);
  position.z = collider.centreZ + (outX * backSin + outZ * backCos);
  return true;
}

function insideBox(x: number, z: number, radius: number, collider: BoxCollider): boolean {
  const cos = Math.cos(-collider.yaw);
  const sin = Math.sin(-collider.yaw);
  const rx = x - collider.centreX;
  const rz = z - collider.centreZ;
  const localX = Math.abs(rx * cos - rz * sin);
  const localZ = Math.abs(rx * sin + rz * cos);
  return localX <= collider.halfX + radius && localZ <= collider.halfZ + radius;
}

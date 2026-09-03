import {
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  TetrahedronGeometry,
  Vector3,
} from 'three';

import type { Assets } from '../core/Assets';
import { clamp01 } from '../core/MathX';
import { stylize } from '../core/Materials';
import { Rng } from '../core/Rng';

/**
 * Particles.
 *
 * Two instanced pools, simulated on the CPU: straw wisps that arc out of the
 * crater and get sucked into the player's backpack, and sparks for treasure
 * reveals and coin pickups. A thousand instances is a few hundred microseconds
 * of arithmetic and a single buffer upload, which is cheaper than the shader
 * plumbing a GPU system would need for behaviour this specific.
 *
 * Fading is done by shrinking rather than by alpha: it needs no transparency,
 * no sorting, and no depth-write trickery, and on a stylised look it reads as
 * "the straw got sucked away" rather than "the straw went see-through".
 */

interface Particle {
  active: boolean;
  life: number;
  maxLife: number;
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly spin: Vector3;
  readonly rotation: Vector3;
  scale: number;
  /** Strength of the pull toward the collection target. */
  attraction: number;
  gravity: number;
  drag: number;
  /** Per-particle tint, so two differently coloured bursts never blend. */
  readonly color: Color;
}

const UP = new Vector3(0, 1, 0);

class Pool {
  readonly mesh: InstancedMesh;
  private readonly particles: Particle[] = [];
  private readonly matrix = new Matrix4();
  private readonly quaternion = new Quaternion();
  private readonly axis = new Vector3();
  private readonly scaleVector = new Vector3();
  private cursor = 0;
  private live = 0;

  constructor(mesh: InstancedMesh, capacity: number) {
    this.mesh = mesh;
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    for (let i = 0; i < capacity; i++) {
      this.particles.push({
        active: false,
        life: 0,
        maxLife: 1,
        position: new Vector3(),
        velocity: new Vector3(),
        spin: new Vector3(),
        rotation: new Vector3(),
        scale: 1,
        attraction: 0,
        gravity: 9.8,
        drag: 1.4,
        color: new Color(1, 1, 1),
      });
    }
    // Everything starts collapsed so unused slots draw nothing.
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  get liveCount(): number {
    return this.live;
  }

  /** Claim a slot, recycling the oldest when the pool is saturated. */
  spawn(): Particle {
    const capacity = this.particles.length;
    for (let i = 0; i < capacity; i++) {
      const index = (this.cursor + i) % capacity;
      const particle = this.particles[index];
      if (!particle.active) {
        this.cursor = (index + 1) % capacity;
        particle.active = true;
        this.live++;
        return particle;
      }
    }
    const particle = this.particles[this.cursor];
    this.cursor = (this.cursor + 1) % capacity;
    return particle;
  }

  update(dt: number, target: Vector3 | null): void {
    let dirty = false;
    for (let index = 0; index < this.particles.length; index++) {
      const particle = this.particles[index];
      if (!particle.active) continue;

      particle.life += dt;
      if (particle.life >= particle.maxLife) {
        particle.active = false;
        this.live--;
        this.matrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(index, this.matrix);
        dirty = true;
        continue;
      }

      if (particle.attraction > 0 && target) {
        // Pull hardens as the particle closes, so it accelerates into the
        // backpack instead of drifting lazily toward it.
        this.axis.copy(target).sub(particle.position);
        const distance = this.axis.length();
        if (distance < 0.35) {
          particle.life = particle.maxLife;
        } else {
          this.axis.divideScalar(distance);
          const pull = particle.attraction * (1 + 9 / (distance + 0.6));
          particle.velocity.addScaledVector(this.axis, pull * dt);
        }
      } else {
        particle.velocity.y -= particle.gravity * dt;
      }

      const damping = Math.max(0, 1 - particle.drag * dt);
      particle.velocity.multiplyScalar(damping);
      particle.position.addScaledVector(particle.velocity, dt);
      particle.rotation.x += particle.spin.x * dt;
      particle.rotation.y += particle.spin.y * dt;
      particle.rotation.z += particle.spin.z * dt;

      // Shrink over the last third of the life so the exit reads as intended.
      const remaining = 1 - particle.life / particle.maxLife;
      const scale = particle.scale * clamp01(remaining * 3);

      this.axis.set(particle.rotation.x, particle.rotation.y, particle.rotation.z);
      const angle = this.axis.length();
      if (angle > 1e-5) this.quaternion.setFromAxisAngle(this.axis.divideScalar(angle), angle);
      else this.quaternion.setFromAxisAngle(UP, 0);

      this.scaleVector.setScalar(scale);
      this.matrix.compose(particle.position, this.quaternion, this.scaleVector);
      this.mesh.setMatrixAt(index, this.matrix);
      if (this.mesh.instanceColor) this.mesh.setColorAt(index, particle.color);
      dirty = true;
    }

    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  clear(): void {
    for (let index = 0; index < this.particles.length; index++) {
      this.particles[index].active = false;
      this.matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(index, this.matrix);
    }
    this.live = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

export interface ParticleBudget {
  straw: number;
  spark: number;
}

export class Particles {
  readonly group = new Group();

  private readonly straw: Pool;
  private readonly spark: Pool;
  private readonly sparkColor = new Color();
  private readonly rng = new Rng(0xc0ffee);
  private readonly scratch = new Vector3();
  /** Where collected straw flies to; the game keeps this on the player. */
  readonly collectTarget = new Vector3();

  constructor(assets: Assets, budget: ParticleBudget) {
    const strawMaterial = stylize(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
      { rim: 0.5 },
    );
    const strawGeometry = assets.has('hay_wisp') ? assets.geometryOf('hay_wisp') : assets.geometryOf('straw');
    this.straw = new Pool(new InstancedMesh(strawGeometry, strawMaterial, budget.straw), budget.straw);

    // A tetrahedron is the cheapest shape that still reads as a glint from any
    // angle, and it needs no billboarding.
    const sparkMaterial = stylize(
      new MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.4,
        metalness: 0,
        emissive: new Color(0xffffff),
        emissiveIntensity: 2.4,
      }),
      { rim: 0, emissiveFromColor: true, cacheKey: 'spark' },
    );
    const sparkMesh = new InstancedMesh(new TetrahedronGeometry(0.06, 0), sparkMaterial, budget.spark);
    sparkMesh.setColorAt(0, new Color(0xffffff));
    this.spark = new Pool(sparkMesh, budget.spark);

    this.group.add(this.straw.mesh, this.spark.mesh);
  }

  get liveCount(): number {
    return this.straw.liveCount + this.spark.liveCount;
  }

  /**
   * Straw thrown out of a crater and drawn toward the player.
   *
   * The initial velocity is biased along the surface normal so the spray
   * follows the shape of the pile rather than exploding symmetrically.
   */
  burst(origin: Vector3, normal: Vector3, count: number, power: number): void {
    for (let i = 0; i < count; i++) {
      const particle = this.straw.spawn();
      particle.life = 0;
      particle.maxLife = this.rng.range(0.45, 0.8);
      particle.position.copy(origin).addScaledVector(normal, this.rng.range(0, 0.18));
      particle.position.x += this.rng.signed(0.16);
      particle.position.z += this.rng.signed(0.16);
      particle.velocity
        .set(this.rng.signed(1), this.rng.range(0.4, 1.4), this.rng.signed(1))
        .normalize()
        .multiplyScalar(this.rng.range(1.6, 3.4) * (0.6 + power * 0.7))
        .addScaledVector(normal, 1.4);
      particle.spin.set(this.rng.signed(9), this.rng.signed(9), this.rng.signed(9));
      particle.rotation.set(this.rng.signed(3), this.rng.signed(3), this.rng.signed(3));
      particle.scale = this.rng.range(0.7, 1.5);
      particle.attraction = 0;
      particle.gravity = 11;
      particle.drag = 1.5;
    }
  }

  /** Straw that flies straight into the backpack - the collect feedback. */
  collect(origin: Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      const particle = this.straw.spawn();
      particle.life = 0;
      particle.maxLife = this.rng.range(0.3, 0.55);
      particle.position.copy(origin);
      particle.position.x += this.rng.signed(0.3);
      particle.position.y += this.rng.range(0, 0.3);
      particle.position.z += this.rng.signed(0.3);
      particle.velocity.set(this.rng.signed(1.6), this.rng.range(0.6, 2.2), this.rng.signed(1.6));
      particle.spin.set(this.rng.signed(14), this.rng.signed(14), this.rng.signed(14));
      particle.rotation.set(this.rng.signed(3), this.rng.signed(3), this.rng.signed(3));
      particle.scale = this.rng.range(0.6, 1.2);
      particle.attraction = this.rng.range(10, 16);
      particle.gravity = 0;
      particle.drag = 0.6;
    }
  }

  /** A shower of glints, for reveals, sales and level-ups. */
  sparkle(origin: Vector3, count: number, color: string, speed = 3): void {
    this.sparkColor.set(color);
    for (let i = 0; i < count; i++) {
      const particle = this.spark.spawn();
      particle.life = 0;
      particle.maxLife = this.rng.range(0.5, 1.1);
      particle.position.copy(origin);
      particle.velocity
        .set(this.rng.signed(1), this.rng.range(-0.2, 1), this.rng.signed(1))
        .normalize()
        .multiplyScalar(this.rng.range(0.5, 1) * speed);
      particle.spin.set(this.rng.signed(12), this.rng.signed(12), this.rng.signed(12));
      particle.rotation.set(this.rng.signed(3), this.rng.signed(3), this.rng.signed(3));
      particle.scale = this.rng.range(0.5, 1.4);
      particle.attraction = 0;
      particle.gravity = 3.5;
      particle.drag = 0.9;
      particle.color.copy(this.sparkColor);
    }
  }

  /** A ring of sparks - used when a stack is cleared or a tier unlocks. */
  ring(origin: Vector3, radius: number, count: number, color: string): void {
    this.sparkColor.set(color);
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const particle = this.spark.spawn();
      particle.life = 0;
      particle.maxLife = this.rng.range(0.8, 1.4);
      this.scratch.set(Math.cos(angle), 0, Math.sin(angle));
      particle.position.copy(origin).addScaledVector(this.scratch, radius * 0.2);
      particle.velocity.copy(this.scratch).multiplyScalar(radius * 1.6).setY(this.rng.range(1.5, 3.5));
      particle.spin.set(this.rng.signed(8), this.rng.signed(8), this.rng.signed(8));
      particle.rotation.set(0, angle, 0);
      particle.scale = this.rng.range(0.8, 1.6);
      particle.attraction = 0;
      particle.gravity = 4;
      particle.drag = 0.7;
      particle.color.copy(this.sparkColor);
    }
  }

  update(dt: number): void {
    this.straw.update(dt, this.collectTarget);
    this.spark.update(dt, null);
  }

  clear(): void {
    this.straw.clear();
    this.spark.clear();
  }

  dispose(): void {
    this.straw.dispose();
    this.spark.dispose();
    this.group.clear();
  }
}

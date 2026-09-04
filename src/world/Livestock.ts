import { AnimationMixer, Group, Object3D, Vector3, type AnimationAction } from 'three';

import type { Assets } from '../core/Assets';
import { dampAngle } from '../core/MathX';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';

/**
 * The animals.
 *
 * A farmyard with nothing moving in it reads as a diorama. A cow that chews, a
 * few hens that potter about and a crow that ticks its head turn the same
 * geometry into a place, and the whole system is a couple of hundred lines
 * because the animals need no intelligence at all - only somewhere to go and
 * the patience to get there.
 *
 * Every animal is a skinned glTF with an `Idle` clip and sometimes an `Eat` or
 * `Peck`; the mixer cross-fades between them on a timer so no two are ever in
 * step.
 */

export interface LivestockSpec {
  model: string;
  count: number;
  /** Metres the animal will wander from where it was placed. */
  roam: number;
  /** Metres per second. */
  speed: number;
  /** Uniform scale multiplier. */
  scale?: number;
}

interface Animal {
  object: Object3D;
  mixer: AnimationMixer;
  idle: AnimationAction | null;
  busy: AnimationAction | null;
  home: Vector3;
  target: Vector3;
  yaw: number;
  /** Seconds until the next decision. */
  timer: number;
  moving: boolean;
  speed: number;
  roam: number;
}

/** How long an animal stands still, chewing or pecking, between walks. */
const PAUSE_RANGE: [number, number] = [3.5, 11];
const WALK_RANGE: [number, number] = [2, 6];
const FADE = 0.4;

export class Livestock {
  readonly group = new Group();

  private readonly animals: Animal[] = [];
  private readonly rng: Rng;
  private readonly scratch = new Vector3();

  constructor(
    private readonly assets: Assets,
    private readonly terrain: Terrain,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ 0x1a2b3c4d);
  }

  get count(): number {
    return this.animals.length;
  }

  /**
   * Scatter a group of animals in a ring band, avoiding the middle.
   *
   * They are placed by rejection sampling rather than on a grid: a farmyard
   * where the hens are evenly spaced looks staged, and at these counts a few
   * rejected samples cost nothing.
   */
  scatter(spec: LivestockSpec, innerRadius: number, outerRadius: number): void {
    if (!this.assets.has(spec.model)) return;
    for (let i = 0; i < spec.count; i++) {
      const angle = this.rng.range(0, Math.PI * 2);
      const radius = Math.sqrt(this.rng.range(innerRadius * innerRadius, outerRadius * outerRadius));
      this.add(spec, Math.cos(angle) * radius, Math.sin(angle) * radius, this.rng.range(0, Math.PI * 2));
    }
  }

  /** Place one animal at an exact spot - the cow beside the sell trough. */
  add(spec: LivestockSpec, x: number, z: number, yaw: number): Object3D | null {
    if (!this.assets.has(spec.model)) return null;
    const object = this.assets.instantiate(spec.model);
    const scale = spec.scale ?? 1;
    object.position.set(x, this.terrain.heightAt(x, z), z);
    object.rotation.y = yaw;
    object.scale.setScalar(scale);
    object.traverse((node) => {
      node.castShadow = true;
      node.receiveShadow = false;
      // Skinned meshes get their bounds from the bind pose, which is a poor fit
      // once a bone moves; culling them by it makes an animal blink out when it
      // turns its head at the edge of the frame.
      node.frustumCulled = false;
    });
    this.group.add(object);

    const mixer = new AnimationMixer(object);
    const model = this.assets.model(spec.model);
    const idleClip = model.clips.find((clip) => clip.name === 'Idle') ?? model.clips[0] ?? null;
    const busyClip =
      model.clips.find((clip) => clip.name === 'Eat') ??
      model.clips.find((clip) => clip.name === 'Peck') ??
      null;

    const idle = idleClip ? mixer.clipAction(idleClip) : null;
    const busy = busyClip && busyClip !== idleClip ? mixer.clipAction(busyClip) : null;
    if (idle) {
      idle.play();
      // Offsetting the start stops a row of hens bobbing in perfect unison.
      idle.time = this.rng.range(0, idleClip?.duration ?? 1);
    }

    this.animals.push({
      object,
      mixer,
      idle,
      busy,
      home: new Vector3(x, 0, z),
      target: new Vector3(x, 0, z),
      yaw,
      timer: this.rng.range(...PAUSE_RANGE),
      moving: false,
      speed: spec.speed,
      roam: spec.roam,
    });
    return object;
  }

  update(dt: number): void {
    for (const animal of this.animals) {
      animal.mixer.update(dt);
      animal.timer -= dt;

      if (animal.timer <= 0) {
        animal.moving = !animal.moving;
        animal.timer = animal.moving
          ? this.rng.range(...WALK_RANGE)
          : this.rng.range(...PAUSE_RANGE);
        if (animal.moving) {
          const angle = this.rng.range(0, Math.PI * 2);
          const distance = this.rng.range(0.3, 1) * animal.roam;
          animal.target.set(
            animal.home.x + Math.cos(angle) * distance,
            0,
            animal.home.z + Math.sin(angle) * distance,
          );
          this.crossFade(animal, animal.idle);
        } else {
          // Standing still is when a cow chews and a hen pecks.
          this.crossFade(animal, animal.busy ?? animal.idle);
        }
      }

      if (!animal.moving) continue;

      this.scratch.set(
        animal.target.x - animal.object.position.x,
        0,
        animal.target.z - animal.object.position.z,
      );
      const distance = this.scratch.length();
      if (distance < 0.12) {
        animal.moving = false;
        animal.timer = this.rng.range(...PAUSE_RANGE);
        this.crossFade(animal, animal.busy ?? animal.idle);
        continue;
      }

      this.scratch.divideScalar(distance);
      const stepLength = Math.min(animal.speed * dt, distance);
      animal.object.position.x += this.scratch.x * stepLength;
      animal.object.position.z += this.scratch.z * stepLength;
      animal.object.position.y = this.terrain.heightAt(
        animal.object.position.x,
        animal.object.position.z,
      );

      // Face the way it is walking, easing round rather than snapping.
      animal.yaw = dampAngle(animal.yaw, Math.atan2(this.scratch.x, this.scratch.z), 4, dt);
      animal.object.rotation.y = animal.yaw;
    }
  }

  /** Turn one animal to face a world point, for the cow at the trough. */
  faceToward(object: Object3D, x: number, z: number): void {
    const animal = this.animals.find((entry) => entry.object === object);
    if (!animal) return;
    animal.yaw = Math.atan2(x - object.position.x, z - object.position.z);
    object.rotation.y = animal.yaw;
    // A tethered animal stays put and just chews.
    animal.roam = 0;
    animal.moving = false;
    animal.timer = Infinity;
    this.crossFade(animal, animal.busy ?? animal.idle);
  }

  private crossFade(animal: Animal, to: AnimationAction | null): void {
    if (!to || to.isRunning()) return;
    const from = to === animal.idle ? animal.busy : animal.idle;
    to.reset().play();
    if (from) from.crossFadeTo(to, FADE, false);
    else to.fadeIn(FADE);
  }

  dispose(): void {
    for (const animal of this.animals) {
      animal.mixer.stopAllAction();
      animal.mixer.uncacheRoot(animal.object);
    }
    this.animals.length = 0;
    this.group.clear();
  }
}

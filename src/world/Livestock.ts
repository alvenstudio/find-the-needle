import {
  AnimationMixer,
  Group,
  Object3D,
  Quaternion,
  Vector3,
  type AnimationAction,
  type Bone,
} from 'three';

import type { Assets } from '../core/Assets';
import { clamp01, dampAngle } from '../core/MathX';
import { Rng } from '../core/Rng';
import type { Terrain } from './Terrain';

/**
 * The animals.
 *
 * A farmyard with nothing moving in it reads as a diorama. A cow that chews, a
 * few hens that potter about and a crow that ticks its head turn the same
 * geometry into a place, and the whole system is a few hundred lines because
 * the animals need no intelligence at all - only somewhere to go, the patience
 * to get there, and legs that move while they do.
 *
 * Every animal is a skinned glTF with an `Idle` clip and sometimes an `Eat` or
 * `Peck`; the mixer cross-fades between them on a timer so no two are ever in
 * step.
 *
 * WALKING IS PROCEDURAL, AND ON PURPOSE
 * -------------------------------------
 * There is no `Walk` clip. A baked one would be a fixed cadence that only ever
 * matches one speed, and it would have to be authored four times over for four
 * skeletons that share no bone names. Instead the gait is driven by *distance
 * travelled*: legs swing as a function of how far the animal has actually
 * moved, so a hen scurrying and a cow ambling are the same eight lines with a
 * different stride length, feet never skate, and an animal that stops mid-step
 * settles rather than snapping.
 *
 * It is layered on top of the mixer rather than replacing it: `mixer.update`
 * writes the idle breathing first, then the gait overwrites the leg bones. Two
 * of the four rigs have no leg bones at all - a cat and a crow whose legs are
 * welded to the root - so for those the gait is carried by the body's bounce
 * and lean, which is what a stylised animal reads as anyway.
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

/**
 * Called when an animal makes a noise, so the world layer never imports audio.
 *
 * `rate` is the individual animal's pitch. Two hens in the same yard are not
 * the same hen, and a random jitter applied per *call* does not fix that - it
 * makes one hen that cannot make up its mind. The offset has to belong to the
 * animal and stay put.
 */
export type VoiceSink = (sound: string, position: Vector3, rate: number) => void;

/** One bone swung as a function of stride phase. */
interface Swing {
  bone: string;
  /** Fraction of a stride this bone lags the reference leg, 0..1. */
  phase: number;
  /** Peak rotation, in radians. */
  amplitude: number;
  /** Which of the bone's local axes it turns about. */
  axis: 'x' | 'y' | 'z';
}

interface Gait {
  /** Full strides per metre travelled. Short legs mean a big number. */
  cadence: number;
  /** Vertical bounce of the whole animal at full stride, in metres. */
  bob: number;
  /** Body roll at full stride, in radians. */
  roll: number;
  legs: Swing[];
  /** Tails, heads and anything else that moves with the walk but is not a leg. */
  extras?: Swing[];
  /**
   * The noises it makes.
   *
   * `calls` is everything it says when nothing is happening, picked at random;
   * `notice` is what it says when the player walks up to it, which is the only
   * one the player reliably connects to the animal in front of them. `spread`
   * is how far individuals of this species drift from the nominal pitch.
   */
  voice?: {
    calls: readonly string[];
    gap: [number, number];
    spread: number;
    notice?: { radius: number; call: string; cooldown: [number, number] };
  };
}

/**
 * Per-species gaits.
 *
 * Leg bones point down the animal's leg, and Blender's roll-0 rule puts the
 * bone's local Y along it, so fore-and-aft swing is a rotation about local X -
 * the same channel the authored `Eat` clip uses to shift the cow's weight.
 *
 * Phases are in fractions of a stride. The cow trots on diagonal pairs, which
 * is what a cow actually does at this speed and reads far better than the
 * "all four legs together" a naive quadruped gait produces.
 */
const GAITS: Readonly<Record<string, Gait>> = {
  cow: {
    cadence: 0.62,
    bob: 0.035,
    roll: 0.035,
    legs: [
      { bone: 'leg_fl', phase: 0, amplitude: 0.34, axis: 'x' },
      { bone: 'leg_br', phase: 0, amplitude: 0.3, axis: 'x' },
      { bone: 'leg_fr', phase: 0.5, amplitude: 0.34, axis: 'x' },
      { bone: 'leg_bl', phase: 0.5, amplitude: 0.3, axis: 'x' },
    ],
    extras: [
      { bone: 'tail', phase: 0.25, amplitude: 0.12, axis: 'z' },
      { bone: 'head', phase: 0.5, amplitude: 0.06, axis: 'x' },
    ],
    // A cow is big and slow and does not startle, so it answers you rather
    // than panicking: walk up and it looks round and moos.
    voice: {
      calls: ['cow_moo', 'cow_snort', 'cow_snort'],
      gap: [11, 26],
      spread: 0.07,
      notice: { radius: 7, call: 'cow_moo', cooldown: [8, 14] },
    },
  },
  chicken: {
    cadence: 2.4,
    bob: 0.022,
    roll: 0.06,
    legs: [
      { bone: 'leg_l', phase: 0, amplitude: 0.55, axis: 'x' },
      { bone: 'leg_r', phase: 0.5, amplitude: 0.55, axis: 'x' },
    ],
    // The head thrust is the whole reason a walking hen is funny, and it runs
    // at twice the leg cadence: forward on each footfall, not each stride.
    extras: [
      { bone: 'neck', phase: 0, amplitude: 0.22, axis: 'x' },
      { bone: 'body', phase: 0.25, amplitude: 0.07, axis: 'x' },
    ],
    // Hens are the noisiest thing in the yard and the twitchiest: they squawk
    // the moment you are inside a few metres.
    voice: {
      calls: ['chicken_cluck', 'chicken_cluck', 'chicken_squawk'],
      gap: [5, 15],
      spread: 0.16,
      notice: { radius: 4.5, call: 'chicken_squawk', cooldown: [5, 9] },
    },
  },
  cat: {
    // No leg bones on this rig, so the walk lives entirely in the body: a low
    // double bounce per stride and a lazy tail.
    cadence: 1.5,
    bob: 0.028,
    roll: 0.05,
    legs: [],
    extras: [
      { bone: 'tail1', phase: 0, amplitude: 0.1, axis: 'x' },
      { bone: 'tail2', phase: 0.15, amplitude: 0.13, axis: 'x' },
      { bone: 'tail3', phase: 0.3, amplitude: 0.16, axis: 'x' },
      { bone: 'body', phase: 0.5, amplitude: 0.05, axis: 'x' },
    ],
    // The cat greets you and then goes back to ignoring you.
    voice: {
      calls: ['cat_meow', 'cat_chirrup', 'cat_chirrup'],
      gap: [12, 30],
      spread: 0.12,
      notice: { radius: 5.5, call: 'cat_chirrup', cooldown: [7, 13] },
    },
  },
  crow: {
    // A crow does not walk so much as hop, so the bounce is large and the
    // cadence high; the body pitches forward on the way down.
    cadence: 2.1,
    bob: 0.055,
    roll: 0.03,
    legs: [],
    extras: [
      { bone: 'body', phase: 0, amplitude: 0.1, axis: 'x' },
      { bone: 'tail', phase: 0.5, amplitude: 0.12, axis: 'x' },
    ],
    // A crow does not greet anything. It tells the rest of the yard you are
    // here, which is the same sound it makes at everything else.
    voice: {
      calls: ['crow_caw', 'crow_rattle', 'crow_caw'],
      gap: [8, 20],
      spread: 0.1,
      notice: { radius: 6, call: 'crow_caw', cooldown: [6, 11] },
    },
  },
};

/** A bone the gait drives, resolved once at spawn. */
interface DrivenBone {
  bone: Bone;
  rest: Quaternion;
  swing: Swing;
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
  gait: Gait | null;
  driven: DrivenBone[];
  /** Stride position, in whole strides. Only the fraction matters. */
  stride: number;
  /** 0..1 blend into the walk, so legs settle instead of snapping to rest. */
  walking: number;
  /** Seconds until this animal next makes a noise. */
  voiceTimer: number;
  /** This individual's pitch, fixed at spawn so it keeps the same voice. */
  pitch: number;
  /** Seconds before it will react to the player again. */
  noticeTimer: number;
  /** True while the player is standing inside its notice radius. */
  noticed: boolean;
}

/** Leaving the notice radius takes a little more than entering it did. */
const NOTICE_HYSTERESIS = 1.6;

/** How long an animal stands still, chewing or pecking, between walks. */
const PAUSE_RANGE: [number, number] = [3.5, 11];
const WALK_RANGE: [number, number] = [2, 6];
const FADE = 0.4;
const TAU = Math.PI * 2;

export class Livestock {
  readonly group = new Group();

  /** Set by the game so animals can be heard. Left null in tests. */
  voice: VoiceSink | null = null;

  private readonly animals: Animal[] = [];
  private readonly rng: Rng;
  private readonly scratch = new Vector3();
  private readonly worldPoint = new Vector3();
  private readonly rotation = new Quaternion();

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
  scatter(
    spec: LivestockSpec,
    innerRadius: number,
    outerRadius: number,
    keepClear?: { x: number; z: number; radius: number },
  ): void {
    if (!this.assets.has(spec.model)) return;
    for (let i = 0; i < spec.count; i++) {
      let x = 0;
      let z = 0;
      // A few tries at staying off the spawn pad. Landing a cow where the
      // player arrives means the first thing they ever see is its flank.
      for (let attempt = 0; attempt < 12; attempt++) {
        const angle = this.rng.range(0, Math.PI * 2);
        const radius = Math.sqrt(this.rng.range(innerRadius * innerRadius, outerRadius * outerRadius));
        x = Math.cos(angle) * radius;
        z = Math.sin(angle) * radius;
        if (!keepClear) break;
        const dx = x - keepClear.x;
        const dz = z - keepClear.z;
        if (dx * dx + dz * dz >= keepClear.radius * keepClear.radius) break;
      }
      const placed = this.add(spec, x, z, this.rng.range(0, Math.PI * 2));
      // Wandering must not undo the placement, so an animal that starts clear
      // of the pad is not allowed to roam back onto it.
      if (placed && keepClear) {
        const animal = this.animals[this.animals.length - 1];
        const distance = Math.hypot(x - keepClear.x, z - keepClear.z);
        animal.roam = Math.min(animal.roam, Math.max(0.5, distance - keepClear.radius));
      }
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

    const gait = GAITS[spec.model] ?? null;
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
      gait,
      driven: gait ? this.resolveBones(object, gait) : [],
      stride: this.rng.next(),
      walking: 0,
      voiceTimer: gait?.voice ? this.rng.range(2, gait.voice.gap[1]) : Infinity,
      pitch: gait?.voice ? 1 + this.rng.range(-gait.voice.spread, gait.voice.spread) : 1,
      noticeTimer: 0,
      noticed: false,
    });
    return object;
  }

  /**
   * Find the bones a gait drives and record their rest pose.
   *
   * The rest quaternion is the bind pose the exporter baked into the node, and
   * every swing is applied relative to it - setting a bone's rotation outright
   * would throw away the rig's own orientation and fold the animal in half.
   */
  private resolveBones(object: Object3D, gait: Gait): DrivenBone[] {
    const driven: DrivenBone[] = [];
    for (const swing of [...gait.legs, ...(gait.extras ?? [])]) {
      const node = object.getObjectByName(swing.bone);
      if (!node) continue;
      driven.push({ bone: node as Bone, rest: node.quaternion.clone(), swing });
    }
    return driven;
  }

  /**
   * `listener` is where the player is. Animals that can hear it coming react
   * to it; pass null and they just get on with their day.
   */
  update(dt: number, listener: Vector3 | null = null): void {
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

      this.speak(animal, dt);
      if (listener) this.notice(animal, dt, listener);

      let stepLength = 0;
      if (animal.moving) {
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
        } else {
          this.scratch.divideScalar(distance);
          stepLength = Math.min(animal.speed * dt, distance);
          animal.object.position.x += this.scratch.x * stepLength;
          animal.object.position.z += this.scratch.z * stepLength;

          // Face the way it is walking, easing round rather than snapping.
          animal.yaw = dampAngle(animal.yaw, Math.atan2(this.scratch.x, this.scratch.z), 4, dt);
          animal.object.rotation.y = animal.yaw;
        }
      }

      this.stride(animal, dt, stepLength);
      animal.object.position.y =
        this.terrain.heightAt(animal.object.position.x, animal.object.position.z) + this.bounce(animal);
    }
  }

  /**
   * Advance the gait and pose the driven bones.
   *
   * The phase is driven by metres walked, not by time: that is the whole reason
   * the feet do not skate, and it means one cadence number covers an animal
   * dawdling and the same animal hurrying.
   */
  private stride(animal: Animal, dt: number, stepLength: number): void {
    const gait = animal.gait;
    if (!gait) return;

    animal.stride += stepLength * gait.cadence;
    // Blend out over about a fifth of a second so a stopping animal puts its
    // legs down rather than having them vanish to rest between frames.
    const target = stepLength > 1e-5 ? 1 : 0;
    animal.walking += (target - animal.walking) * clamp01(dt * 9);
    if (animal.walking < 0.001) {
      if (animal.walking !== 0) {
        animal.walking = 0;
        animal.object.rotation.z = 0;
        for (const driven of animal.driven) driven.bone.quaternion.copy(driven.rest);
      }
      return;
    }

    const phase = animal.stride * TAU;
    for (const driven of animal.driven) {
      const angle =
        Math.sin(phase + driven.swing.phase * TAU) * driven.swing.amplitude * animal.walking;
      this.rotation.setFromAxisAngle(AXES[driven.swing.axis], angle);
      driven.bone.quaternion.copy(driven.rest).multiply(this.rotation);
    }

    animal.object.rotation.z = Math.sin(phase) * gait.roll * animal.walking;
  }

  /** Vertical bounce: twice a stride, because each stride is two footfalls. */
  private bounce(animal: Animal): number {
    const gait = animal.gait;
    if (!gait || animal.walking < 0.001) return 0;
    return Math.abs(Math.sin(animal.stride * Math.PI * 2)) * gait.bob * animal.walking;
  }

  private speak(animal: Animal, dt: number): void {
    const voice = animal.gait?.voice;
    if (!voice || !this.voice) return;
    animal.voiceTimer -= dt;
    if (animal.voiceTimer > 0) return;
    animal.voiceTimer = this.rng.range(voice.gap[0], voice.gap[1]);
    this.say(animal, voice.calls[this.rng.int(0, voice.calls.length - 1)]);
  }

  /**
   * React to the player walking up.
   *
   * This is the half of the farmyard the player actually hears. A call on a
   * random timer is scenery: it happens whether or not anyone is there, and
   * the ear files it with the wind. A call that fires because you walked up to
   * a hen is the hen talking to you, and it is the same sound.
   *
   * Edge-triggered with hysteresis, so standing on the boundary does not turn
   * the animal into an alarm.
   */
  private notice(animal: Animal, dt: number, listener: Vector3): void {
    const spec = animal.gait?.voice?.notice;
    if (!spec || !this.voice) return;
    animal.noticeTimer -= dt;
    const dx = listener.x - animal.object.position.x;
    const dz = listener.z - animal.object.position.z;
    const distance = Math.hypot(dx, dz);

    if (animal.noticed) {
      if (distance > spec.radius + NOTICE_HYSTERESIS) animal.noticed = false;
      return;
    }
    if (distance > spec.radius) return;
    animal.noticed = true;
    if (animal.noticeTimer > 0) return;
    animal.noticeTimer = this.rng.range(spec.cooldown[0], spec.cooldown[1]);
    this.say(animal, spec.call);
    // Whatever it was about to say on its own, it has said something now.
    const voice = animal.gait?.voice;
    if (voice) {
      animal.voiceTimer = Math.max(animal.voiceTimer, this.rng.range(voice.gap[0], voice.gap[1]) * 0.6);
    }
  }

  /** Make one animal speak now - the cow answering a sale, for instance. */
  callOut(object: Object3D, call?: string): void {
    const animal = this.animals.find((entry) => entry.object === object);
    const voice = animal?.gait?.voice;
    if (!animal || !voice) return;
    animal.noticeTimer = Math.max(animal.noticeTimer, 1.5);
    this.say(animal, call ?? voice.calls[0]);
  }

  private say(animal: Animal, sound: string): void {
    if (!this.voice) return;
    animal.object.getWorldPosition(this.worldPoint);
    this.voice(sound, this.worldPoint, animal.pitch);
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

const AXES: Record<'x' | 'y' | 'z', Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
};

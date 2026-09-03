import { Group, Object3D, Vector3, type PerspectiveCamera } from 'three';

import type { Assets } from '../core/Assets';
import { Signal } from '../core/Signals';
import type { CollisionWorld } from '../world/Collision';
import type { Terrain } from '../world/Terrain';

/**
 * The things in the world the player can walk up to and use.
 *
 * Selection is deliberately forgiving: it picks whatever is closest *and* in
 * front of the player, with a generous angular tolerance, rather than requiring
 * a precise look. A first-person game where you have to aim at a shop counter
 * is a first-person game people stop playing.
 */

export type InteractionId =
  | 'sell'
  | 'shop'
  | 'quests'
  | 'leaderboard'
  | 'rebirth'
  | 'gate'
  | 'tools';

export interface Interactable {
  id: InteractionId;
  model: string;
  label: string;
  hint: string;
  position: Vector3;
  yaw: number;
  /** Distance within which the prompt appears. */
  radius: number;
  object: Object3D | null;
  enabled: boolean;
}

export class InteractionSystem {
  readonly group = new Group();
  readonly triggered = new Signal<Interactable>();
  readonly focusChanged = new Signal<Interactable | null>();

  readonly items: Interactable[] = [];
  private focused: Interactable | null = null;

  private readonly toItem = new Vector3();
  private readonly forward = new Vector3();

  constructor(
    private readonly assets: Assets,
    private readonly terrain: Terrain,
    private readonly collision: CollisionWorld,
  ) {}

  /**
   * Lay the working ring out around the stack.
   *
   * Angles are fixed rather than random: the player learns where the shop is on
   * the Home Stack and finds it in the same place on the Mother Lode, which is
   * worth far more than the novelty of a different arrangement each tier.
   */
  build(ringRadius: number, options: { rebirthUnlocked: boolean; hasNextTier: boolean }): void {
    this.clear();

    const layout: { id: InteractionId; model: string; label: string; hint: string; angle: number; radius: number; enabled: boolean }[] = [
      {
        id: 'sell',
        model: 'sell_trough',
        label: 'Sell hay',
        hint: 'Trade your load for coins',
        angle: Math.PI * 1.5,
        radius: 3.6,
        enabled: true,
      },
      {
        id: 'shop',
        model: 'upgrade_kiosk',
        label: 'Upgrades',
        hint: 'Spend coins on better gear',
        angle: Math.PI * 1.72,
        radius: 3.4,
        enabled: true,
      },
      {
        id: 'tools',
        model: 'storage_silo',
        label: 'Tool shed',
        hint: 'Buy and equip tools',
        angle: Math.PI * 1.28,
        radius: 3.4,
        enabled: true,
      },
      {
        id: 'quests',
        model: 'quest_board',
        label: 'Jobs board',
        hint: "Today's jobs",
        angle: Math.PI * 0.14,
        radius: 3.2,
        enabled: true,
      },
      {
        id: 'leaderboard',
        model: 'leaderboard',
        label: 'Records',
        hint: 'Best times and collection',
        angle: Math.PI * 0.4,
        radius: 3.2,
        enabled: true,
      },
      {
        id: 'rebirth',
        model: 'rebirth_shrine',
        label: 'Retire',
        hint: 'Trade it all for permanent bonuses',
        angle: Math.PI * 0.72,
        radius: 3.6,
        enabled: options.rebirthUnlocked,
      },
      {
        id: 'gate',
        model: 'tier_gate',
        label: 'Next stack',
        hint: 'Travel to a bigger haystack',
        angle: Math.PI * 1.0,
        radius: 4.0,
        enabled: options.hasNextTier,
      },
    ];

    for (const entry of layout) {
      const x = Math.cos(entry.angle) * ringRadius;
      const z = Math.sin(entry.angle) * ringRadius;
      const y = this.terrain.heightAt(x, z);
      // Everything on the ring faces the stack at the centre.
      const yaw = Math.atan2(-x, -z) + Math.PI;

      const item: Interactable = {
        id: entry.id,
        model: entry.model,
        label: entry.label,
        hint: entry.hint,
        position: new Vector3(x, y, z),
        yaw,
        radius: entry.radius,
        object: null,
        enabled: entry.enabled,
      };

      if (this.assets.has(entry.model)) {
        const object = this.assets.instantiate(entry.model);
        object.position.set(x, y, z);
        object.rotation.y = yaw;
        object.matrixAutoUpdate = false;
        object.updateMatrix();
        this.group.add(object);
        item.object = object;

        const size = this.assets.model(entry.model).size;
        this.collision.addBox(
          item.position,
          Math.max(0.2, size.x / 2 - 0.15),
          Math.max(0.2, size.z / 2 - 0.15),
          y,
          y + size.y,
          yaw,
        );
      }
      this.terrain.addDirtPatch(x, z, 2.4);
      this.items.push(item);
    }

    // The spawn pad marks where the player arrives, opposite the sell point.
    if (this.assets.has('spawn_pad')) {
      const angle = Math.PI * 1.5;
      const x = Math.cos(angle) * (ringRadius + 5.5);
      const z = Math.sin(angle) * (ringRadius + 5.5);
      const pad = this.assets.instantiate('spawn_pad');
      pad.position.set(x, this.terrain.heightAt(x, z) + 0.02, z);
      pad.matrixAutoUpdate = false;
      pad.updateMatrix();
      this.group.add(pad);
      this.terrain.addDirtPatch(x, z, 3);
    }
  }

  setEnabled(id: InteractionId, enabled: boolean): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    item.enabled = enabled;
    if (item.object) item.object.visible = enabled;
  }

  get current(): Interactable | null {
    return this.focused;
  }

  /** Where the player should stand to use a station, for the tutorial arrow. */
  positionOf(id: InteractionId): Vector3 | null {
    return this.items.find((entry) => entry.id === id)?.position ?? null;
  }

  update(playerPosition: Vector3, camera: PerspectiveCamera): void {
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.forward.normalize();

    let best: Interactable | null = null;
    let bestScore = -Infinity;

    for (const item of this.items) {
      if (!item.enabled) continue;
      this.toItem.copy(item.position).sub(playerPosition);
      this.toItem.y = 0;
      const distance = this.toItem.length();
      if (distance > item.radius) continue;

      this.toItem.divideScalar(Math.max(distance, 1e-4));
      const facing = this.toItem.dot(this.forward);
      // Anything roughly ahead qualifies; ties break toward whatever is closer.
      if (facing < -0.35) continue;
      const score = facing * 2 - distance / item.radius;
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best !== this.focused) {
      this.focused = best;
      this.focusChanged.emit(best);
    }
  }

  /** Fire the focused interaction, if any. */
  activate(): boolean {
    if (!this.focused) return false;
    this.triggered.emit(this.focused);
    return true;
  }

  clear(): void {
    this.items.length = 0;
    this.group.clear();
    this.focused = null;
  }

  dispose(): void {
    this.clear();
    this.triggered.clear();
    this.focusChanged.clear();
  }
}

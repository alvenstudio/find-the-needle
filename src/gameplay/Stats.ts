import {
  PERK_BY_ID,
  TOOL_BY_ID,
  UPGRADE_BY_ID,
  upgradeValue,
  type PerkId,
  type ToolDefinition,
  type ToolId,
  type UpgradeId,
} from './Content';

/**
 * Turns a run plus a set of permanent perks into the numbers the simulation
 * actually uses.
 *
 * Deliberately pure and dependency-free: the same function produces the stats
 * for the live game and for the headless balance simulator, so the pacing that
 * gets validated is exactly the pacing that ships.
 */

export interface StatSource {
  /** Per-run upgrade levels. */
  upgrades: Readonly<Record<string, number>>;
  /** Permanent perk levels. */
  perks: Readonly<Record<string, number>>;
  activeTool: ToolId;
  /**
   * Multiplier on bag capacity for this stack.
   *
   * A Mother Lode straw is one of a million rather than one of twelve thousand,
   * so a bag that held twenty-five of them would fill in a fifth of a second
   * and the whole run would be a walk to the cow. Scaling the bag with the
   * stack keeps the dig-to-haul ratio - and therefore the rhythm of the loop -
   * identical on every tier.
   */
  bagScale?: number;
}

export interface DerivedStats {
  tool: ToolDefinition;
  /** Crater radius in metres. */
  digRadius: number;
  /** Depth removed per pull, or per second for a continuous tool. */
  digDepth: number;
  /** Seconds between pulls; 0 for continuous tools. */
  cooldown: number;
  reach: number;
  /** Maximum hay carried before a trip to the cow. */
  capacity: number;
  /** Multiplier on the tier's straw value. */
  sellMultiplier: number;
  /** Multiplier on the player's base walking speed. */
  moveSpeed: number;
  /** Radius within which loose hay drifts to the player. */
  magnetRadius: number;
  /** Multiplier on the chance a pull turns up a buried treasure. */
  luck: number;
  /**
   * Range at which a *buried treasure* glints through the hay.
   *
   * Deliberately never applied to the needle. A sense that finds the needle
   * collapses the entire game: the player takes hundreds of pulls per stack and
   * each one is a fresh probe from a new position, so even a three-metre radius
   * resolves the search inside a minute. Treasures are optional bonuses, so
   * making them easier to spot is a reward rather than a solution.
   */
  treasureSense: number;
  /** Hunch charges available this run. */
  hunchCharges: number;
}

const level = (source: StatSource, id: UpgradeId): number => source.upgrades[id] ?? 0;
const perk = (source: StatSource, id: PerkId): number => source.perks[id] ?? 0;

/** Range at which treasures glint with no Prospector levels. */
export const BASE_TREASURE_SENSE = 2.4;

export function deriveStats(source: StatSource): DerivedStats {
  const tool = TOOL_BY_ID[source.activeTool] ?? TOOL_BY_ID.hands;

  const grasp = upgradeValue(UPGRADE_BY_ID.grasp, level(source, 'grasp'));
  const sweep = upgradeValue(UPGRADE_BY_ID.reach, level(source, 'reach'));
  const bag = upgradeValue(UPGRADE_BY_ID.bag, level(source, 'bag'));
  const boots = upgradeValue(UPGRADE_BY_ID.boots, level(source, 'boots'));
  const haggle = upgradeValue(UPGRADE_BY_ID.haggle, level(source, 'haggle'));
  const magnet = upgradeValue(UPGRADE_BY_ID.magnet, level(source, 'magnet'));
  const luck = upgradeValue(UPGRADE_BY_ID.luck, level(source, 'luck'));

  const arms = 1 + PERK_BY_ID.strong_arms.perLevel * perk(source, 'strong_arms');
  const pockets = 1 + PERK_BY_ID.deep_pockets.perLevel * perk(source, 'deep_pockets');
  const gilded = 1 + PERK_BY_ID.gilded_touch.perLevel * perk(source, 'gilded_touch');
  const swift = 1 + PERK_BY_ID.swift_boots.perLevel * perk(source, 'swift_boots');
  const prospector = PERK_BY_ID.prospector.perLevel * perk(source, 'prospector');

  return {
    tool,
    digRadius: tool.radius * sweep,
    digDepth: tool.depth * grasp * arms,
    cooldown: tool.continuous ? 0 : tool.cooldown,
    reach: tool.reach,
    capacity: Math.max(1, Math.round(bag * pockets * (source.bagScale ?? 1))),
    sellMultiplier: haggle * gilded,
    moveSpeed: boots * swift,
    magnetRadius: Math.max(tool.autoCollect, magnet),
    luck,
    treasureSense: BASE_TREASURE_SENSE + prospector,
    hunchCharges: perk(source, 'hunch'),
  };
}

/**
 * Volume of hay a single pull removes, in cubic metres.
 *
 * `HeightField.dig` cuts `depth * smoothstep(1 - d/r)^2`, and revolving that
 * profile gives
 *
 *     V = depth * 2*pi*r^2 * integral(0..1) (1 - 3u^2 + 2u^3)^2 * u du
 *       = depth * 2*pi*r^2 * 3/35
 *       = depth * pi*r^2 * 6/35
 *
 * so the coefficient below is exact, not fitted. Real pulls remove slightly
 * less where the crater bottoms out on already-cleared ground.
 */
export const CRATER_VOLUME_COEFFICIENT = 6 / 35;

export function digVolume(radius: number, depth: number): number {
  return Math.PI * radius * radius * depth * CRATER_VOLUME_COEFFICIENT;
}

/** Straws removed by one pull on a stack of the given density. */
export function digYield(stats: DerivedStats, strawsPerCubicMetre: number): number {
  return digVolume(stats.digRadius, stats.digDepth) * strawsPerCubicMetre;
}

/** Sustained straws per second at the face, ignoring the walk to the cow. */
export function digRate(stats: DerivedStats, strawsPerCubicMetre: number): number {
  const perUse = digYield(stats, strawsPerCubicMetre);
  return stats.tool.continuous ? perUse : perUse / stats.cooldown;
}

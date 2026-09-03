import {
  PERK_BY_ID,
  TOOL_BY_ID,
  UPGRADE_BY_ID,
  rebirthValueMultiplier,
  rebirthYieldMultiplier,
  upgradeValue,
  type PerkId,
  type ToolDefinition,
  type ToolId,
  type UpgradeId,
} from './Content';

/**
 * Turns a save file into the numbers the simulation actually uses.
 *
 * Deliberately pure and dependency-free: the same function produces the stats
 * for the live game and for the headless balance simulator, so the pacing that
 * gets validated is exactly the pacing that ships.
 */

export interface StatSource {
  upgrades: Readonly<Record<string, number>>;
  perks: Readonly<Record<string, number>>;
  rebirths: number;
  activeTool: ToolId;
}

export interface DerivedStats {
  tool: ToolDefinition;
  /** Crater radius in metres. */
  digRadius: number;
  /** Depth removed per swing, or per second for continuous tools. */
  digDepth: number;
  /** Seconds between swings; 0 for continuous tools. */
  cooldown: number;
  reach: number;
  /** Maximum straws carried before a trip to the cart. */
  capacity: number;
  /** Multiplier on the tier's straw value. */
  sellMultiplier: number;
  /** Multiplier on the player's base walking speed. */
  moveSpeed: number;
  /** Radius within which loose straw drifts to the player. */
  magnetRadius: number;
  /** Multiplier on the chance a dig turns up a buried treasure. */
  luck: number;
  /** Range in metres at which the needle registers on the magnifier. */
  senseRange: number;
  hasDetector: boolean;
  /** Multiplier applied to every dig's volume, from rebirths. */
  yieldMultiplier: number;
}

const level = (source: StatSource, id: UpgradeId): number => source.upgrades[id] ?? 0;
const perk = (source: StatSource, id: PerkId): number => source.perks[id] ?? 0;

/** Range the magnifier reads at with no Fine Sifter levels. */
export const BASE_SENSE_RANGE = 3.2;

export function deriveStats(source: StatSource): DerivedStats {
  const tool = TOOL_BY_ID[source.activeTool] ?? TOOL_BY_ID.hands;

  const scoop = upgradeValue(UPGRADE_BY_ID.scoop, level(source, 'scoop'));
  const sweep = upgradeValue(UPGRADE_BY_ID.radius, level(source, 'radius'));
  const pack = upgradeValue(UPGRADE_BY_ID.capacity, level(source, 'capacity'));
  const boots = upgradeValue(UPGRADE_BY_ID.boots, level(source, 'boots'));
  const haggling = upgradeValue(UPGRADE_BY_ID.haggling, level(source, 'haggling'));
  const magnet = upgradeValue(UPGRADE_BY_ID.magnet, level(source, 'magnet'));
  const lucky = upgradeValue(UPGRADE_BY_ID.lucky, level(source, 'lucky'));
  const sifter = upgradeValue(UPGRADE_BY_ID.sifter, level(source, 'sifter'));

  const pockets = 1 + PERK_BY_ID.deep_pockets.perLevel * perk(source, 'deep_pockets');
  const gilded = 1 + PERK_BY_ID.gilded_touch.perLevel * perk(source, 'gilded_touch');
  const swift = 1 - PERK_BY_ID.swift_hands.perLevel * perk(source, 'swift_hands');
  const sense = PERK_BY_ID.sixth_sense.perLevel * perk(source, 'sixth_sense');

  const yieldMultiplier = rebirthYieldMultiplier(source.rebirths);

  return {
    tool,
    digRadius: tool.radius * sweep,
    digDepth: tool.depth * scoop * yieldMultiplier,
    // Floored so that stacking Swift Hands can never produce a zero-cost swing.
    cooldown: tool.continuous ? 0 : Math.max(0.12, tool.cooldown * swift),
    reach: tool.reach,
    capacity: Math.round(pack * pockets),
    sellMultiplier: haggling * gilded * rebirthValueMultiplier(source.rebirths),
    moveSpeed: boots,
    magnetRadius: Math.max(tool.autoCollect, magnet),
    luck: lucky,
    senseRange: BASE_SENSE_RANGE + sifter + sense,
    hasDetector: perk(source, 'metal_detector') > 0,
    yieldMultiplier,
  };
}

/**
 * Volume of hay a single dig removes, in cubic metres.
 *
 * `HeightField.dig` cuts `depth * smoothstep(1 - d/r)^2`, and revolving that
 * profile gives
 *
 *     V = depth * 2*pi*r^2 * integral(0..1) (1 - 3u^2 + 2u^3)^2 * u du
 *       = depth * 2*pi*r^2 * 3/35
 *       = depth * pi*r^2 * 6/35
 *
 * so the coefficient below is exact, not fitted. Real digs remove slightly less
 * where the crater bottoms out on already-cleared ground.
 */
export const CRATER_VOLUME_COEFFICIENT = 6 / 35;

export function digVolume(radius: number, depth: number): number {
  return Math.PI * radius * radius * depth * CRATER_VOLUME_COEFFICIENT;
}

/** Straws removed by one dig on a stack of the given density. */
export function digYield(stats: DerivedStats, strawsPerCubicMetre: number): number {
  return digVolume(stats.digRadius, stats.digDepth) * strawsPerCubicMetre;
}

/** Sustained straws per second, ignoring travel time to the cart. */
export function digRate(stats: DerivedStats, strawsPerCubicMetre: number): number {
  const perUse = digYield(stats, strawsPerCubicMetre);
  return stats.tool.continuous ? perUse : perUse / stats.cooldown;
}

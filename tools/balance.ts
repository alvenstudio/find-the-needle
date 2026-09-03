/**
 * Headless balance simulator.
 *
 * Plays thousands of sessions against the real tables in `src/gameplay` and
 * prints the pacing curve, so tuning is a measurement rather than a guess.
 * Run it with `npm run balance`.
 *
 * The model deliberately includes the boring parts - walking to the cart,
 * waiting out swing cooldowns, digs that hit ground that is already clear -
 * because those are exactly what a spreadsheet leaves out and what makes a
 * real session feel slower than the designer expected.
 */

import {
  PERKS,
  TIERS,
  TOOLS,
  UPGRADES,
  upgradeCost,
  type TierDefinition,
  type ToolId,
  type UpgradeId,
} from '../src/gameplay/Content.ts';
import { deriveStats, digVolume, type DerivedStats } from '../src/gameplay/Stats.ts';

// ------------------------------------------------------------------ model

/** Metres from the working face of the stack to the sell cart and back. */
const HAUL_DISTANCE = 15;
/** Seconds spent at the cart per sale. */
const SELL_TIME = 0.55;
/**
 * Fraction of dig time lost to aiming and walking to a fresh face.
 *
 * It grows with the footprint: on the Home Stack everything is within two
 * steps, but the Mother Lode is forty metres across and a real share of the
 * session is spent walking from one worked-out crater to the next.
 */
function aimOverhead(tier: TierDefinition): number {
  return Math.min(0.55, 0.13 + tier.radius * 0.021);
}
/** Base walk speed in metres per second, mirroring DEFAULT_TUNING. */
const BASE_WALK_SPEED = 4.35;

interface Player {
  coins: number;
  gems: number;
  upgrades: Record<string, number>;
  perks: Record<string, number>;
  rebirths: number;
  activeTool: ToolId;
  ownedTools: Set<ToolId>;
  tier: number;
}

interface Stack {
  tier: TierDefinition;
  /** Cubic metres of hay left. */
  volume: number;
  readonly fullVolume: number;
  readonly density: number;
}

/** Analytic volume of the generated mound, matching HeightField.generate. */
function moundVolume(radius: number, peak: number, falloff = 2.15, shoulder = 0.72): number {
  // V = 2*pi * integral(0..R) peak * (1 - (r/R)^falloff)^shoulder * r dr
  const samples = 4000;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const u = (i + 0.5) / samples;
    total += Math.pow(Math.max(0, 1 - Math.pow(u, falloff)), shoulder) * u;
  }
  return 2 * Math.PI * radius * radius * peak * (total / samples);
}

function makeStack(tier: TierDefinition): Stack {
  const fullVolume = moundVolume(tier.radius, tier.peak);
  return { tier, volume: fullVolume, fullVolume, density: tier.straws / fullVolume };
}

function newPlayer(): Player {
  return {
    coins: 0,
    gems: 0,
    upgrades: {},
    perks: {},
    rebirths: 0,
    activeTool: 'hands',
    ownedTools: new Set<ToolId>(['hands']),
    tier: 0,
  };
}

function statsOf(player: Player): DerivedStats {
  return deriveStats({
    upgrades: player.upgrades,
    perks: player.perks,
    rebirths: player.rebirths,
    activeTool: player.activeTool,
  });
}

/**
 * Straws removed by one dig, accounting for the crater bottoming out.
 *
 * Late in a stack the average remaining depth is less than the tool's reach, so
 * a swing that would take 40 cm only finds 8 cm of hay. Without this the
 * simulator wildly overstates end-of-stack throughput.
 */
function effectiveDig(stats: DerivedStats, stack: Stack): number {
  const footprint = Math.PI * stack.tier.radius * stack.tier.radius;
  const averageDepth = stack.volume / footprint;
  // The player naturally works the thickest part, so allow 1.7x the average.
  const available = Math.min(stats.digDepth, averageDepth * 1.7);
  return digVolume(stats.digRadius, Math.max(available, 0)) * stack.density;
}

/** Sustained straws per second while standing at the face. */
function faceRate(stats: DerivedStats, stack: Stack): number {
  const perUse = effectiveDig(stats, stack);
  const rate = stats.tool.continuous ? perUse : perUse / stats.cooldown;
  return rate * (1 - aimOverhead(stack.tier));
}

/** Seconds for one dig-until-full, haul, sell cycle, and the straws it moves. */
function cycle(stats: DerivedStats, stack: Stack): { seconds: number; straws: number } {
  const rate = faceRate(stats, stack);
  if (rate <= 1e-6) return { seconds: Infinity, straws: 0 };
  const straws = Math.min(stats.capacity, stack.volume * stack.density);
  const haul = HAUL_DISTANCE / (BASE_WALK_SPEED * stats.moveSpeed);
  return { seconds: straws / rate + haul + SELL_TIME, straws };
}

function coinsPerSecond(player: Player, stack: Stack): number {
  const stats = statsOf(player);
  const { seconds, straws } = cycle(stats, stack);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return (straws * stack.tier.strawValue * stats.sellMultiplier) / seconds;
}

// ------------------------------------------------------------ the shopper

/** Upgrades the greedy shopper reasons about directly. */
const ECONOMIC: UpgradeId[] = ['scoop', 'radius', 'capacity', 'boots', 'haggling'];
/** Quality-of-life upgrades bought once they are comfortably affordable. */
const OPPORTUNISTIC: UpgradeId[] = ['magnet', 'lucky', 'sifter'];

/**
 * Buy whatever most improves coins per second per coin spent.
 *
 * This is what an engaged player converges on, and it is the strategy the
 * balance has to hold up against: if one upgrade dominates, the greedy shopper
 * finds it immediately and the pacing report shows a flat, boring curve.
 */
function shop(player: Player, stack: Stack): boolean {
  let bought = false;

  for (;;) {
    const baseline = coinsPerSecond(player, stack);
    let bestId: UpgradeId | null = null;
    let bestScore = 0;
    let bestCost = 0;

    for (const id of ECONOMIC) {
      const definition = UPGRADES.find((upgrade) => upgrade.id === id)!;
      const level = player.upgrades[id] ?? 0;
      const cost = upgradeCost(definition, level);
      if (!Number.isFinite(cost) || cost > player.coins) continue;
      player.upgrades[id] = level + 1;
      const gain = coinsPerSecond(player, stack) - baseline;
      player.upgrades[id] = level;
      const score = gain / cost;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
        bestCost = cost;
      }
    }

    if (!bestId) break;
    player.coins -= bestCost;
    player.upgrades[bestId] = (player.upgrades[bestId] ?? 0) + 1;
    bought = true;
  }

  for (const id of OPPORTUNISTIC) {
    const definition = UPGRADES.find((upgrade) => upgrade.id === id)!;
    const level = player.upgrades[id] ?? 0;
    const cost = upgradeCost(definition, level);
    // Only when it is pocket change, so it never competes with real throughput.
    if (Number.isFinite(cost) && player.coins > cost * 8) {
      player.coins -= cost;
      player.upgrades[id] = level + 1;
      bought = true;
    }
  }

  for (const tool of TOOLS) {
    if (player.ownedTools.has(tool.id)) continue;
    if (tool.requiresTier > player.tier || tool.price > player.coins) continue;
    const previous = player.activeTool;
    const before = coinsPerSecond(player, stack);
    player.activeTool = tool.id;
    const after = coinsPerSecond(player, stack);
    if (after > before) {
      player.coins -= tool.price;
      player.ownedTools.add(tool.id);
      bought = true;
    } else {
      player.activeTool = previous;
    }
  }

  return bought;
}

// ------------------------------------------------------------- simulation

export interface StackResult {
  seconds: number;
  coinsEarned: number;
  clearedFraction: number;
  digs: number;
  sells: number;
}

export interface SimOptions {
  /** 'rush' stops at the needle, 'clear' empties the stack. */
  strategy: 'rush' | 'clear';
  /** Fraction of the stack cleared before the needle turns up. */
  needleAt: number;
  /** Hard stop so a broken table cannot hang the run. */
  timeLimit: number;
}

function runStack(player: Player, tier: TierDefinition, options: SimOptions): StackResult {
  const stack = makeStack(tier);
  let seconds = 0;
  let coinsEarned = 0;
  let digs = 0;
  let sells = 0;

  const stopAt = options.strategy === 'rush' ? options.needleAt : 0.9995;

  while (stack.volume > stack.fullVolume * (1 - stopAt) && seconds < options.timeLimit) {
    const stats = statsOf(player);
    const step = cycle(stats, stack);
    if (!Number.isFinite(step.seconds)) break;

    const strawsAvailable = stack.volume * stack.density;
    const straws = Math.min(step.straws, strawsAvailable);
    const perDig = Math.max(effectiveDig(stats, stack), 1e-6);

    stack.volume = Math.max(0, stack.volume - straws / stack.density);
    seconds += step.seconds;
    digs += stats.tool.continuous ? straws / perDig : Math.ceil(straws / perDig);
    sells += 1;

    const income = straws * tier.strawValue * stats.sellMultiplier;
    player.coins += income;
    coinsEarned += income;
    shop(player, stack);
  }

  if (options.strategy === 'clear') {
    const stats = statsOf(player);
    const bonus = tier.straws * tier.strawValue * stats.sellMultiplier * tier.clearBonusMultiplier;
    player.coins += bonus;
    coinsEarned += bonus;
    player.gems += tier.clearBonusGems;
  }
  player.gems += tier.needleReward;

  return {
    seconds,
    coinsEarned,
    clearedFraction: 1 - stack.volume / stack.fullVolume,
    digs: Math.round(digs),
    sells,
  };
}

export interface Milestone {
  label: string;
  seconds: number;
  cumulative: number;
  coins: number;
  gems: number;
  cleared: number;
  digs: number;
  toolAtEnd: ToolId;
  topUpgrades: string;
  /** Purchased levels as a fraction of every level in the table. */
  progression: number;
}

export function simulate(options: SimOptions): Milestone[] {
  const player = newPlayer();
  const milestones: Milestone[] = [];
  let cumulative = 0;

  for (let index = 0; index < TIERS.length; index++) {
    const tier = TIERS[index];

    // Grind the previous stack until the next one is affordable.
    if (tier.unlockCost > 0) {
      const previous = TIERS[index - 1];
      let guard = 0;
      while (player.coins < tier.unlockCost && guard < 400) {
        const replay = runStack(player, previous, { ...options, strategy: 'clear' });
        cumulative += replay.seconds;
        guard++;
        if (replay.seconds <= 0 || !Number.isFinite(replay.seconds)) break;
      }
      player.coins -= tier.unlockCost;
      player.tier = index;
    }

    const result = runStack(player, tier, options);
    cumulative += result.seconds;
    milestones.push({
      label: tier.name,
      seconds: result.seconds,
      cumulative,
      coins: player.coins,
      gems: player.gems,
      cleared: result.clearedFraction,
      digs: result.digs,
      toolAtEnd: player.activeTool,
      topUpgrades: UPGRADES.map((upgrade) => `${upgrade.id}:${player.upgrades[upgrade.id] ?? 0}`)
        .filter((entry) => !entry.endsWith(':0'))
        .join(' '),
      progression:
        UPGRADES.reduce((sum, upgrade) => sum + (player.upgrades[upgrade.id] ?? 0), 0) /
        UPGRADES.reduce((sum, upgrade) => sum + upgrade.maxLevel, 0),
    });
  }

  return milestones;
}

// ------------------------------------------------------------------ report

function clock(seconds: number): string {
  if (!Number.isFinite(seconds)) return '  --  ';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function short(value: number): string {
  const units = ['', 'K', 'M', 'B', 'T'];
  let n = value;
  let tier = 0;
  while (Math.abs(n) >= 1000 && tier < units.length - 1) {
    n /= 1000;
    tier++;
  }
  return `${n.toFixed(n >= 100 || tier === 0 ? 0 : 1)}${units[tier]}`;
}

/** Time from a standing start to the first purchasable upgrade. */
function timeToFirstUpgrade(): number {
  const player = newPlayer();
  const stack = makeStack(TIERS[0]);
  const stats = statsOf(player);
  const rate = faceRate(stats, stack);
  const cheapest = Math.min(...UPGRADES.map((upgrade) => upgrade.baseCost));
  const strawsNeeded = cheapest / (TIERS[0].strawValue * stats.sellMultiplier);
  const haul = HAUL_DISTANCE / (BASE_WALK_SPEED * stats.moveSpeed);
  return strawsNeeded / rate + haul + SELL_TIME;
}

export function report(): void {
  const player = newPlayer();
  const stack = makeStack(TIERS[0]);
  const stats = statsOf(player);

  console.log('=== opening feel ===');
  console.log(`  straws per swing (bare hands) : ${effectiveDig(stats, stack).toFixed(1)}`);
  console.log(`  swings to fill the backpack   : ${Math.ceil(stats.capacity / effectiveDig(stats, stack))}`);
  console.log(`  seconds to first upgrade      : ${timeToFirstUpgrade().toFixed(1)}`);
  console.log(`  home stack straws / volume    : ${TIERS[0].straws} over ${moundVolume(TIERS[0].radius, TIERS[0].peak).toFixed(1)} m3`);
  console.log('');

  for (const strategy of ['rush', 'clear'] as const) {
    console.log(`=== strategy: ${strategy} ===`);
    // A wider sense range finds the needle after clearing less of the stack,
    // but a bigger stack dilutes that advantage.
    const needleAt = strategy === 'rush' ? 0.45 : 1;
    const milestones = simulate({ strategy, needleAt, timeLimit: 60 * 60 * 12 });
    console.log(
      '  ' +
        'stack'.padEnd(18) +
        'time'.padStart(8) +
        'total'.padStart(10) +
        'coins'.padStart(9) +
        'gems'.padStart(6) +
        'digs'.padStart(8) +
        'upg'.padStart(6) +
        '  tool',
    );
    for (const milestone of milestones) {
      console.log(
        '  ' +
          milestone.label.padEnd(18) +
          clock(milestone.seconds).padStart(8) +
          clock(milestone.cumulative).padStart(10) +
          short(milestone.coins).padStart(9) +
          String(milestone.gems).padStart(6) +
          short(milestone.digs).padStart(8) +
          `${Math.round(milestone.progression * 100)}%`.padStart(6) +
          `  ${milestone.toolAtEnd}`,
      );
    }
    const last = milestones[milestones.length - 1];
    console.log(`  upgrades at the end: ${last.topUpgrades}`);
    console.log('');
  }

  console.log('=== perk affordability (gems) ===');
  for (const perk of PERKS) {
    const total = Array.from({ length: perk.maxLevel }, (_, level) =>
      Math.ceil(perk.gemCost * Math.pow(2, level)),
    ).reduce((a, b) => a + b, 0);
    console.log(`  ${perk.name.padEnd(16)} max level costs ${total} gems total`);
  }
}

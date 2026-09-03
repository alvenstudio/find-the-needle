/**
 * Headless balance simulator.
 *
 * Plays whole runs against the real tables in `src/gameplay` and reports the
 * pacing curve, so tuning is a measurement rather than a guess. Run it with
 * `npm run balance`.
 *
 * The model deliberately includes the boring parts - walking to the cow,
 * waiting out pull cooldowns, pulls that hit ground already cleared, and the
 * fact that a bigger stack means more walking between working faces - because
 * those are exactly what a spreadsheet leaves out, and they are why a real
 * session always feels slower than the designer expected.
 */

import {
  GEMS_PER_MINUTE,
  GOLDEN_STRAW,
  PERKS,
  PERK_BY_ID,
  TIERS,
  TOOLS,
  UPGRADES,
  bagScaleFor,
  costScaleFor,
  perkCost,
  upgradeCost,
  type PerkId,
  type TierDefinition,
  type ToolId,
  type UpgradeId,
} from '../src/gameplay/Content.ts';
import { deriveStats, digVolume, type DerivedStats } from '../src/gameplay/Stats.ts';

// ------------------------------------------------------------------ model

/** Metres from the working face to the cow and back. */
const HAUL_DISTANCE = 16;
/** Seconds spent at the cow per sale. */
const SELL_TIME = 0.5;
/** Base walk speed in metres per second, mirroring DEFAULT_TUNING. */
const BASE_WALK_SPEED = 4.35;
/** A human cannot click faster than this, whatever the tool's cooldown says. */
const HUMAN_CLICK_FLOOR = 0.16;

/**
 * Share of dig time lost to aiming and walking to a fresh face.
 *
 * It grows with the footprint: on the Home Stack everything is within two
 * steps, but the Mother Lode is forty metres across and a real part of the run
 * is spent walking from one worked-out crater to the next.
 */
function aimOverhead(tier: TierDefinition): number {
  return Math.min(0.5, 0.1 + tier.radius * 0.019);
}

interface Stack {
  tier: TierDefinition;
  volume: number;
  readonly fullVolume: number;
  readonly density: number;
}

/** Analytic volume of the generated mound, matching HeightField.generate. */
function moundVolume(radius: number, peak: number, falloff = 2.15, shoulder = 0.72): number {
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

interface RunPlayer {
  cash: number;
  upgrades: Record<string, number>;
  tools: Set<ToolId>;
  activeTool: ToolId;
}

function newRunPlayer(tier: TierDefinition, perks: Record<string, number>): RunPlayer {
  const headStart = PERK_BY_ID.head_start.perLevel * (perks.head_start ?? 0);
  const tools = new Set<ToolId>();
  for (const tool of TOOLS) {
    tools.add(tool.id);
    if (tool.id === tier.startingTool) break;
  }
  return {
    cash: Math.round(tier.straws * tier.strawValue * headStart),
    upgrades: {},
    tools,
    activeTool: tier.startingTool,
  };
}

function statsOf(player: RunPlayer, perks: Record<string, number>, tier: TierDefinition): DerivedStats {
  return deriveStats({
    upgrades: player.upgrades,
    perks,
    activeTool: player.activeTool,
    bagScale: bagScaleFor(tier),
  });
}

/**
 * Straws removed by one pull, accounting for the crater bottoming out.
 *
 * Late in a stack the average remaining depth is less than the tool's bite, so
 * a pull that would take 40 cm only finds 8 cm of hay. Without this the
 * simulator wildly overstates end-of-stack throughput.
 */
function effectivePull(stats: DerivedStats, stack: Stack): number {
  const footprint = Math.PI * stack.tier.radius * stack.tier.radius;
  const averageDepth = stack.volume / footprint;
  // The player naturally works the thickest part, so allow 1.7x the average.
  const available = Math.min(stats.digDepth, averageDepth * 1.7);
  return digVolume(stats.digRadius, Math.max(available, 0)) * stack.density;
}

/** Sustained straws per second at the face, including the golden bundles. */
function faceRate(stats: DerivedStats, stack: Stack): number {
  const perUse = effectivePull(stats, stack);
  const period = stats.tool.continuous ? 1 : Math.max(stats.cooldown, HUMAN_CLICK_FLOOR);
  const raw = stats.tool.continuous ? perUse : perUse / period;
  const goldenBonus = 1 + GOLDEN_STRAW.chance * (GOLDEN_STRAW.payout - 1);
  return raw * goldenBonus * (1 - aimOverhead(stack.tier));
}

/** Seconds for one fill-haul-sell cycle, and the straws it moves. */
function cycle(stats: DerivedStats, stack: Stack): { seconds: number; straws: number } {
  const rate = faceRate(stats, stack);
  if (rate <= 1e-6) return { seconds: Infinity, straws: 0 };
  const straws = Math.min(stats.capacity, stack.volume * stack.density);
  const haul = HAUL_DISTANCE / (BASE_WALK_SPEED * stats.moveSpeed);
  return { seconds: straws / rate + haul + SELL_TIME, straws };
}

function cashPerSecond(player: RunPlayer, perks: Record<string, number>, stack: Stack): number {
  const stats = statsOf(player, perks, stack.tier);
  const { seconds, straws } = cycle(stats, stack);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return (straws * stack.tier.strawValue * stats.sellMultiplier) / seconds;
}

// ------------------------------------------------------------ the shopper

const ECONOMIC: UpgradeId[] = ['grasp', 'reach', 'bag', 'boots', 'haggle'];
const OPPORTUNISTIC: UpgradeId[] = ['magnet', 'luck'];

/**
 * Buy whatever most improves cash per second per unit of cash spent.
 *
 * This is what an engaged player converges on, and it is the strategy the
 * balance has to hold up against: if one upgrade dominates, the greedy shopper
 * finds it immediately and the pacing report goes flat.
 */
function shop(player: RunPlayer, perks: Record<string, number>, stack: Stack): number {
  let bought = 0;

  for (;;) {
    const baseline = cashPerSecond(player, perks, stack);
    let bestId: UpgradeId | null = null;
    let bestScore = 0;
    let bestCost = 0;

    for (const id of ECONOMIC) {
      const definition = UPGRADES.find((upgrade) => upgrade.id === id);
      if (!definition) continue;
      const level = player.upgrades[id] ?? 0;
      const cost = upgradeCost(definition, level, costScaleFor(stack.tier));
      if (!Number.isFinite(cost) || cost > player.cash) continue;
      player.upgrades[id] = level + 1;
      const gain = cashPerSecond(player, perks, stack) - baseline;
      player.upgrades[id] = level;
      const score = gain / cost;
      if (score > bestScore) {
        bestScore = score;
        bestId = id;
        bestCost = cost;
      }
    }

    // Tools are a step change rather than a marginal gain, so they are judged
    // on whether they beat the current rate at all, then bought outright.
    let boughtTool = false;
    for (const tool of TOOLS) {
      const price = tool.price * costScaleFor(stack.tier);
      if (player.tools.has(tool.id) || price > player.cash) continue;
      const previous = player.activeTool;
      player.activeTool = tool.id;
      const after = cashPerSecond(player, perks, stack);
      player.activeTool = previous;
      if (after > baseline * 1.02) {
        player.cash -= price;
        player.tools.add(tool.id);
        player.activeTool = tool.id;
        bought++;
        boughtTool = true;
        break;
      }
    }
    if (boughtTool) continue;

    if (!bestId) break;
    player.cash -= bestCost;
    player.upgrades[bestId] = (player.upgrades[bestId] ?? 0) + 1;
    bought++;
  }

  for (const id of OPPORTUNISTIC) {
    const definition = UPGRADES.find((upgrade) => upgrade.id === id);
    if (!definition) continue;
    const level = player.upgrades[id] ?? 0;
    const cost = upgradeCost(definition, level, costScaleFor(stack.tier));
    if (Number.isFinite(cost) && player.cash > cost * 8) {
      player.cash -= cost;
      player.upgrades[id] = level + 1;
      bought++;
    }
  }

  return bought;
}

// ------------------------------------------------------------- simulation

export interface RunResult {
  seconds: number;
  purchases: number;
  gaps: number[];
  firstPurchase: number;
  hayPulled: number;
  clearedFraction: number;
  cashLeftOver: number;
  finalTool: ToolId;
  upgradeFraction: number;
  gems: number;
  /** Seconds after the last affordable purchase - the "nothing to buy" tail. */
  deadTail: number;
}

/** Play one stack until the needle surfaces at the given volume quantile. */
export function simulateRun(
  tier: TierDefinition,
  perks: Record<string, number>,
  needleQuantile: number,
): RunResult {
  const stack = makeStack(tier);
  const player = newRunPlayer(tier, perks);
  const gaps: number[] = [];

  let seconds = 0;
  let hayPulled = 0;
  let purchases = 0;
  let firstPurchase = -1;
  let lastPurchaseSeconds = 0;

  const initial = shop(player, perks, stack);
  if (initial > 0) {
    purchases += initial;
    firstPurchase = 0;
  }

  while (1 - stack.volume / stack.fullVolume < needleQuantile && seconds < 60 * 90) {
    const stats = statsOf(player, perks, stack.tier);
    const step = cycle(stats, stack);
    if (!Number.isFinite(step.seconds)) break;

    const available = stack.volume * stack.density;
    const straws = Math.min(step.straws, available);
    if (straws <= 1e-6) break;
    stack.volume = Math.max(0, stack.volume - straws / stack.density);
    seconds += step.seconds;
    hayPulled += straws;

    player.cash += straws * tier.strawValue * stats.sellMultiplier;
    const boughtNow = shop(player, perks, stack);
    if (boughtNow > 0) {
      const span = seconds - lastPurchaseSeconds;
      for (let i = 0; i < boughtNow; i++) gaps.push(span / boughtNow);
      if (firstPurchase < 0) firstPurchase = seconds;
      purchases += boughtNow;
      lastPurchaseSeconds = seconds;
    }
  }

  const totalLevels = UPGRADES.reduce((sum, upgrade) => sum + upgrade.maxLevel, 0);
  const ownedLevels = UPGRADES.reduce((sum, upgrade) => sum + (player.upgrades[upgrade.id] ?? 0), 0);

  return {
    seconds,
    purchases,
    gaps,
    firstPurchase,
    hayPulled,
    clearedFraction: 1 - stack.volume / stack.fullVolume,
    cashLeftOver: player.cash,
    finalTool: player.activeTool,
    upgradeFraction: ownedLevels / totalLevels,
    gems: tier.needleGems + Math.floor((seconds / 60) * GEMS_PER_MINUTE),
    deadTail: Math.max(0, seconds - lastPurchaseSeconds),
  };
}

// ------------------------------------------------------------------ report

function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '  --  ';
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

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Career simulation: play runs, bank gems, buy perks, move up a stack.
 *
 * The greedy perk shopper buys the cheapest affordable perk, which is what a
 * player without a spreadsheet does and is the pessimistic case for pacing.
 */
function simulateCareer(maxRuns = 14): void {
  const perks: Record<string, number> = {};
  let gems = 0;
  let unlocked = 0;
  let totalSeconds = 0;

  console.log('=== career: one run per stack, then repeats of the last ===');
  console.log(
    '  ' +
      'run'.padStart(4) +
      '  ' +
      'stack'.padEnd(18) +
      'time'.padStart(8) +
      'total'.padStart(9) +
      'buys'.padStart(6) +
      'upg'.padStart(6) +
      'gems'.padStart(7) +
      '  perks',
  );

  for (let runIndex = 1; runIndex <= maxRuns; runIndex++) {
    const tier = TIERS[unlocked];
    const quantile = (tier.needleQuantile[0] + tier.needleQuantile[1]) / 2;
    const result = simulateRun(tier, perks, quantile);
    totalSeconds += result.seconds;
    gems += result.gems;

    let spent = true;
    while (spent) {
      spent = false;
      let cheapest: { id: PerkId; cost: number } | null = null;
      for (const perk of PERKS) {
        const level = perks[perk.id] ?? 0;
        const cost = perkCost(perk, level);
        if (!Number.isFinite(cost) || cost > gems) continue;
        if (!cheapest || cost < cheapest.cost) cheapest = { id: perk.id, cost };
      }
      if (cheapest) {
        gems -= cheapest.cost;
        perks[cheapest.id] = (perks[cheapest.id] ?? 0) + 1;
        spent = true;
      }
    }

    const perkSummary = PERKS.map((perk) => perks[perk.id] ?? 0).join('');
    console.log(
      '  ' +
        String(runIndex).padStart(4) +
        '  ' +
        tier.name.padEnd(18) +
        clock(result.seconds).padStart(8) +
        clock(totalSeconds).padStart(9) +
        String(result.purchases).padStart(6) +
        `${Math.round(result.upgradeFraction * 100)}%`.padStart(6) +
        String(gems).padStart(7) +
        `  ${perkSummary}`,
    );

    if (unlocked < TIERS.length - 1) unlocked++;
  }
  console.log('');
}

export function report(): void {
  console.log('=== per-stack pacing (no perks, needle at the median quantile) ===');
  console.log(
    '  ' +
      'stack'.padEnd(18) +
      'time'.padStart(8) +
      'first'.padStart(7) +
      'gap p50'.padStart(9) +
      'gap p90'.padStart(9) +
      'buys'.padStart(6) +
      'upg'.padStart(6) +
      'dead'.padStart(8) +
      'hay'.padStart(9) +
      '  tool',
  );
  for (const tier of TIERS) {
    const quantile = (tier.needleQuantile[0] + tier.needleQuantile[1]) / 2;
    const result = simulateRun(tier, {}, quantile);
    console.log(
      '  ' +
        tier.name.padEnd(18) +
        clock(result.seconds).padStart(8) +
        `${result.firstPurchase.toFixed(1)}s`.padStart(7) +
        `${percentile(result.gaps, 0.5).toFixed(1)}s`.padStart(9) +
        `${percentile(result.gaps, 0.9).toFixed(1)}s`.padStart(9) +
        String(result.purchases).padStart(6) +
        `${Math.round(result.upgradeFraction * 100)}%`.padStart(6) +
        clock(result.deadTail).padStart(8) +
        short(result.hayPulled).padStart(9) +
        `  ${result.finalTool}`,
    );
  }
  console.log('');

  console.log('=== opening thirty seconds (Home Stack, bare hands) ===');
  const stack = makeStack(TIERS[0]);
  const player = newRunPlayer(TIERS[0], {});
  const stats = statsOf(player, {}, TIERS[0]);
  const perPull = effectivePull(stats, stack);
  console.log(`  hay per pull        : ${perPull.toFixed(1)}`);
  console.log(`  pulls to fill bag   : ${Math.ceil(stats.capacity / perPull)}`);
  console.log(`  seconds to fill bag : ${(stats.capacity / faceRate(stats, stack)).toFixed(1)}`);
  console.log(`  first bag pays      : $${Math.round(stats.capacity * TIERS[0].strawValue)}`);
  console.log(`  cheapest upgrade    : $${Math.min(...UPGRADES.map((upgrade) => upgrade.baseCost))}`);
  console.log(
    `  stack volume        : ${stack.fullVolume.toFixed(0)} m3 at ${stack.density.toFixed(0)} straws/m3`,
  );
  console.log('');

  console.log('=== needle-quantile sensitivity (Home Stack) ===');
  for (const quantile of [0.15, 0.25, 0.4, 0.6, 0.8, 1]) {
    const result = simulateRun(TIERS[0], {}, quantile);
    console.log(`  cleared ${(quantile * 100).toFixed(0).padStart(3)}%  ->  ${clock(result.seconds)}`);
  }
  console.log('');

  simulateCareer();

  console.log('=== perk ladder (total gems to max each) ===');
  for (const perk of PERKS) {
    const total = Array.from({ length: perk.maxLevel }, (_, level) => perkCost(perk, level)).reduce(
      (a, b) => a + b,
      0,
    );
    console.log(`  ${perk.name.padEnd(16)} ${String(total).padStart(6)} gems`);
  }
}

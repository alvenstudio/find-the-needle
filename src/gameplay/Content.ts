/**
 * Every tunable number in the game, in one place.
 *
 * Nothing here reaches for `three` or the DOM, which means the balance
 * simulator in `tools/balance.mjs` can import it and play thousands of
 * simulated sessions to check the pacing before a human ever sees it.
 *
 * DESIGN NOTES
 * ------------
 * The loop is dig -> carry -> sell -> upgrade, and it has to stay interesting
 * from the first fifteen-straw scoop to a stack of a million. Three levers keep
 * it honest:
 *
 *   * **Costs rise faster than yields.** Upgrade costs grow ~1.35x per level
 *     while their effect grows linearly, so the tenth Scoop level costs twenty
 *     times the first but only doubles the yield. Money never becomes
 *     meaningless, and there is always a next thing to want.
 *   * **Tiers reset the scale, not the skill.** Each new haystack multiplies
 *     both the work and the payout, so upgrades bought in tier 1 still matter
 *     in tier 4 - they are simply no longer sufficient.
 *   * **The needle is a shortcut, not a formality.** Finding it early ends the
 *     stack with fewer coins but more gems. Clearing the stack completely pays
 *     the most money. Both are viable, which is the only interesting kind of
 *     choice.
 */

// ---------------------------------------------------------------- upgrades

export type UpgradeId =
  | 'scoop'
  | 'radius'
  | 'capacity'
  | 'boots'
  | 'haggling'
  | 'magnet'
  | 'lucky'
  | 'sifter';

export interface UpgradeDefinition {
  id: UpgradeId;
  name: string;
  blurb: string;
  icon: string;
  baseCost: number;
  /** cost(level) = baseCost * growth^level */
  growth: number;
  maxLevel: number;
  /**
   * How the stat grows. 'linear' adds `perLevel` each level; 'geometric'
   * multiplies by it. Capacity has to be geometric: straw counts grow by three
   * orders of magnitude across the tiers, and a linear backpack would turn the
   * late game into an unbroken walk to the cart and back.
   */
  mode: 'linear' | 'geometric';
  /** The stat's value at level 0. */
  base: number;
  perLevel: number;
  /** How the stat reads in the shop: 'x' for multipliers, 'm' for metres. */
  unit: 'x' | 'm' | '' | '%';
}

export const UPGRADES: readonly UpgradeDefinition[] = [
  {
    id: 'scoop',
    name: 'Scoop Depth',
    blurb: 'Bite deeper into the stack with every swing.',
    icon: '⛏',
    baseCost: 25,
    growth: 1.45,
    maxLevel: 34,
    mode: 'linear',
    base: 1,
    perLevel: 0.13,
    unit: 'x',
  },
  {
    id: 'radius',
    name: 'Sweep Width',
    blurb: 'Widen the crater so each swing clears more ground.',
    icon: '↔',
    baseCost: 90,
    growth: 1.55,
    maxLevel: 20,
    mode: 'linear',
    base: 1,
    perLevel: 0.042,
    unit: 'x',
  },
  {
    id: 'capacity',
    name: 'Backpack',
    blurb: 'Carry more straw before you have to walk back.',
    icon: '🎒',
    baseCost: 40,
    growth: 1.42,
    maxLevel: 42,
    mode: 'geometric',
    base: 45,
    perLevel: 1.185,
    unit: '',
  },
  {
    id: 'boots',
    name: 'Work Boots',
    blurb: 'Move faster across the yard and up the stack.',
    icon: '👢',
    baseCost: 150,
    growth: 1.6,
    maxLevel: 14,
    mode: 'linear',
    base: 1,
    perLevel: 0.05,
    unit: 'x',
  },
  {
    id: 'haggling',
    name: 'Haggling',
    blurb: 'Talk the buyer up. Every straw sells for more.',
    icon: '💰',
    baseCost: 220,
    growth: 1.55,
    maxLevel: 26,
    mode: 'linear',
    base: 1,
    perLevel: 0.085,
    unit: 'x',
  },
  {
    id: 'magnet',
    name: 'Straw Magnet',
    blurb: 'Loose straw drifts to you instead of lying there.',
    icon: '🧲',
    baseCost: 260,
    growth: 1.62,
    maxLevel: 16,
    // Level 0 means "not bought yet", so the base is deliberately zero.
    mode: 'linear',
    base: 0,
    perLevel: 0.42,
    unit: 'm',
  },
  {
    id: 'lucky',
    name: 'Lucky Rake',
    blurb: 'Turn up buried oddities far more often.',
    icon: '🍀',
    baseCost: 500,
    growth: 1.75,
    maxLevel: 14,
    mode: 'linear',
    base: 1,
    perLevel: 0.22,
    unit: 'x',
  },
  {
    id: 'sifter',
    name: 'Fine Sifter',
    blurb: 'Sharpens the needle-sense: a stronger, longer-range reading.',
    icon: '🔎',
    baseCost: 900,
    growth: 1.7,
    maxLevel: 12,
    // Adds to the magnifier's intrinsic range rather than replacing it.
    mode: 'linear',
    base: 0,
    perLevel: 1.15,
    unit: 'm',
  },
] as const;

export const UPGRADE_BY_ID: Readonly<Record<UpgradeId, UpgradeDefinition>> = Object.fromEntries(
  UPGRADES.map((upgrade) => [upgrade.id, upgrade]),
) as Record<UpgradeId, UpgradeDefinition>;

export function upgradeCost(definition: UpgradeDefinition, level: number): number {
  if (level >= definition.maxLevel) return Infinity;
  return Math.ceil(definition.baseCost * Math.pow(definition.growth, level));
}

export function upgradeValue(definition: UpgradeDefinition, level: number): number {
  return definition.mode === 'geometric'
    ? definition.base * Math.pow(definition.perLevel, level)
    : definition.base + definition.perLevel * level;
}

// ------------------------------------------------------------------- tools

export type ToolId = 'hands' | 'pitchfork' | 'rake' | 'blower' | 'vacuum' | 'compressor';

export interface ToolDefinition {
  id: ToolId;
  name: string;
  blurb: string;
  model: string;
  /** Crater radius in metres before upgrades. */
  radius: number;
  /**
   * Depth removed per use. For swing tools this is per swing; for continuous
   * tools it is per second, and `continuous` says which.
   */
  depth: number;
  continuous: boolean;
  /** Seconds between swings. Ignored for continuous tools. */
  cooldown: number;
  /** How far in front of the player the tool can reach. */
  reach: number;
  /** Coin price. The starting tool is free. */
  price: number;
  /** Tier the player must have unlocked before it appears in the shop. */
  requiresTier: number;
  /** Straws inside this radius are hoovered up without a magnet upgrade. */
  autoCollect: number;
  /** Viewmodel animation feel. */
  swingStyle: 'stab' | 'sweep' | 'stream';
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'hands',
    name: 'Bare Hands',
    blurb: 'Two hands and some determination.',
    model: 'hands',
    radius: 0.7,
    depth: 0.16,
    continuous: false,
    cooldown: 0.42,
    reach: 2.1,
    price: 0,
    requiresTier: 0,
    autoCollect: 0.0,
    swingStyle: 'stab',
  },
  {
    id: 'pitchfork',
    name: 'Pitchfork',
    blurb: 'The honest farmhand answer to a big pile of hay.',
    model: 'pitchfork',
    radius: 0.95,
    depth: 0.185,
    continuous: false,
    cooldown: 0.38,
    reach: 3.0,
    price: 700,
    requiresTier: 0,
    autoCollect: 0.0,
    swingStyle: 'stab',
  },
  {
    id: 'rake',
    name: 'Wide Rake',
    blurb: 'Sweeps a broad arc. Less depth, far more ground.',
    model: 'rake',
    radius: 1.55,
    depth: 0.125,
    continuous: false,
    cooldown: 0.32,
    reach: 3.4,
    price: 16000,
    requiresTier: 1,
    autoCollect: 1.0,
    swingStyle: 'sweep',
  },
  {
    id: 'blower',
    name: 'Leaf Blower',
    blurb: 'Hold it down. The straw simply leaves.',
    model: 'leaf_blower',
    radius: 1.45,
    depth: 0.62,
    continuous: true,
    cooldown: 0.0,
    reach: 4.0,
    price: 300000,
    requiresTier: 2,
    autoCollect: 1.6,
    swingStyle: 'stream',
  },
  {
    id: 'vacuum',
    name: 'Hay Vacuum',
    blurb: 'Industrial suction with a backpack to match.',
    model: 'hay_vacuum',
    radius: 2.05,
    depth: 0.72,
    continuous: true,
    cooldown: 0.0,
    reach: 4.6,
    price: 6000000,
    requiresTier: 3,
    autoCollect: 3.0,
    swingStyle: 'stream',
  },
  {
    id: 'compressor',
    name: 'Stack Compressor',
    blurb: 'Eats a haystack the way a combine eats a field.',
    model: 'compressor',
    radius: 2.9,
    depth: 0.95,
    continuous: true,
    cooldown: 0.0,
    reach: 5.4,
    price: 110000000,
    requiresTier: 4,
    autoCollect: 5.0,
    swingStyle: 'stream',
  },
] as const;

export const TOOL_BY_ID: Readonly<Record<ToolId, ToolDefinition>> = Object.fromEntries(
  TOOLS.map((tool) => [tool.id, tool]),
) as Record<ToolId, ToolDefinition>;

// ------------------------------------------------------------------- tiers

export interface TierDefinition {
  id: string;
  name: string;
  tagline: string;
  /** Footprint radius and peak height of the pile, in metres. */
  radius: number;
  peak: number;
  /** How many straws the full stack contains. Drives density, not volume. */
  straws: number;
  /** Coins per straw sold here, before Haggling and rebirth multipliers. */
  strawValue: number;
  /** Coin price to unlock. The first stack is free. */
  unlockCost: number;
  /** Gems awarded the first time the needle is found here. */
  needleReward: number;
  /** Extra gems for clearing every last straw. */
  clearBonusGems: number;
  /** Coin bonus for a full clear, as a multiple of the stack's total value. */
  clearBonusMultiplier: number;
  /** Buried treasures placed in the stack. */
  treasures: number;
  /** Sky and lighting mood. */
  mood: 'noon' | 'golden' | 'overcast' | 'storm' | 'night' | 'dawn';
  /** Environment dressing preset. */
  scene: 'yard' | 'loft' | 'field' | 'silo' | 'meadow' | 'canyon';
}

export const TIERS: readonly TierDefinition[] = [
  {
    id: 'home',
    name: 'The Home Stack',
    tagline: 'Grandad swore he dropped it right here.',
    radius: 4.6,
    peak: 2.5,
    straws: 12000,
    strawValue: 1,
    unlockCost: 0,
    needleReward: 3,
    clearBonusGems: 2,
    clearBonusMultiplier: 0.35,
    treasures: 3,
    mood: 'noon',
    scene: 'yard',
  },
  {
    id: 'loft',
    name: 'The Barn Loft',
    tagline: 'Forty years of hay, and something metal in it.',
    radius: 6.2,
    peak: 3.4,
    straws: 33000,
    strawValue: 2.6,
    unlockCost: 5000,
    needleReward: 6,
    clearBonusGems: 4,
    clearBonusMultiplier: 0.4,
    treasures: 4,
    mood: 'overcast',
    scene: 'loft',
  },
  {
    id: 'field',
    name: 'Sunset Field',
    tagline: 'The whole harvest in one enormous heap.',
    radius: 8.5,
    peak: 4.6,
    straws: 95000,
    strawValue: 8,
    unlockCost: 90000,
    needleReward: 12,
    clearBonusGems: 7,
    clearBonusMultiplier: 0.45,
    treasures: 5,
    mood: 'golden',
    scene: 'field',
  },
  {
    id: 'silo',
    name: 'Storm Silo',
    tagline: 'They filled it before the storm and never emptied it.',
    radius: 12.0,
    peak: 6.2,
    straws: 280000,
    strawValue: 26,
    unlockCost: 1600000,
    needleReward: 22,
    clearBonusGems: 12,
    clearBonusMultiplier: 0.5,
    treasures: 6,
    mood: 'storm',
    scene: 'silo',
  },
  {
    id: 'meadow',
    name: 'Moonlit Meadow',
    tagline: 'Something down there is catching the moonlight.',
    radius: 16.0,
    peak: 7.8,
    straws: 800000,
    strawValue: 85,
    unlockCost: 32000000,
    needleReward: 40,
    clearBonusGems: 20,
    clearBonusMultiplier: 0.55,
    treasures: 8,
    mood: 'night',
    scene: 'meadow',
  },
  {
    id: 'motherlode',
    name: 'The Mother Lode',
    tagline: 'One million straws. One needle. Good luck.',
    radius: 20.0,
    peak: 9.2,
    straws: 1000000,
    strawValue: 260,
    unlockCost: 520000000,
    needleReward: 75,
    clearBonusGems: 40,
    clearBonusMultiplier: 0.65,
    treasures: 10,
    mood: 'dawn',
    scene: 'canyon',
  },
] as const;

// --------------------------------------------------------------- treasures

export type TreasureRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface TreasureDefinition {
  id: string;
  name: string;
  model: string;
  rarity: TreasureRarity;
  /** Relative weight within its rarity band. */
  weight: number;
  /** Coins paid on discovery, before multipliers. */
  coins: number;
  gems: number;
  flavour: string;
}

export const RARITY_WEIGHTS: Readonly<Record<TreasureRarity, number>> = {
  common: 58,
  uncommon: 25,
  rare: 12,
  epic: 4.2,
  legendary: 0.8,
};

export const RARITY_COLORS: Readonly<Record<TreasureRarity, string>> = {
  common: '#cfd6dd',
  uncommon: '#6ddf7a',
  rare: '#59b3ff',
  epic: '#c07bff',
  legendary: '#ffc23d',
};

export const TREASURES: readonly TreasureDefinition[] = [
  {
    id: 'coin',
    name: 'Old Penny',
    model: 'coin',
    rarity: 'common',
    weight: 3,
    coins: 120,
    gems: 0,
    flavour: 'Still shiny under all that dust.',
  },
  {
    id: 'horseshoe',
    name: 'Lucky Horseshoe',
    model: 'horseshoe',
    rarity: 'common',
    weight: 2,
    coins: 180,
    gems: 0,
    flavour: 'Open end up, or the luck runs out.',
  },
  {
    id: 'arrowhead',
    name: 'Flint Arrowhead',
    model: 'arrowhead',
    rarity: 'uncommon',
    weight: 2,
    coins: 420,
    gems: 0,
    flavour: 'Older than the barn. Older than the farm.',
  },
  {
    id: 'key',
    name: 'Brass Key',
    model: 'key',
    rarity: 'uncommon',
    weight: 2,
    coins: 520,
    gems: 1,
    flavour: 'Opens something. Nobody remembers what.',
  },
  {
    id: 'bone',
    name: 'Enormous Bone',
    model: 'bone',
    rarity: 'rare',
    weight: 2,
    coins: 1400,
    gems: 1,
    flavour: 'Too big for any cow that ever lived here.',
  },
  {
    id: 'pocket_watch',
    name: 'Pocket Watch',
    model: 'pocket_watch',
    rarity: 'rare',
    weight: 2,
    coins: 1900,
    gems: 2,
    flavour: 'Stopped at 4:07. Nobody knows which one.',
  },
  {
    id: 'ring',
    name: 'Wedding Ring',
    model: 'ring',
    rarity: 'epic',
    weight: 2,
    coins: 6500,
    gems: 4,
    flavour: 'Someone cried about this for a week in 1953.',
  },
  {
    id: 'gnome',
    name: 'Garden Gnome',
    model: 'gnome',
    rarity: 'epic',
    weight: 1.5,
    coins: 7200,
    gems: 4,
    flavour: 'He has been down there a while. He seems fine.',
  },
  {
    id: 'chest',
    name: 'Buried Chest',
    model: 'chest',
    rarity: 'legendary',
    weight: 1.5,
    coins: 45000,
    gems: 12,
    flavour: 'Heavier than it has any right to be.',
  },
  {
    id: 'ufo',
    name: 'The Saucer',
    model: 'ufo',
    rarity: 'legendary',
    weight: 1,
    coins: 60000,
    gems: 18,
    flavour: 'So THAT is what flattened the corn.',
  },
  {
    id: 'needle_golden',
    name: 'The Golden Needle',
    model: 'needle_golden',
    rarity: 'legendary',
    weight: 0.6,
    coins: 90000,
    gems: 30,
    flavour: 'The needle behind the needle.',
  },
] as const;

export const TREASURE_BY_ID: Readonly<Record<string, TreasureDefinition>> = Object.fromEntries(
  TREASURES.map((treasure) => [treasure.id, treasure]),
);

// ---------------------------------------------------------------- rebirth

/** Retiring resets coins, upgrades and tier access for a permanent multiplier. */
export const REBIRTH = {
  /** Tier index that must be cleared before retirement unlocks. */
  requiresTier: 2,
  /** Sell-value multiplier is `valueGrowth ^ rebirths`. */
  valueGrowth: 1.55,
  /** Dig-yield multiplier is `yieldGrowth ^ rebirths`. */
  yieldGrowth: 1.18,
  /** Gems granted per retirement, scaled by how far the player got. */
  baseGems: 25,
  gemsPerTier: 15,
} as const;

export function rebirthValueMultiplier(rebirths: number): number {
  return Math.pow(REBIRTH.valueGrowth, rebirths);
}

export function rebirthYieldMultiplier(rebirths: number): number {
  return Math.pow(REBIRTH.yieldGrowth, rebirths);
}

export function rebirthReward(rebirths: number, highestTier: number): number {
  return Math.round((REBIRTH.baseGems + REBIRTH.gemsPerTier * highestTier) * (1 + rebirths * 0.25));
}

// ----------------------------------------------------------------- quests

export type QuestKind = 'sell' | 'dig' | 'treasure' | 'clear' | 'needle' | 'speed';

export interface QuestTemplate {
  kind: QuestKind;
  name: string;
  /** Target scales with the player's current tier. */
  baseTarget: number;
  tierScale: number;
  coinReward: number;
  gemReward: number;
  describe: (target: number) => string;
}

export const QUEST_TEMPLATES: readonly QuestTemplate[] = [
  {
    kind: 'sell',
    name: 'Market Day',
    baseTarget: 2500,
    tierScale: 2.6,
    coinReward: 400,
    gemReward: 1,
    describe: (target) => `Sell ${target.toLocaleString('en-US')} straws`,
  },
  {
    kind: 'dig',
    name: 'Elbow Grease',
    baseTarget: 220,
    tierScale: 1.35,
    coinReward: 300,
    gemReward: 1,
    describe: (target) => `Take ${target} swings at the stack`,
  },
  {
    kind: 'treasure',
    name: 'Rummage',
    baseTarget: 2,
    tierScale: 1.15,
    coinReward: 700,
    gemReward: 2,
    describe: (target) => `Dig up ${target} buried ${target === 1 ? 'oddity' : 'oddities'}`,
  },
  {
    kind: 'clear',
    name: 'Tidy Farmer',
    baseTarget: 45,
    tierScale: 1.05,
    coinReward: 900,
    gemReward: 2,
    describe: (target) => `Clear ${target}% of a single stack`,
  },
  {
    kind: 'needle',
    name: 'Sharp Eyes',
    baseTarget: 1,
    tierScale: 1,
    coinReward: 1200,
    gemReward: 3,
    describe: (target) => `Find ${target} needle${target === 1 ? '' : 's'}`,
  },
  {
    kind: 'speed',
    name: 'Against the Clock',
    baseTarget: 300,
    tierScale: 1.12,
    coinReward: 1500,
    gemReward: 4,
    describe: (target) => `Find a needle within ${Math.round(target / 60)} minutes of starting a stack`,
  },
] as const;

// ------------------------------------------------------------ gem upgrades

export type PerkId = 'sixth_sense' | 'deep_pockets' | 'gilded_touch' | 'swift_hands' | 'metal_detector';

export interface PerkDefinition {
  id: PerkId;
  name: string;
  blurb: string;
  icon: string;
  gemCost: number;
  maxLevel: number;
  /** Effect strength per level; interpretation is perk-specific. */
  perLevel: number;
}

export const PERKS: readonly PerkDefinition[] = [
  {
    id: 'metal_detector',
    name: 'Metal Detector',
    blurb: 'Audible pings that quicken as you close on the needle.',
    icon: '📡',
    gemCost: 8,
    maxLevel: 1,
    perLevel: 1,
  },
  {
    id: 'sixth_sense',
    name: 'Sixth Sense',
    blurb: 'Widens the range at which buried things register.',
    icon: '✨',
    gemCost: 6,
    maxLevel: 5,
    perLevel: 1.6,
  },
  {
    id: 'deep_pockets',
    name: 'Deep Pockets',
    blurb: '+20% backpack capacity per level, forever.',
    icon: '👝',
    gemCost: 10,
    maxLevel: 5,
    perLevel: 0.2,
  },
  {
    id: 'gilded_touch',
    name: 'Gilded Touch',
    blurb: '+12% coins from every sale, forever.',
    icon: '🪙',
    gemCost: 14,
    maxLevel: 6,
    perLevel: 0.12,
  },
  {
    id: 'swift_hands',
    name: 'Swift Hands',
    blurb: '-6% swing cooldown per level.',
    icon: '⚡',
    gemCost: 12,
    maxLevel: 5,
    perLevel: 0.06,
  },
] as const;

export const PERK_BY_ID: Readonly<Record<PerkId, PerkDefinition>> = Object.fromEntries(
  PERKS.map((perk) => [perk.id, perk]),
) as Record<PerkId, PerkDefinition>;

export function perkCost(definition: PerkDefinition, level: number): number {
  // Gem prices double each level; gems are scarce and the perks are strong.
  return level >= definition.maxLevel ? Infinity : Math.ceil(definition.gemCost * Math.pow(2, level));
}

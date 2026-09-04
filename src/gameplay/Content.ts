/**
 * Every tunable number in the game, in one place.
 *
 * Nothing here reaches for `three` or the DOM, so the balance simulator in
 * `tools/balance.ts` imports it and plays thousands of runs to check the pacing
 * before a human ever sees it.
 *
 * THE SHAPE OF THE GAME
 * --------------------
 * A *run* is one haystack. You arrive with nothing but your permanent perks,
 * pull hay, sell it at the cow, and spend the cash on upgrades that last only
 * until the needle turns up. Finding it ends the run and pays gems, which are
 * the only thing that crosses the boundary.
 *
 * That structure is not incidental, and it is the model the games this one is
 * modelled on actually use. An upgrade tree that persists forever is fully
 * bought out by the third hour and the economy dies with it; a tree that resets
 * every run means the eight-second "something to buy" clock ticks from the
 * first pull of every session. It also makes a run a self-contained thing you
 * can win, lose track of time in, and immediately start again.
 *
 * THE THREE CLOCKS
 * ----------------
 *   ~10 s   buy an upgrade
 *   ~60 s   fill the bag, walk to the cow, sell
 *   ~8 min  find the needle, bank the gems, start over
 *
 * Everything below is tuned to keep those three ticking.
 */

// ---------------------------------------------------------------- upgrades

export type UpgradeId = 'grasp' | 'reach' | 'bag' | 'boots' | 'haggle' | 'magnet' | 'luck';

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
   * multiplies by it. The bag has to be geometric: a run spans two orders of
   * magnitude of throughput, and a linear bag would turn its back half into an
   * unbroken walk to the cow and back.
   */
  mode: 'linear' | 'geometric';
  /** The stat's value at level 0. */
  base: number;
  perLevel: number;
  unit: 'x' | 'm' | '' | '%';
}

export const UPGRADES: readonly UpgradeDefinition[] = [
  {
    id: 'grasp',
    name: 'Хватка',
    blurb: 'Каждый рывок уходит глубже в стог.',
    icon: '✊',
    baseCost: 22,
    growth: 1.42,
    maxLevel: 55,
    mode: 'linear',
    base: 1,
    perLevel: 0.085,
    unit: 'x',
  },
  {
    id: 'reach',
    name: 'Размах',
    blurb: 'Шире захват — за раз уходит больше стога.',
    icon: '↔',
    baseCost: 60,
    growth: 1.5,
    maxLevel: 32,
    mode: 'linear',
    base: 1,
    perLevel: 0.02,
    unit: 'x',
  },
  {
    id: 'bag',
    name: 'Мешок',
    blurb: 'Больше сена за одну ходку к корове.',
    icon: '🎒',
    baseCost: 30,
    growth: 1.4,
    maxLevel: 50,
    mode: 'geometric',
    base: 25,
    perLevel: 1.155,
    unit: '',
  },
  {
    id: 'boots',
    name: 'Сапоги',
    blurb: 'Быстрее по двору и увереннее по стогу.',
    icon: '👢',
    baseCost: 80,
    growth: 1.55,
    maxLevel: 16,
    mode: 'linear',
    base: 1,
    perLevel: 0.03,
    unit: 'x',
  },
  {
    id: 'haggle',
    name: 'Торг',
    blurb: 'Корова платит щедрее, если смотреть ей в глаза.',
    icon: '💰',
    baseCost: 90,
    growth: 1.45,
    maxLevel: 40,
    mode: 'linear',
    base: 1,
    perLevel: 0.045,
    unit: 'x',
  },
  {
    id: 'magnet',
    name: 'Магнит',
    blurb: 'Разлетевшееся сено само тянется к рукам.',
    icon: '🧲',
    baseCost: 260,
    growth: 1.6,
    maxLevel: 16,
    mode: 'linear',
    // Level 0 means "not bought yet", so the base is deliberately zero.
    base: 0,
    perLevel: 0.42,
    unit: 'm',
  },
  {
    id: 'luck',
    name: 'Везучие грабли',
    blurb: 'Закопанные находки попадаются куда чаще.',
    icon: '🍀',
    baseCost: 400,
    growth: 1.7,
    maxLevel: 14,
    mode: 'linear',
    base: 1,
    perLevel: 0.2,
    unit: 'x',
  },
] as const;

export const UPGRADE_BY_ID: Readonly<Record<UpgradeId, UpgradeDefinition>> = Object.fromEntries(
  UPGRADES.map((upgrade) => [upgrade.id, upgrade]),
) as Record<UpgradeId, UpgradeDefinition>;

/**
 * Price of the next level.
 *
 * `scale` is the tier's straw value, which makes the whole shop self-similar:
 * the first upgrade always costs about one bagful, on the Home Stack and on the
 * Mother Lode alike. Without it a tier where hay sells for $260 would let the
 * player buy out half the tree from a single sale, and the ten-second
 * "something to buy" clock - the thing the run's whole rhythm hangs on - would
 * collapse into a single shopping spree.
 */
export function upgradeCost(definition: UpgradeDefinition, level: number, scale = 1): number {
  if (level >= definition.maxLevel) return Infinity;
  return Math.ceil(definition.baseCost * Math.pow(definition.growth, level) * scale);
}

export function upgradeValue(definition: UpgradeDefinition, level: number): number {
  return definition.mode === 'geometric'
    ? definition.base * Math.pow(definition.perLevel, level)
    : definition.base + definition.perLevel * level;
}

// ------------------------------------------------------------------- tools

export type ToolId = 'hands' | 'pitchfork' | 'rake' | 'dynamite' | 'blower' | 'vacuum' | 'compressor';

export interface ToolDefinition {
  id: ToolId;
  name: string;
  blurb: string;
  model: string;
  /** Crater radius in metres before upgrades. */
  radius: number;
  /**
   * Depth removed per use: per pull for a discrete tool, per second for a
   * continuous one.
   */
  depth: number;
  continuous: boolean;
  /** Seconds between pulls. Ignored for continuous tools. */
  cooldown: number;
  /** How far in front of the player the tool can reach. */
  reach: number;
  /**
   * Cash price within a run, in bagfuls-of-tier-one. Multiplied by the tier's
   * straw value at purchase time, exactly like upgrade costs.
   */
  price: number;
  /** Straws hoovered up around the player without a Magnet. */
  autoCollect: number;
  swingStyle: 'stab' | 'sweep' | 'stream' | 'throw';
  /** Screen shake and sound weight, 0..1. */
  heft: number;
}

export const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'hands',
    name: 'Голые руки',
    blurb: 'Одна рука и немного упрямства.',
    model: 'hands',
    radius: 0.72,
    depth: 0.15,
    continuous: false,
    cooldown: 0.24,
    reach: 2.3,
    price: 0,
    autoCollect: 0,
    swingStyle: 'stab',
    heft: 0.25,
  },
  {
    id: 'pitchfork',
    name: 'Вилы',
    blurb: 'Честный крестьянский ответ на большой стог.',
    model: 'pitchfork',
    radius: 1.0,
    depth: 0.145,
    continuous: false,
    cooldown: 0.26,
    reach: 3.1,
    price: 420,
    autoCollect: 0.4,
    swingStyle: 'stab',
    heft: 0.5,
  },
  {
    id: 'rake',
    name: 'Широкие грабли',
    blurb: 'Загребают широкой дугой: мельче, зато вдвое шире.',
    model: 'rake',
    radius: 1.55,
    depth: 0.109,
    continuous: false,
    cooldown: 0.28,
    reach: 3.5,
    price: 4500,
    autoCollect: 1.0,
    swingStyle: 'sweep',
    heft: 0.6,
  },
  {
    id: 'dynamite',
    name: 'Динамит',
    blurb: 'Одна огромная воронка — и долгое ожидание следующей шашки.',
    model: 'hay_hook',
    radius: 3.0,
    depth: 0.6,
    continuous: false,
    cooldown: 4.0,
    reach: 13,
    price: 22000,
    autoCollect: 3.5,
    swingStyle: 'throw',
    heft: 1,
  },
  {
    id: 'blower',
    name: 'Воздуходувка',
    blurb: 'Зажми кнопку — и сено просто уходит.',
    model: 'leaf_blower',
    radius: 1.5,
    depth: 0.666,
    continuous: true,
    cooldown: 0.0,
    reach: 4.0,
    price: 60000,
    autoCollect: 1.7,
    swingStyle: 'stream',
    heft: 0.45,
  },
  {
    id: 'vacuum',
    name: 'Сеновсос',
    blurb: 'Промышленная тяга и ранец под стать.',
    model: 'hay_vacuum',
    radius: 2.1,
    depth: 0.577,
    continuous: true,
    cooldown: 0.0,
    reach: 4.6,
    price: 400000,
    autoCollect: 3.2,
    swingStyle: 'stream',
    heft: 0.55,
  },
  {
    id: 'compressor',
    name: 'Прессователь стогов',
    blurb: 'Съедает стог так же, как комбайн съедает поле.',
    model: 'compressor',
    radius: 3.0,
    depth: 0.481,
    continuous: true,
    cooldown: 0.0,
    reach: 5.4,
    price: 3000000,
    autoCollect: 5.0,
    swingStyle: 'stream',
    heft: 0.75,
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
  /** How many straws the full stack contains. Sets density, not volume. */
  straws: number;
  /** Cash per straw sold here, before Haggle and perks. */
  strawValue: number;
  /** Gems paid for finding the needle here. */
  needleGems: number;
  /** Extra gems for clearing every last straw. */
  clearGems: number;
  /** Buried oddities placed in the stack. */
  treasures: number;
  /**
   * Where the needle sits, as the fraction of the stack that must be cleared
   * before it surfaces. Sampled uniformly between these bounds and then placed
   * exactly, rather than left to emerge from a random burial depth - see
   * `BuriedField.placeNeedle` for why that distinction matters.
   */
  needleQuantile: [number, number];
  /** Gems to unlock this stack early instead of completing the previous one. */
  gemKey: number;
  /**
   * The tool the player arrives with.
   *
   * Each stack is bigger than the last, and a run is meant to take about the
   * same eight minutes on every one of them, so the starting tool scales with
   * the pile. It also reads correctly: you have done this before, and you
   * brought the right kit this time.
   */
  startingTool: ToolId;
  mood: 'noon' | 'golden' | 'overcast' | 'storm' | 'night' | 'dawn';
  scene: 'yard' | 'loft' | 'field' | 'silo' | 'meadow' | 'canyon';
}

export const TIERS: readonly TierDefinition[] = [
  {
    id: 'home',
    name: 'Домашний стог',
    tagline: 'Дед божился, что обронил её прямо тут.',
    radius: 4.6,
    peak: 2.5,
    straws: 12000,
    strawValue: 1,
    needleGems: 20,
    clearGems: 12,
    treasures: 3,
    needleQuantile: [0.2, 0.62],
    gemKey: 0,
    startingTool: 'hands',
    mood: 'noon',
    scene: 'yard',
  },
  {
    id: 'loft',
    name: 'Сеновал',
    tagline: 'Сорок лет сена — и что-то металлическое внутри.',
    radius: 5.0,
    peak: 2.7,
    straws: 33000,
    strawValue: 2.6,
    needleGems: 32,
    clearGems: 18,
    treasures: 4,
    needleQuantile: [0.24, 0.68],
    gemKey: 45,
    startingTool: 'hands',
    mood: 'overcast',
    scene: 'loft',
  },
  {
    id: 'field',
    name: 'Закатное поле',
    tagline: 'Весь урожай в одной огромной куче.',
    radius: 6.0,
    peak: 3.2,
    straws: 95000,
    strawValue: 8,
    needleGems: 48,
    clearGems: 26,
    treasures: 5,
    needleQuantile: [0.26, 0.72],
    gemKey: 90,
    startingTool: 'pitchfork',
    mood: 'golden',
    scene: 'field',
  },
  {
    id: 'silo',
    name: 'Грозовой силос',
    tagline: 'Набили перед грозой и так и не разобрали.',
    radius: 7.2,
    peak: 3.8,
    straws: 260000,
    strawValue: 26,
    needleGems: 70,
    clearGems: 38,
    treasures: 6,
    needleQuantile: [0.28, 0.74],
    gemKey: 160,
    startingTool: 'rake',
    mood: 'storm',
    scene: 'silo',
  },
  {
    id: 'meadow',
    name: 'Лунный луг',
    tagline: 'Что-то там внизу ловит лунный свет.',
    radius: 8.5,
    peak: 4.4,
    straws: 550000,
    strawValue: 85,
    needleGems: 100,
    clearGems: 55,
    treasures: 8,
    needleQuantile: [0.3, 0.76],
    gemKey: 260,
    startingTool: 'blower',
    mood: 'night',
    scene: 'meadow',
  },
  {
    id: 'motherlode',
    name: 'Золотая жила',
    tagline: 'Миллион соломин. Одна иголка. Удачи.',
    radius: 10.0,
    peak: 5.2,
    straws: 1000000,
    strawValue: 260,
    needleGems: 150,
    clearGems: 85,
    treasures: 10,
    needleQuantile: [0.32, 0.8],
    gemKey: 420,
    startingTool: 'vacuum',
    mood: 'dawn',
    scene: 'canyon',
  },
] as const;

export const TIER_BY_ID: Readonly<Record<string, TierDefinition>> = Object.fromEntries(
  TIERS.map((tier) => [tier.id, tier]),
);

/** Gems paid for time spent, settled at the end of a run. */
export const GEMS_PER_MINUTE = 0.6;

/** Straw count of the first stack; every self-similar scale is relative to it. */
export const BASE_STACK_STRAWS = TIERS[0].straws;

/** How much bigger this tier's bag is than the Home Stack's. */
export function bagScaleFor(tier: TierDefinition): number {
  return tier.straws / BASE_STACK_STRAWS;
}

/**
 * How much more expensive this tier's shop is than the Home Stack's.
 *
 * Pegged to the whole stack's cash value, which is what actually flows through
 * the player's hands in a run. Peg it to the straw price alone and a Mother
 * Lode bagful - eighty-three times bigger *and* worth two hundred and sixty
 * times more per straw - buys out the entire tree from the first sale.
 */
export function costScaleFor(tier: TierDefinition): number {
  return (tier.straws * tier.strawValue) / (BASE_STACK_STRAWS * TIERS[0].strawValue);
}

// ------------------------------------------------------------ golden straw

/**
 * Rare glinting bundles mixed into every pile.
 *
 * They pay several times over, so the player's attention has a reason to travel
 * across the whole stack rather than glazing over at one dig face.
 */
export const GOLDEN_STRAW = {
  /** Chance that any given pull turns up a golden bundle. */
  chance: 0.045,
  /** Cash multiplier on the straws in that pull. */
  payout: 8,
  /** Extra straws granted on top. */
  bonusStraws: 6,
} as const;

// --------------------------------------------------------------- treasures

export type TreasureRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export interface TreasureDefinition {
  id: string;
  name: string;
  model: string;
  rarity: TreasureRarity;
  weight: number;
  /**
   * Cash paid on discovery, as a share of the whole stack's nominal value.
   * Expressing it relatively means a treasure is worth roughly the same number
   * of seconds saved on every tier.
   */
  cashShare: number;
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
    name: 'Старая монетка',
    model: 'coin',
    rarity: 'common',
    weight: 3,
    cashShare: 0.012,
    gems: 0,
    flavour: 'Под слоем пыли всё ещё блестит.',
  },
  {
    id: 'horseshoe',
    name: 'Счастливая подкова',
    model: 'horseshoe',
    rarity: 'common',
    weight: 2,
    cashShare: 0.018,
    gems: 0,
    flavour: 'Вешать рогами вверх, иначе удача вытечет.',
  },
  {
    id: 'arrowhead',
    name: 'Кремнёвый наконечник',
    model: 'arrowhead',
    rarity: 'uncommon',
    weight: 2,
    cashShare: 0.035,
    gems: 1,
    flavour: 'Старше амбара. Старше самой фермы.',
  },
  {
    id: 'key',
    name: 'Латунный ключ',
    model: 'key',
    rarity: 'uncommon',
    weight: 2,
    cashShare: 0.042,
    gems: 1,
    flavour: 'Что-то открывает. Никто уже не помнит что.',
  },
  {
    id: 'bone',
    name: 'Огромная кость',
    model: 'bone',
    rarity: 'rare',
    weight: 2,
    cashShare: 0.075,
    gems: 2,
    flavour: 'Слишком велика для любой здешней коровы.',
  },
  {
    id: 'pocket_watch',
    name: 'Карманные часы',
    model: 'pocket_watch',
    rarity: 'rare',
    weight: 2,
    cashShare: 0.085,
    gems: 3,
    flavour: 'Стоят на 4:07. Никто не знает, дня или ночи.',
  },
  {
    id: 'ring',
    name: 'Обручальное кольцо',
    model: 'ring',
    rarity: 'epic',
    weight: 2,
    cashShare: 0.16,
    gems: 6,
    flavour: 'Из-за него неделю плакали в 1953-м.',
  },
  {
    id: 'gnome',
    name: 'Садовый гном',
    model: 'gnome',
    rarity: 'epic',
    weight: 1.5,
    cashShare: 0.18,
    gems: 7,
    flavour: 'Он там уже давно. Выглядит вполне довольным.',
  },
  {
    id: 'chest',
    name: 'Закопанный сундук',
    model: 'chest',
    rarity: 'legendary',
    weight: 1.5,
    cashShare: 0.45,
    gems: 18,
    flavour: 'Тяжелее, чем имеет право быть.',
  },
  {
    id: 'ufo',
    name: 'Летающая тарелка',
    model: 'ufo',
    rarity: 'legendary',
    weight: 1,
    cashShare: 0.5,
    gems: 24,
    flavour: 'Так вот кто примял всю кукурузу.',
  },
  {
    id: 'needle_golden',
    name: 'Золотая иголка',
    model: 'needle_golden',
    rarity: 'legendary',
    weight: 0.6,
    cashShare: 0.6,
    gems: 40,
    flavour: 'Та самая иголка за иголкой.',
  },
] as const;

export const TREASURE_BY_ID: Readonly<Record<string, TreasureDefinition>> = Object.fromEntries(
  TREASURES.map((treasure) => [treasure.id, treasure]),
);

// ------------------------------------------------------------------ perks

export type PerkId =
  | 'strong_arms'
  | 'deep_pockets'
  | 'gilded_touch'
  | 'swift_boots'
  | 'prospector'
  | 'head_start'
  | 'hunch';

export interface PerkDefinition {
  id: PerkId;
  name: string;
  blurb: string;
  icon: string;
  gemCost: number;
  /** Gem cost grows by this factor per level. */
  costGrowth: number;
  maxLevel: number;
  /** Effect strength per level; the meaning is perk-specific. */
  perLevel: number;
}

/**
 * Permanent upgrades, bought with gems, that survive every run.
 *
 * These are the whole meta-game, so they are deliberately broad and gentle: a
 * few per cent each, never a mechanic the run does not already have. A perk
 * that changed how the game plays would make the first run a worse game than
 * the tenth, which is the wrong way round.
 */
export const PERKS: readonly PerkDefinition[] = [
  {
    id: 'strong_arms',
    name: 'Крепкие руки',
    blurb: '+7% сена за рывок. В каждом заходе, навсегда.',
    icon: '💪',
    gemCost: 20,
    costGrowth: 1.5,
    maxLevel: 8,
    perLevel: 0.07,
  },
  {
    id: 'deep_pockets',
    name: 'Глубокие карманы',
    blurb: '+12% к мешку. В каждом заходе, навсегда.',
    icon: '👝',
    gemCost: 18,
    costGrowth: 1.5,
    maxLevel: 8,
    perLevel: 0.12,
  },
  {
    id: 'gilded_touch',
    name: 'Золотые руки',
    blurb: '+9% денег с каждой продажи. Навсегда.',
    icon: '🪙',
    gemCost: 24,
    costGrowth: 1.5,
    maxLevel: 8,
    perLevel: 0.09,
  },
  {
    id: 'swift_boots',
    name: 'Скороходы',
    blurb: '+5% к скорости. В каждом заходе, навсегда.',
    icon: '🥾',
    gemCost: 16,
    costGrowth: 1.5,
    maxLevel: 6,
    perLevel: 0.05,
  },
  {
    id: 'prospector',
    name: 'Старатель',
    blurb: 'Находки просвечивают сквозь сено издалека.',
    icon: '✨',
    gemCost: 26,
    costGrowth: 1.5,
    maxLevel: 5,
    perLevel: 2.2,
  },
  {
    id: 'head_start',
    name: 'Фора',
    blurb: 'Каждый заход начинается с деньгами в кармане.',
    icon: '🚀',
    gemCost: 30,
    costGrowth: 1.5,
    maxLevel: 6,
    // A share of the stack's nominal value, so it scales with the tier.
    perLevel: 0.012,
  },
  {
    id: 'hunch',
    name: 'Чутьё',
    blurb: 'Раз за заход озарение укажет в сторону иголки.',
    icon: '🔮',
    gemCost: 60,
    costGrowth: 1.5,
    maxLevel: 3,
    perLevel: 1,
  },
] as const;

export const PERK_BY_ID: Readonly<Record<PerkId, PerkDefinition>> = Object.fromEntries(
  PERKS.map((perk) => [perk.id, perk]),
) as Record<PerkId, PerkDefinition>;

export function perkCost(definition: PerkDefinition, level: number): number {
  return level >= definition.maxLevel
    ? Infinity
    : Math.ceil(definition.gemCost * Math.pow(definition.costGrowth, level));
}

/**
 * The Hunch.
 *
 * A charge points a shimmering arrow toward the needle for a few seconds. It is
 * the one thing in the game that narrows the search, so it is rationed hard:
 * one charge per level, per run, and it gives a *direction*, not a position.
 * Sweeping the stack is still the job; this only tells you which half to sweep.
 */
export const HUNCH = {
  /** Seconds the arrow stays up. */
  duration: 6,
  /** Random angular error, in degrees, so it is a hint and not a solution. */
  spreadDegrees: 26,
  /** Seconds before it can be used again, on top of the per-run charge limit. */
  cooldown: 45,
} as const;

// ----------------------------------------------------------------- quests

export type QuestKind = 'sell' | 'pull' | 'treasure' | 'clear' | 'needle' | 'golden';

export interface QuestTemplate {
  kind: QuestKind;
  name: string;
  baseTarget: number;
  gemReward: number;
  describe: (target: number) => string;
}

export const QUEST_TEMPLATES: readonly QuestTemplate[] = [
  {
    kind: 'sell',
    name: 'Базарный день',
    baseTarget: 4000,
    gemReward: 8,
    describe: (target) => `Продать ${target.toLocaleString('ru-RU')} сена`,
  },
  {
    kind: 'pull',
    name: 'Засучив рукава',
    baseTarget: 400,
    gemReward: 6,
    describe: (target) => `Сделать рывков: ${target}`,
  },
  {
    kind: 'treasure',
    name: 'Раскопки',
    baseTarget: 3,
    gemReward: 10,
    describe: (target) => `Откопать находок: ${target}`,
  },
  {
    kind: 'clear',
    name: 'Хозяйственный',
    baseTarget: 70,
    gemReward: 12,
    describe: (target) => `Разобрать ${target}% одного стога`,
  },
  {
    kind: 'needle',
    name: 'Острый глаз',
    baseTarget: 2,
    gemReward: 14,
    describe: (target) => `Найти иголок: ${target}`,
  },
  {
    kind: 'golden',
    name: 'Блеск',
    baseTarget: 25,
    gemReward: 9,
    describe: (target) => `Вытянуть золотых охапок: ${target}`,
  },
] as const;

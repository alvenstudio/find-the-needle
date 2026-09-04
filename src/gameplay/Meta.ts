import { clamp01 } from '../core/MathX';
import { Rng, hashSeed } from '../core/Rng';
import type { SaveData } from '../core/Save';
import { Signal } from '../core/Signals';
import {
  GEMS_PER_MINUTE,
  PERKS,
  PERK_BY_ID,
  QUEST_TEMPLATES,
  TIERS,
  TREASURE_BY_ID,
  perkCost,
  type PerkDefinition,
  type PerkId,
  type QuestKind,
  type TierDefinition,
} from './Content';
import type { Run } from './Run';

/**
 * Everything that survives a run.
 *
 * Gems, permanent perks, which stacks are open, the collection, the jobs board
 * and every lifetime statistic. This is the only class that writes to the save
 * file, which means there is exactly one place to look when a number is wrong
 * and one place to change when the schema moves.
 *
 * It emits signals rather than calling into the HUD, so the meta-game has no
 * idea a user interface exists.
 */

export interface PurchaseResult {
  ok: boolean;
  reason?: 'gems' | 'maxed' | 'locked';
}

export interface ActiveQuest {
  id: string;
  kind: QuestKind;
  name: string;
  description: string;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  gemReward: number;
}

export interface RunSummary {
  tier: TierDefinition;
  seconds: number;
  hayPulled: number;
  clearedFraction: number;
  foundNeedle: boolean;
  treasures: number;
  gemsFromNeedle: number;
  gemsFromClear: number;
  gemsFromTime: number;
  gemsFromTreasures: number;
  gemsTotal: number;
  newBestTime: boolean;
  unlockedTier: TierDefinition | null;
}

export interface PerkRow {
  definition: PerkDefinition;
  level: number;
  cost: number;
  affordable: boolean;
  maxed: boolean;
}

const QUEST_SLOTS = 3;

export class Meta {
  readonly gemsChanged = new Signal<number>();
  readonly perkBought = new Signal<PerkRow>();
  readonly tierUnlocked = new Signal<TierDefinition>();
  readonly questCompleted = new Signal<ActiveQuest>();
  readonly collectionGrew = new Signal<string>();
  readonly purchaseFailed = new Signal<PurchaseResult>();

  private quests: ActiveQuest[] = [];

  constructor(private readonly save: SaveData) {
    this.refreshQuests();
  }

  // -------------------------------------------------------------- currency
  get gems(): number {
    return this.save.gems;
  }

  addGems(amount: number): void {
    if (amount === 0) return;
    this.save.gems = Math.max(0, this.save.gems + amount);
    if (amount > 0) this.save.stats.gemsEarned += amount;
    this.gemsChanged.emit(this.save.gems);
  }

  // ----------------------------------------------------------------- perks
  get perks(): Readonly<Record<string, number>> {
    return this.save.perks;
  }

  perkLevel(id: PerkId): number {
    return this.save.perks[id] ?? 0;
  }

  buyPerk(id: PerkId): PurchaseResult {
    const definition = PERK_BY_ID[id];
    const level = this.perkLevel(id);
    if (level >= definition.maxLevel) return this.fail({ ok: false, reason: 'maxed' });
    const cost = perkCost(definition, level);
    if (this.save.gems < cost) return this.fail({ ok: false, reason: 'gems' });

    this.save.gems -= cost;
    this.save.perks[id] = level + 1;
    this.gemsChanged.emit(this.save.gems);
    this.perkBought.emit(this.perkRow(definition));
    return { ok: true };
  }

  perkRows(): PerkRow[] {
    return PERKS.map((definition) => this.perkRow(definition));
  }

  private perkRow(definition: PerkDefinition): PerkRow {
    const level = this.perkLevel(definition.id);
    const cost = perkCost(definition, level);
    return {
      definition,
      level,
      cost,
      affordable: Number.isFinite(cost) && this.save.gems >= cost,
      maxed: level >= definition.maxLevel,
    };
  }

  // ----------------------------------------------------------------- tiers
  get unlockedTiers(): number {
    return this.save.unlockedTiers;
  }

  isTierUnlocked(index: number): boolean {
    return index <= this.save.unlockedTiers;
  }

  tierAt(index: number): TierDefinition {
    return TIERS[Math.max(0, Math.min(index, TIERS.length - 1))];
  }

  /** Open the next stack with gems instead of by finding the previous needle. */
  buyTierKey(index: number): PurchaseResult {
    if (index <= this.save.unlockedTiers) return this.fail({ ok: false, reason: 'locked' });
    if (index > this.save.unlockedTiers + 1) return this.fail({ ok: false, reason: 'locked' });
    const tier = TIERS[index];
    if (!tier) return this.fail({ ok: false, reason: 'locked' });
    if (this.save.gems < tier.gemKey) return this.fail({ ok: false, reason: 'gems' });

    this.save.gems -= tier.gemKey;
    this.save.unlockedTiers = index;
    this.gemsChanged.emit(this.save.gems);
    this.tierUnlocked.emit(tier);
    return { ok: true };
  }

  // ------------------------------------------------------------ collection
  get collection(): readonly string[] {
    return this.save.collection;
  }

  /** Record a treasure. Returns true when it is new to the collection. */
  recordTreasure(id: string): boolean {
    this.save.stats.treasuresFound += 1;
    this.advanceQuest('treasure', 1);
    if (this.save.collection.includes(id)) return false;
    this.save.collection.push(id);
    this.collectionGrew.emit(id);
    return true;
  }

  get collectionFraction(): number {
    return clamp01(this.save.collection.length / Object.keys(TREASURE_BY_ID).length);
  }

  // ----------------------------------------------------------------- stats
  get stats(): SaveData['stats'] {
    return this.save.stats;
  }

  bestTime(tierId: string): number | null {
    return this.save.stats.bestTimes[tierId] ?? null;
  }

  bestClear(tierId: string): number {
    return this.save.stats.bestClears[tierId] ?? 0;
  }

  recordPull(straws: number, golden: boolean): void {
    this.save.stats.pulls += 1;
    this.save.stats.hayPulled += straws;
    this.advanceQuest('pull', 1);
    if (golden) {
      this.save.stats.goldenPulled += 1;
      this.advanceQuest('golden', 1);
    }
  }

  recordSale(straws: number, cash: number): void {
    this.save.stats.haySold += straws;
    this.save.stats.cashEarned += cash;
    this.advanceQuest('sell', straws);
  }

  recordClear(fraction: number, tierId: string): void {
    const best = this.save.stats.bestClears[tierId] ?? 0;
    if (fraction > best) this.save.stats.bestClears[tierId] = fraction;
    this.advanceQuest('clear', 0, Math.round(fraction * 100));
  }

  // ------------------------------------------------------------- run cycle
  /**
   * Settle a finished run.
   *
   * Gems come from four places, and each one nudges a different behaviour: the
   * needle rewards finishing, the full clear rewards thoroughness, time rewards
   * simply playing, and treasures reward looking around. A run that ends on the
   * needle at 30 % cleared and a run that clears 100 % should both feel worth
   * doing, which is why neither reward dominates.
   */
  finishRun(run: Run, foundNeedle: boolean, clearedFraction: number, treasureGems: number): RunSummary {
    // `treasureGems` is a report, not a payment: each oddity paid out when the
    // player walked into it, because a reward that arrives minutes later is not
    // a reward for the thing you just did.
    const tier = run.tier;
    const seconds = run.elapsed;

    const gemsFromNeedle = foundNeedle ? tier.needleGems : 0;
    const gemsFromClear = clearedFraction >= 0.999 ? tier.clearGems : 0;
    const gemsFromTime = Math.floor((seconds / 60) * GEMS_PER_MINUTE);
    const gemsBanked = gemsFromNeedle + gemsFromClear + gemsFromTime;
    const gemsTotal = gemsBanked + treasureGems;

    let newBestTime = false;
    if (foundNeedle) {
      this.save.stats.needlesFound += 1;
      const best = this.save.stats.bestTimes[tier.id];
      if (best === undefined || seconds < best) {
        this.save.stats.bestTimes[tier.id] = seconds;
        newBestTime = true;
      }
      this.advanceQuest('needle', 1);
    }
    this.recordClear(clearedFraction, tier.id);
    this.save.stats.runs += 1;
    this.addGems(gemsBanked);

    let unlockedTier: TierDefinition | null = null;
    const index = TIERS.findIndex((entry) => entry.id === tier.id);
    if (foundNeedle && index === this.save.unlockedTiers && index + 1 < TIERS.length) {
      this.save.unlockedTiers = index + 1;
      unlockedTier = TIERS[index + 1];
      this.tierUnlocked.emit(unlockedTier);
    }

    this.save.run = null;

    return {
      tier,
      seconds,
      hayPulled: run.hayPulled,
      clearedFraction,
      foundNeedle,
      treasures: run.claimed.filter((id) => id !== 'needle').length,
      gemsFromNeedle,
      gemsFromClear,
      gemsFromTime,
      gemsFromTreasures: treasureGems,
      gemsTotal,
      newBestTime,
      unlockedTier,
    };
  }

  /** Persist the run in progress so a reload resumes it. */
  storeRun(run: Run | null): void {
    this.save.run = run ? run.snapshot() : null;
  }

  get storedRun(): SaveData['run'] {
    return this.save.run;
  }

  // ---------------------------------------------------------------- quests
  get activeQuests(): readonly ActiveQuest[] {
    return this.quests;
  }

  /**
   * Roll today's jobs.
   *
   * Seeded from the calendar day, so the board is stable across a session and a
   * reload, and everyone playing on the same day gets the same three.
   */
  refreshQuests(now = new Date()): void {
    const day = now.toISOString().slice(0, 10);
    if (this.save.questDay === day && this.save.quests.length > 0) {
      this.quests = this.save.quests
        .map((stored) => this.hydrateQuest(stored.id, stored))
        .filter((quest): quest is ActiveQuest => quest !== null);
      if (this.quests.length > 0) return;
    }

    const rng = new Rng(hashSeed(day));
    const pool = [...QUEST_TEMPLATES];
    rng.shuffle(pool);
    this.quests = pool.slice(0, QUEST_SLOTS).map((template) => ({
      id: `${day}:${template.kind}`,
      kind: template.kind,
      name: template.name,
      description: template.describe(template.baseTarget),
      target: template.baseTarget,
      progress: 0,
      completed: false,
      claimed: false,
      gemReward: template.gemReward,
    }));
    this.save.questDay = day;
    this.persistQuests();
  }

  private hydrateQuest(
    id: string,
    stored: { progress: number; completed: boolean; claimed: boolean },
  ): ActiveQuest | null {
    const kind = id.split(':')[1] as QuestKind;
    const template = QUEST_TEMPLATES.find((entry) => entry.kind === kind);
    if (!template) return null;
    return {
      id,
      kind: template.kind,
      name: template.name,
      description: template.describe(template.baseTarget),
      target: template.baseTarget,
      progress: stored.progress,
      completed: stored.completed,
      claimed: stored.claimed,
      gemReward: template.gemReward,
    };
  }

  /** Add to any matching quest. `absolute` sets a high-water mark instead. */
  private advanceQuest(kind: QuestKind, delta: number, absolute?: number): void {
    let changed = false;
    for (const quest of this.quests) {
      if (quest.kind !== kind || quest.completed) continue;
      quest.progress = absolute !== undefined ? Math.max(quest.progress, absolute) : quest.progress + delta;
      changed = true;
      if (quest.progress >= quest.target) {
        quest.completed = true;
        quest.progress = quest.target;
        this.questCompleted.emit(quest);
      }
    }
    if (changed) this.persistQuests();
  }

  claimQuest(id: string): PurchaseResult {
    const quest = this.quests.find((entry) => entry.id === id);
    if (!quest || !quest.completed || quest.claimed) return this.fail({ ok: false, reason: 'locked' });
    quest.claimed = true;
    this.addGems(quest.gemReward);
    this.persistQuests();
    return { ok: true };
  }

  get claimableQuests(): number {
    return this.quests.filter((quest) => quest.completed && !quest.claimed).length;
  }

  private persistQuests(): void {
    this.save.quests = this.quests.map((quest) => ({
      id: quest.id,
      progress: quest.progress,
      completed: quest.completed,
      claimed: quest.claimed,
    }));
  }

  private fail(result: PurchaseResult): PurchaseResult {
    this.purchaseFailed.emit(result);
    return result;
  }
}

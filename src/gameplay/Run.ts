import type { RunSnapshot } from '../core/Save';
import { Rng, hashSeed } from '../core/Rng';
import { Signal } from '../core/Signals';
import {
  GOLDEN_STRAW,
  HUNCH,
  PERK_BY_ID,
  TOOLS,
  TOOL_BY_ID,
  UPGRADES,
  UPGRADE_BY_ID,
  bagScaleFor,
  costScaleFor,
  upgradeCost,
  upgradeValue,
  type TierDefinition,
  type ToolDefinition,
  type ToolId,
  type UpgradeDefinition,
  type UpgradeId,
} from './Content';
import { deriveStats, type DerivedStats } from './Stats';

/**
 * One haystack, start to finish.
 *
 * Everything in here dies when the needle turns up: cash, upgrade levels, the
 * tools you bought, the crater you dug. That is the point - it is what lets the
 * shop stay interesting for the whole life of the game instead of being fully
 * bought out in the first evening.
 *
 * The run owns its own random stream, seeded from the stack, so the needle, the
 * treasures and the golden bundles are all reproducible: reload mid-run and the
 * stack you come back to is the stack you left.
 */

export interface PurchaseResult {
  ok: boolean;
  reason?: 'cash' | 'maxed' | 'owned';
}

export interface SaleResult {
  straws: number;
  cash: number;
  /** True when the load contained a golden bundle. */
  golden: boolean;
}

export interface UpgradeRow {
  definition: UpgradeDefinition;
  level: number;
  cost: number;
  value: number;
  next: number;
  affordable: boolean;
  maxed: boolean;
}

export interface ToolRow {
  definition: ToolDefinition;
  owned: boolean;
  equipped: boolean;
  affordable: boolean;
}

export class Run {
  readonly cashChanged = new Signal<number>();
  readonly upgraded = new Signal<UpgradeRow>();
  readonly toolChanged = new Signal<ToolDefinition>();
  readonly purchaseFailed = new Signal<PurchaseResult>();
  readonly hunchUsed = new Signal<number>();

  readonly tier: TierDefinition;
  readonly seed: number;

  cash = 0;
  carried = 0;
  elapsed = 0;
  pulls = 0;
  hayPulled = 0;
  goldenPulled = 0;
  /** Cubic metres removed, mirrored from the pile so the save can restore it. */
  removedVolume = 0;
  claimed: string[] = [];

  private readonly upgrades: Record<string, number> = {};
  private readonly tools = new Set<ToolId>();
  private activeToolId: ToolId;
  private hunchesUsed = 0;
  private hunchCooldown = 0;

  private readonly rng: Rng;
  private statsCache: DerivedStats | null = null;

  constructor(
    tier: TierDefinition,
    seed: number,
    private readonly perks: Readonly<Record<string, number>>,
  ) {
    this.tier = tier;
    this.seed = seed;
    this.rng = new Rng(seed ^ 0x51ed270b);
    this.activeToolId = tier.startingTool;
    // Everything up to and including the starting tool comes for free; the
    // shop only ever offers the player something better than what they have.
    for (const tool of TOOLS) {
      this.tools.add(tool.id);
      if (tool.id === tier.startingTool) break;
    }

    // Head Start converts gems already spent into a running start, expressed as
    // a share of the stack's nominal value so it is worth the same on any tier.
    const headStart = PERK_BY_ID.head_start.perLevel * (perks.head_start ?? 0);
    if (headStart > 0) {
      this.cash = Math.round(tier.straws * tier.strawValue * headStart);
    }
  }

  // ---------------------------------------------------------------- stats
  /**
   * Derived stats, recomputed only when something that feeds them changes.
   *
   * `deriveStats` walks every upgrade and perk and is read from the dig system
   * every fixed step; caching turns that into a pointer read.
   */
  get stats(): DerivedStats {
    if (!this.statsCache) {
      this.statsCache = deriveStats({
        upgrades: this.upgrades,
        perks: this.perks,
        activeTool: this.activeToolId,
        bagScale: bagScaleFor(this.tier),
      });
    }
    return this.statsCache;
  }

  private invalidate(): void {
    this.statsCache = null;
  }

  /** Straws per cubic metre for this stack, derived rather than assumed. */
  density(originalVolume: number): number {
    return originalVolume <= 0 ? 0 : this.tier.straws / originalVolume;
  }

  // --------------------------------------------------------------- economy
  addCash(amount: number): void {
    if (amount === 0) return;
    this.cash = Math.max(0, this.cash + amount);
    this.cashChanged.emit(this.cash);
  }

  /**
   * Sell the load.
   *
   * The tier's straw value scales the payout by orders of magnitude; the
   * player's multipliers ride on top. Keeping those two factors separate means
   * a tier can be retuned without touching a single upgrade.
   */
  sell(): SaleResult {
    const straws = this.carried;
    if (straws <= 0) return { straws: 0, cash: 0, golden: false };
    this.carried = 0;
    const cash = Math.floor(straws * this.tier.strawValue * this.stats.sellMultiplier);
    this.addCash(cash);
    return { straws, cash, golden: false };
  }

  /**
   * Register a pull.
   *
   * Golden bundles are rolled here rather than pre-placed in the pile: a
   * pre-placed bundle would be invisible until it happened to be dug up, and
   * the whole point of the mechanic is the surprise at the moment of the pull.
   */
  registerPull(straws: number): { straws: number; golden: boolean } {
    this.pulls += 1;
    let total = straws;
    const golden = this.rng.next() < GOLDEN_STRAW.chance;
    if (golden) {
      total = straws * GOLDEN_STRAW.payout + GOLDEN_STRAW.bonusStraws;
      this.goldenPulled += 1;
    }
    this.hayPulled += total;
    return { straws: total, golden };
  }

  /** Add to the bag, returning how much actually fitted. */
  carry(straws: number): number {
    const room = Math.max(0, this.stats.capacity - this.carried);
    const taken = Math.min(straws, room);
    this.carried += taken;
    return taken;
  }

  get bagFraction(): number {
    const capacity = this.stats.capacity;
    return capacity <= 0 ? 0 : Math.min(1, this.carried / capacity);
  }

  get bagFull(): boolean {
    return this.carried >= this.stats.capacity - 1e-6;
  }

  // -------------------------------------------------------------- upgrades
  levelOf(id: UpgradeId): number {
    return this.upgrades[id] ?? 0;
  }

  /** Everything in the shop is priced relative to what this stack is worth. */
  get costScale(): number {
    return costScaleFor(this.tier);
  }

  costOf(id: UpgradeId): number {
    return upgradeCost(UPGRADE_BY_ID[id], this.levelOf(id), this.costScale);
  }

  toolPrice(id: ToolId): number {
    return Math.ceil(TOOL_BY_ID[id].price * this.costScale);
  }

  buyUpgrade(id: UpgradeId): PurchaseResult {
    const definition = UPGRADE_BY_ID[id];
    const level = this.levelOf(id);
    if (level >= definition.maxLevel) return this.fail({ ok: false, reason: 'maxed' });
    const cost = upgradeCost(definition, level, this.costScale);
    if (this.cash < cost) return this.fail({ ok: false, reason: 'cash' });

    this.cash -= cost;
    this.upgrades[id] = level + 1;
    this.invalidate();
    this.cashChanged.emit(this.cash);
    this.upgraded.emit(this.upgradeRow(definition));
    return { ok: true };
  }

  /** Buy as many levels as the player can afford, for the shop's Max button. */
  buyUpgradeMax(id: UpgradeId): number {
    let bought = 0;
    while (this.buyUpgrade(id).ok) bought++;
    return bought;
  }

  upgradeRows(): UpgradeRow[] {
    return UPGRADES.map((definition) => this.upgradeRow(definition));
  }

  private upgradeRow(definition: UpgradeDefinition): UpgradeRow {
    const level = this.levelOf(definition.id);
    const cost = upgradeCost(definition, level, this.costScale);
    return {
      definition,
      level,
      cost,
      value: upgradeValue(definition, level),
      next: upgradeValue(definition, level + 1),
      affordable: Number.isFinite(cost) && this.cash >= cost,
      maxed: level >= definition.maxLevel,
    };
  }

  // ----------------------------------------------------------------- tools
  get tool(): ToolDefinition {
    return TOOL_BY_ID[this.activeToolId];
  }

  owns(id: ToolId): boolean {
    return this.tools.has(id);
  }

  buyTool(id: ToolId): PurchaseResult {
    if (this.tools.has(id)) return this.fail({ ok: false, reason: 'owned' });
    const price = this.toolPrice(id);
    if (this.cash < price) return this.fail({ ok: false, reason: 'cash' });
    this.cash -= price;
    this.tools.add(id);
    this.cashChanged.emit(this.cash);
    this.equip(id);
    return { ok: true };
  }

  equip(id: ToolId): PurchaseResult {
    if (!this.tools.has(id)) return this.fail({ ok: false, reason: 'owned' });
    if (this.activeToolId === id) return { ok: true };
    this.activeToolId = id;
    this.invalidate();
    this.toolChanged.emit(TOOL_BY_ID[id]);
    return { ok: true };
  }

  /** Cycle to the next owned tool, for the wheel and the Q/R keys. */
  cycleTool(direction: number): void {
    const owned = TOOLS.filter((tool) => this.tools.has(tool.id));
    if (owned.length <= 1) return;
    const index = owned.findIndex((tool) => tool.id === this.activeToolId);
    const next = (index + direction + owned.length) % owned.length;
    this.equip(owned[next].id);
  }

  toolRows(): ToolRow[] {
    return TOOLS.map((definition) => ({
      definition,
      owned: this.tools.has(definition.id),
      equipped: this.activeToolId === definition.id,
      affordable: this.cash >= this.toolPrice(definition.id),
    }));
  }

  // ----------------------------------------------------------------- hunch
  get hunchesLeft(): number {
    return Math.max(0, this.stats.hunchCharges - this.hunchesUsed);
  }

  get hunchReady(): boolean {
    return this.hunchesLeft > 0 && this.hunchCooldown <= 0;
  }

  get hunchCooldownRemaining(): number {
    return this.hunchCooldown;
  }

  useHunch(): boolean {
    if (!this.hunchReady) return false;
    this.hunchesUsed += 1;
    this.hunchCooldown = HUNCH.cooldown;
    this.hunchUsed.emit(this.hunchesLeft);
    return true;
  }

  // ------------------------------------------------------------------ tick
  update(dt: number): void {
    this.elapsed += dt;
    if (this.hunchCooldown > 0) this.hunchCooldown = Math.max(0, this.hunchCooldown - dt);
  }

  // ------------------------------------------------------------ persistence
  snapshot(): RunSnapshot {
    return {
      tierId: this.tier.id,
      seed: this.seed,
      elapsed: this.elapsed,
      cash: this.cash,
      upgrades: { ...this.upgrades },
      tools: [...this.tools],
      activeTool: this.activeToolId,
      removedVolume: this.removedVolume,
      claimed: [...this.claimed],
      carried: this.carried,
      hayPulled: this.hayPulled,
      goldenPulled: this.goldenPulled,
      pulls: this.pulls,
      hunchesUsed: this.hunchesUsed,
    };
  }

  restore(snapshot: RunSnapshot): void {
    this.cash = snapshot.cash;
    this.elapsed = snapshot.elapsed;
    this.carried = snapshot.carried;
    this.hayPulled = snapshot.hayPulled;
    this.goldenPulled = snapshot.goldenPulled;
    this.pulls = snapshot.pulls;
    this.removedVolume = snapshot.removedVolume;
    this.claimed = [...snapshot.claimed];
    this.hunchesUsed = snapshot.hunchesUsed;
    for (const [id, level] of Object.entries(snapshot.upgrades)) this.upgrades[id] = level;
    this.tools.clear();
    for (const id of snapshot.tools) this.tools.add(id as ToolId);
    this.tools.add(this.tier.startingTool);
    this.activeToolId = (snapshot.activeTool as ToolId) in TOOL_BY_ID ? (snapshot.activeTool as ToolId) : 'hands';
    this.invalidate();
  }

  private fail(result: PurchaseResult): PurchaseResult {
    this.purchaseFailed.emit(result);
    return result;
  }
}

/** A fresh seed for a stack, mixing the tier, the clock and the run count. */
export function makeRunSeed(tierId: string, runCount: number, now: number): number {
  return hashSeed(`${tierId}:${runCount}:${now}`);
}

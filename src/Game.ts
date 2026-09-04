import { Vector3 } from 'three';

import { Assets } from './core/Assets';
import { Engine, type QualityTier } from './core/Engine';
import { Input } from './core/Input';
import { MaterialLibrary } from './core/Materials';
import { clamp01, formatShort, lerp } from './core/MathX';
import { Rng, hashSeed } from './core/Rng';
import { SaveManager } from './core/Save';
import { AudioSystem } from './audio/Audio';
import { Particles } from './fx/Particles';
import { FlashLayer, ScreenEffects } from './fx/ScreenEffects';
import { BuriedField } from './gameplay/Buried';
import {
  GOLDEN_STRAW,
  HUNCH,
  RARITY_COLORS,
  TIERS,
  TOOL_BY_ID,
  type PerkId,
  type TierDefinition,
  type ToolId,
  type UpgradeId,
} from './gameplay/Content';
import { DigSystem } from './gameplay/DigSystem';
import { InteractionSystem, type Interactable } from './gameplay/Interactables';
import { Meta, type RunSummary } from './gameplay/Meta';
import { Player } from './gameplay/Player';
import { Run, makeRunSeed } from './gameplay/Run';
import { Viewmodel } from './gameplay/Viewmodel';
import { GameUi, type CrosshairState } from './ui/GameUi';
import { CollisionWorld } from './world/Collision';
import { Environment } from './world/Environment';
import { HayPile } from './world/HayPile';
import { Livestock } from './world/Livestock';
import { CRITICAL_ASSETS, DEFERRED_ASSETS } from './world/Manifest';
import { SCENE_PALETTES, Scenery } from './world/Scenery';
import { Terrain } from './world/Terrain';

/**
 * The game.
 *
 * Owns every system and the order they run in, and does the wiring that turns
 * one system's event into another's input - a dig into particles, a sale into a
 * banner, a needle into a celebration. Nothing else in the project knows about
 * more than its immediate neighbours.
 *
 * The frame is split in two on purpose. `fixedUpdate` advances gameplay in
 * exact 1/60 s steps: movement, digging, the economy, anything a replay or a
 * save would have to reproduce. `frameUpdate` runs once per drawn frame and
 * does only presentation: interpolating the camera, animating the viewmodel,
 * pushing numbers at the HUD.
 */

type GameState = 'loading' | 'title' | 'playing' | 'paused' | 'summary';

/** Where hay flies to: a point just below the camera, at the player's chest. */
const COLLECT_OFFSET = new Vector3(0, -0.45, 0);

/** How each species behaves once it is in the yard. */
const LIVESTOCK: Record<string, { model: string; count: number; roam: number; speed: number }> = {
  cow: { model: 'cow', count: 0, roam: 3.5, speed: 0.5 },
  chicken: { model: 'chicken', count: 0, roam: 4.5, speed: 0.9 },
  cat: { model: 'cat', count: 0, roam: 3, speed: 0.7 },
  crow: { model: 'crow', count: 0, roam: 5, speed: 1.1 },
};

export class Game {
  private readonly engine: Engine;
  private readonly materials = new MaterialLibrary();
  private readonly assets: Assets;
  private readonly input: Input;
  private readonly audio = new AudioSystem();
  private readonly save = new SaveManager();
  private readonly meta: Meta;
  private readonly ui: GameUi;

  private readonly collision = new CollisionWorld();
  private readonly terrain: Terrain;
  private readonly environment: Environment;
  private readonly player: Player;
  private readonly screen = new ScreenEffects();
  private readonly flash: FlashLayer;

  private pile: HayPile | null = null;
  private buried: BuriedField | null = null;
  private scenery: Scenery | null = null;
  private livestock: Livestock | null = null;
  private interactions: InteractionSystem;
  private dig: DigSystem | null = null;
  private viewmodel: Viewmodel | null = null;
  private particles: Particles | null = null;

  private run: Run | null = null;
  private state: GameState = 'loading';

  private readonly scratch = new Vector3();
  private readonly scratchB = new Vector3();
  private readonly lookDelta = { yaw: 0, pitch: 0 };
  private readonly rng = new Rng(0x1234abcd);

  /** Seconds of continuous-tool use since the last golden-bundle roll. */
  private streamAccumulator = 0;
  /** Gems banked from treasures this run, for the summary breakdown. */
  private runTreasureGems = 0;
  /** Seconds left on the Hunch arrow. */
  private hunchTimer = 0;
  private readonly hunchDirection = new Vector3();
  private detectorTimer = 0;
  private lastBagWarning = -99;
  private elapsed = 0;
  /** True once the browser has actually granted pointer lock at least once. */
  private wasLocked = false;
  /** When the current lock was granted, for telling Escape from a browser quirk. */
  private lockedAt = 0;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    const settings = this.save.state.settings;
    const tier = settings.quality === 'auto' ? undefined : (settings.quality as QualityTier);
    this.engine = new Engine(canvas, tier);
    this.assets = new Assets(this.materials);
    this.input = new Input(canvas);
    this.meta = new Meta(this.save.state);

    this.terrain = new Terrain({ seed: 7 });
    this.engine.scene.add(this.terrain.mesh);
    this.collision.groundHeight = (x, z) => this.terrain.heightAt(x, z);

    this.environment = new Environment(this.engine);
    this.player = new Player(this.input, this.collision);
    this.interactions = new InteractionSystem(this.assets, this.terrain, this.collision);
    this.engine.scene.add(this.interactions.group);
    // The viewmodel is a child of the camera, so the camera has to be in the
    // scene graph for it to be drawn at all.
    this.engine.scene.add(this.engine.camera);

    this.flash = new FlashLayer(uiRoot);
    this.ui = new GameUi(uiRoot, {
      onStartGame: () => this.beginPlaying(),
      onResume: () => this.setPaused(false),
      onOpenSettings: () => this.ui.openSettings(this.save.state.settings),
      onBuyUpgrade: (id, max) => this.buyUpgrade(id, max),
      onBuyTool: (id) => this.buyTool(id),
      onEquipTool: (id) => this.equipTool(id),
      onBuyPerk: (id) => this.buyPerk(id),
      onClaimQuest: (id) => this.claimQuest(id),
      onPickTier: (index) => void this.travelTo(index),
      onBuyTierKey: (index) => this.buyTierKey(index),
      onReplayStack: () => void this.replayStack(),
      onSettingChanged: (key, value) => this.applySetting(key, value),
      onResetSave: () => this.resetSave(),
      onCloseModal: () => this.onModalClosed(),
      onSound: (name) => this.audio.play(name),
    });

    this.applyAllSettings();
    this.engine.fixedUpdate.on((dt) => this.fixedUpdate(dt));
    this.engine.frameUpdate.on((dt) => this.frameUpdate(dt));
    this.bindInput();
  }

  // ------------------------------------------------------------------ boot
  async boot(): Promise<void> {
    this.assets.progress.on((progress) => {
      this.ui.setLoadingProgress(progress.fraction * 0.75, 'Baling the hay…');
    });
    await this.assets.loadAll(CRITICAL_ASSETS);

    this.particles = new Particles(this.assets, {
      straw: Math.round(this.engine.settings.particleBudget * 0.7),
      spark: Math.round(this.engine.settings.particleBudget * 0.3),
    });
    this.engine.scene.add(this.particles.group);
    this.viewmodel = new Viewmodel(this.assets);
    this.viewmodel.attachTo(this.engine.camera);

    const stored = this.meta.storedRun;
    const tierIndex = stored ? Math.max(0, TIERS.findIndex((tier) => tier.id === stored.tierId)) : 0;
    this.openStack(TIERS[tierIndex], stored?.seed ?? makeRunSeed(TIERS[tierIndex].id, 0, Date.now()));
    if (stored) this.run?.restore(stored);

    this.ui.setLoadingProgress(0.8, 'Waking the cow…');
    this.engine.start();

    // The rest of the library streams in behind the title screen: the player is
    // reading a menu, which is the cheapest loading screen there is.
    void this.assets.loadAll(DEFERRED_ASSETS).then(() => {
      this.buildScenery();
      this.ui.setLoadingProgress(1, 'Ready');
    });

    this.state = 'title';
    this.ui.showTitle({
      hasRun: stored !== null,
      gems: this.meta.gems,
      needles: this.meta.stats.needlesFound,
    });
  }

  /** Movement is enabled whenever the player is in the world and unblocked. */
  private syncControl(): void {
    this.player.controlEnabled = this.state === 'playing' && !this.ui.modalOpen;
  }

  private beginPlaying(): void {
    this.state = 'playing';
    this.ui.showHud();
    this.syncControl();
    void this.audio.unlock().then(() => {
      this.audio.setAmbience(this.currentTier.mood);
      this.audio.setMusic(this.save.state.settings.musicVolume > 0);
    });
    void this.input.requestLock();
  }

  // -------------------------------------------------------------- the stack
  private get currentTier(): TierDefinition {
    return this.run?.tier ?? TIERS[0];
  }

  /**
   * Tear down the current stack and build the next one.
   *
   * A tier changes the pile's size, the scenery palette and the light, so this
   * is a full rebuild rather than a reconfiguration. It happens between runs
   * behind a fade, which is the one moment in the game where half a second of
   * work is invisible.
   */
  private openStack(tier: TierDefinition, seed: number): void {
    this.disposeStack();

    const quality = this.engine.settings;
    // Cell size is held roughly constant so a crater has the same shape on the
    // Home Stack and the Mother Lode; the grid simply gets bigger.
    const resolution = Math.min(257, Math.max(65, Math.round((tier.radius * 2) / 0.13) | 1));
    this.pile = new HayPile(this.assets, {
      radius: tier.radius,
      peak: tier.peak,
      resolution,
      seed,
      shellBudget: quality.shellBudget,
      bandBudget: quality.bandBudget,
      bandRadius: 6.5,
      position: new Vector3(0, 0, 0),
    });
    this.engine.scene.add(this.pile.group);
    // The pile is walkable: standing on it is how the player reaches the crown.
    this.collision.addElevator((x, z) => this.pile?.surfaceHeightAt(x, z) ?? 0);

    this.run = new Run(tier, seed, this.meta.perks);
    this.dig = new DigSystem(this.pile);
    this.dig.density = this.run.density(this.pile.field.originalVolume);
    this.bindRun(this.run, this.dig);

    this.buried = new BuriedField(this.assets, this.pile, tier, seed, this.run.stats.luck, []);
    this.engine.scene.add(this.buried.group);
    this.bindBuried(this.buried);

    this.environment.setMood(tier.mood);
    this.buildScenery();

    // Arrive on the spawn pad, which sits just behind the cow, and look across
    // the yard at the stack. Landing next to the sell point keeps the first
    // fill-and-sell loop short, which is the loop that has to teach itself.
    const spawn = this.spawnPoint();
    this.player.teleport(spawn.x, spawn.z, Math.atan2(spawn.x, spawn.z));
    this.viewmodel?.setTool(this.run.tool.model);
    this.streamAccumulator = 0;
    this.hunchTimer = 0;
    this.runTreasureGems = 0;
  }

  /**
   * Where a run starts: on the pad, on the far side of the sell point.
   *
   * Mirrors the angle `InteractionSystem` uses for the spawn pad, so the two
   * cannot drift apart.
   */
  private spawnPoint(): { x: number; z: number } {
    const ring = this.currentTier.radius + 7.5;
    const angle = Math.PI * 1.5;
    const distance = ring + 5.5;
    return { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance };
  }

  private buildScenery(): void {
    if (!this.pile) return;
    this.scenery?.dispose();
    this.livestock?.dispose();
    const tier = this.currentTier;
    this.scenery = new Scenery(this.assets, this.terrain, this.collision, {
      seed: hashSeed(tier.id),
      scene: tier.scene,
      pileRadius: tier.radius,
      ringMargin: 7.5,
      scatterRadius: this.engine.settings.scatterDistance,
    });
    this.engine.scene.add(this.scenery.group);

    this.interactions.build(this.scenery.ringRadius, {
      rebirthUnlocked: true,
      hasNextTier: true,
    });
    this.populate(tier);
    this.terrain.refreshColors();
  }

  /**
   * Put animals in the yard, and a cow at the trough.
   *
   * The cow is the whole fiction of the sell point - you are feeding it, and it
   * pays you - so it is placed by hand beside the trough and turned to face
   * whoever walks up, while the rest of the livestock wanders the ring.
   */
  private populate(tier: TierDefinition): void {
    if (!this.scenery) return;
    const livestock = new Livestock(this.assets, this.terrain, hashSeed(`${tier.id}:stock`));
    this.engine.scene.add(livestock.group);
    this.livestock = livestock;

    const sell = this.interactions.positionOf('sell');
    if (sell) {
      // Just behind the trough, on the far side from the player's approach.
      const outward = Math.hypot(sell.x, sell.z) || 1;
      const cowX = sell.x + (sell.x / outward) * 1.9;
      const cowZ = sell.z + (sell.z / outward) * 1.9;
      const cow = livestock.add(
        { model: 'cow', count: 1, roam: 0, speed: 0 },
        cowX,
        cowZ,
        0,
      );
      if (cow) livestock.faceToward(cow, sell.x, sell.z);
    }

    const palette = SCENE_PALETTES[tier.scene];
    const inner = tier.radius + 4;
    const outer = this.scenery.ringRadius + 9;
    for (const entry of palette.animals) {
      const spec = LIVESTOCK[entry.model];
      if (!spec) continue;
      livestock.scatter({ ...spec, count: entry.count }, inner, outer);
    }
  }

  private disposeStack(): void {
    if (this.pile) {
      this.engine.scene.remove(this.pile.group);
      this.pile.dispose();
      this.pile = null;
    }
    if (this.buried) {
      this.engine.scene.remove(this.buried.group);
      this.buried.dispose();
      this.buried = null;
    }
    this.dig = null;
    this.particles?.clear();
    // Colliders are rebuilt with the scenery; the elevator list goes with them.
    this.collision.clear();
  }

  // ------------------------------------------------------------------ wiring
  private bindRun(run: Run, dig: DigSystem): void {
    run.cashChanged.on((cash) => this.ui.setCash(cash));
    run.toolChanged.on((tool) => {
      this.viewmodel?.setTool(tool.model);
      this.audio.play('ui_click');
    });
    run.purchaseFailed.on(() => {
      this.audio.play('denied');
      this.screen.shake(0.05, 8);
    });

    dig.swingStarted.on(() => {
      const tool = run.tool;
      this.viewmodel?.swing(tool.swingStyle, Math.max(dig.cooldownRemaining, 0.18));
      this.screen.kick(-0.02 * tool.heft, 0, 0.01 * tool.heft);
    });

    dig.dug.on((event) => {
      const tool = run.tool;
      this.pile?.drainDislodged();

      // Continuous tools have no discrete pull, so a bundle is rolled on a
      // timer instead - otherwise a blower would roll sixty times a second.
      let straws = event.collected;
      let golden = false;
      if (event.discrete) {
        const pull = run.registerPull(event.collected);
        straws = run.carry(pull.straws);
        golden = pull.golden;
        this.meta.recordPull(pull.straws, pull.golden);
      } else {
        this.streamAccumulator += 1 / 60;
        straws = run.carry(event.collected);
        if (this.streamAccumulator >= 0.25) {
          this.streamAccumulator = 0;
          if (this.rng.next() < GOLDEN_STRAW.chance) {
            golden = true;
            const bonus = event.collected * (GOLDEN_STRAW.payout - 1) + GOLDEN_STRAW.bonusStraws;
            straws += run.carry(bonus);
            run.goldenPulled += 1;
            this.meta.recordPull(bonus, true);
          }
        }
      }

      if (this.particles) {
        this.pile?.field.normalAt(
          event.point.x - (this.pile?.group.position.x ?? 0),
          event.point.z - (this.pile?.group.position.z ?? 0),
          this.scratch,
        );
        const count = event.discrete ? (golden ? 16 : 9) : 2;
        this.particles.burst(event.point, this.scratch, count, event.power);
        this.particles.collect(event.point, event.discrete ? 7 : 2);
        if (golden) this.particles.sparkle(event.point, 14, '#ffd75e', 3.6);
      }

      if (event.discrete) {
        this.audio.play(tool.heft > 0.4 ? 'dig_hard' : 'dig_soft', {
          position: event.point,
          detune: 2,
          volume: 0.55 + tool.heft * 0.4,
        });
        this.screen.shake(0.03 + tool.heft * 0.07, 9);
        if (tool.heft >= 1) this.screen.freeze(0.05);
        this.showWorldPopup(event.point, golden ? `GOLDEN +${formatShort(straws)}` : `+${formatShort(straws)}`, golden ? 'gem' : 'hay');
      }
      if (golden) this.audio.play('coin', { position: event.point, volume: 0.8 });
    });

    dig.backpackFull.on(() => {
      // One nag per trip, not one per pull: the player is already being told by
      // a full red meter, and a stack of identical toasts is just noise.
      if (this.elapsed - this.lastBagWarning < 6) return;
      this.lastBagWarning = this.elapsed;
      this.ui.toast('Bag full — take it to the cow', 'bad', '🎒');
      this.audio.play('denied', { volume: 0.5 });
    });

    dig.pileCleared.on(() => {
      this.buried?.collectAllExposed();
      this.ui.toast('Stack cleared!', 'good', '🌾');
      if (this.pile) this.particles?.ring(this.pile.group.position, this.currentTier.radius, 48, '#ffe08a');
    });
  }

  private bindBuried(buried: BuriedField): void {
    buried.revealed.on(({ item, worldPosition }) => {
      const colour = item.kind === 'needle' ? '#ffffff' : RARITY_COLORS[item.definition?.rarity ?? 'common'];
      this.particles?.sparkle(worldPosition, item.kind === 'needle' ? 40 : 22, colour, 4);
      this.audio.play(item.kind === 'needle' ? 'needle_found' : 'treasure', { position: worldPosition });
      if (item.kind === 'needle') {
        this.screen.punchFov(-7);
        this.flash.flash('#fff6d8', 0.55, 1.6);
      }
    });

    buried.collected.on(({ item, worldPosition }) => {
      if (!this.run) return;
      if (item.kind === 'needle') {
        this.finishRun(true);
        return;
      }
      const definition = item.definition;
      if (!definition) return;
      const cash = Math.round(this.currentTier.straws * this.currentTier.strawValue * definition.cashShare);
      this.run.addCash(cash);
      this.meta.recordTreasure(definition.id);
      this.meta.addGems(definition.gems);
      this.runTreasureGems += definition.gems;
      this.particles?.sparkle(worldPosition, 26, RARITY_COLORS[definition.rarity], 3);
      this.ui.toast(`${definition.name} — ${definition.flavour}`, 'good', '✨');
      this.ui.banner(`${definition.name}!  +$${formatShort(cash)}`, 'gem');
      this.audio.play('treasure', { position: worldPosition });
      this.screen.shake(0.12, 6);
      this.save.touch();
    });
  }

  private bindInput(): void {
    this.input.pointerLockChanged.on((locked) => {
      // Losing a lock we actually held means the player hit Escape, which is a
      // pause. Never *acquiring* one - a browser that refuses the request, an
      // embedded frame, a user who dismissed the prompt - must not lock the
      // player out of their own game, so movement is gated on game state
      // rather than on the lock. Only mouse-look needs the lock, and `Input`
      // already ignores motion without it.
      if (locked) {
        this.wasLocked = true;
        this.lockedAt = performance.now();
      } else if (this.wasLocked && this.state === 'playing' && !this.ui.modalOpen) {
        // A lock that evaporates within a few frames of being granted is the
        // browser refusing, not the player pressing Escape - it happens in
        // embedded frames and unfocused windows. Pausing on that would strand
        // the player in a menu they never asked for.
        const heldFor = performance.now() - this.lockedAt;
        if (heldFor > 350) this.setPaused(true);
      }
      this.syncControl();
    });

    // Clicking the world re-acquires the lock after the player has tabbed away.
    this.engine.canvas.addEventListener('mousedown', () => {
      if (this.state === 'playing' && !this.ui.modalOpen && !this.input.isLocked) {
        void this.input.requestLock();
      }
    });

    this.input.actionPressed.on((action) => {
      if (this.state !== 'playing') {
        if (action === 'pause' && this.state === 'paused') this.setPaused(false);
        return;
      }
      switch (action) {
        case 'interact':
          this.interactions.activate();
          break;
        case 'inspect':
          this.useHunch();
          break;
        case 'shop':
          this.openModal(() => this.run && this.ui.openShop(this.run));
          break;
        case 'quests':
          this.openModal(() => this.ui.openQuests(this.meta));
          break;
        case 'map':
          this.openModal(() => this.ui.openTravel(this.meta, this.tierIndex));
          break;
        case 'pause':
          this.setPaused(true);
          break;
        case 'toolNext':
          this.run?.cycleTool(1);
          break;
        case 'toolPrev':
          this.run?.cycleTool(-1);
          break;
        default:
          break;
      }
    });

    this.input.wheel.on((direction) => {
      if (this.state === 'playing') this.run?.cycleTool(direction);
    });

    this.input.slotSelected.on((slot) => {
      if (this.state !== 'playing' || !this.run) return;
      const owned = this.run.toolRows().filter((row) => row.owned);
      if (slot < owned.length) this.run.equip(owned[slot].definition.id);
    });

    this.player.onStep = () => {
      const onHay = (this.pile?.surfaceHeightAt(this.player.position.x, this.player.position.z) ?? 0) > 0.1;
      this.audio.play(onHay ? 'footstep_hay' : 'footstep_grass', { volume: 0.35, detune: 3 });
    };
    this.player.onLand = (impact) => {
      this.audio.play('land', { volume: clamp01(impact / 14) });
      this.screen.shake(clamp01(impact / 22) * 0.25, 7);
    };

    this.interactions.triggered.on((item) => this.interact(item));
    this.interactions.focusChanged.on((item) => this.ui.setPrompt(this.promptFor(item)));

    this.meta.questCompleted.on((quest) => {
      this.ui.toast(`Job done: ${quest.name}`, 'good', '📋');
      this.audio.play('quest_complete');
    });
    this.meta.tierUnlocked.on((tier) => {
      this.ui.toast(`${tier.name} unlocked!`, 'good', '🔓');
      this.audio.play('tier_unlock');
    });
    this.meta.gemsChanged.on((gems) => this.ui.setGems(gems));

    window.addEventListener('beforeunload', () => this.persist());
  }

  // ------------------------------------------------------------ interaction
  private promptFor(item: Interactable | null): { key: string; label: string; blocked?: boolean } | null {
    if (!item || !this.run) return null;
    if (item.id === 'sell') {
      const carried = this.run.carried;
      return {
        key: 'E',
        label: carried > 0 ? `Sell ${formatShort(carried)} hay` : 'Nothing to sell',
        blocked: carried <= 0,
      };
    }
    return { key: 'E', label: item.label };
  }

  private interact(item: Interactable): void {
    if (!this.run) return;
    switch (item.id) {
      case 'sell':
        this.sell();
        break;
      case 'shop':
        this.openModal(() => this.run && this.ui.openShop(this.run));
        break;
      case 'tools':
        this.openModal(() => this.run && this.ui.openShop(this.run));
        break;
      case 'quests':
        this.openModal(() => this.ui.openQuests(this.meta));
        break;
      case 'leaderboard':
        this.openModal(() => this.ui.openRecords(this.meta));
        break;
      case 'rebirth':
        this.openModal(() => this.ui.openPerks(this.meta));
        break;
      case 'gate':
        this.openModal(() => this.ui.openTravel(this.meta, this.tierIndex));
        break;
      default:
        break;
    }
  }

  private sell(): void {
    if (!this.run || this.run.carried <= 0) {
      this.audio.play('denied', { volume: 0.4 });
      return;
    }
    const result = this.run.sell();
    this.meta.recordSale(result.straws, result.cash);
    this.ui.banner(`Sold ${formatShort(result.straws)} hay for $${formatShort(result.cash)}`, 'good');
    this.audio.play('sell');
    const sellPoint = this.interactions.positionOf('sell');
    if (sellPoint && this.particles) {
      this.scratch.copy(sellPoint).setY(sellPoint.y + 1.1);
      this.particles.sparkle(this.scratch, 18, '#ffd75e', 3);
    }
    this.screen.shake(0.06, 8);
    this.save.touch();
  }

  private useHunch(): void {
    if (!this.run || !this.buried) return;
    if (!this.run.hunchReady) {
      this.audio.play('denied', { volume: 0.4 });
      return;
    }
    const direction = this.buried.hunchDirection(this.player.position, this.rng, this.hunchDirection);
    if (!direction) return;
    this.run.useHunch();
    this.hunchTimer = HUNCH.duration;
    this.audio.play('detector_ping', { rate: 1.4 });
    this.flash.flash('#8fd8ff', 0.2, 3);
  }

  // ---------------------------------------------------------------- economy
  private buyUpgrade(id: UpgradeId, max: boolean): void {
    if (!this.run) return;
    const bought = max ? this.run.buyUpgradeMax(id) > 0 : this.run.buyUpgrade(id).ok;
    if (bought) {
      this.audio.play('purchase');
      this.ui.refreshOpenModal();
      this.save.touch();
    }
  }

  private buyTool(id: ToolId): void {
    if (!this.run) return;
    if (this.run.buyTool(id).ok) {
      this.audio.play('purchase');
      this.ui.toast(`${TOOL_BY_ID[id].name} unlocked`, 'good', '🛠');
      this.ui.refreshOpenModal();
      this.save.touch();
    }
  }

  private equipTool(id: ToolId): void {
    this.run?.equip(id);
    this.ui.refreshOpenModal();
  }

  private buyPerk(id: PerkId): void {
    if (this.meta.buyPerk(id).ok) {
      this.audio.play('purchase');
      this.ui.refreshOpenModal();
      this.save.flush();
    } else {
      this.audio.play('denied');
    }
  }

  private claimQuest(id: string): void {
    if (this.meta.claimQuest(id).ok) {
      this.audio.play('quest_complete');
      this.ui.refreshOpenModal();
      this.save.flush();
    }
  }

  private buyTierKey(index: number): void {
    if (this.meta.buyTierKey(index).ok) {
      this.audio.play('tier_unlock');
      this.ui.refreshOpenModal();
      this.save.flush();
    } else {
      this.audio.play('denied');
    }
  }

  // --------------------------------------------------------------- run flow
  private get tierIndex(): number {
    return Math.max(0, TIERS.findIndex((tier) => tier.id === this.currentTier.id));
  }

  private finishRun(foundNeedle: boolean): void {
    if (!this.run || !this.pile) return;
    const cleared = this.pile.field.clearedFraction;
    // Treasure gems were paid the moment each one was picked up, so they are
    // reported here rather than awarded again.
    const summary: RunSummary = this.meta.finishRun(this.run, foundNeedle, cleared, this.runTreasureGems);

    this.state = 'summary';
    this.input.releaseLock();
    this.syncControl();
    this.audio.duck(2.4, 0.35);
    this.ui.showSummary(summary, { canAdvance: summary.unlockedTier !== null || this.tierIndex + 1 < TIERS.length });
    this.save.flush();
  }

  private async travelTo(index: number): Promise<void> {
    const target = TIERS[Math.max(0, Math.min(index, TIERS.length - 1))];
    if (!this.meta.isTierUnlocked(index)) {
      this.audio.play('denied');
      return;
    }
    this.ui.closeModal();
    this.ui.hideSummary();
    this.flash.flash('#ffffff', 0.9, 1.4);
    this.openStack(target, makeRunSeed(target.id, this.meta.stats.runs, Date.now()));
    this.audio.setAmbience(target.mood);
    this.state = 'playing';
    this.syncControl();
    this.ui.showHud();
    void this.input.requestLock();
    this.save.touch();
  }

  private async replayStack(): Promise<void> {
    await this.travelTo(this.tierIndex);
  }

  // ---------------------------------------------------------------- options
  private applySetting<K extends keyof typeof this.save.state.settings>(
    key: K,
    value: (typeof this.save.state.settings)[K],
  ): void {
    this.save.state.settings[key] = value;
    this.applyAllSettings();
    this.save.flush();
  }

  private applyAllSettings(): void {
    const settings = this.save.state.settings;
    this.input.sensitivity = settings.sensitivity;
    this.input.invertY = settings.invertY;
    this.audio.setMasterVolume(settings.masterVolume);
    this.audio.setMusicVolume(settings.musicVolume);
    this.audio.setSfxVolume(settings.sfxVolume);
    this.audio.setMusic(settings.musicVolume > 0);
    this.screen.intensity = settings.reducedMotion ? 0.25 : 1;
    if (settings.quality !== 'auto') this.engine.setQuality(settings.quality as QualityTier);
  }

  private resetSave(): void {
    this.save.reset();
    window.location.reload();
  }

  private openModal(open: () => void): void {
    this.input.releaseLock();
    this.player.controlEnabled = false;
    this.audio.play('ui_open');
    open();
  }

  private onModalClosed(): void {
    this.audio.play('ui_close');
    this.syncControl();
    if (this.state === 'playing') void this.input.requestLock();
  }

  private setPaused(paused: boolean): void {
    if (paused && this.state === 'playing') {
      this.state = 'paused';
      this.syncControl();
      this.input.releaseLock();
      this.ui.showPause({
        tier: this.currentTier.name,
        elapsed: this.run?.elapsed ?? 0,
        cleared: this.pile?.field.clearedFraction ?? 0,
        gems: this.meta.gems,
      });
      this.audio.suspend();
      this.persist();
    } else if (!paused && this.state === 'paused') {
      this.state = 'playing';
      this.syncControl();
      this.ui.hidePause();
      this.audio.resume();
      void this.input.requestLock();
    }
  }

  private persist(): void {
    this.meta.storeRun(this.run);
    if (this.run && this.pile) {
      this.run.removedVolume = this.pile.field.originalVolume - this.pile.field.remainingVolume;
      this.run.claimed = this.buried?.claimedIds() ?? [];
      this.meta.storeRun(this.run);
    }
    this.save.flush();
  }

  // ------------------------------------------------------------------- loop
  private fixedUpdate(dt: number): void {
    if (this.state !== 'playing') {
      this.input.endStep();
      return;
    }
    if (this.screen.consumeTimeScale(dt) === 0) {
      this.input.endStep();
      return;
    }

    const run = this.run;
    const dig = this.dig;
    if (!run || !dig || !this.pile) {
      this.input.endStep();
      return;
    }

    run.update(dt);
    this.player.modifiers.speed = run.stats.moveSpeed;
    this.player.update(dt);

    // Aim from where the player *is*, not from where the camera was left by the
    // last frame. Rendering re-poses the camera with interpolation a moment
    // later; this snap costs two matrix builds and makes the crosshair and the
    // crater agree exactly, even mid-turn.
    this.player.applyToCamera(this.engine.camera, 1, this.elapsed, 0);
    this.engine.camera.updateMatrixWorld(true);

    // Digging is gated on game state, not on pointer lock. Only mouse-look
    // needs the lock, and `Input` already discards motion without it; a browser
    // that refuses the lock should still leave a playable game.
    const digging = this.input.isDown('dig');
    dig.update(dt, this.engine.camera, run.stats, digging);
    this.viewmodel?.setStreaming(dig.streaming);

    this.buried?.update(dt, this.player.position);
    this.interactions.update(this.player.position, this.engine.camera);
    this.save.update(dt);

    if (this.hunchTimer > 0) this.hunchTimer = Math.max(0, this.hunchTimer - dt);
    this.updateDetector(dt);
    this.input.endStep();
  }

  /**
   * The treasure glint.
   *
   * Pings faster as an undug oddity gets closer. It deliberately never reacts
   * to the needle: the player takes hundreds of pulls per stack, each a fresh
   * probe from a new position, so any needle-sensing at all collapses the whole
   * search into a minute of sweeping.
   */
  private updateDetector(dt: number): void {
    if (!this.buried || !this.run) return;
    const range = this.run.stats.treasureSense;
    const distance = this.buried.nearestBuriedTreasure(this.player.position, range, this.scratchB);
    if (!Number.isFinite(distance)) {
      this.detectorTimer = 0;
      return;
    }
    const closeness = 1 - clamp01(distance / range);
    this.detectorTimer -= dt;
    if (this.detectorTimer <= 0) {
      this.detectorTimer = lerp(1.1, 0.16, closeness);
      this.audio.play('detector_ping', { rate: lerp(0.85, 1.9, closeness), volume: 0.22 + closeness * 0.3 });
      this.particles?.sparkle(this.scratchB, 1, '#9fe8ff', 0.6);
    }
  }

  private frameUpdate(dt: number): void {
    this.elapsed += dt;
    const settings = this.save.state.settings;

    this.player.applyToCamera(this.engine.camera, this.engine.alpha, this.elapsed, settings.headBob ? 1 : 0);
    this.screen.update(dt);
    this.screen.apply(this.engine.camera, this.player.desiredFov(settings.fov));
    this.environment.update(dt, this.engine.camera, this.player.position);
    this.scenery?.update(dt);
    this.livestock?.update(dt);
    this.flash.update(dt);

    this.input.drainLook(this.lookDelta);
    this.viewmodel?.update(dt, this.lookDelta, this.player.speedFraction, this.player.grounded);

    if (this.particles) {
      this.engine.camera.getWorldPosition(this.particles.collectTarget).add(COLLECT_OFFSET);
      this.particles.update(dt);
    }
    this.pile?.update(this.player.position);

    this.engine.camera.getWorldPosition(this.scratch);
    this.engine.camera.getWorldDirection(this.scratchB);
    this.audio.setListener(this.scratch, this.scratchB, UP);
    this.audio.update(dt);

    if (this.state === 'playing') this.syncHud();
  }

  private syncHud(): void {
    const run = this.run;
    const dig = this.dig;
    if (!run || !dig || !this.pile) return;

    this.ui.setCash(run.cash);
    this.ui.setGems(this.meta.gems);
    this.ui.setBag(run.carried, run.stats.capacity);
    this.ui.setStack(this.pile.field.clearedFraction, run.tier.name);

    const rows = run.toolRows().filter((row) => row.owned);
    const index = rows.findIndex((row) => row.equipped);
    this.ui.setTool(run.tool.name, '🛠', index + 1, rows.length);
    this.ui.setHunch(run.hunchesLeft, run.hunchReady, run.hunchCooldownRemaining);

    let crosshair: CrosshairState = 'idle';
    if (dig.aimState === 'hay') crosshair = dig.streaming || this.input.isDown('dig') ? 'digging' : 'hot';
    else if (dig.aimState === 'far') crosshair = 'far';
    this.ui.setCrosshair(crosshair);

    this.ui.setPrompt(this.promptFor(this.interactions.current));
    this.ui.setFps(this.engine.fps, this.save.state.settings.showFps, `${this.pile.instanceCount} straws`);
  }

  /** Project a world point to the screen and pop a number there. */
  private showWorldPopup(worldPoint: Vector3, text: string, kind: 'hay' | 'money' | 'gem'): void {
    this.scratch.copy(worldPoint).project(this.engine.camera);
    if (this.scratch.z > 1) return;
    const x = (this.scratch.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.scratch.y * 0.5 + 0.5) * window.innerHeight;
    this.ui.popup(x, y, text, kind);
  }

  // ---------------------------------------------------------------- teardown
  dispose(): void {
    this.persist();
    this.engine.stop();
    this.disposeStack();
    this.scenery?.dispose();
    this.livestock?.dispose();
    this.interactions.dispose();
    this.particles?.dispose();
    this.viewmodel?.dispose();
    this.environment.dispose();
    this.terrain.dispose();
    this.materials.dispose();
    this.assets.dispose();
    this.audio.dispose();
    this.flash.dispose();
    this.ui.dispose();
    this.input.dispose();
    this.engine.dispose();
  }
}

const UP = new Vector3(0, 1, 0);

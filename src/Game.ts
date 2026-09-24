import { Vector3, type Object3D } from 'three';

import { Assets } from './core/Assets';
import { Engine, type QualityTier } from './core/Engine';
import { Input } from './core/Input';
import { MaterialLibrary } from './core/Materials';
import { clamp01, damp, formatShort, lerp } from './core/MathX';
import { Rng, hashSeed } from './core/Rng';
import { SaveManager } from './core/Save';
import { AudioSystem } from './audio/Audio';
import {
  flushCloudSave,
  hasSDK,
  isTV,
  saveCloudDebounced,
  setGameplayActive,
  showInterstitial,
  showRewarded,
} from './platform/ysdk';
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
import {
  InteractionSystem,
  SPAWN_ANGLE,
  SPAWN_MARGIN,
  type Interactable,
} from './gameplay/Interactables';
import { Meta, type RunSummary } from './gameplay/Meta';
import { Player } from './gameplay/Player';
import { Run, makeRunSeed } from './gameplay/Run';
import type { RunSnapshot } from './core/Save';
import { Viewmodel } from './gameplay/Viewmodel';
import { DevConsole, type DevApi, type DevStats, type DevTierInfo, type TeleportTarget } from './ui/DevConsole';
import { GameUi, type CrosshairState, type HudPanel } from './ui/GameUi';
import { CollisionWorld } from './world/Collision';
import { Environment } from './world/Environment';
import { HayPile } from './world/HayPile';
import { Livestock } from './world/Livestock';
import { CRITICAL_ASSETS, DEFERRED_ASSETS } from './world/Manifest';
import { SCENE_PALETTES, Scenery } from './world/Scenery';
import { SKY_PRESETS, type SkyMood } from './world/Sky';
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

/**
 * Metres between the kiosk ring and the boundary fence.
 *
 * Everything the player can reach lives in this band: the buildings, the yard
 * clutter, the spawn pad. It is the one number that sets how big the world is,
 * and it is deliberately small - a yard you can cross in ten seconds keeps the
 * fill-and-sell loop tight, and the rampart of hills outside it does the work
 * that an open horizon used to.
 */
const BOUNDARY_MARGIN = 17;

/**
 * Shortest gap between two interstitials, in wall-clock milliseconds.
 *
 * Four minutes against a stack that takes seven to ten means at most one per
 * haystack, and usually fewer. The platform's own floor is a minute; this is
 * not a technical limit but a judgement about a game whose whole appeal is
 * that it is calm.
 */
const AD_COOLDOWN_MS = 240_000;

/** False only in the Yandex store build. See `devConsole`. */
const DEV_CONSOLE_ENABLED = import.meta.env.VITE_DEV_CONSOLE !== 'false';

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
  /**
   * The admin console, or nothing at all.
   *
   * Yandex Games treats a reachable developer console as technical text and as
   * a cheat, and both are rejections - so the store build is made with
   * `--mode yandex`, which switches `VITE_DEV_CONSOLE` off and lets the bundler
   * drop the whole module. Everywhere else it is there, including the public
   * web build, because it is how this game gets tested.
   */
  private readonly devConsole: DevConsole | null;

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
  /** The cow beside the trough, kept so it can answer when it is fed. */
  private troughCow: Object3D | null = null;

  /** Wall-clock time of the last interstitial, for the cooldown. */
  private lastAdAt = -Infinity;
  /** Raised while travelling, so a platform pause does not fight the handover. */
  private inTransition = false;
  /** Raised for the whole of a travel, so a second button press is ignored. */
  private travelling = false;
  private interactions: InteractionSystem;
  private dig: DigSystem | null = null;
  /** Detaches the pile's ground sampler; see `openStack`. */
  private releasePileElevator: (() => void) | null = null;
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
  /** Metres of the hunch trail already drawn this activation. */
  private hunchTrail = 0;
  private lastBagWarning = -99;
  /** 0..1 blend into the magnifier's narrowed field of view. */
  private inspectZoom = 0;
  /**
   * Which onboarding beat the player is on, or -1 once they are past it.
   *
   * Three lines, each fired by the player doing the previous thing, and only
   * ever on a save that has never finished a run. A game that teaches itself in
   * thirty seconds does not need a tutorial; it needs three sentences that
   * arrive exactly when they are useful.
   */
  private tutorialStep = -1;
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
      onOpenPanel: (panel) => this.openPanel(panel),
      onInteract: () => {
        if (this.state === 'playing') this.interactions.activate();
      },
      onPause: () => this.setPaused(true),
      onCycleTool: () => this.run?.cycleTool(1),
      onCloseModal: () => this.onModalClosed(),
      onSound: (name) => this.audio.play(name),
      rewardedAvailable: () => hasSDK() && !isTV(),
      onDoubleGems: (gems, done) => this.doubleGems(gems, done),
    });

    this.devConsole = DEV_CONSOLE_ENABLED ? new DevConsole(uiRoot, this.devApi()) : null;

    this.applyAllSettings();
    this.engine.fixedUpdate.on((dt) => this.fixedUpdate(dt));
    this.engine.frameUpdate.on((dt) => this.frameUpdate(dt));
    // A tier change re-sizes the buffers and rebuilds the composer by itself,
    // but the straw budgets are baked into the pile when the stack is opened.
    // Thinning the band is the one part worth doing without waiting for the
    // next stack: it is the most expensive object in the scene.
    this.engine.qualityChanged.on(() => {
      this.pile?.setBandBudget(this.engine.settings.bandBudget);
    });
    this.bindInput();
  }

  // ------------------------------------------------------------------ boot
  async boot(): Promise<void> {
    this.assets.progress.on((progress) => {
      this.ui.setLoadingProgress(progress.fraction * 0.75, 'Вяжем сено…');
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
    this.openStack(
      TIERS[tierIndex],
      stored?.seed ?? makeRunSeed(TIERS[tierIndex].id, 0, Date.now()),
      stored,
    );

    this.ui.setLoadingProgress(0.8, 'Будим корову…');
    this.engine.start();

    // The rest of the library streams in behind the title screen: the player is
    // reading a menu, which is the cheapest loading screen there is.
    void this.assets.loadAll(DEFERRED_ASSETS).then(() => {
      this.buildScenery();
      this.ui.setLoadingProgress(1, 'Готово');
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
    this.player.controlEnabled =
      this.state === 'playing' && !this.ui.modalOpen && !(this.devConsole?.isOpen ?? false);
  }

  private beginPlaying(): void {
    this.state = 'playing';
    this.ui.showHud();
    this.syncControl();
    if (this.meta.stats.runs === 0 && this.meta.stats.pulls === 0) {
      this.tutorialStep = 0;
      this.ui.toast('Подойди к стогу и зажми левую кнопку мыши.', 'info', '🌾');
    }
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
  private openStack(tier: TierDefinition, seed: number, restore: RunSnapshot | null = null): void {
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
    // The handle matters - `CollisionWorld.clear()` drops colliders, not ground
    // layers, so without it every stack the player travels to leaves another
    // sampler behind for `surfaceHeight` to walk.
    this.releasePileElevator = this.collision.addElevator((x, z) => this.pile?.surfaceHeightAt(x, z) ?? 0);

    this.run = new Run(tier, seed, this.meta.perks);
    // Restoring before the pile and the buried field are set up is what makes
    // "close the tab mid-stack" actually resume: the crater has to be replayed
    // into the height field, and the treasures already picked up have to be
    // excluded before any of them are placed.
    if (restore) this.run.restore(restore);
    if (this.run.removedVolume > 0) this.pile.restoreTo(this.run.removedVolume);

    this.dig = new DigSystem(this.pile);
    this.dig.density = this.run.density(this.pile.field.originalVolume);
    this.bindRun(this.run, this.dig);

    this.buried = new BuriedField(
      this.assets,
      this.pile,
      tier,
      seed,
      this.run.stats.luck,
      restore?.claimed ?? [],
    );
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
    const distance = this.currentTier.radius + 7.5 + SPAWN_MARGIN;
    return { x: Math.cos(SPAWN_ANGLE) * distance, z: Math.sin(SPAWN_ANGLE) * distance };
  }

  private buildScenery(): void {
    if (!this.pile) return;
    // `dispose` empties a group; it does not detach it. Travelling six times
    // used to leave twelve orphaned Groups in the scene, each of them still
    // walked by every `traverse` the renderer does.
    if (this.scenery) {
      this.engine.scene.remove(this.scenery.group);
      this.scenery.dispose();
      this.scenery = null;
    }
    if (this.livestock) {
      this.engine.scene.remove(this.livestock.group);
      this.livestock.dispose();
      this.livestock = null;
      this.troughCow = null;
    }
    const tier = this.currentTier;
    this.terrain.clearDirtPatches();
    this.scenery = new Scenery(this.assets, this.terrain, this.collision, {
      seed: hashSeed(tier.id),
      scene: tier.scene,
      pileRadius: tier.radius,
      ringMargin: 7.5,
      boundaryMargin: BOUNDARY_MARGIN,
      scatterRadius: this.engine.settings.scatterDistance,
    });
    this.engine.scene.add(this.scenery.group);
    // The fence is drawn, but this is what actually keeps the player in it.
    this.collision.boundaryRadius = this.scenery.boundaryRadius;

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
    // The world layer knows nothing about audio; it just says who made a noise
    // and where, and the game turns that into a positional voice.
    livestock.voice = (sound, position, rate) => {
      this.audio.play(sound as Parameters<AudioSystem['play']>[0], {
        position,
        volume: 0.9,
        rate,
      });
    };
    this.engine.scene.add(livestock.group);
    this.livestock = livestock;

    const sell = this.interactions.positionOf('sell');
    if (sell) {
      // Beside the trough, not behind it. Standing the cow on the line between
      // the spawn pad and the stack means the first thing a new player sees is
      // a cow's backside filling the screen.
      const outward = Math.hypot(sell.x, sell.z) || 1;
      const alongX = sell.x / outward;
      const alongZ = sell.z / outward;
      // The offset goes to the side the player does *not* arrive from: the
      // spawn pad sits clockwise of the trough, so the cow stands anticlockwise
      // of it and stays out of the shot on the walk in.
      const cowX = sell.x + alongX * 0.9 + alongZ * 2.2;
      const cowZ = sell.z + alongZ * 0.9 - alongX * 2.2;
      const cow = livestock.add(
        { model: 'cow', count: 1, roam: 0, speed: 0 },
        cowX,
        cowZ,
        0,
      );
      if (cow) livestock.faceToward(cow, sell.x, sell.z);
      this.troughCow = cow;
    }

    const palette = SCENE_PALETTES[tier.scene];
    const inner = tier.radius + 4;
    const outer = this.scenery.ringRadius + 9;
    const spawn = this.spawnPoint();
    for (const entry of palette.animals) {
      const spec = LIVESTOCK[entry.model];
      if (!spec) continue;
      livestock.scatter({ ...spec, count: entry.count }, inner, outer, {
        x: spawn.x,
        z: spawn.z,
        radius: 5.5,
      });
    }
  }

  private disposeStack(): void {
    this.releasePileElevator?.();
    this.releasePileElevator = null;
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

    dig.dug.on(() => {
      if (this.tutorialStep !== 0) return;
      this.tutorialStep = 1;
      this.ui.toast('Набери полный мешок, отнеси корове и нажми E.', 'info', '🐄');
    });

    dig.backpackFull.on(() => {
      // One nag per trip, not one per pull: the player is already being told by
      // a full red meter, and a stack of identical toasts is just noise.
      if (this.elapsed - this.lastBagWarning < 6) return;
      this.lastBagWarning = this.elapsed;
      this.ui.toast('Мешок полон — неси корове', 'bad', '🎒');
      this.audio.play('denied', { volume: 0.5 });
    });

    dig.pileCleared.on(() => {
      this.buried?.collectAllExposed();
      this.ui.toast('Стог разобран!', 'good', '🌾');
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
      this.ui.banner(`${definition.name}!  +${formatShort(cash)}`, 'gem');
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
        case 'hunch':
          this.useHunch();
          break;
        case 'shop':
          this.openPanel('shop');
          break;
        case 'quests':
          this.openPanel('quests');
          break;
        case 'map':
          this.openPanel('travel');
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
      // Nothing for an ordinary jump. A flat jump lands at six metres a
      // second, and shaking the screen every time the player hops is how a
      // jump button ends up feeling like a punishment; the controller's own
      // knee already carries the weight of it. Above that, a real fall still
      // rattles.
      this.screen.shake(clamp01((impact - 7) / 15) * 0.22, 7);
    };

    this.interactions.triggered.on((item) => this.interact(item));
    this.interactions.focusChanged.on((item) => this.ui.setPrompt(this.promptFor(item)));

    this.meta.questCompleted.on((quest) => {
      this.ui.toast(`Задание выполнено: ${quest.name}`, 'good', '📋');
      this.audio.play('quest_complete');
    });
    this.meta.tierUnlocked.on((tier) => {
      this.ui.toast(`Открыт стог «${tier.name}»!`, 'good', '🔓');
      this.audio.play('tier_unlock');
    });
    this.meta.gemsChanged.on((gems) => this.ui.setGems(gems));

    window.addEventListener('beforeunload', () => this.persist());

    // Every local write goes to the cloud as well. The signal fires on flush,
    // which is already the "something worth keeping happened" moment, so the
    // cloud copy can never drift from the local one.
    this.save.saved.on((data) => saveCloudDebounced(data));
    // A tab being hidden is the last chance to get a save out; `pagehide` is
    // the one event that survives a mobile browser being killed outright.
    window.addEventListener('pagehide', () => {
      this.persist();
      void flushCloudSave();
    });
  }

  // ------------------------------------------------------------ interaction
  private promptFor(item: Interactable | null): { key: string; label: string; blocked?: boolean } | null {
    if (!item || !this.run) return null;
    if (item.id === 'sell') {
      const carried = this.run.carried;
      return {
        key: 'E',
        label: carried > 0 ? `Продать сено (${formatShort(carried)})` : 'Продавать нечего',
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
    if (this.tutorialStep === 1) {
      this.tutorialStep = 2;
      this.ui.toast('Потрать их в Лавке — кнопка справа. С иголкой всё обнулится.', 'info', '🛒');
    } else if (this.tutorialStep === 2) {
      this.tutorialStep = -1;
    }
    this.ui.banner(`Продано сена: ${formatShort(result.straws)} за ${formatShort(result.cash)} монет`, 'good');
    this.audio.play('sell');
    // You are feeding the cow. It should say something about that - and it is
    // the one animal call in the game the player is guaranteed to trigger.
    if (this.troughCow && this.livestock) this.livestock.callOut(this.troughCow, 'cow_moo');
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
    this.hunchTrail = 0;
    this.ui.toast('Чутьё говорит: туда.', 'good', '🔮');
    this.audio.play('detector_ping', { rate: 1.4 });
    this.flash.flash('#8fd8ff', 0.2, 3);
  }

  // ---------------------------------------------------------------- economy
  /**
   * Open one of the HUD's panels.
   *
   * The keyboard shortcuts and the on-screen rail both come through here, so
   * "the shop" is one call site rather than two that can drift - and the rail
   * is what gives a phone, which has no B key, a shop at all.
   */
  private openPanel(panel: HudPanel): void {
    if (this.state !== 'playing') return;
    switch (panel) {
      case 'shop':
        this.openModal(() => this.run && this.ui.openShop(this.run));
        break;
      case 'records':
        this.openModal(() => this.ui.openRecords(this.meta));
        break;
      case 'quests':
        this.openModal(() => this.ui.openQuests(this.meta));
        break;
      case 'travel':
        this.openModal(() => this.ui.openTravel(this.meta, this.tierIndex));
        break;
    }
  }

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
      this.ui.toast(`Куплено: ${TOOL_BY_ID[id].name}`, 'good', '🛠');
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
    // Travel now yields - there may be an advert between the button and the
    // new yard - so a second press has to be ignored rather than opening a
    // second stack on top of the first.
    if (this.travelling) return;
    const target = TIERS[Math.max(0, Math.min(index, TIERS.length - 1))];
    if (!this.meta.isTierUnlocked(index)) {
      this.audio.play('denied');
      return;
    }
    this.travelling = true;
    try {
      await this.doTravel(target);
    } finally {
      this.travelling = false;
    }
  }

  private async doTravel(target: TierDefinition): Promise<void> {
    this.ui.closeModal();
    this.ui.hideSummary();

    // The only place an advert interrupts anything. It is the right place: the
    // player has just pressed a button, the stack they were on is finished,
    // and nothing is happening that an interruption can ruin. Never on a
    // timer, and never often - a stack is the best part of ten minutes, so the
    // cooldown means at most one of these per haystack.
    await this.adBreak();

    this.flash.flash('#ffffff', 0.9, 1.4);
    this.openStack(target, makeRunSeed(target.id, this.meta.stats.runs, Date.now()));
    this.audio.setAmbience(target.mood);
    this.state = 'playing';
    this.syncControl();
    this.ui.hidePause();
    this.ui.showHud();
    void this.input.requestLock();
    this.save.touch();
  }

  /**
   * Show an interstitial, if one is due.
   *
   * Sound and simulation stop for the duration. On the platform the SDK also
   * fires its own pause event, which lands on `suspendForPlatform` and does
   * the same thing; both paths are idempotent, and the transition flag keeps
   * the pause menu from appearing over a screen the player is leaving anyway.
   */
  private async adBreak(): Promise<void> {
    if (!hasSDK()) return;
    const now = performance.now();
    if (now - this.lastAdAt < AD_COOLDOWN_MS) return;
    this.lastAdAt = now;
    this.inTransition = true;
    this.input.releaseAll();
    this.audio.suspend();
    try {
      await showInterstitial();
    } finally {
      this.inTransition = false;
      this.audio.resume();
    }
  }

  /**
   * Double this run's gems for a watched video.
   *
   * The reward is granted in the platform's `onRewarded` and nowhere else: an
   * `onClose` grant pays out for closing the advert after two seconds, which
   * is both an exploit and a rejection.
   */
  private doubleGems(gems: number, done: (granted: boolean) => void): void {
    if (gems <= 0 || !hasSDK()) {
      done(false);
      return;
    }
    let granted = false;
    void showRewarded(
      () => {
        granted = true;
        this.meta.addGems(gems);
        this.audio.play('coin', { rate: 1.2 });
        this.save.flush();
      },
      {
        onOpen: () => {
          this.input.releaseAll();
          this.audio.suspend();
        },
        // Fires exactly once whatever happened - watched, skipped, failed or
        // offline - so it is the only place the button needs to be released.
        onClose: () => {
          this.audio.resume();
          done(granted);
        },
      },
    );
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
    // Only "auto" lets the engine overrule itself when frames run long. A
    // player who picked Ultra and meant it keeps Ultra, slow or not.
    this.engine.adaptiveQuality = settings.quality === 'auto';
    if (settings.quality !== 'auto') this.engine.setQuality(settings.quality as QualityTier);
  }

  /**
   * Adopt a save that arrived from the platform's cloud. Called once, before
   * `boot`, so everything downstream is built from the final save.
   */
  hydrateSave(raw: unknown): void {
    const outcome = this.save.hydrate(raw);
    if (outcome === 'adopted') this.applyAllSettings();
  }

  /**
   * The screen has gone away: a tab switch, the phone locking, an advert or a
   * purchase window. Freeze everything within the platform's two seconds.
   *
   * Idempotent, and deliberately does not resume by itself - coming back to a
   * pause menu is expected, and un-pausing a player who is not looking is how
   * you return them to a dead character in a game that has one.
   */
  suspendForPlatform(): void {
    this.input.releaseAll();
    setGameplayActive(false);
    if (this.inTransition) {
      this.audio.suspend();
      return;
    }
    if (this.state === 'playing') this.setPaused(true);
    else this.audio.suspend();
  }

  resumeFromPlatform(): void {
    // While the pause card is up the audio belongs to the pause, not to us.
    if (this.state !== 'paused') this.audio.resume();
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
    dig.update(dt, this.engine.camera, run.stats, digging, run.carried);
    this.viewmodel?.setStreaming(dig.streaming);

    this.buried?.update(dt, this.player.position);
    this.interactions.update(this.player.position, this.engine.camera);
    this.save.update(dt);

    // The magnifier is a held action: raising it stows the tool, narrows the
    // lens and lights up anything buried nearby.
    this.viewmodel?.setInspecting(this.input.isDown('inspect'));
    this.updateHunch(dt);
    this.updateDetector(dt);
    this.input.endStep();
  }

  /**
   * The Hunch arrow.
   *
   * A line of motes drifts out from the player along the hinted direction. It
   * is deliberately a *direction*, not a marker: the arrow tells you which half
   * of the stack to sweep and nothing more, which is the difference between a
   * hint and an answer.
   */
  private updateHunch(dt: number): void {
    if (this.hunchTimer <= 0) return;
    this.hunchTimer = Math.max(0, this.hunchTimer - dt);
    if (!this.particles) return;

    // Motes march outward and wrap, so the trail always reads as flowing away
    // from the player rather than sitting there as a static dotted line.
    this.hunchTrail = (this.hunchTrail + dt * 7) % 1.6;
    for (let i = 0; i < 9; i++) {
      const distance = 1.4 + i * 1.6 + this.hunchTrail;
      this.scratch
        .copy(this.player.position)
        .addScaledVector(this.hunchDirection, distance)
        .setY(this.player.position.y + 1.35 + Math.sin(this.elapsed * 3 + i) * 0.12);
      this.particles.sparkle(this.scratch, 1, '#9fe0ff', 0.35);
    }
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
    // Raising the magnifier roughly doubles the range, which is the whole
    // reason to raise it.
    const inspecting = this.input.isDown('inspect');
    const range = this.run.stats.treasureSense * (inspecting ? 2.1 : 1);
    const distance = this.buried.nearestBuriedTreasure(this.player.position, range, this.scratchB);
    if (!Number.isFinite(distance)) {
      this.detectorTimer = 0;
      return;
    }

    const closeness = 1 - clamp01(distance / range);
    // A glint sits on the surface above the find rather than at its buried
    // depth, so it marks a place the player can actually dig.
    this.scratchB.y = Math.max(
      this.scratchB.y,
      this.pile?.surfaceHeightAt(this.scratchB.x, this.scratchB.z) ?? this.scratchB.y,
    );
    if (inspecting) this.particles?.sparkle(this.scratchB, 1, '#bfe9ff', 0.5);

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

    // Gameplay markup, told once a frame rather than hooked onto each of the
    // dozen places `state` changes. The call de-duplicates itself, so this is
    // one comparison per frame and no transition can ever be missed - which is
    // the failure mode the markup is checked for.
    setGameplayActive(this.state === 'playing' && !this.inTransition);

    this.player.applyToCamera(this.engine.camera, this.engine.alpha, this.elapsed, settings.headBob ? 1 : 0);
    this.screen.update(dt);
    const inspecting = this.state === 'playing' && this.input.isDown('inspect');
    this.inspectZoom = damp(this.inspectZoom, inspecting ? 1 : 0, 11, dt);
    this.screen.apply(
      this.engine.camera,
      this.player.desiredFov(settings.fov) - this.inspectZoom * 22,
    );
    this.environment.update(dt, this.engine.camera, this.player.position);
    this.scenery?.update(dt);
    this.livestock?.update(dt, this.player.position);
    this.flash.update(dt);

    this.input.drainLook(this.lookDelta);
    this.viewmodel?.update(dt, this.lookDelta, this.player.speedFraction, this.player.grounded);

    if (this.particles) {
      this.engine.camera.getWorldPosition(this.particles.collectTarget).add(COLLECT_OFFSET);
      this.particles.update(dt);
    }
    this.pile?.update(this.player.position);
    this.devConsole?.update();

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

  // ------------------------------------------------------------ dev console
  /**
   * Everything the admin console is allowed to touch, in one place.
   *
   * Written as a plain object of closures rather than by handing the console a
   * `Game` because the boundary is the whole value of the thing: every cheat is
   * one named verb here, and reading this method tells you the complete list of
   * ways the console can move the game off its normal rails.
   */
  private devApi(): DevApi {
    const game = this;
    return {
      tiers(): DevTierInfo[] {
        return TIERS.map((tier, index) => ({
          index,
          id: tier.id,
          name: tier.name,
          unlocked: game.meta.isTierUnlocked(index),
          current: tier.id === game.currentTier.id,
        }));
      },
      travelTo(index) {
        void game.travelTo(index);
      },
      unlockAllTiers() {
        game.meta.unlockAllTiers();
        game.save.flush();
      },
      addCash(amount) {
        game.run?.addCash(amount);
      },
      setCash(amount) {
        if (!game.run) return;
        game.run.cash = Math.max(0, amount);
        game.ui.setCash(game.run.cash);
      },
      addGems(amount) {
        game.meta.addGems(Math.round(amount));
        game.save.flush();
      },
      maxUpgrades() {
        game.run?.grantEverything();
        game.refreshDigStats();
      },
      unlockAllTools() {
        game.run?.grantEverything();
        game.refreshDigStats();
      },
      unlockAllPerks() {
        game.meta.grantAllPerks();
        game.save.flush();
      },
      refillHunches() {
        game.run?.refillHunches();
      },
      setCleared(fraction) {
        if (!game.pile || !game.run) return;
        game.pile.restoreTo(fraction * game.pile.field.originalVolume);
        game.run.removedVolume = game.pile.field.originalVolume - game.pile.field.remainingVolume;
        game.refreshDigStats();
      },
      fillBag() {
        if (!game.run || !game.dig) return;
        game.run.carried = game.run.stats.capacity;
      },
      emptyBag() {
        if (!game.run) return;
        game.run.carried = 0;
      },
      revealNeedle() {
        game.exposeBuried('needle');
      },
      findNeedle() {
        game.finishRun(true);
      },
      collectTreasures() {
        game.exposeBuried('treasure');
      },
      completeCollection() {
        game.meta.completeCollection();
        game.save.flush();
      },
      setNoclip(on) {
        game.player.noclip = on;
      },
      setSpeed(multiplier) {
        const clamped = Math.max(0.1, Math.min(40, multiplier));
        game.player.debugSpeed = clamped;
        return clamped;
      },
      teleport(where: TeleportTarget) {
        game.devTeleport(where);
      },
      setQuality(tier) {
        game.applySetting('quality', tier as (typeof game.save.state.settings)['quality']);
      },
      setMood(mood) {
        game.environment.setMood(mood as SkyMood);
      },
      moods() {
        return Object.keys(SKY_PRESETS);
      },
      stats(): DevStats {
        const info = game.engine.renderer.info;
        return {
          fps: game.engine.fps,
          drawCalls: info.render.calls,
          triangles: info.render.triangles,
          strawInstances: game.pile?.instanceCount ?? 0,
          quality: game.engine.quality,
          resolutionScale: game.engine.renderScale,
          cleared: game.pile?.field.clearedFraction ?? 0,
          cash: game.run?.cash ?? 0,
          gems: game.meta.gems,
          noclip: game.player.noclip,
          position: {
            x: game.player.position.x,
            y: game.player.position.y,
            z: game.player.position.z,
          },
        };
      },
      resetSave() {
        game.resetSave();
      },
      setConsoleOpen(open) {
        if (open) game.input.releaseLock();
        game.syncControl();
        if (!open && game.state === 'playing') void game.input.requestLock();
      },
    };
  }

  /** The dig system caches derived stats; call after any cheat that moves them. */
  private refreshDigStats(): void {
    if (this.dig && this.run && this.pile) {
      this.dig.density = this.run.density(this.pile.field.originalVolume);
    }
  }

  /** Dev console: put the player somewhere useful. */
  private devTeleport(where: TeleportTarget): void {
    if (where === 'spawn') {
      const spawn = this.spawnPoint();
      this.player.teleport(spawn.x, spawn.z, Math.atan2(spawn.x, spawn.z));
      return;
    }
    if (where === 'stack') {
      const top = this.pile?.surfaceHeightAt(0, 0) ?? 0;
      this.player.teleportTo(0, top + 0.4, 0);
      return;
    }
    const target = this.interactions.positionOf(where === 'sell' ? 'sell' : 'shop');
    if (!target) return;
    // Stand a stride outside the kiosk so the prompt is already up on arrival.
    const outward = Math.hypot(target.x, target.z) || 1;
    const x = target.x + (target.x / outward) * 1.6;
    const z = target.z + (target.z / outward) * 1.6;
    this.player.teleport(x, z, Math.atan2(target.x - x, target.z - z));
  }

  /**
   * Dig straight down onto buried things so they surface.
   *
   * Cutting the hay away rather than teleporting the item is what makes this
   * useful: the reveal runs through the same code path a real dig does, so it
   * exercises the effect, the sound and the collection as well as the placement.
   */
  private exposeBuried(kind: 'needle' | 'treasure'): void {
    const buried = this.buried;
    const pile = this.pile;
    if (!buried || !pile) return;
    for (const item of buried.items) {
      if (item.claimed || item.kind !== kind) continue;
      const world = buried.worldPosition(item, this.scratch);
      const surface = pile.surfaceHeightAt(world.x, world.z);
      if (surface > world.y) pile.dig(world, 1.1, surface - world.y + 0.12);
      if (kind === 'needle') {
        this.player.teleportTo(world.x, Math.max(surface, world.y) + 1.9, world.z);
      }
    }
    this.refreshDigStats();
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
    this.devConsole?.dispose();
    this.ui.dispose();
    this.input.dispose();
    this.engine.dispose();
  }
}

const UP = new Vector3(0, 1, 0);

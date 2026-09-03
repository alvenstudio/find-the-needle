/**
 * Find the Needle - the whole user interface.
 *
 * This file owns every pixel that is not the 3D scene: the loading card, the
 * title screen, the in-game HUD, the six dialogs, the pause menu and the
 * needle celebration. It is deliberately the *only* place that knows both what
 * a haystack is and what a `<div>` is.
 *
 * THE THREE RULES THIS FILE LIVES BY
 * ----------------------------------
 *  1. **No `three`, ever.** Nothing here imports the renderer, and nothing here
 *     is imported by it. The game talks to the UI through `GameUi`'s methods
 *     and the UI talks back through `UiCallbacks`, which means the HUD can be
 *     rebuilt, restyled or unit-tested against a bare jsdom without a GL
 *     context anywhere in sight.
 *  2. **The DOM is built once.** Every node the HUD needs exists by the time
 *     the constructor returns. The per-frame setters (`setCash`, `setBag`,
 *     `setStack`, ...) only ever write text or toggle a class, and each one
 *     compares against a cached value first so that a steady-state frame does
 *     no DOM work at all. Panels are the exception: they rebuild on open,
 *     which happens a few times a minute, not sixty times a second.
 *  3. **No layout reads in the frame path.** `offsetWidth`,
 *     `getBoundingClientRect` and friends force a synchronous layout, and a
 *     synchronous layout in the middle of a 16ms budget is a dropped frame.
 *     The one measurement anything here needs - the viewport size, for the
 *     centred banner - is cached from a `resize` listener.
 *
 * WHY THE UI OWNS SO LITTLE STATE
 * -------------------------------
 * `GameUi` holds no game state. It is handed a `Run` or a `Meta` when a panel
 * opens, reads it, and forgets it again apart from a reference kept purely so
 * `refreshOpenModal()` can re-read the same source after a purchase. Every
 * mutation goes out through `UiCallbacks` and comes back as new numbers on the
 * next render. That one-way flow is why a mis-rendered price is always a bug
 * in one place rather than a disagreement between two copies of the truth.
 */

import './styles.css';

import { formatClock, formatExact } from '../core/MathX';
import type { SaveData } from '../core/Save';
import {
  HUNCH,
  TIERS,
  TREASURES,
  type PerkId,
  type TierDefinition,
  type ToolId,
  type TreasureDefinition,
  type UpgradeId,
} from '../gameplay/Content';
import type { ActiveQuest, Meta, PerkRow, RunSummary } from '../gameplay/Meta';
import type { Run, ToolRow, UpgradeRow } from '../gameplay/Run';
import {
  Modal,
  PopupLayer,
  ToastStack,
  button,
  chip,
  clear,
  el,
  formatShort,
  meter,
  setText,
  slider,
  tabs,
  toggle,
  toggleClass,
  type ChipHandle,
  type MeterHandle,
} from './Widgets';

/* ------------------------------------------------------------------ api -- */

/**
 * Everything the UI can ask the game to do.
 *
 * The UI never mutates a `Run` or a `Meta` itself, even though it is holding
 * one while a panel is open. It asks, the game decides, and the game hands the
 * new numbers back. That keeps purchase validation, sound, saving and analytics
 * in one place instead of scattered across button handlers.
 */
export interface UiCallbacks {
  onStartGame(): void;
  onResume(): void;
  onOpenSettings(): void;
  onBuyUpgrade(id: UpgradeId, max: boolean): void;
  onBuyTool(id: ToolId): void;
  onEquipTool(id: ToolId): void;
  onBuyPerk(id: PerkId): void;
  onClaimQuest(id: string): void;
  /** Travel to a stack by index. Also the "next stack" button on the summary. */
  onPickTier(index: number): void;
  onBuyTierKey(index: number): void;
  onReplayStack(): void;
  onSettingChanged<K extends keyof SaveData['settings']>(key: K, value: SaveData['settings'][K]): void;
  onResetSave(): void;
  /** Fired whenever any modal closes, however it was closed. */
  onCloseModal(): void;
  onSound(name: 'ui_hover' | 'ui_click' | 'ui_open' | 'ui_close'): void;
}

/** The centre-screen "[E] Sell hay" line, or `null` for nothing in reach. */
export type HudPrompt = { key: string; label: string; blocked?: boolean } | null;

export type CrosshairState = 'hidden' | 'idle' | 'hot' | 'digging' | 'far';

/* ------------------------------------------------------------ constants -- */

/**
 * Loading tips.
 *
 * They rotate rather than sitting still because a static line reads as a frozen
 * screen, and a loading screen that looks frozen is indistinguishable from one
 * that *is*. They also do the tutorial's job: by the time the first stack is
 * ready the player has read three sentences about how the game works.
 */
const LOADING_TIPS: readonly string[] = [
  'Cash and upgrades belong to one haystack. Gems are forever.',
  'A full bag wastes every swing. Watch the green bar.',
  'Golden bundles pay eight times over. Keep moving around the stack.',
  'The needle sits deeper on the bigger stacks. Clear wide, not just deep.',
  'Sell at the cow. Haggle makes every load worth more.',
  'Buried oddities join your collection permanently.',
  'A Hunch points toward the needle. It only tells you which half to dig.',
  'Clearing every last straw pays a bonus on top of the needle.',
];

const TIP_INTERVAL_MS = 4200;
/** Must outlast `--dur-4` in styles.css, which drives the fade. */
const LOADING_FADE_MS = 460;

/**
 * Pips stop being readable long before a 60-level upgrade runs out, so the
 * strip is capped and the true level is written next to it as "x37".
 */
const PIP_CAP = 12;

/** Stagger between gem-breakdown counters on the celebration screen. */
const COUNT_UP_STAGGER_MS = 260;

/**
 * Tools carry a `model` name for the renderer but no glyph - what a pitchfork
 * looks like in a shop row is a UI decision, so the mapping lives here.
 */
const TOOL_ICONS: Readonly<Record<ToolId, string>> = {
  hands: '✋',
  pitchfork: '🔱',
  rake: '🧹',
  dynamite: '🧨',
  blower: '🌬️',
  vacuum: '🌪️',
  compressor: '🚜',
};

/** Same story for treasures: `model` is for the scene, this is for the grid. */
const TREASURE_ICONS: Readonly<Record<string, string>> = {
  coin: '🪙',
  horseshoe: '🐴',
  arrowhead: '🏹',
  key: '🗝️',
  bone: '🦴',
  pocket_watch: '⌚',
  ring: '💍',
  gnome: '🧙',
  chest: '🗃️',
  ufo: '🛸',
  needle_golden: '🪡',
};

const QUEST_ICONS: Readonly<Record<string, string>> = {
  sell: '💰',
  pull: '✊',
  treasure: '💎',
  clear: '🧹',
  needle: '🪡',
  golden: '✨',
};

const QUALITY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'ultra', label: 'Ultra' },
  { value: 'auto', label: 'Auto' },
];

/** Which dialog is currently mounted, so `refreshOpenModal` knows what to redraw. */
type ModalKind = 'shop' | 'perks' | 'quests' | 'records' | 'travel' | 'settings';

/* -------------------------------------------------------------- helpers -- */

/** `2.400` -> `"2.4"`. Keeps stat columns honest without trailing noise. */
function trimNumber(value: number, decimals = 2): string {
  return String(Number(value.toFixed(decimals)));
}

/**
 * Render an upgrade's stat in its own unit.
 *
 * The bag is the odd one out: its "unit" is empty because the number *is* the
 * capacity, and a capacity of 1.19^40 straws needs the short-scale treatment.
 */
function statText(unit: string, value: number): string {
  if (!Number.isFinite(value)) return '-';
  switch (unit) {
    case 'x':
      return `${trimNumber(value)}x`;
    case 'm':
      return `${trimNumber(value)} m`;
    case '%':
      return `${Math.round(value * 100)}%`;
    default:
      return formatShort(Math.round(value));
  }
}

/** Cash for a shop row: short-scale, because late tiers deal in millions. */
function cashText(value: number): string {
  return Number.isFinite(value) ? formatShort(value) : 'MAX';
}

/**
 * Level pips, capped.
 *
 * Beyond `PIP_CAP` the strip stops being a readout and starts being wallpaper,
 * so it saturates and the real level is spelled out beside it.
 */
function pipStrip(level: number, maxLevel: number): HTMLElement {
  const shown = Math.min(maxLevel, PIP_CAP);
  const filled = Math.min(level, shown);
  const strip = el('div.shop-row__pips');
  for (let i = 0; i < shown; i += 1) {
    const on = i < filled;
    const max = on && level >= maxLevel;
    strip.appendChild(el('span.pip', { className: max ? 'pip--on pip--max' : on ? 'pip--on' : undefined }));
  }
  // The number only appears once the pips stop being able to say it. Printing
  // "x0" next to an empty strip is noise the player has to learn to ignore.
  if (level > shown) strip.appendChild(el('span.u-num.u-dim', { textContent: ` x${level}` }));
  return strip;
}

/** The `💰 1.2K` block used on every priced row. */
function costTag(icon: string, text: string): HTMLElement {
  return el('div.shop-row__cost', undefined, [
    el('span', { textContent: icon, attrs: { 'aria-hidden': 'true' } }),
    el('span', { textContent: text }),
  ]);
}

/** A static currency badge - no rolling counter, for labels that never move. */
function badge(icon: string, text: string, className: string): HTMLElement {
  return el('div.chip', { className }, [
    el('span.chip__icon', { textContent: icon, attrs: { 'aria-hidden': 'true' } }),
    el('span.chip__value', { textContent: text }),
  ]);
}

/** A label/value pair for the pause menu and the records list. */
function statLine(label: string, value: string): HTMLElement {
  return el('div.pause__stat', undefined, [
    el('span', { textContent: label }),
    el('span.u-num', { textContent: value }),
  ]);
}

/** A `[key] Label` hint, using the same keycap as the interaction prompt. */
function keyHint(key: string, label: string): HTMLElement {
  return el('div.u-row', undefined, [
    el('span.key', { textContent: key }),
    el('span.u-label', { textContent: label }),
  ]);
}

/**
 * Hide a meter's own head row.
 *
 * Some meters (the stack bar, the Hunch cooldown) live inside a layout that
 * already prints the label and the number in a larger size, and the widget's
 * built-in head would just repeat them. `u-hidden` is doubled in the stylesheet
 * specifically so it can beat a component's own `display`.
 */
function hideMeterHead(handle: MeterHandle): MeterHandle {
  const head = handle.root.querySelector('.meter__head');
  if (head instanceof HTMLElement) head.classList.add('u-hidden');
  return handle;
}

/* ----------------------------------------------------------------- main -- */

export class GameUi {
  private readonly root: HTMLElement;
  private readonly cb: UiCallbacks;

  /* --- screens ---------------------------------------------------------- */
  private readonly loading: HTMLElement;
  private readonly loadingFill: HTMLElement;
  private readonly loadingPct: HTMLElement;
  private readonly loadingTip: HTMLElement;

  private readonly title: HTMLElement;
  private readonly titleStats: HTMLElement;
  private readonly titlePlay: HTMLButtonElement;
  private readonly titleFoot: HTMLElement;

  private readonly hud: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly pauseStats: HTMLElement;
  private readonly pauseTravel: HTMLButtonElement;

  private readonly celebrate: HTMLElement;
  private readonly celebrateCard: HTMLElement;

  /* --- HUD parts -------------------------------------------------------- */
  private readonly bagMeter: MeterHandle;
  /** Reparented between the corners at the phone breakpoint; see `applyLayout`. */
  private bagPanel!: HTMLElement;
  private topLeftColumn!: HTMLElement;
  private bottomLeft!: HTMLElement;
  private hintsPanel!: HTMLElement;
  private stackPanel!: HTMLElement;
  private stackRow!: HTMLElement;
  private readonly stackMeter: MeterHandle;
  private readonly stackPct: HTMLElement;
  private readonly stackName: HTMLElement;
  private readonly cashChip: ChipHandle;
  private readonly gemChip: ChipHandle;

  private readonly toolIcon: HTMLElement;
  private readonly toolName: HTMLElement;
  private readonly toolCount: HTMLElement;

  private readonly hunchPanel: HTMLElement;
  private readonly hunchCount: HTMLElement;
  private readonly hunchMeter: MeterHandle;

  private readonly crosshair: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly promptKey: HTMLElement;
  private readonly promptText: HTMLElement;

  private readonly fpsPanel: HTMLElement;
  private readonly fpsText: HTMLElement;

  /* --- overlays --------------------------------------------------------- */
  private readonly toasts: ToastStack;
  private readonly popups: PopupLayer;
  private readonly modal: Modal;

  /* --- per-frame caches -------------------------------------------------
     Every one of these exists so a setter that is called sixty times a second
     with an unchanged value can return before touching the DOM. */
  private lastCash = Number.NaN;
  private lastGems = Number.NaN;
  private lastCarried = Number.NaN;
  private lastCapacity = Number.NaN;
  private lastStackPermille = -1;
  private lastTierName = '';
  private lastToolKey = '';
  private lastPromptKey = '';
  private lastCrosshair: CrosshairState | '' = '';
  private lastHunchKey = '';
  private lastFpsKey = '';
  private lastLoadingPct = -1;

  /* --- panel sources ----------------------------------------------------
     Held only so `refreshOpenModal()` can re-read the same object after a
     purchase. Never mutated from here. */
  private run: Run | null = null;
  private meta: Meta | null = null;
  private settings: SaveData['settings'] | null = null;
  private modalKind: ModalKind | null = null;
  private shopTab = 'upgrades';
  private recordsTab = 'records';
  private travelIndex = 0;
  private resetArmed = false;

  /** Which full-screen surface a modal covered, so it can be put back. */
  private screenUnderModal: 'title' | 'pause' | null = null;

  /* --- misc ------------------------------------------------------------- */
  private viewWidth = 0;
  private viewHeight = 0;
  /** False matches the wide build order, so the first `applyLayout` is a no-op there. */
  private narrowLayout = false;
  private tipTimer: ReturnType<typeof setInterval> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private countUpTimers: ReturnType<typeof setTimeout>[] = [];
  private hoverTarget: Element | null = null;
  private titleGems = 0;
  private titleNeedles = 0;
  private disposed = false;

  constructor(root: HTMLElement, callbacks: UiCallbacks) {
    this.root = root;
    this.cb = callbacks;

    this.viewWidth = window.innerWidth;
    this.viewHeight = window.innerHeight;

    /* --- HUD ------------------------------------------------------------ */
    this.bagMeter = meter({ label: 'Hay', className: 'meter--backpack' });
    this.cashChip = chip({ icon: '💰', className: 'chip--money' });
    this.gemChip = chip({ icon: '💎', className: 'chip--gem' });

    this.stackMeter = hideMeterHead(meter({ label: 'Stack', className: 'meter--stack meter--lg' }));
    this.stackPct = el('div.u-title.u-num', { textContent: '0%' });
    this.stackName = el('div.u-muted', { textContent: '' });

    this.toolIcon = el('span.hud__tool-icon', { textContent: '✋', attrs: { 'aria-hidden': 'true' } });
    this.toolName = el('span', { textContent: 'Bare Hands' });
    this.toolCount = el('span.u-dim.u-num', { textContent: '1/1' });

    this.hunchCount = el('span.u-num', { textContent: 'x0' });
    this.hunchMeter = hideMeterHead(meter({ label: 'Hunch' }));
    this.hunchPanel = el('div.hud__panel', undefined, [
      el('div.u-row', undefined, [
        el('span.hud__tool-icon', { textContent: '🔮', attrs: { 'aria-hidden': 'true' } }),
        el('span.key', { textContent: 'F' }),
        this.hunchCount,
      ]),
      this.hunchMeter.root,
    ]);
    this.hunchPanel.hidden = true;

    this.fpsText = el('span.u-label.u-num', { textContent: '' });
    this.fpsPanel = el('div.hud__panel', undefined, this.fpsText);
    this.fpsPanel.hidden = true;

    this.crosshair = el('div.crosshair', { attrs: { 'aria-hidden': 'true' } }, [
      el('div.crosshair__ring'),
      el('div.crosshair__dot'),
    ]);

    this.promptKey = el('span.key', { textContent: 'E' });
    this.promptText = el('span.prompt__text', { textContent: '' });
    this.prompt = el('div.prompt.prompt--hidden', undefined, [this.promptKey, this.promptText]);

    this.hud = this.buildHud();

    /* --- overlays ------------------------------------------------------- */
    // Popups sit under toasts, which sit under dialogs; the stylesheet's `--z-*`
    // scale already encodes that, so DOM order here is only about tidiness.
    this.popups = new PopupLayer(root);
    this.toasts = new ToastStack(root);
    this.modal = new Modal(root, { title: '', onClose: () => this.closeModal() });

    /* --- full-screen surfaces ------------------------------------------- */
    this.loadingFill = el('div.loading__fill');
    this.loadingPct = el('div.loading__pct', { textContent: '0%' });
    this.loadingTip = el('p.loading__tip', { textContent: LOADING_TIPS[0] ?? '' });
    this.loading = this.buildLoading();

    this.titlePlay = button('Play', () => this.onPlay(), 'primary');
    this.titleStats = el('div.u-row');
    this.titleFoot = el('p.title__foot', { textContent: 'Made with hay, sunshine and three.js.' });
    this.title = this.buildTitle();

    this.pauseStats = el('div.pause__stats');
    this.pauseTravel = button('Travel', () => this.travelFromPause(), 'ghost');
    this.pause = this.buildPause();

    this.celebrateCard = el('div.panel.celebrate__card');
    this.celebrate = el('div.celebrate.u-hidden', undefined, [
      el('div.celebrate__rays', { attrs: { 'aria-hidden': 'true' } }),
      this.celebrateCard,
    ]);

    root.append(this.hud, this.celebrate, this.pause, this.title, this.loading);

    // The HUD starts hidden: the loading card owns the screen until the game
    // says otherwise, and a HUD flashing behind it during boot looks broken.
    this.hud.classList.add('u-hidden');
    this.title.classList.add('u-hidden');
    this.pause.classList.add('u-hidden');

    this.applyLayout();

    window.addEventListener('resize', this.onResize, { passive: true });
    // Two delegated listeners instead of a pair per button: the UI builds and
    // discards hundreds of buttons over a session, and the sound hooks should
    // not be something a new panel can forget to wire up.
    root.addEventListener('click', this.onDelegatedClick);
    root.addEventListener('pointerover', this.onDelegatedHover);

    this.startTips();
  }

  /* ==================================================================== dom */

  /** The four HUD corners plus the centre furniture, built once. */
  private buildHud(): HTMLElement {
    this.bagPanel = el('div.hud__panel', undefined, this.bagMeter.root);
    this.topLeftColumn = el('div.u-col', undefined, [
      this.bagPanel,
      el('div.u-row', undefined, this.cashChip.root),
    ]);
    const topLeft = el('div.hud__top-left', undefined, this.topLeftColumn);

    this.stackRow = el('div.u-row', undefined, [
      el('span.u-label', { textContent: 'Stack' }),
      el('span.u-spacer'),
    ]);
    this.stackPanel = el('div.hud__panel', undefined, [
      this.stackRow,
      this.stackPct,
      this.stackName,
      this.stackMeter.root,
    ]);
    const topCenter = el('div.hud__top-center', undefined, this.stackPanel);

    const topRight = el('div.hud__top-right', undefined, this.fpsPanel);

    this.bottomLeft = el('div.hud__bottom-left', undefined, [
      el('div.u-row', undefined, this.gemChip.root),
    ]);
    const bottomLeft = this.bottomLeft;

    this.hintsPanel = el('div.hud__panel', undefined, [
      el('div.u-row', undefined, [keyHint('Q', 'Cycle'), keyHint('E', 'Use')]),
      el('div.u-row', undefined, [keyHint('B', 'Shop'), keyHint('J', 'Jobs'), keyHint('M', 'Travel')]),
    ]);

    const bottomRight = el('div.hud__bottom-right', undefined, [
      this.hunchPanel,
      el('div.hud__panel', undefined, [
        el('div.hud__tool', undefined, [this.toolIcon, this.toolName, this.toolCount]),
      ]),
      this.hintsPanel,
    ]);

    // The crosshair and prompt are children of `.hud` rather than of their own
    // layer because an absolutely positioned box resolves against its
    // ancestor's *padding box* - `.hud`'s gutter padding does not shift them
    // off centre, and one node fewer is one node fewer.
    return el('div.hud', undefined, [
      topLeft,
      topCenter,
      topRight,
      bottomLeft,
      bottomRight,
      this.crosshair,
      this.prompt,
    ]);
  }

  private buildLoading(): HTMLElement {
    return el('div.loading', undefined, [
      el('div.loading__card', undefined, [
        el('div.loading__needle', { textContent: '🪡', attrs: { 'aria-hidden': 'true' } }),
        el('h1.loading__logo', { textContent: 'Find the Needle' }),
        el('div.loading__bar', { attrs: { role: 'progressbar', 'aria-label': 'Loading' } }, this.loadingFill),
        this.loadingPct,
        this.loadingTip,
      ]),
    ]);
  }

  private buildTitle(): HTMLElement {
    const logo = el('h1.title__logo.u-outlined');
    logo.append('Find the', el('em', { textContent: 'Needle' }));

    return el('div.title', undefined, [
      logo,
      el('p.title__tagline', { textContent: 'One needle. A million straws.' }),
      this.titleStats,
      el('div.title__menu', undefined, [
        this.titlePlay,
        button('Settings', () => this.cb.onOpenSettings(), 'ghost'),
        button('Credits', () => this.toggleCredits(), 'ghost'),
      ]),
      this.titleFoot,
    ]);
  }

  private buildPause(): HTMLElement {
    return el('div.pause', undefined, [
      el('div.panel.pause__menu', undefined, [
        el('h2.pause__title', { textContent: 'Paused' }),
        el('div.pause__actions', undefined, [
          button('Resume', () => this.resume(), 'primary'),
          button('Settings', () => this.cb.onOpenSettings(), 'ghost'),
          this.pauseTravel,
          button('Quit to title', () => this.quitToTitle(true), 'ghost'),
        ]),
        this.pauseStats,
      ]),
    ]);
  }

  /* ================================================================ screens */

  /**
   * Drive the loading bar.
   *
   * The bar is a `scaleX` transform, not a width, so it composites; the label
   * is the only text write and it is gated on a whole percent changing, which
   * turns a per-asset firehose into at most a hundred DOM writes.
   */
  setLoadingProgress(fraction: number, label: string): void {
    const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    const pct = Math.round(clamped * 100);
    if (pct !== this.lastLoadingPct) {
      this.lastLoadingPct = pct;
      this.loadingFill.style.transform = `scaleX(${clamped})`;
      this.loading.querySelector('.loading__bar')?.setAttribute('aria-valuenow', String(pct));
      setText(this.loadingPct, `${pct}%  ${label}`);
    }
    if (clamped >= 1) this.finishLoading();
  }

  /** Fade the loading card out, then take it out of the tree entirely. */
  private finishLoading(): void {
    if (this.loading.classList.contains('loading--done')) return;
    this.loading.classList.add('loading--done');
    this.stopTips();
    this.fadeTimer = setTimeout(() => {
      this.fadeTimer = null;
      this.loading.classList.add('u-hidden');
    }, LOADING_FADE_MS);
  }

  /**
   * The title screen.
   *
   * Shown once, on first load, over the live scene - which is why the surface
   * is a vignette rather than a card. `hasRun` decides whether the primary
   * button offers a fresh stack or the one the player walked away from.
   */
  showTitle(info: { hasRun: boolean; gems: number; needles: number }): void {
    this.titleGems = info.gems;
    this.titleNeedles = info.needles;

    setText(this.titlePlay, info.hasRun ? 'Continue' : 'Play');

    clear(this.titleStats);
    if (info.gems > 0) this.titleStats.appendChild(badge('💎', formatShort(info.gems), 'chip--gem'));
    if (info.needles > 0) {
      this.titleStats.appendChild(badge('🪡', formatExact(info.needles), 'chip--money'));
    }

    this.finishLoading();
    this.hud.classList.add('u-hidden');
    this.pause.classList.add('u-hidden');
    this.celebrate.classList.add('u-hidden');
    this.title.classList.remove('u-hidden');
  }

  /** Hand the screen back to the game. */
  showHud(): void {
    this.finishLoading();
    this.title.classList.add('u-hidden');
    this.pause.classList.add('u-hidden');
    this.celebrate.classList.add('u-hidden');
    this.hud.classList.remove('u-hidden');
  }

  showPause(info: { tier: string; elapsed: number; cleared: number; gems: number }): void {
    clear(this.pauseStats);
    this.pauseStats.append(
      statLine('Stack', info.tier),
      statLine('Time', formatClock(info.elapsed)),
      statLine('Cleared', `${(info.cleared * 100).toFixed(1)}%`),
      statLine('Gems', formatShort(info.gems)),
    );

    // The travel dialog needs a `Meta`, which only arrives when the game opens
    // one of the meta panels. Until then the button is honest about being
    // unavailable rather than silently doing nothing.
    this.pauseTravel.disabled = this.meta === null;
    this.travelIndex = Math.max(0, TIERS.findIndex((tier) => tier.name === info.tier));

    this.pause.classList.remove('u-hidden');
  }

  hidePause(): void {
    this.pause.classList.add('u-hidden');
  }

  /**
   * The needle moment.
   *
   * The card is rebuilt from scratch here rather than updated in place: it
   * appears at most once every few minutes, it is the loudest thing in the
   * game, and a fresh subtree guarantees the entrance animation and the
   * counters start from zero every time.
   */
  showSummary(summary: RunSummary, options: { canAdvance: boolean }): void {
    this.clearCountUps();
    clear(this.celebrateCard);

    const index = TIERS.findIndex((tier) => tier.id === summary.tier.id);
    const nextIndex = index + 1;

    const subtitle = summary.unlockedTier
      ? `${summary.tier.name} - ${summary.unlockedTier.name} is open!`
      : summary.tier.name;

    const timeValue = el('div.celebrate__stat-value', {
      textContent: formatClock(summary.seconds),
      // A new best is the only stat worth shouting about, so it borrows the
      // legendary ink and glow rather than inventing a second highlight style.
      className: summary.newBestTime ? 'rarity-legendary rarity-text-glow' : undefined,
    });

    const stats = el('div.celebrate__stats', undefined, [
      this.celebrateStat('Hay pulled', el('div.celebrate__stat-value', { textContent: formatShort(summary.hayPulled) })),
      this.celebrateStat(summary.newBestTime ? 'New best time' : 'Time', timeValue),
      this.celebrateStat(
        'Cleared',
        el('div.celebrate__stat-value', { textContent: `${(summary.clearedFraction * 100).toFixed(1)}%` }),
      ),
    ]);

    const breakdown = el('div.celebrate__stats', undefined, [
      this.gemStat('Needle', summary.gemsFromNeedle, 0),
      this.gemStat('Full clear', summary.gemsFromClear, 1),
      this.gemStat('Time', summary.gemsFromTime, 2),
      this.gemStat('Oddities', summary.gemsFromTreasures, 3),
    ]);

    const totalChip = chip({ icon: '💎', className: 'chip--gem' });
    totalChip.set(0);
    this.countUpTimers.push(
      setTimeout(() => totalChip.set(summary.gemsTotal), COUNT_UP_STAGGER_MS * 4),
    );

    const actions = el('div.celebrate__actions');
    if (options.canAdvance && nextIndex < TIERS.length) {
      actions.appendChild(
        button('Next stack', () => {
          this.hideSummary();
          this.showHud();
          this.cb.onPickTier(nextIndex);
        }, 'primary'),
      );
    }
    actions.append(
      button('Play again', () => {
        this.hideSummary();
        this.showHud();
        this.cb.onReplayStack();
      }, 'buy'),
      button('Back to the farm', () => this.quitToTitle(false), 'ghost'),
    );

    this.celebrateCard.append(
      el('div.celebrate__needle', { textContent: '🪡', attrs: { 'aria-hidden': 'true' } }),
      el('h2.celebrate__title', { textContent: summary.foundNeedle ? 'NEEDLE FOUND!' : 'STACK CLEARED!' }),
      el('p.celebrate__sub', { textContent: subtitle }),
      stats,
      el('div.u-label', { textContent: 'Gems earned' }),
      breakdown,
      el('div.u-row', undefined, totalChip.root),
      actions,
    );

    // Local high score aside: the title screen shows a needle count, and the
    // player may well come straight back to it from this card.
    if (summary.foundNeedle) this.titleNeedles += 1;
    this.titleGems += summary.gemsTotal;

    // The title sits at `--z-loading`, *above* `--z-celebrate`, so leaving it
    // mounted would draw the menu straight over the payoff screen.
    this.title.classList.add('u-hidden');
    this.hud.classList.add('u-hidden');
    this.pause.classList.add('u-hidden');
    this.celebrate.classList.remove('u-hidden');
  }

  hideSummary(): void {
    this.clearCountUps();
    this.celebrate.classList.add('u-hidden');
  }

  private celebrateStat(label: string, value: HTMLElement): HTMLElement {
    return el('div.celebrate__stat', undefined, [
      el('div.celebrate__stat-label', { textContent: label }),
      value,
    ]);
  }

  /**
   * One line of the gem breakdown, counting up.
   *
   * The chip widget snaps on its first `set` and tweens on every later one, so
   * seeding it with zero and scheduling the real value is all the animation
   * this needs - no bespoke tween, and it stops the moment it arrives.
   */
  private gemStat(label: string, value: number, order: number): HTMLElement {
    const handle = chip({ icon: '💎', className: 'chip--gem chip--sm' });
    handle.set(0);
    this.countUpTimers.push(setTimeout(() => handle.set(value), COUNT_UP_STAGGER_MS * order + 120));
    return el('div.celebrate__stat', undefined, [
      el('div.celebrate__stat-label', { textContent: label }),
      handle.root,
    ]);
  }

  /* =============================================================== live HUD */

  setCash(value: number): void {
    if (value === this.lastCash) return;
    this.lastCash = value;
    this.cashChip.set(value);
  }

  setGems(value: number): void {
    if (value === this.lastGems) return;
    this.lastGems = value;
    this.titleGems = value;
    this.gemChip.set(value);
  }

  /**
   * The backpack.
   *
   * The meter widget turns the fraction into the warn/full classes itself, and
   * the stylesheet turns "full" into a red pulse - a full bag silently eating
   * every swing is the single most frustrating thing this loop can do to a
   * player, so it is the loudest ambient signal in the HUD.
   */
  setBag(carried: number, capacity: number): void {
    if (carried === this.lastCarried && capacity === this.lastCapacity) return;
    this.lastCarried = carried;
    this.lastCapacity = capacity;
    const fraction = capacity > 0 ? carried / capacity : 0;
    this.bagMeter.set(fraction, `${formatShort(carried)} / ${formatShort(capacity)}`);
  }

  /** The primary progress read: how much of this haystack is gone. */
  setStack(clearedFraction: number, tierName: string): void {
    const permille = Math.round(clearedFraction * 1000);
    if (permille !== this.lastStackPermille) {
      this.lastStackPermille = permille;
      this.stackMeter.set(clearedFraction);
      setText(this.stackPct, `${(permille / 10).toFixed(1)}%`);
    }
    if (tierName !== this.lastTierName) {
      this.lastTierName = tierName;
      setText(this.stackName, tierName);
    }
  }

  setTool(name: string, icon: string, index: number, total: number): void {
    const key = `${name}|${icon}|${index}|${total}`;
    if (key === this.lastToolKey) return;
    this.lastToolKey = key;
    setText(this.toolIcon, icon);
    setText(this.toolName, name);
    setText(this.toolCount, `${Math.min(index + 1, total)}/${total}`);
  }

  /**
   * The interaction prompt.
   *
   * Hiding is `display: none`, which is deliberate: re-showing a `display:
   * none` element restarts its CSS animation from frame one, so the prompt
   * pops every time it appears without any reflow trickery.
   */
  setPrompt(prompt: HudPrompt): void {
    const key = prompt === null ? '' : `${prompt.key}|${prompt.label}|${prompt.blocked === true ? '1' : '0'}`;
    if (key === this.lastPromptKey) return;
    this.lastPromptKey = key;

    if (prompt === null) {
      this.prompt.classList.add('prompt--hidden');
      return;
    }
    setText(this.promptKey, prompt.key);
    setText(this.promptText, prompt.label);
    toggleClass(this.prompt, 'prompt--blocked', prompt.blocked === true);
    this.prompt.classList.remove('prompt--hidden');
  }

  /**
   * The crosshair.
   *
   * Four of the five states are a class swap. `far` is the exception: the
   * stylesheet has no rule for it, so it is expressed as a one-off opacity
   * write - a compositor-only property, written once per state change rather
   * than per frame, and cleared again the moment the state leaves `far` so the
   * `hidden` rule can win.
   */
  setCrosshair(state: CrosshairState): void {
    if (state === this.lastCrosshair) return;
    this.lastCrosshair = state;
    const list = this.crosshair.classList;
    list.toggle('crosshair--hidden', state === 'hidden');
    list.toggle('crosshair--hot', state === 'hot');
    list.toggle('crosshair--digging', state === 'digging');
    this.crosshair.style.opacity = state === 'far' ? '0.4' : '';
  }

  /**
   * The Hunch rail.
   *
   * It disappears entirely when the perk has not been bought - an empty ability
   * slot is UI that teaches the player nothing except that they are missing
   * something, and the perks panel already does that job properly.
   */
  setHunch(charges: number, ready: boolean, cooldown: number): void {
    const tenths = Math.round(cooldown * 10);
    const key = `${charges}|${ready ? 1 : 0}|${tenths}`;
    if (key === this.lastHunchKey) return;
    this.lastHunchKey = key;

    const visible = charges > 0 || cooldown > 0;
    this.hunchPanel.hidden = !visible;
    if (!visible) return;

    setText(this.hunchCount, `x${charges}`);
    // Full bar = ready. The wipe fills as the cooldown burns down, which reads
    // as "recharging" rather than "draining".
    const fraction = cooldown > 0 ? 1 - cooldown / HUNCH.cooldown : 1;
    this.hunchMeter.set(fraction);
    toggleClass(this.hunchPanel, 'is-pulsing', ready);
  }

  setFps(fps: number, visible: boolean, extra?: string): void {
    const key = visible ? `${Math.round(fps)}|${extra ?? ''}` : '';
    if (key === this.lastFpsKey) return;
    this.lastFpsKey = key;
    this.fpsPanel.hidden = !visible;
    if (!visible) return;
    setText(this.fpsText, extra === undefined ? `${Math.round(fps)} fps` : `${Math.round(fps)} fps  ${extra}`);
  }

  /* ============================================================== feedback */

  /** A world-anchored "+12". `x`/`y` are viewport pixels from the projector. */
  popup(x: number, y: number, text: string, kind: 'hay' | 'money' | 'gem' | 'big' | 'bad' = 'hay'): void {
    this.popups.spawn(x, y, text, { className: `popup--${kind}` });
  }

  toast(message: string, tone: 'info' | 'good' | 'bad' = 'info', icon?: string): void {
    this.toasts.push(message, { tone, icon });
  }

  /**
   * The big centre-screen line, e.g. "Sold 200 hay for $230!".
   *
   * This is a popup spawned at the centre of the viewport rather than a
   * separate component: same pooled node, same composited float-up, and the
   * viewport size comes from a cached `resize` value so nothing measures
   * anything at the moment of a sale.
   */
  banner(text: string, tone: 'good' | 'gem' = 'good'): void {
    const className = tone === 'gem' ? 'popup--big popup--gem' : 'popup--big popup--money';
    this.popups.spawn(this.viewWidth * 0.5, this.viewHeight * 0.36, text, { className, ms: 1600 });
  }

  /* ================================================================ modals */

  get modalOpen(): boolean {
    return this.modal.isOpen;
  }

  openShop(run: Run): void {
    this.run = run;
    this.present('shop', 'Farm Supply', true, () => this.renderShop());
  }

  openPerks(meta: Meta): void {
    this.meta = meta;
    this.present('perks', 'Permanent Perks', false, () => this.renderPerks());
  }

  openQuests(meta: Meta): void {
    this.meta = meta;
    this.present('quests', "Today's Jobs", false, () => this.renderQuests());
  }

  openRecords(meta: Meta): void {
    this.meta = meta;
    this.present('records', 'Records', true, () => this.renderRecords());
  }

  openTravel(meta: Meta, currentTier: number): void {
    this.meta = meta;
    this.travelIndex = currentTier;
    this.present('travel', 'Where to?', true, () => this.renderTravel());
  }

  openSettings(settings: SaveData['settings']): void {
    this.settings = settings;
    this.resetArmed = false;
    this.present('settings', 'Settings', false, () => this.renderSettings());
  }

  /**
   * Redraw the open dialog in place.
   *
   * Called after a purchase, when every price and every affordability colour in
   * the list may have moved. The scroll offset is read and restored around the
   * rebuild - the one place in this file that touches layout, justified because
   * a shop that jumps to the top on every click is unusable, and because it
   * happens on a click rather than in a frame.
   */
  refreshOpenModal(): void {
    if (this.modalKind === null || !this.modal.isOpen) return;
    const scroll = this.modal.body.scrollTop;
    switch (this.modalKind) {
      case 'shop':
        this.renderShop();
        break;
      case 'perks':
        this.renderPerks();
        break;
      case 'quests':
        this.renderQuests();
        break;
      case 'records':
        this.renderRecords();
        break;
      case 'travel':
        this.renderTravel();
        break;
      case 'settings':
        this.renderSettings();
        break;
    }
    this.modal.body.scrollTop = scroll;
  }

  closeModal(): void {
    if (!this.modal.isOpen) return;
    this.modal.close();
    this.modal.setTabs(null);
    clear(this.modal.body);
    this.modalKind = null;

    // A dialog opened from the title or the pause menu hid that surface,
    // because both sit *above* `--z-modal` and would otherwise cover it.
    if (this.screenUnderModal === 'title') this.title.classList.remove('u-hidden');
    else if (this.screenUnderModal === 'pause') this.pause.classList.remove('u-hidden');
    this.screenUnderModal = null;

    this.cb.onSound('ui_close');
    this.cb.onCloseModal();
  }

  /** Mount (or re-title) the shared dialog and run a renderer into its body. */
  private present(kind: ModalKind, title: string, wide: boolean, render: () => void): void {
    const wasOpen = this.modal.isOpen;
    this.modalKind = kind;
    this.modal.setTitle(title);
    this.modal.setTabs(null);
    this.modal.setFooterVisible(false);
    toggleClass(this.modal.panel, 'modal--wide', wide);
    render();

    if (wasOpen) return;
    if (!this.title.classList.contains('u-hidden')) {
      this.screenUnderModal = 'title';
      this.title.classList.add('u-hidden');
    } else if (!this.pause.classList.contains('u-hidden')) {
      this.screenUnderModal = 'pause';
      this.pause.classList.add('u-hidden');
    }
    this.modal.open();
    this.cb.onSound('ui_open');
  }

  /* ------------------------------------------------------------- the shop */

  private renderShop(): void {
    const run = this.run;
    clear(this.modal.body);
    if (run === null) return;

    // `tabs` selects its first item silently but `select()` notifies, and the
    // handler re-renders - which would build a new bar and select again, for
    // ever. The latch lets the restoring `select()` through as pure visual
    // state and only arms the handler once the bar matches the model.
    let live = false;
    const bar = tabs(
      [
        { id: 'upgrades', label: 'Upgrades' },
        { id: 'tools', label: 'Tools' },
      ],
      (id) => {
        if (!live) return;
        this.shopTab = id;
        this.renderShop();
      },
    );
    bar.select(this.shopTab);
    live = true;
    this.modal.setTabs(bar.root);

    const list = el('div.shop-list');
    if (this.shopTab === 'tools') {
      for (const row of run.toolRows()) list.appendChild(this.toolRow(row));
    } else {
      for (const row of run.upgradeRows()) list.appendChild(this.upgradeRow(row));
    }

    this.modal.body.append(
      el('p.settings__hint', {
        textContent: 'Upgrades and tools last for this haystack only. Spend it all.',
      }),
      list,
    );
  }

  private upgradeRow(row: UpgradeRow): HTMLElement {
    const { definition } = row;
    const state = row.maxed ? 'shop-row--maxed' : row.affordable ? 'shop-row--afford' : 'shop-row--poor';

    const stat = row.maxed
      ? statText(definition.unit, row.value)
      : `${statText(definition.unit, row.value)} → ${statText(definition.unit, row.next)}`;

    const buy = button('Buy', () => this.buyUpgrade(definition.id, false), 'buy');
    buy.classList.add('btn--sm');
    buy.disabled = row.maxed || !row.affordable;

    const buys = el('div.shop-row__buy', undefined, [
      costTag('💰', row.maxed ? 'MAX' : cashText(row.cost)),
      buy,
    ]);
    if (!row.maxed) {
      // "Max" only earns its place while there are levels left to sweep up.
      const max = button('Max', () => this.buyUpgrade(definition.id, true), 'primary');
      max.classList.add('btn--sm');
      max.disabled = !row.affordable;
      buys.appendChild(max);
    }

    return el('div.shop-row', { className: state }, [
      el('div.shop-row__icon', { textContent: definition.icon, attrs: { 'aria-hidden': 'true' } }),
      el('div.shop-row__main', undefined, [
        el('div.shop-row__name', { textContent: definition.name }),
        el('div.shop-row__blurb', { textContent: definition.blurb }),
        el('div.shop-row__stat', { textContent: stat }),
        pipStrip(row.level, definition.maxLevel),
      ]),
      buys,
    ]);
  }

  private toolRow(row: ToolRow): HTMLElement {
    const tool = row.definition;
    const state = row.equipped
      ? 'shop-row--maxed'
      : row.owned
        ? 'shop-row--afford'
        : row.affordable
          ? 'shop-row--afford'
          : 'shop-row--locked shop-row--poor';

    // Radius / bite / rhythm, in that order: it is the shape of the hole, how
    // deep it goes and how often you get to make one.
    const bite = tool.continuous ? `${trimNumber(tool.depth)} m/s` : `${trimNumber(tool.depth)} m/pull`;
    const rhythm = tool.continuous ? 'continuous' : `${trimNumber(tool.cooldown)} s`;
    const stats = `⌀ ${trimNumber(tool.radius * 2)} m  ·  ${bite}  ·  ${rhythm}`;

    const buys = el('div.shop-row__buy');
    if (!row.owned) {
      buys.appendChild(costTag('💰', cashText(tool.price)));
      const buy = button('Buy', () => this.buyTool(tool.id), 'buy');
      buy.classList.add('btn--sm');
      buy.disabled = !row.affordable;
      buys.appendChild(buy);
    } else if (row.equipped) {
      const equipped = button('Equipped', () => undefined, 'ghost');
      equipped.classList.add('btn--sm');
      equipped.disabled = true;
      buys.appendChild(equipped);
    } else {
      const equip = button('Equip', () => this.equipTool(tool.id), 'primary');
      equip.classList.add('btn--sm');
      buys.appendChild(equip);
    }

    return el('div.shop-row', { className: state }, [
      el('div.shop-row__icon', { textContent: TOOL_ICONS[tool.id], attrs: { 'aria-hidden': 'true' } }),
      el('div.shop-row__main', undefined, [
        el('div.shop-row__name', { textContent: tool.name }),
        el('div.shop-row__blurb', { textContent: tool.blurb }),
        el('div.shop-row__stat', { textContent: stats }),
      ]),
      buys,
    ]);
  }

  /* ------------------------------------------------------------ the perks */

  private renderPerks(): void {
    const meta = this.meta;
    clear(this.modal.body);
    if (meta === null) return;

    const list = el('div.shop-list');
    for (const row of meta.perkRows()) list.appendChild(this.perkRow(row));

    this.modal.body.append(
      el('div.u-row', undefined, [
        badge('💎', formatShort(meta.gems), 'chip--gem'),
        el('p.settings__hint', {
          textContent: 'Perks are permanent. They apply to every run you will ever play.',
        }),
      ]),
      list,
    );
  }

  private perkRow(row: PerkRow): HTMLElement {
    const perk = row.definition;
    const state = row.maxed ? 'shop-row--maxed' : row.affordable ? 'shop-row--afford' : 'shop-row--poor';

    const buys = el('div.shop-row__buy', undefined, costTag('💎', row.maxed ? 'MAX' : cashText(row.cost)));
    const buy = button(row.maxed ? 'Maxed' : 'Buy', () => this.buyPerk(perk.id), 'buy');
    buy.classList.add('btn--sm');
    buy.disabled = row.maxed || !row.affordable;
    buys.appendChild(buy);

    return el('div.shop-row', { className: state }, [
      el('div.shop-row__icon', { textContent: perk.icon, attrs: { 'aria-hidden': 'true' } }),
      el('div.shop-row__main', undefined, [
        el('div.shop-row__name', { textContent: perk.name }),
        el('div.shop-row__blurb', { textContent: perk.blurb }),
        el('div.shop-row__stat', { textContent: `Level ${row.level} / ${perk.maxLevel}` }),
        pipStrip(row.level, perk.maxLevel),
      ]),
      buys,
    ]);
  }

  /* ------------------------------------------------------------ the jobs */

  private renderQuests(): void {
    const meta = this.meta;
    clear(this.modal.body);
    if (meta === null) return;

    const list = el('div.quests');
    for (const quest of meta.activeQuests) list.appendChild(this.questRow(quest));

    this.modal.body.append(
      el('p.settings__hint', { textContent: 'Three jobs a day. They reset at midnight, wherever you are.' }),
      list,
    );
  }

  private questRow(quest: ActiveQuest): HTMLElement {
    const claimable = quest.completed && !quest.claimed;
    const bar = meter({ label: quest.description, className: 'quest__meter' });
    bar.set(quest.target > 0 ? quest.progress / quest.target : 0, `${formatShort(quest.progress)} / ${formatShort(quest.target)}`);

    const reward = el('div.quest__reward', undefined, badge('💎', String(quest.gemReward), 'chip--gem chip--sm'));
    if (claimable) {
      const claim = button('Claim', () => this.claimQuest(quest.id), 'buy');
      claim.classList.add('btn--sm');
      reward.appendChild(claim);
    } else if (quest.claimed) {
      reward.appendChild(el('span.u-label', { textContent: 'Claimed' }));
    }

    const classes = [quest.completed ? 'quest--done' : '', claimable ? 'quest--claimable' : '']
      .filter((name) => name !== '')
      .join(' ');

    return el('div.quest', { className: classes === '' ? undefined : classes }, [
      el('div.quest__icon', { textContent: QUEST_ICONS[quest.kind] ?? '📋', attrs: { 'aria-hidden': 'true' } }),
      el('div.quest__main', undefined, [
        el('div.quest__title', { textContent: quest.name }),
        bar.root,
      ]),
      reward,
    ]);
  }

  /* --------------------------------------------------------- the records */

  private renderRecords(): void {
    const meta = this.meta;
    clear(this.modal.body);
    if (meta === null) return;

    // See `renderShop` for why the handler is latched off during the restore.
    let live = false;
    const bar = tabs(
      [
        { id: 'records', label: 'Records' },
        { id: 'collection', label: 'Collection' },
      ],
      (id) => {
        if (!live) return;
        this.recordsTab = id;
        this.renderRecords();
      },
    );
    bar.select(this.recordsTab);
    live = true;
    this.modal.setTabs(bar.root);

    if (this.recordsTab === 'collection') {
      const found = new Set(meta.collection);
      const grid = el('div.collection');
      for (const treasure of TREASURES) grid.appendChild(this.collectionCell(treasure, found.has(treasure.id)));
      this.modal.body.append(
        el('p.settings__hint', {
          textContent: `${found.size} of ${TREASURES.length} oddities dug up.`,
        }),
        grid,
      );
      return;
    }

    const lifetime = el('div.settings__group', undefined, [
      el('div.settings__group-title', { textContent: 'Lifetime' }),
      statLine('Runs', formatExact(meta.stats.runs)),
      statLine('Needles found', formatExact(meta.stats.needlesFound)),
      statLine('Hay pulled', formatShort(meta.stats.hayPulled)),
      statLine('Golden bundles', formatExact(meta.stats.goldenPulled)),
      statLine('Oddities dug up', formatExact(meta.stats.treasuresFound)),
      statLine('Gems earned', formatShort(meta.stats.gemsEarned)),
    ]);

    const list = el('div.shop-list');
    for (const tier of TIERS) {
      const best = meta.bestTime(tier.id);
      const clear_ = meta.bestClear(tier.id);
      list.appendChild(
        el('div.shop-row', { className: best === null ? 'shop-row--locked' : 'shop-row--afford' }, [
          el('div.shop-row__icon', { textContent: '🌾', attrs: { 'aria-hidden': 'true' } }),
          el('div.shop-row__main', undefined, [
            el('div.shop-row__name', { textContent: tier.name }),
            el('div.shop-row__blurb', { textContent: `${formatShort(tier.straws)} straws` }),
            el('div.shop-row__stat', {
              textContent: `Best clear ${(clear_ * 100).toFixed(1)}%`,
            }),
          ]),
          el('div.shop-row__buy', undefined, [
            el('div.celebrate__stat-label', { textContent: 'Best time' }),
            el('div.shop-row__cost', undefined, el('span', { textContent: best === null ? '—' : formatClock(best) })),
          ]),
        ]),
      );
    }

    this.modal.body.append(lifetime, list);
  }

  /**
   * One treasure in the collection grid.
   *
   * Undiscovered entries are a greyed silhouette with the name still legible.
   * Blanking them out entirely would be tidier and much worse: knowing what is
   * missing is most of the reason a collection screen works at all.
   */
  private collectionCell(treasure: TreasureDefinition, found: boolean): HTMLElement {
    const rarity = `rarity-${treasure.rarity}`;
    const classes = found
      ? `cell--found ${rarity}${treasure.rarity === 'legendary' ? ' rarity-sweep' : ''}`
      : `cell--locked ${rarity}`;

    return el(
      'div.cell',
      {
        className: classes,
        title: found ? `${treasure.name} - ${treasure.flavour}` : 'Not found yet',
      },
      [
        el('div.cell__icon', { textContent: TREASURE_ICONS[treasure.id] ?? '❔', attrs: { 'aria-hidden': 'true' } }),
        el('div.cell__name', { textContent: found ? treasure.name : '???' }),
      ],
    );
  }

  /* ---------------------------------------------------------- the travel */

  private renderTravel(): void {
    const meta = this.meta;
    clear(this.modal.body);
    if (meta === null) return;

    const list = el('div.shop-list');
    TIERS.forEach((tier, index) => list.appendChild(this.travelRow(meta, tier, index)));

    this.modal.body.append(
      el('div.u-row', undefined, [
        badge('💎', formatShort(meta.gems), 'chip--gem'),
        el('p.settings__hint', { textContent: 'Travelling starts a fresh run. Cash and upgrades stay behind.' }),
      ]),
      list,
    );
  }

  private travelRow(meta: Meta, tier: TierDefinition, index: number): HTMLElement {
    const unlocked = meta.isTierUnlocked(index);
    const current = index === this.travelIndex;
    const best = meta.bestTime(tier.id);
    // Only the very next stack can be bought open; buying past that would let a
    // player skip the ladder the whole economy is tuned around.
    const buyable = !unlocked && index === meta.unlockedTiers + 1;

    const buys = el('div.shop-row__buy');
    if (unlocked) {
      const go = button(current ? 'Here' : 'Go', () => this.pickTier(index), 'primary');
      go.classList.add('btn--sm');
      go.disabled = current;
      buys.append(costTag('🕒', best === null ? '—' : formatClock(best)), go);
    } else {
      const key = button(`Unlock`, () => this.buyTierKey(index), 'buy');
      key.classList.add('btn--sm');
      key.disabled = !buyable || meta.gems < tier.gemKey;
      buys.append(costTag('💎', formatShort(tier.gemKey)), key);
    }

    const state = !unlocked ? 'shop-row--locked' : current ? 'shop-row--maxed' : 'shop-row--afford';

    return el('div.shop-row', { className: state }, [
      el('div.shop-row__icon', { textContent: unlocked ? '🌾' : '🔒', attrs: { 'aria-hidden': 'true' } }),
      el('div.shop-row__main', undefined, [
        el('div.shop-row__name', { textContent: tier.name }),
        el('div.shop-row__blurb', { textContent: tier.tagline }),
        el('div.shop-row__stat', {
          textContent: `${formatShort(tier.straws)} straws  ·  ${tier.needleGems} 💎 for the needle`,
        }),
      ]),
      buys,
    ]);
  }

  /* -------------------------------------------------------- the settings */

  private renderSettings(): void {
    const settings = this.settings;
    clear(this.modal.body);
    if (settings === null) return;

    const audio = el('div.settings__group', undefined, [
      el('div.settings__group-title', { textContent: 'Sound' }),
      slider({
        label: 'Master',
        min: 0,
        max: 1,
        step: 0.01,
        value: settings.masterVolume,
        format: percent,
        onInput: (value) => this.cb.onSettingChanged('masterVolume', value),
      }),
      slider({
        label: 'Music',
        min: 0,
        max: 1,
        step: 0.01,
        value: settings.musicVolume,
        format: percent,
        onInput: (value) => this.cb.onSettingChanged('musicVolume', value),
      }),
      slider({
        label: 'Effects',
        min: 0,
        max: 1,
        step: 0.01,
        value: settings.sfxVolume,
        format: percent,
        onInput: (value) => this.cb.onSettingChanged('sfxVolume', value),
      }),
    ]);

    const controls = el('div.settings__group', undefined, [
      el('div.settings__group-title', { textContent: 'Controls' }),
      slider({
        label: 'Look sensitivity',
        min: 0.2,
        max: 3,
        step: 0.05,
        value: settings.sensitivity,
        format: (value) => `${trimNumber(value)}x`,
        onInput: (value) => this.cb.onSettingChanged('sensitivity', value),
      }),
      slider({
        label: 'Field of view',
        min: 60,
        max: 100,
        step: 1,
        value: settings.fov,
        format: (value) => `${Math.round(value)}°`,
        onInput: (value) => this.cb.onSettingChanged('fov', value),
      }),
      toggle({
        label: 'Invert vertical look',
        value: settings.invertY,
        onChange: (value) => this.cb.onSettingChanged('invertY', value),
      }),
      toggle({
        label: 'Head bob',
        value: settings.headBob,
        onChange: (value) => this.cb.onSettingChanged('headBob', value),
      }),
    ]);

    // A real `<select>` wearing the button's clothes: the native control keeps
    // keyboard, touch and screen-reader behaviour, and `.btn` makes it look
    // like it belongs next to everything else.
    const quality = el<'select'>('select.btn.btn--sm', { attrs: { 'aria-label': 'Graphics quality' } });
    for (const option of QUALITY_OPTIONS) {
      quality.appendChild(el<'option'>('option', { value: option.value, textContent: option.label }));
    }
    quality.value = settings.quality;
    quality.addEventListener('change', () => this.cb.onSettingChanged('quality', quality.value));

    const display = el('div.settings__group', undefined, [
      el('div.settings__group-title', { textContent: 'Display' }),
      el('div.settings__row.u-row', undefined, [
        el('span.slider__label', { textContent: 'Quality' }),
        el('span.u-spacer'),
        quality,
      ]),
      toggle({
        label: 'Show FPS',
        value: settings.showFps,
        onChange: (value) => this.cb.onSettingChanged('showFps', value),
      }),
      toggle({
        label: 'Reduced motion',
        value: settings.reducedMotion,
        onChange: (value) => this.cb.onSettingChanged('reducedMotion', value),
      }),
      el('p.settings__hint', { textContent: 'Reduced motion calms screen shake, bobbing and UI animation.' }),
    ]);

    // Two steps, always. A one-click button that deletes every gem the player
    // has ever earned is not a button, it is a trap.
    const danger = el('div.settings__group', undefined, [
      el('div.settings__group-title', { textContent: 'Danger zone' }),
      el('p.settings__hint', {
        textContent: 'Erases gems, perks, records and your collection. There is no undo.',
      }),
    ]);
    if (this.resetArmed) {
      danger.append(
        el('div.u-row', undefined, [
          button('Yes, erase everything', () => {
            this.resetArmed = false;
            this.cb.onResetSave();
            this.refreshOpenModal();
          }, 'danger'),
          button('Cancel', () => {
            this.resetArmed = false;
            this.refreshOpenModal();
          }, 'ghost'),
        ]),
      );
    } else {
      danger.appendChild(
        button('Reset save', () => {
          this.resetArmed = true;
          this.refreshOpenModal();
        }, 'danger'),
      );
    }

    this.modal.body.appendChild(el('div.settings', undefined, [audio, controls, display, danger]));
  }

  /* =============================================================== actions */

  private onPlay(): void {
    this.title.classList.add('u-hidden');
    this.showHud();
    this.cb.onStartGame();
  }

  private resume(): void {
    this.hidePause();
    this.cb.onResume();
  }

  /**
   * Leave the run and go back to the title.
   *
   * There is no `onQuit` callback by design - quitting is a pure UI move. The
   * game keeps whatever run it has; pressing Continue simply comes back to it,
   * which is why the title is rebuilt with `hasRun` set from the caller.
   */
  private quitToTitle(hasRun: boolean): void {
    this.hideSummary();
    this.hidePause();
    this.showTitle({ hasRun, gems: this.titleGems, needles: this.titleNeedles });
  }

  private travelFromPause(): void {
    if (this.meta === null) return;
    this.openTravel(this.meta, this.travelIndex);
  }

  private toggleCredits(): void {
    const credits = 'Design, code and hay by the Find the Needle team. Built on three.js.';
    const foot = 'Made with hay, sunshine and three.js.';
    setText(this.titleFoot, this.titleFoot.textContent === credits ? foot : credits);
  }

  // Each of these fires the callback and then redraws from the (now changed)
  // source. The game is expected to call `refreshOpenModal()` too; doing it
  // here as well costs one extra render of a list that is only rebuilt on a
  // click, and it means a panel can never sit there showing a stale price.
  private buyUpgrade(id: UpgradeId, max: boolean): void {
    this.cb.onBuyUpgrade(id, max);
    this.refreshOpenModal();
  }

  private buyTool(id: ToolId): void {
    this.cb.onBuyTool(id);
    this.refreshOpenModal();
  }

  private equipTool(id: ToolId): void {
    this.cb.onEquipTool(id);
    this.refreshOpenModal();
  }

  private buyPerk(id: PerkId): void {
    this.cb.onBuyPerk(id);
    this.refreshOpenModal();
  }

  private claimQuest(id: string): void {
    this.cb.onClaimQuest(id);
    this.refreshOpenModal();
  }

  private buyTierKey(index: number): void {
    this.cb.onBuyTierKey(index);
    this.refreshOpenModal();
  }

  private pickTier(index: number): void {
    this.closeModal();
    this.showHud();
    this.cb.onPickTier(index);
  }

  /* =============================================================== plumbing */

  private readonly onResize = (): void => {
    // Cached rather than read on demand: `banner()` fires in the middle of a
    // sale, and a viewport query there can flush pending layout.
    this.viewWidth = window.innerWidth;
    this.viewHeight = window.innerHeight;
    this.applyLayout();
  };

  /**
   * Move the backpack meter between the corners at the phone breakpoint.
   *
   * On a wide screen the top-left corner is the bag meter with the cash chip
   * beneath it - the proven reading order, since bag pressure and money are
   * the two numbers a player checks together.
   *
   * That column is about 100px tall, and below 520px the stylesheet drops the
   * stack bar onto its own full-width row 46px from the top, which is sized
   * for a strip of chips and nothing more. Leaving the column there puts the
   * stack bar straight through the cash chip. So on a phone the meter moves
   * down to `.hud__bottom-left`, a stretch column already shaped for exactly
   * this, and the top strip is left holding only the chip it has room for.
   *
   * Reparenting rather than restyling keeps the decision in one place instead
   * of smearing it across a media query the stylesheet does not own. It runs
   * on `resize` and only when the breakpoint actually flips, so it is never in
   * the frame path.
   */
  private applyLayout(): void {
    const narrow = this.viewWidth <= 520;
    if (narrow === this.narrowLayout) return;
    this.narrowLayout = narrow;
    if (narrow) this.bottomLeft.prepend(this.bagPanel);
    else this.topLeftColumn.prepend(this.bagPanel);
    // The keyboard hints go with it: they are the widest thing in the bottom
    // corners, they collide with the relocated meter, and a phone has no Q key
    // to press anyway.
    this.hintsPanel.hidden = narrow;

    // The stack panel collapses from four stacked lines to two. On a phone the
    // stylesheet gives it its own full-width row 46px down and starts the
    // toasts at 110px, so it has about 64px to live in - the tier name and the
    // percentage move up beside the label rather than below it.
    if (narrow) {
      this.stackRow.append(this.stackName, this.stackPct);
    } else {
      this.stackPanel.insertBefore(this.stackPct, this.stackMeter.root);
      this.stackPanel.insertBefore(this.stackName, this.stackMeter.root);
    }
  }

  /**
   * One click listener for the whole overlay.
   *
   * `closest` walks a handful of ancestors at most and only runs on a real
   * click, which is cheaper and far less forgettable than attaching a sound
   * hook to every button in six panels.
   */
  private readonly onDelegatedClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.btn, .tab, .toggle, .cell') === null) return;
    this.cb.onSound('ui_click');
  };

  private readonly onDelegatedHover = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const hit = target.closest('.btn, .tab, .shop-row, .cell, .quest');
    // `pointerover` fires for every descendant crossed; comparing against the
    // last hit collapses that into one sound per control entered.
    if (hit === null || hit === this.hoverTarget) {
      this.hoverTarget = hit;
      return;
    }
    this.hoverTarget = hit;
    this.cb.onSound('ui_hover');
  };

  private startTips(): void {
    let index = 0;
    this.tipTimer = setInterval(() => {
      index = (index + 1) % LOADING_TIPS.length;
      setText(this.loadingTip, LOADING_TIPS[index] ?? '');
    }, TIP_INTERVAL_MS);
  }

  private stopTips(): void {
    if (this.tipTimer === null) return;
    clearInterval(this.tipTimer);
    this.tipTimer = null;
  }

  private clearCountUps(): void {
    for (const timer of this.countUpTimers) clearTimeout(timer);
    this.countUpTimers.length = 0;
  }

  /** Tear everything down. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stopTips();
    this.clearCountUps();
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }

    window.removeEventListener('resize', this.onResize);
    this.root.removeEventListener('click', this.onDelegatedClick);
    this.root.removeEventListener('pointerover', this.onDelegatedHover);

    this.modal.dispose();
    this.toasts.dispose();
    this.popups.dispose();

    this.hud.remove();
    this.title.remove();
    this.pause.remove();
    this.celebrate.remove();
    this.loading.remove();

    this.run = null;
    this.meta = null;
    this.settings = null;
  }
}

/** Volume sliders read as percentages; everything else keeps its own unit. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

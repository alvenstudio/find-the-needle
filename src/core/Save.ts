import { Signal } from './Signals';

/**
 * Versioned local persistence.
 *
 * The save file is the only thing in the project that outlives a deploy, so it
 * is treated like a database schema: every shape change bumps `SAVE_VERSION`
 * and adds a migration, and a save that cannot be migrated is archived under a
 * separate key rather than silently thrown away.
 *
 * Note what is *not* in here. Cash, upgrade levels and owned tools belong to a
 * run and die with it; only the run currently in progress is stored, so closing
 * the tab mid-stack and coming back tomorrow resumes exactly where you were.
 */

export const SAVE_VERSION = 2;
const STORAGE_KEY = 'find-the-needle/save';
const BACKUP_KEY = 'find-the-needle/save.broken';
const AUTOSAVE_INTERVAL = 10;

/** A run in progress, serialised. */
export interface RunSnapshot {
  tierId: string;
  seed: number;
  /** Seconds of play in this run. */
  elapsed: number;
  cash: number;
  upgrades: Record<string, number>;
  tools: string[];
  activeTool: string;
  /** Cubic metres of hay already taken out of the stack. */
  removedVolume: number;
  /** Ids of buried things already dug up. */
  claimed: string[];
  carried: number;
  hayPulled: number;
  goldenPulled: number;
  pulls: number;
  hunchesUsed: number;
}

export interface QuestState {
  id: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
}

export interface SaveData {
  version: number;
  createdAt: number;
  updatedAt: number;
  playTime: number;

  /** The only currency that crosses a run boundary. */
  gems: number;
  /** Perk id -> purchased level. Permanent. */
  perks: Record<string, number>;
  /** Highest tier index the player may start a run on. */
  unlockedTiers: number;
  /** Treasure ids ever discovered. */
  collection: string[];

  quests: QuestState[];
  questDay: string;

  /** The run in progress, or null when the player is between runs. */
  run: RunSnapshot | null;

  stats: {
    runs: number;
    needlesFound: number;
    hayPulled: number;
    haySold: number;
    cashEarned: number;
    gemsEarned: number;
    treasuresFound: number;
    goldenPulled: number;
    pulls: number;
    distanceWalked: number;
    /** Fastest needle per tier, in seconds. */
    bestTimes: Record<string, number>;
    /** Highest cleared fraction reached per tier, 0..1. */
    bestClears: Record<string, number>;
  };

  settings: {
    quality: string;
    masterVolume: number;
    musicVolume: number;
    sfxVolume: number;
    sensitivity: number;
    invertY: boolean;
    fov: number;
    headBob: boolean;
    showFps: boolean;
    reducedMotion: boolean;
  };
}

export function createSave(now = Date.now()): SaveData {
  return {
    version: SAVE_VERSION,
    createdAt: now,
    updatedAt: now,
    playTime: 0,
    gems: 0,
    perks: {},
    unlockedTiers: 0,
    collection: [],
    quests: [],
    questDay: '',
    run: null,
    stats: {
      runs: 0,
      needlesFound: 0,
      hayPulled: 0,
      haySold: 0,
      cashEarned: 0,
      gemsEarned: 0,
      treasuresFound: 0,
      goldenPulled: 0,
      pulls: 0,
      distanceWalked: 0,
      bestTimes: {},
      bestClears: {},
    },
    settings: {
      quality: 'auto',
      masterVolume: 0.85,
      musicVolume: 0.45,
      sfxVolume: 1,
      sensitivity: 1,
      invertY: false,
      fov: 74,
      headBob: true,
      showFps: false,
      reducedMotion: false,
    },
  };
}

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Migrations run in order from the save's version up to `SAVE_VERSION`.
 * Index 0 upgrades a version-0 file to version 1, and so on.
 */
const MIGRATIONS: Migration[] = [
  // 0 -> 1: no version-0 file ever shipped; treat it as a fresh save.
  () => createSave() as unknown as Record<string, unknown>,

  /**
   * 1 -> 2: the persistent-bank model became per-run.
   *
   * Cash, upgrade levels, owned tools and the cash-gated tier ladder all went
   * away. Gems, perks and the collection carry over untouched, and the tier the
   * player had reached becomes the tier they may start a run on, so nobody
   * loses access to a stack they had already earned.
   */
  (old) => {
    const fresh = createSave() as unknown as Record<string, unknown>;
    const stats = (old.stats ?? {}) as Record<string, unknown>;
    fresh.gems = numberOr(old.gems, 0);
    fresh.perks = (old.perks as Record<string, number>) ?? {};
    fresh.unlockedTiers = numberOr(old.tier, 0);
    fresh.collection = Array.isArray(old.collection) ? old.collection : [];
    fresh.playTime = numberOr(old.playTime, 0);
    fresh.createdAt = numberOr(old.createdAt, Date.now());

    const target = fresh.stats as SaveData['stats'];
    target.needlesFound = numberOr(stats.needlesFound, 0);
    target.haySold = numberOr(stats.haySold, 0);
    target.hayPulled = numberOr(stats.hayCollected, 0);
    target.pulls = numberOr(stats.digs, 0);
    target.treasuresFound = numberOr(stats.secretsFound, 0);
    target.distanceWalked = numberOr(stats.distanceWalked, 0);
    target.bestTimes = (stats.bestTimes as Record<string, number>) ?? {};
    return fresh;
  },
];

export class SaveManager {
  readonly saved = new Signal<SaveData>();
  readonly loadFailed = new Signal<string>();

  private data: SaveData;
  private sinceAutosave = 0;
  private dirty = false;

  constructor() {
    this.data = this.read();
  }

  get state(): SaveData {
    return this.data;
  }

  /** Mark the save dirty; the next autosave tick flushes it. */
  touch(): void {
    this.dirty = true;
  }

  update(dt: number): void {
    this.data.playTime += dt;
    this.sinceAutosave += dt;
    if (this.sinceAutosave >= AUTOSAVE_INTERVAL) {
      this.sinceAutosave = 0;
      if (this.dirty) this.flush();
    }
  }

  flush(): void {
    this.dirty = false;
    this.data.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.saved.emit(this.data);
    } catch (error) {
      // Quota or a private-mode block. The game keeps running in memory.
      console.warn('[save] could not persist', error);
    }
  }

  reset(): SaveData {
    this.data = createSave();
    this.flush();
    return this.data;
  }

  replace(data: SaveData): void {
    this.data = data;
    this.flush();
  }

  /** Base64 of the UTF-8 JSON, safe for the clipboard. */
  export(): string {
    const bytes = new TextEncoder().encode(JSON.stringify(this.data));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  import(encoded: string): boolean {
    try {
      const bytes = Uint8Array.from(atob(encoded.trim()), (character) => character.charCodeAt(0));
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const migrated = migrate(parsed);
      if (!migrated) return false;
      this.replace(migrated);
      return true;
    } catch {
      return false;
    }
  }

  private read(): SaveData {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return createSave();
    }
    if (!raw) return createSave();

    try {
      const migrated = migrate(JSON.parse(raw) as Record<string, unknown>);
      if (migrated) return migrated;
      throw new Error('unsupported save version');
    } catch (error) {
      // Never destroy a player's file. Park it and start fresh.
      try {
        localStorage.setItem(BACKUP_KEY, raw);
      } catch {
        /* nothing more we can do */
      }
      this.loadFailed.emit(String(error));
      return createSave();
    }
  }
}

/** Bring a parsed object up to the current schema, or return null if we cannot. */
function migrate(parsed: Record<string, unknown>): SaveData | null {
  let version = typeof parsed.version === 'number' ? parsed.version : 0;
  if (version > SAVE_VERSION) return null;

  let working = parsed;
  while (version < SAVE_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) return null;
    working = migration(working);
    version++;
  }
  working.version = SAVE_VERSION;
  // Fill in anything a migration or a hand-edited file left out.
  return deepDefaults(working as unknown as SaveData, createSave());
}

/** Recursively fill missing keys from `fallback` without touching present ones. */
function deepDefaults<T>(value: T, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof fallback !== 'object' || Array.isArray(fallback)) return value;
  const target = value as Record<string, unknown>;
  const source = fallback as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    target[key] = deepDefaults(target[key], source[key]);
  }
  return target as T;
}

import { Signal } from './Signals';

/**
 * Versioned local persistence.
 *
 * The save file is the only thing in the project that outlives a deploy, so it
 * is treated like a database schema: every shape change bumps `SAVE_VERSION`
 * and adds a migration, and a save that cannot be migrated is archived under a
 * separate key rather than silently thrown away.
 */

export const SAVE_VERSION = 1;
const STORAGE_KEY = 'find-the-needle/save';
const BACKUP_KEY = 'find-the-needle/save.broken';
const AUTOSAVE_INTERVAL = 12;

export interface StackProgress {
  /** Seed the pile was generated from. */
  seed: number;
  /** Straw units removed so far. */
  removed: number;
  /** Ids of buried things already dug up in this stack. */
  claimed: string[];
  /** Seconds spent on this stack. */
  elapsed: number;
}

export interface QuestState {
  id: string;
  progress: number;
  completed: boolean;
  claimedAt: number;
}

export interface SaveData {
  version: number;
  createdAt: number;
  updatedAt: number;

  playTime: number;
  money: number;
  gems: number;

  /** Upgrade id -> purchased level. */
  upgrades: Record<string, number>;
  unlockedTools: string[];
  activeTool: string;

  /** Index into the tier table; every tier at or below this is unlocked. */
  tier: number;
  stacks: Record<string, StackProgress>;

  rebirths: number;
  /** Treasure ids discovered across the whole save. */
  collection: string[];
  quests: QuestState[];
  questDay: string;

  stats: {
    hayCollected: number;
    haySold: number;
    moneyEarned: number;
    needlesFound: number;
    secretsFound: number;
    distanceWalked: number;
    digs: number;
    bestTimes: Record<string, number>;
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
    money: 0,
    gems: 0,
    upgrades: {},
    unlockedTools: ['hands'],
    activeTool: 'hands',
    tier: 0,
    stacks: {},
    rebirths: 0,
    collection: [],
    quests: [],
    questDay: '',
    stats: {
      hayCollected: 0,
      haySold: 0,
      moneyEarned: 0,
      needlesFound: 0,
      secretsFound: 0,
      distanceWalked: 0,
      digs: 0,
      bestTimes: {},
    },
    settings: {
      quality: 'auto',
      masterVolume: 0.85,
      musicVolume: 0.5,
      sfxVolume: 1,
      sensitivity: 1,
      invertY: false,
      fov: 72,
      headBob: true,
      showFps: false,
      reducedMotion: false,
    },
  };
}

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migrations run in order from the save's version up to `SAVE_VERSION`.
 * Index 0 upgrades a version-0 file to version 1, and so on.
 */
const MIGRATIONS: Migration[] = [];

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

  /** Mark the save dirty; the next autosave tick will flush it. */
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

  /** Replace the whole save, e.g. from an imported string. */
  replace(data: SaveData): void {
    this.data = data;
    this.flush();
  }

  export(): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(this.data))));
  }

  import(encoded: string): boolean {
    try {
      const parsed = JSON.parse(decodeURIComponent(escape(atob(encoded.trim())))) as Record<string, unknown>;
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

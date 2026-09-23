// Yandex Games SDK wrapper — drop-in module for three.js / any browser game.
//
// Design goals (each maps to a moderation requirement, see references/requirements.md):
//  - Single init, every SDK promise timeout-guarded: a stalled wrapper never hangs the boot
//    and never prevents LoadingAPI.ready() (1.19.2).
//  - Language from environment.i18n.lang is applied through `onLang` the moment init
//    resolves — call initYSDK() BEFORE building any UI (2.14).
//  - Graceful degradation without the SDK (plain `vite dev`): ads resolve immediately,
//    purchases grant immediately, saves go to a localStorage mirror, serverTime → Date.now().
//  - Purchases: grant → flush save → consumePurchase; pending purchases processed at launch (1.13.1).
//  - Prices: value + currency icon straight from IProduct (1.13.2).
//  - Pause/resume + GameplayAPI markup de-duplicated (1.19.3/1.19.4, 1.3, 4.7).
//
// No dependencies. Copy into src/ysdk.ts, wire `onLang` to your i18n setLang(), and keep the
// rest of the game free of any direct window.YaGames access.

// ---------------------------------------------------------------------------
// Minimal SDK typings (subset of @types/ysdk 1.2.0 that this module uses)
// ---------------------------------------------------------------------------

export interface IProduct {
  id: string;
  title: string;
  description: string;
  imageURI: string;
  price: string;              // "<value> <code>", e.g. "49 YAN"
  priceValue: string;         // "49"
  priceCurrencyCode: string;  // "YAN" (or "TST" under the moderator's currency mock)
  getPriceCurrencyImage: (size: "small" | "medium" | "svg") => string;
}

export interface IPurchase {
  productID: string;
  purchaseToken: string;
  developerPayload?: string;
}

export interface ILeaderboardEntry {
  score: number;
  formattedScore?: string;
  rank: number;
  extraData?: string;
  player: {
    publicName: string;
    uniqueID: string;
    getAvatarSrc: (size?: "small" | "medium" | "large") => string;
  };
}

interface AdvCallbacks {
  onOpen?: () => void;
  onRewarded?: () => void;
  onClose?: (wasShown: boolean) => void;
  onError?: (error: unknown) => void;
  onOffline?: () => void;
}

interface PlayerAPI {
  getData: (keys?: string[]) => Promise<Record<string, unknown>>;
  setData: (data: object, flush?: boolean) => Promise<void>;
  getStats: (keys?: string[]) => Promise<Record<string, number>>;
  setStats: (stats: Record<string, number>) => Promise<void>;
  incrementStats: (increments: Record<string, number>) => Promise<{ stats: Record<string, number> }>;
  isAuthorized: () => boolean;
  getUniqueID: () => string;
  getName: () => string;
  getPhoto: (size: "small" | "medium" | "large") => string;
  getPayingStatus: () => "paying" | "partially_paying" | "not_paying" | "unknown";
}

interface PaymentsAPI {
  purchase: (opts: { id: string; developerPayload?: string }) => Promise<IPurchase>;
  getPurchases: () => Promise<IPurchase[]>;
  consumePurchase: (token: string) => Promise<void>;
  getCatalog: () => Promise<IProduct[]>;
}

interface YSDK {
  environment: {
    app: { id: string };
    browser?: { lang: string };
    i18n: { lang: string; tld?: string };
    payload?: string | null;
    referrer?: { type: "promo"; promoId: string; intent?: string; inappId?: string };
  };
  deviceInfo: { type: string; isMobile(): boolean; isDesktop(): boolean; isTablet(): boolean; isTV(): boolean };
  features: {
    LoadingAPI?: { ready: () => void };
    GameplayAPI?: { start: () => void; stop: () => void };
    GamesAPI?: {
      getAllGames: () => Promise<{ games: IOtherGame[]; developerURL: string }>;
      getGameByID: (id: number) => Promise<{ isAvailable: boolean; game?: IOtherGame }>;
    };
  };
  adv: {
    showFullscreenAdv: (opts?: { callbacks?: Omit<AdvCallbacks, "onRewarded"> }) => void;
    showRewardedVideo: (opts?: { callbacks?: AdvCallbacks }) => void;
    getBannerAdvStatus: () => Promise<{ stickyAdvIsShowing: boolean; reason?: string }>;
    showBannerAdv: () => Promise<{ reason?: string }>;
    hideBannerAdv: () => Promise<{ stickyAdvIsShowing: boolean }>;
  };
  auth: { openAuthDialog: () => Promise<void> };
  getPlayer: (opts?: { signed?: boolean; scopes?: boolean }) => Promise<PlayerAPI>;
  getPayments: (opts?: { signed?: boolean }) => Promise<PaymentsAPI>;
  leaderboards: {
    setScore: (name: string, score: number, extraData?: string) => Promise<void>;
    getPlayerEntry: (name: string) => Promise<ILeaderboardEntry>;
    getEntries: (name: string, opts?: { includeUser?: boolean; quantityAround?: number; quantityTop?: number }) =>
      Promise<{ entries: ILeaderboardEntry[]; userRank: number }>;
  };
  isAvailableMethod: (name: string) => Promise<boolean>;
  getFlags: (params?: { defaultFlags?: Record<string, string>; clientFeatures?: { name: string; value: string }[] }) =>
    Promise<Record<string, string>>;
  serverTime: () => number;
  feedback: {
    canReview: () => Promise<{ value: boolean; reason?: string }>;
    requestReview: () => Promise<{ feedbackSent: boolean }>;
  };
  shortcut: {
    canShowPrompt: () => Promise<{ canShow: boolean }>;
    showPrompt: () => Promise<{ outcome: "accepted" | "rejected" }>;
  };
  screen: { fullscreen: { status: "on" | "off"; request: () => Promise<void>; exit: () => Promise<void> } };
  clipboard: { writeText: (text: string) => void };
  EVENTS: { EXIT: "EXIT"; HISTORY_BACK: "HISTORY_BACK"; ACCOUNT_SELECTION_DIALOG_OPENED: string; ACCOUNT_SELECTION_DIALOG_CLOSED: string };
  on: (event: string, cb: (...args: unknown[]) => void) => (() => void) | void;
  off: (event: string, cb: (...args: unknown[]) => void) => void;
  dispatchEvent: (event: string, detail?: object) => Promise<unknown>;
}

export interface IOtherGame { appID: string; title: string; url: string; coverURL: string; iconURL: string }

declare global {
  interface Window {
    YaGames?: { init: (opts?: { signed?: boolean }) => Promise<YSDK> };
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface YSDKOptions {
  /** Called with the portal language (ISO 639-1) as soon as the SDK initialises. Wire to i18n.setLang(). */
  onLang?: (lang: string) => void;
  /** Key under which the whole save blob is stored (player.setData and the localStorage mirror). */
  saveKey?: string;
  /** Pass true if purchases are processed on your server (signature mode). Default false. */
  signed?: boolean;
  /** Log SDK warnings to the console. Default true. */
  log?: boolean;
}

const options: Required<YSDKOptions> = {
  onLang: () => {},
  saveKey: "save",
  signed: false,
  log: true,
};

function warn(...args: unknown[]): void {
  if (options.log) console.warn("[ysdk]", ...args);
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

let ysdkPromise: Promise<YSDK | null> | null = null;
let sdk: YSDK | null = null;
let detectedLang: string | null = null;

/** Resolve with `fallback` if `p` has not settled within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      warn(`${label} timed out after ${ms}ms`);
      resolve(fallback);
    }, ms);
    p.then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (err) => { if (!settled) { settled = true; clearTimeout(timer); warn(`${label} failed:`, err); resolve(fallback); } },
    );
  });
}

/**
 * Wait for /sdk.js to define window.YaGames. On a plain local server the script 404s; add
 * `onerror="window.__yaSdkMissing=true"` to the script tag (see assets/index.html) and the
 * wait ends immediately instead of after the timeout.
 */
async function waitForYaGames(timeoutMs = 4000): Promise<Window["YaGames"] | null> {
  const w = window as Window & { __yaSdkMissing?: boolean };
  if (w.YaGames) return w.YaGames;
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    if (w.__yaSdkMissing) return null;
    await new Promise((r) => setTimeout(r, 50));
    if (w.YaGames) return w.YaGames;
  }
  return null;
}

/**
 * Initialise the SDK once. Safe to call many times; the first call may pass options.
 * Resolves to null when the SDK is unavailable (local dev, blocked script) — every other
 * helper in this module then falls back to a local behaviour.
 */
export function initYSDK(opts?: YSDKOptions): Promise<YSDK | null> {
  if (!ysdkPromise) {
    Object.assign(options, opts ?? {});
    ysdkPromise = (async () => {
      const YaGames = await waitForYaGames();
      if (!YaGames) { warn("YaGames not found — running without the platform"); return null; }
      const instance = await withTimeout(YaGames.init({ signed: options.signed }), 10000, null, "YaGames.init");
      if (!instance) return null;
      sdk = instance;
      try {
        detectedLang = instance.environment?.i18n?.lang ?? null;
        if (detectedLang) options.onLang(detectedLang);
      } catch (err) {
        warn("environment.i18n unavailable:", err);
      }
      installPlatformEvents(instance);
      return instance;
    })();
  }
  return ysdkPromise;
}

/** True once init resolved with a live SDK. */
export function hasSDK(): boolean { return sdk !== null; }

/** Portal language reported by the SDK, or null before init / without the SDK. */
export function getDetectedLang(): string | null { return detectedLang; }

export function getAppId(): string | null { return sdk?.environment?.app?.id ?? null; }
export function getPayload(): string | null { return sdk?.environment?.payload ?? null; }
export function getReferrer(): YSDK["environment"]["referrer"] | null { return sdk?.environment?.referrer ?? null; }

export type DeviceType = "desktop" | "mobile" | "tablet" | "tv";
/** Device class from the SDK, with a user-agent guess when the SDK is absent. */
export function deviceType(): DeviceType {
  const t = sdk?.deviceInfo?.type;
  if (t === "desktop" || t === "mobile" || t === "tablet" || t === "tv") return t;
  const ua = navigator.userAgent;
  if (/TV|SmartTV|Tizen|Web0S/i.test(ua)) return "tv";
  if (/iPad|Tablet/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone/i.test(ua)) return "mobile";
  return "desktop";
}
export function isTV(): boolean { return deviceType() === "tv"; }
export function isTouchDevice(): boolean { const t = deviceType(); return t === "mobile" || t === "tablet"; }

// ---------------------------------------------------------------------------
// Loading / gameplay markup / platform pause-resume
// ---------------------------------------------------------------------------

let readyCalled = false;
/** Tell Yandex the game is fully loaded and interactive. Idempotent. Call it at the exact moment the player can act. */
export async function loadingReady(): Promise<void> {
  if (readyCalled) return;
  readyCalled = true;
  const s = await initYSDK();
  try { s?.features.LoadingAPI?.ready(); } catch (err) { warn("LoadingAPI.ready failed", err); }
}

let gameplayActive = false;
/**
 * Gameplay markup with de-duplication: start() only when going inactive → active and vice
 * versa, so menus, ads and platform pauses can all call it freely.
 */
export function setGameplayActive(active: boolean): void {
  if (active === gameplayActive) return;
  gameplayActive = active;
  const api = sdk?.features.GameplayAPI;
  if (!api) return;
  try { active ? api.start() : api.stop(); } catch (err) { warn("GameplayAPI failed", err); }
}
export function isGameplayActive(): boolean { return gameplayActive; }

const pauseListeners = new Set<() => void>();
const resumeListeners = new Set<() => void>();
let platformPaused = false;

function installPlatformEvents(s: YSDK): void {
  try {
    s.on("game_api_pause", () => { platformPaused = true; for (const fn of pauseListeners) fn(); });
    s.on("game_api_resume", () => { platformPaused = false; for (const fn of resumeListeners) fn(); });
  } catch (err) {
    warn("pause/resume subscription failed", err);
  }
}

/** Platform asks to pause (ad opened, purchase window, tab hidden, startup interstitial). Pause loop + audio. */
export function onPlatformPause(fn: () => void): () => void { pauseListeners.add(fn); return () => { pauseListeners.delete(fn); }; }
/** Platform asks to resume. Resume loop + audio; start the game here if it was still waiting. */
export function onPlatformResume(fn: () => void): () => void { resumeListeners.add(fn); return () => { resumeListeners.delete(fn); }; }
/** True while the platform holds the game paused (e.g. the startup ad is still open). */
export function isPlatformPaused(): boolean { return platformPaused; }

// ---------------------------------------------------------------------------
// Player + cloud save (with localStorage mirror)
// ---------------------------------------------------------------------------

let playerPromise: Promise<PlayerAPI | null> | null = null;

async function getPlayer(): Promise<PlayerAPI | null> {
  if (!playerPromise) {
    playerPromise = (async () => {
      const s = await initYSDK();
      if (!s) return null;
      // scopes:false — no personal-data prompt; anonymous players get cloud saves silently.
      return await withTimeout(s.getPlayer({ scopes: false }), 10000, null, "getPlayer");
    })();
  }
  return playerPromise;
}

export async function isAuthorized(): Promise<boolean> {
  const p = await getPlayer();
  try { return p?.isAuthorized() ?? false; } catch { return false; }
}

/**
 * Open the Yandex ID login dialog. Only call from a deliberate, clearly labelled button
 * whose prompt explains the benefit (req. 1.2.1). Re-creates the cached player on success.
 */
export async function openAuthDialog(): Promise<boolean> {
  const s = await initYSDK();
  if (!s) return false;
  try {
    await s.auth.openAuthDialog();
    playerPromise = null;
    const p = await getPlayer();
    return p?.isAuthorized() ?? false;
  } catch (err) {
    warn("openAuthDialog failed:", err);
    return false;
  }
}

export interface PlayerProfile { id: string; authorized: boolean; name: string; photo: string; payingStatus: string }
export async function getPlayerProfile(): Promise<PlayerProfile | null> {
  const p = await getPlayer();
  if (!p) return null;
  try {
    return {
      id: p.getUniqueID(),
      authorized: p.isAuthorized(),
      name: p.getName(),
      photo: p.getPhoto("medium"),
      payingStatus: p.getPayingStatus(),
    };
  } catch (err) { warn("player profile failed:", err); return null; }
}

function readMirror(): unknown | null {
  try { const raw = localStorage.getItem(`ysdk:${options.saveKey}`); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeMirror(data: object | null): void {
  try {
    if (data === null) localStorage.removeItem(`ysdk:${options.saveKey}`);
    else localStorage.setItem(`ysdk:${options.saveKey}`, JSON.stringify(data));
  } catch { /* private mode / quota */ }
}

/**
 * Load the save blob: cloud when available (timeout-guarded), otherwise the local mirror.
 * Returns null for a brand-new player.
 */
export async function loadCloudSave(): Promise<unknown | null> {
  const player = await getPlayer();
  if (player) {
    const data = await withTimeout<Record<string, unknown> | null>(player.getData([options.saveKey]), 10000, null, "getData");
    if (data && data[options.saveKey] != null) return data[options.saveKey];
    if (data) return null; // cloud reachable and empty → genuinely new (don't resurrect a stale mirror)
  }
  return readMirror();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPayload: object | null = null;
let inflight: Promise<void> | null = null;

async function flushPending(immediate: boolean): Promise<void> {
  if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null; }
  const payload = pendingPayload;
  if (!payload) return;
  pendingPayload = null;
  const player = await getPlayer();
  if (!player) return;
  inflight = player.setData({ [options.saveKey]: payload }, immediate).catch((err) => warn("setData failed:", err));
  await inflight;
  inflight = null;
}

/**
 * Queue a save. The local mirror is written synchronously (progress "saved right after the
 * action", req. 1.9); the cloud write is coalesced to stay under 100 calls / 5 min.
 */
export function saveCloudDebounced(data: object, delayMs = 1500): void {
  writeMirror(data);
  pendingPayload = data;
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushPending(false), delayMs);
}

/** Send any pending save now (page hide, before consuming a purchase, after milestones). */
export async function flushCloudSave(): Promise<void> {
  if (pendingPayload) await flushPending(true);
  else if (inflight) await inflight;
}

/** Wipe the save (cloud + mirror). Cancels pending writes first so they cannot resurrect old data. */
export async function clearCloudSave(): Promise<void> {
  pendingPayload = null;
  if (saveTimer != null) { clearTimeout(saveTimer); saveTimer = null; }
  writeMirror(null);
  const player = await getPlayer();
  if (!player) return;
  try { await player.setData({ [options.saveKey]: null }, true); } catch (err) { warn("clear save failed:", err); }
}

/** Numeric stats (10 KB, 60 calls/min). Atomic increments — ideal for currency and XP. */
export async function incrementStats(increments: Record<string, number>): Promise<Record<string, number> | null> {
  const player = await getPlayer();
  if (!player) return null;
  try { return (await player.incrementStats(increments)).stats; } catch (err) { warn("incrementStats failed:", err); return null; }
}
export async function getStats(keys?: string[]): Promise<Record<string, number> | null> {
  const player = await getPlayer();
  if (!player) return null;
  try { return await player.getStats(keys); } catch (err) { warn("getStats failed:", err); return null; }
}

if (typeof window !== "undefined") {
  window.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void flushCloudSave(); });
  window.addEventListener("pagehide", () => { void flushCloudSave(); });
}

// ---------------------------------------------------------------------------
// Ads
// ---------------------------------------------------------------------------

export interface AdHooks {
  /** Freeze simulation + suspend audio. */
  onOpen?: () => void;
  /** Unfreeze + resume audio. Always fires exactly once, even on error / offline / not shown. */
  onClose?: (wasShown: boolean) => void;
}

/**
 * Interstitial. Only call at a logical pause right after a non-gameplay action (Next,
 * Retry, Store…) — req. 4.4. Gameplay markup is stopped/started around it.
 */
export async function showInterstitial(hooks: AdHooks = {}): Promise<void> {
  const s = await initYSDK();
  if (!s) { hooks.onClose?.(false); return; }
  const wasActive = gameplayActive;
  let settled = false;
  const finish = (wasShown: boolean) => {
    if (settled) return;
    settled = true;
    hooks.onClose?.(wasShown);
    if (wasActive) setGameplayActive(true);
  };
  try {
    s.adv.showFullscreenAdv({
      callbacks: {
        onOpen: () => { setGameplayActive(false); hooks.onOpen?.(); },
        onClose: (wasShown) => finish(wasShown),
        onError: (err) => { warn("interstitial error", err); finish(false); },
        onOffline: () => finish(false),
      },
    });
  } catch (err) {
    warn("showFullscreenAdv threw:", err);
    finish(false);
  }
}

/**
 * Rewarded video. `onReward` runs only on Yandex's onRewarded (impression counted) — req. 4.5.
 * Without the SDK the reward is granted immediately so local playtesting works.
 */
export async function showRewarded(onReward: () => void, hooks: AdHooks = {}): Promise<void> {
  const s = await initYSDK();
  if (!s) { onReward(); hooks.onClose?.(true); return; }
  const wasActive = gameplayActive;
  let settled = false;
  const finish = (wasShown: boolean) => {
    if (settled) return;
    settled = true;
    hooks.onClose?.(wasShown);
    if (wasActive) setGameplayActive(true);
  };
  try {
    s.adv.showRewardedVideo({
      callbacks: {
        onOpen: () => { setGameplayActive(false); hooks.onOpen?.(); },
        onRewarded: () => { try { onReward(); } catch (err) { warn("reward handler threw", err); } },
        onClose: () => finish(true),
        onError: (err) => { warn("rewarded error", err); finish(false); },
      },
    });
  } catch (err) {
    warn("showRewardedVideo threw:", err);
    finish(false);
  }
}

/** Sticky banner control (requires "Use the API to display a sticky banner" in the console). */
export async function setStickyBanner(visible: boolean): Promise<void> {
  const s = await initYSDK();
  if (!s) return;
  try {
    if (visible) await s.adv.showBannerAdv();
    else await s.adv.hideBannerAdv();
  } catch (err) { warn("sticky banner failed:", err); }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

let paymentsPromise: Promise<PaymentsAPI | null> | null = null;
let catalogPromise: Promise<void> | null = null;
const catalog = new Map<string, IProduct>();
const catalogListeners = new Set<() => void>();

async function getPayments(): Promise<PaymentsAPI | null> {
  if (!paymentsPromise) {
    paymentsPromise = (async () => {
      const s = await initYSDK();
      if (!s) return null;
      try { return await s.getPayments({ signed: options.signed }); }
      catch (err) { warn("getPayments failed (purchases not enabled?):", err); return null; }
    })();
  }
  return paymentsPromise;
}

/** True when the shop can be shown (SDK present and purchases enabled for this game). */
export async function purchasesAvailable(): Promise<boolean> { return (await getPayments()) !== null; }

/** Fetch and cache the catalog once. Listeners fire when it arrives (or when it fails, so UI can fall back). */
export function loadCatalog(): Promise<void> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const p = await getPayments();
      if (p) {
        try { for (const product of await p.getCatalog()) catalog.set(product.id, product); }
        catch (err) { warn("getCatalog failed:", err); }
      }
      for (const fn of catalogListeners) fn();
    })();
  }
  return catalogPromise;
}
export function onCatalogReady(fn: () => void): () => void {
  if (catalogPromise && catalog.size > 0) queueMicrotask(fn);
  catalogListeners.add(fn);
  return () => { catalogListeners.delete(fn); };
}
export function getProduct(id: string): IProduct | null { return catalog.get(id) ?? null; }
export function getCatalogProducts(): IProduct[] { return [...catalog.values()]; }

export interface PriceInfo { value: string; currencyCode: string; currencyImage: string; label: string }
/**
 * Price as the platform wants it displayed (req. 1.13.2): numeric value + currency icon URL
 * + the SDK's own "value code" label. Null until the catalog is loaded / product unknown.
 */
export function getPriceInfo(productId: string): PriceInfo | null {
  const product = catalog.get(productId);
  if (!product) return null;
  let currencyImage = "";
  try { currencyImage = product.getPriceCurrencyImage?.("svg") ?? ""; } catch { currencyImage = ""; }
  return { value: product.priceValue, currencyCode: product.priceCurrencyCode, currencyImage, label: product.price };
}

/** Product handler: apply the reward to game state; return true if the product is recognised. */
export type PurchaseGrant = (productId: string, purchase: IPurchase) => boolean | Promise<boolean>;

/**
 * Buy a product. Order (req. 1.13.1): purchase → grant → flush save → consume (consumables only).
 * Returns true when the reward was granted. Without the SDK grants immediately.
 */
export async function purchase(productId: string, grant: PurchaseGrant, consumable = true): Promise<boolean> {
  const p = await getPayments();
  if (!p) {
    // No SDK at all (plain local dev): grant so the flow can be playtested. SDK present but
    // purchases unavailable (not enabled in the console, network error): never give it away.
    if (hasSDK()) { warn("purchase skipped: payments unavailable on the platform"); return false; }
    await grant(productId, { productID: productId, purchaseToken: "local" });
    return true;
  }
  let bought: IPurchase;
  try { bought = await p.purchase({ id: productId }); }
  catch (err) { warn("purchase cancelled/failed:", err); return false; }
  return applyPurchase(p, bought, grant, consumable);
}

async function applyPurchase(p: PaymentsAPI, bought: IPurchase, grant: PurchaseGrant, consumable: boolean): Promise<boolean> {
  let granted = false;
  try { granted = await grant(bought.productID, bought); }
  catch (err) { warn("grant threw:", err); return false; }
  if (!granted) return false;
  await flushCloudSave();
  if (consumable) {
    try { await p.consumePurchase(bought.purchaseToken); }
    catch (err) { warn("consumePurchase failed (will retry next launch):", err); }
  }
  return true;
}

/**
 * Mandatory at every launch (req. 1.13.1): re-deliver purchases that were paid but not
 * consumed, and re-apply non-consumables. `isConsumable(productId)` decides whether to consume.
 * Call after the save is hydrated.
 */
export async function processPendingPurchases(grant: PurchaseGrant, isConsumable: (productId: string) => boolean = () => true): Promise<number> {
  const p = await getPayments();
  if (!p) return 0;
  let purchases: IPurchase[] = [];
  try { purchases = await withTimeout(p.getPurchases(), 10000, [], "getPurchases"); }
  catch (err) { warn("getPurchases failed:", err); return 0; }
  let handled = 0;
  for (const bought of purchases) {
    if (await applyPurchase(p, bought, grant, isConsumable(bought.productID))) handled++;
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

let lastScoreAt = 0;
let queuedScore: { name: string; score: number; extra?: string } | null = null;
let scoreTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Submit a score (authorised players only — silently skipped otherwise). Throttled to the
 * 1 request/second limit; the latest score wins.
 */
export function submitScore(leaderboard: string, score: number, extraData?: string): void {
  queuedScore = { name: leaderboard, score: Math.max(0, Math.floor(score)), extra: extraData };
  const wait = Math.max(0, 1100 - (performance.now() - lastScoreAt));
  if (scoreTimer != null) clearTimeout(scoreTimer);
  scoreTimer = setTimeout(async () => {
    scoreTimer = null;
    const item = queuedScore; queuedScore = null;
    if (!item) return;
    const s = await initYSDK();
    if (!s) return;
    try {
      if (!(await s.isAvailableMethod("leaderboards.setScore"))) return;
      lastScoreAt = performance.now();
      await s.leaderboards.setScore(item.name, item.score, item.extra);
    } catch (err) { warn("setScore failed:", err); }
  }, wait);
}

export async function getLeaderboardEntries(leaderboard: string, quantityTop = 10, quantityAround = 3): Promise<{ entries: ILeaderboardEntry[]; userRank: number } | null> {
  const s = await initYSDK();
  if (!s) return null;
  try { return await s.leaderboards.getEntries(leaderboard, { quantityTop, includeUser: true, quantityAround }); }
  catch (err) { warn("getEntries failed:", err); return null; }
}

export async function getPlayerEntry(leaderboard: string): Promise<ILeaderboardEntry | null> {
  const s = await initYSDK();
  if (!s) return null;
  try {
    if (!(await s.isAvailableMethod("leaderboards.getPlayerEntry"))) return null;
    return await s.leaderboards.getPlayerEntry(leaderboard);
  } catch (err) {
    if (!(err && typeof err === "object" && (err as { code?: string }).code === "LEADERBOARD_PLAYER_NOT_PRESENT")) warn("getPlayerEntry failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Flags, time, review, shortcut, other games, TV, misc
// ---------------------------------------------------------------------------

/** Remote config merged over local defaults. Fetch once at startup. */
export async function getFlags(defaults: Record<string, string>, clientFeatures?: { name: string; value: string }[]): Promise<Record<string, string>> {
  const s = await initYSDK();
  if (!s) return { ...defaults };
  try { return await withTimeout(s.getFlags({ defaultFlags: defaults, clientFeatures }), 5000, { ...defaults }, "getFlags"); }
  catch (err) { warn("getFlags failed:", err); return { ...defaults }; }
}

/** Tamper-proof time in ms (Date.now() without the SDK). Call every time you need "now". */
export function serverTime(): number {
  try { return sdk?.serverTime() ?? Date.now(); } catch { return Date.now(); }
}

/** Ask for a rating once per session, only when the SDK says it is possible. Returns true if sent. */
export async function requestReview(): Promise<boolean> {
  const s = await initYSDK();
  if (!s) return false;
  try {
    const { value } = await s.feedback.canReview();
    if (!value) return false;
    const { feedbackSent } = await s.feedback.requestReview();
    return feedbackSent;
  } catch (err) { warn("review failed:", err); return false; }
}

export async function canPromptShortcut(): Promise<boolean> {
  const s = await initYSDK();
  if (!s) return false;
  try { return (await s.shortcut.canShowPrompt()).canShow; } catch { return false; }
}
/** Show the "add to desktop" prompt (only from a button, after canPromptShortcut()). True if accepted. */
export async function promptShortcut(): Promise<boolean> {
  const s = await initYSDK();
  if (!s) return false;
  try { return (await s.shortcut.showPrompt()).outcome === "accepted"; } catch { return false; }
}

/** Your other games available on this platform+domain (req. 8.4.1). Empty on TV or without the SDK. */
export async function getOtherGames(): Promise<IOtherGame[]> {
  const s = await initYSDK();
  if (!s?.features.GamesAPI || isTV()) return [];
  try { return (await s.features.GamesAPI.getAllGames()).games; } catch (err) { warn("getAllGames failed:", err); return []; }
}

/** TV remote Back button (req. 1.6.3.3). Show your pause / exit-confirmation dialog in `fn`. */
export function onHistoryBack(fn: () => void): void {
  void initYSDK().then((s) => { try { s?.on(s.EVENTS.HISTORY_BACK, fn); } catch (err) { warn("HISTORY_BACK subscribe failed", err); } });
}
/** Player confirmed leaving the game (TV). */
export async function exitGame(): Promise<void> {
  const s = await initYSDK();
  try { await s?.dispatchEvent(s.EVENTS.EXIT); } catch (err) { warn("EXIT dispatch failed", err); }
}

/** Account-selection dialog (anonymous progress vs account). Pause sync on open; reload/re-fetch on close. */
export function onAccountSelection(onOpen: () => void, onClose: () => void): void {
  void initYSDK().then((s) => {
    if (!s) return;
    try {
      s.on(s.EVENTS.ACCOUNT_SELECTION_DIALOG_OPENED, onOpen);
      s.on(s.EVENTS.ACCOUNT_SELECTION_DIALOG_CLOSED, () => { playerPromise = null; onClose(); });
    } catch (err) { warn("account selection subscribe failed", err); }
  });
}

export async function requestFullscreen(): Promise<void> {
  const s = await initYSDK();
  try { await s?.screen.fullscreen.request(); } catch { /* browsers may refuse outside a gesture */ }
}
export async function exitFullscreen(): Promise<void> {
  const s = await initYSDK();
  try { await s?.screen.fullscreen.exit(); } catch { /* ignore */ }
}
export function copyToClipboard(text: string): void {
  try { sdk ? sdk.clipboard.writeText(text) : void navigator.clipboard?.writeText(text); } catch { /* ignore */ }
}

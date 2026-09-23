import { Game } from './Game';
import {
  hasSDK,
  initYSDK,
  loadCloudSave,
  loadingReady,
  onPlatformPause,
  onPlatformResume,
} from './platform/ysdk';

/**
 * Entry point.
 *
 * Deliberately thin: find the two DOM anchors, check that the browser can
 * actually run the game, and hand over. Everything that could fail interestingly
 * fails inside `Game.boot`, where there is a loading screen to say so.
 *
 * The one thing that is not thin is the boot order, because on Yandex Games the
 * order *is* the requirement. The platform watches for three things and rejects
 * the build if any of them is late: the language has to come from the SDK
 * before a word of UI exists (2.14), the cloud save has to be in hand before
 * the player sees a haystack they are about to lose (1.9), and `ready()` has to
 * fire at the exact moment the player can act - not on a timer, not while a
 * spinner is still up (1.19.2).
 */

/** Long enough for a slow round trip, short enough not to be a black screen. */
const PLATFORM_BUDGET = 6000;

function fail(message: string, detail?: string): void {
  const root = document.getElementById('ui');
  if (!root) return;
  root.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'panel';
  card.style.cssText = 'max-width:34rem;margin:12vh auto;padding:2rem;pointer-events:auto';
  const title = document.createElement('h1');
  title.className = 'panel__title';
  title.textContent = message;
  card.appendChild(title);
  if (detail) {
    const body = document.createElement('p');
    body.textContent = detail;
    card.appendChild(body);
  }
  root.appendChild(card);
}

function supportsWebGL2(canvas: HTMLCanvasElement): boolean {
  try {
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/** Resolve with null if `promise` has not settled in time. Never rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport');
  const uiRoot = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !uiRoot) {
    fail('Чего-то не хватает', 'Страница загрузилась не полностью. Попробуй обновить.');
    return;
  }

  if (!supportsWebGL2(canvas)) {
    fail(
      'Этот браузер не потянет «Найди иголку»',
      'Игре нужен WebGL 2. Попробуй свежий Chrome, Edge, Firefox или Safari и включи аппаратное ускорение.',
    );
    return;
  }

  // First thing, before anything is constructed: the platform handshake, which
  // is what reads the portal language. The game itself is Russian only, so
  // there is nothing to re-render - but the SDK has to be asked, and asked
  // first, or the language check fails.
  const sdkReady = initYSDK({
    saveKey: 'find-the-needle',
    onLang: (lang) => {
      document.documentElement.lang = lang;
    },
  });
  const cloudSave = sdkReady.then((sdk) => (sdk ? loadCloudSave() : null));

  // A dead SDK must never leave the platform's own loader up forever.
  const backstop = window.setTimeout(() => void loadingReady(), 30_000);

  const game = new Game(canvas, uiRoot);
  // A handle on the game is exactly the kind of thing a moderator calls a cheat
  // console, so it exists only in development.
  if (import.meta.env.DEV) {
    (window as unknown as { game?: Game }).game = game;
  }

  try {
    // Both of these are already in flight; this is the barrier, not the start.
    // Capped, because the game working offline matters more than the save.
    const raw = await within(cloudSave, PLATFORM_BUDGET);
    if (raw) game.hydrateSave(raw);

    // Everything the player will look at is built in here, from a save that is
    // now final.
    await game.boot();

    // The player can act as of this line: the title screen is up and the
    // loading card is gone.
    window.clearTimeout(backstop);
    void loadingReady();
    installPlatformHooks(game);
  } catch (error) {
    window.clearTimeout(backstop);
    void loadingReady();
    console.error('[boot] failed', error);
    fail('Ферма не загрузилась', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Everything that has to happen when the game loses the screen.
 *
 * Two signals, not one. `visibilitychange` covers a tab switch and the phone
 * going to the home screen; the platform's own event covers an advert or a
 * purchase window, which do not hide the tab and so fire nothing else. Both
 * land on the same idempotent pair inside the game.
 */
function installPlatformHooks(game: Game): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) game.suspendForPlatform();
    else game.resumeFromPlatform();
  });
  onPlatformPause(() => game.suspendForPlatform());
  onPlatformResume(() => game.resumeFromPlatform());

  // A long press on any part of the HUD must not raise the browser's own menu.
  // The canvas already handles its own; this is everything else.
  window.addEventListener('contextmenu', (event) => event.preventDefault(), { capture: true });

  if (hasSDK()) console.info('[platform] Yandex Games SDK active');
}

void main();

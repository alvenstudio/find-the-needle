import { Game } from './Game';

/**
 * Entry point.
 *
 * Deliberately thin: find the two DOM anchors, check that the browser can
 * actually run the game, and hand over. Everything that could fail interestingly
 * fails inside `Game.boot`, where there is a loading screen to say so.
 */

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

async function main(): Promise<void> {
  const canvas = document.getElementById('viewport');
  const uiRoot = document.getElementById('ui');
  if (!(canvas instanceof HTMLCanvasElement) || !uiRoot) {
    fail('Something is missing', 'The page did not load correctly. Try a refresh.');
    return;
  }

  if (!supportsWebGL2(canvas)) {
    fail(
      'This browser cannot run Find the Needle',
      'The game needs WebGL 2. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is switched on.',
    );
    return;
  }

  const game = new Game(canvas, uiRoot);
  // Expose the instance for the browser console; harmless in production and
  // invaluable when debugging a report that only reproduces on someone's laptop.
  (window as unknown as { game?: Game }).game = game;

  try {
    await game.boot();
  } catch (error) {
    console.error('[boot] failed', error);
    fail('The farm would not load', error instanceof Error ? error.message : String(error));
  }
}

void main();

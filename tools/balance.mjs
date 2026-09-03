/**
 * Runner for the balance simulator.
 *
 * Bundles `balance.ts` with the esbuild that already ships inside Vite and
 * imports the result from memory, so checking the game's pacing needs no extra
 * dependency and no build step.
 */
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [new URL('./balance.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  logLevel: 'warning',
});

const source = bundle.outputFiles[0].text;
const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
module.report();

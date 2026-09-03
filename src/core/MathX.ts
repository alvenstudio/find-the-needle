/** Small numeric helpers used across the whole game. */

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const inverseLerp = (a: number, b: number, value: number): number =>
  a === b ? 0 : (value - a) / (b - a);

export const remap = (value: number, inMin: number, inMax: number, outMin: number, outMax: number): number =>
  lerp(outMin, outMax, clamp01(inverseLerp(inMin, inMax, value)));

export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const smootherstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * Frame-rate independent exponential approach.
 *
 * `damp(current, target, lambda, dt)` moves a fraction of the way to `target`
 * every second regardless of frame time; a naive `lerp(a, b, 0.1)` in an update
 * loop makes everything faster on a 144 Hz display.
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Shortest signed angular difference, in radians. */
export const angleDelta = (from: number, to: number): number => {
  const twoPi = Math.PI * 2;
  let delta = (to - from) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return delta;
};

export const dampAngle = (current: number, target: number, lambda: number, dt: number): number =>
  current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));

/** Move `current` toward `target` by at most `maxDelta`. */
export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const delta = target - current;
  return Math.abs(delta) <= maxDelta ? target : current + Math.sign(delta) * maxDelta;
};

/** Classic 1-D value noise; cheap wobble for wind, flicker and idle sway. */
export const wobble = (t: number, frequency = 1, seed = 0): number =>
  Math.sin(t * frequency + seed) * 0.6 + Math.sin(t * frequency * 2.31 + seed * 1.7) * 0.3 +
  Math.sin(t * frequency * 5.13 + seed * 2.9) * 0.1;

/**
 * Format a quantity for the HUD: 1234 -> "1.23K", 4500000 -> "4.5M".
 *
 * Numbers in this game span seven orders of magnitude, so the HUD needs a
 * consistent, glanceable short form.
 */
const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp'];

export function formatShort(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '∞';
  const sign = value < 0 ? '-' : '';
  let n = Math.abs(value);
  if (n < 1000) return sign + (n < 10 && !Number.isInteger(n) ? n.toFixed(1) : Math.floor(n).toString());
  let tier = 0;
  while (n >= 1000 && tier < SUFFIXES.length - 1) {
    n /= 1000;
    tier++;
  }
  const digits = n >= 100 ? 0 : n >= 10 ? 1 : precision;
  return `${sign}${n.toFixed(digits).replace(/\.?0+$/, '')}${SUFFIXES[tier]}`;
}

/** Thousands-separated integer, for places where precision matters. */
export function formatExact(value: number): string {
  return Math.floor(value).toLocaleString('en-US');
}

/** Seconds -> "4:07" or "1:02:33". */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

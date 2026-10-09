/** Small numeric helpers shared by the ink engine. */

export { clamp } from "../util";

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
export const easeOut3 = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
/** Exponential approach of x toward target at `rate` (1/s) over dt seconds. */
export const approach = (x: number, target: number, rate: number, dt: number): number =>
  x + (target - x) * (1 - Math.exp(-rate * dt));
/** Numbers for SVG attributes and CSS: 2 decimals (`fmt`) or 3 (`fmt3`), no trailing zeros. */
export const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();
export const fmt3 = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/** Fixed integration step (s) for springs and waves. */
export const STEP = 1 / 240;

/**
 * Advance a unit-mass damped spring `s` (position p, velocity v) toward `target` by `dt` seconds in
 * fixed sub-steps; `each(h)` runs after every sub-step (satellites, clocks).
 */
export function stepSpring(s: { p: number; v: number }, k: number, c: number, target: number, dt: number, each?: (h: number) => void): void {
  let rem = dt;
  while (rem > 1e-9) {
    const h = Math.min(rem, STEP);
    rem -= h;
    s.v += (-k * (s.p - target) - c * s.v) * h;
    s.p += s.v * h;
    if (each) each(h);
  }
}

/** Small seeded PRNG (mulberry32): a drop from the same place splashes the same way (deterministic frames). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

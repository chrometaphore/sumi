/**
 * Ink engine tuning and the dock's footprint. Distances are CSS px, times ms unless noted.
 * (Split out of ink.ts; ink.ts re-exports everything here.)
 */

/**
 * Surface-wave tuning, shared by the dock (open tab and closed drop) and every ink skin (note
 * popover, More menu, notes panel). Distances are CSS px along / across the ink's edge, times in s.
 */
export const INK_WAVES = {
  /** Ambient shimmer (px) while the pointer is over / near a surface but away from its edge. */
  ambientRest: 0.6,
  /** Ambient shimmer (px) while the pointer is at the edge (scaled by how close it is). */
  ambientHover: 2.5,
  /** How fast the shimmer swells toward a higher amplitude (1/s). */
  ambientRise: 3,
  /** How fast it calms back down when the pointer moves away (1/s). */
  ambientFall: 2.2,
  /** Once the pointer has rested this long (s), the shimmer fades out (at `restFall`, 1/s) and the frames stop. */
  restAfter: 1,
  restFall: 4.5,
  /** Pointer ripples run at full frame rate for this long (s) after the last one; ambient-only and loading
   * frames are capped at 30 fps. */
  hotFor: 1.2,
  /** Typical ambient wavelength along the edge (px). */
  ambientWave: 90,
  /** How fast the ambient pattern drifts along the edge (px/s). */
  ambientDrift: 24,
  /** Ripple speed along the edge (px/s). */
  speed: 260,
  /** Velocity damping (1/s): a ripple's amplitude decays like e^(−damping·t/2). */
  damping: 4.5,
  /** Viscous smoothing of short wavelengths (px²/s): keeps crests round, never spiky. */
  viscosity: 120,
  /** Restoring force toward the rest outline (1/s²): guarantees everything settles. */
  restore: 24,
  /** Pointer within this distance of the edge (px) ripples it and counts as hovering it. */
  hoverDist: 40,
  /** Pointer within this distance of the edge, or anywhere over the ink, keeps the rest shimmer (px). */
  wakeDist: 72,
  /** Width (gaussian σ, px along the edge) of one pointer impulse. */
  falloff: 24,
  /** Bump height per px of pointer motion across the edge (toward = dent, away = lift). */
  push: 0.12,
  /** Bow-wave height per px of pointer motion along the edge (ink piles up ahead of the pointer, a
   * trough trails it); the wave runs off the same way the pointer moved. */
  drag: 0.035,
  /** Low-pass time constant for injected energy (s): jerky pointer events never spike the edge. */
  smoothing: 0.04,
  /** Maximum displacement (px); soft clamp, so crests flatten smoothly as they approach it. */
  clamp: 6,
  /** Closed drop: breathing amplitude while hovered (px of radius; 0 turns it off). */
  breathe: 0.5,
  /** Closed drop: breathing period (s). */
  breathePeriod: 2.6,
  /** Outline sample spacing (px); grows automatically on outlines longer than `maxSamples`. */
  spacing: 3.5,
  /** Maximum samples per outline (performance cap for tall panels). */
  maxSamples: 360,
  /** Extra damping (1/s) where the dock's outline runs off-screen: ripples leave, they don't bounce. */
  sponge: 40,
  /** Length (px) over which the dock's ink goes from pinned (at the viewport edge) to free. */
  edgeRamp: 14,
  /** A surface stops animating once every displacement is below this (px) and no pointer is near. */
  sleep: 0.03,
};

/**
 * Note-popover "ink drop" tuning (`inkDropIn` / `inkDropOut`): a drop lands where the gesture ended,
 * spreads into the card through the goo and hands over to the card's ink skin; closing pulls it back
 * into a droplet. Distances are CSS px, times ms, springs unit-mass.
 */
export const INK_DROP = {
  /** Drop radius when it appears, and once it has landed (px). */
  startRadius: 3,
  landRadius: 16,
  /** Appear → land (ms); the impact squash takes the last `squashMs` of it. */
  fallMs: 90,
  squashMs: 30,
  /** Impact squash at its peak: extra width / lost height, as fractions of the drop's diameter. */
  squashX: 0.3,
  squashY: 0.2,
  /** Reopening a note: a smaller, quicker drop from its badge (radii px, fall ms). */
  smallStartRadius: 10,
  smallLandRadius: 13,
  smallFallMs: 45,
  /** Spread spring: stiffness and damping ratio (≈4% overshoot, the feel of the dock's open morph). */
  spreadK: 380,
  spreadZeta: 0.72,
  /** The small drop's spread spring: quicker, visually settled ≈200 ms after it lands. */
  smallSpreadK: 1100,
  smallSpreadZeta: 0.76,
  /** Nominal spread duration (ms): content timing is measured against it (scaled for the small drop). */
  spreadMs: 330,
  /** Spread speed at the impact (progress per s): the landing already throws the ink outward. */
  spreadKick: 1,
  /** The spreading ink stays round until this progress, and has the card's corners from `cornersBy` on. */
  roundUntil: 0.25,
  cornersBy: 0.9,
  /** The leading side runs this far ahead along the travel at mid-spread (fraction of the travel, ≤ 300 px). */
  lead: 0.08,
  /** A puddle stays behind at the impact point and drains into the moving ink until this spread progress. */
  tailUntil: 0.6,
  /** Splash droplets flung from the impact point (the small drop flings `smallSplash`). */
  splashMin: 3,
  splashMax: 5,
  smallSplash: 2,
  /** Splash droplet radius range (px; the goo eats ~2–3 px of it). */
  splashR: [8, 11] as [number, number],
  /** How far past the impact point droplets are thrown (px). */
  splashDist: [22, 42] as [number, number],
  /** Splash flight time range (ms). */
  splashMs: [230, 330] as [number, number],
  /** Droplets whose throw ends farther than this from the card (px) fade out instead of falling back into it. */
  splashReach: 70,
  /** Content starts entering this far into the spread (fraction of `spreadMs`), items `stagger` ms apart. */
  contentAt: 0.6,
  stagger: 30,
  /** Each content item's entrance: duration (ms) and rise (px). */
  itemMs: 200,
  itemRise: 6,
  /** The spread counts as settled once every edge is within this of the card (px) and slow. */
  settlePx: 0.75,
  /** Hand-off: once settled, the goo eases out over this long (ms), then the skin takes over. */
  handoffMs: 80,
  /** Ripple kicked into the card's edge at the hand-off, where the drop came in (px). */
  ripple: 1.6,
  /** … and where each splash droplet fell back in (px). */
  rippleDroplet: 0.9,
  /** Exit: total time (ms) and content fade (ms). */
  exitMs: 220,
  exitFadeMs: 60,
  /** Exit spring: stiffness and damping ratio. */
  exitK: 600,
  exitZeta: 0.8,
  /** Exit: radius of the droplet the card collapses into (px), and when it starts to shrink away (ms). */
  exitRadius: 10,
  exitShrinkAt: 120,
  /** Exit: tiny droplets the retracting ink leaves behind and pulls back in (count, radius px). */
  exitDroplets: 2,
  exitDropletR: 6.5,
};

/**
 * "Claude is working" tuning (`dock.setLoading`): the dock collapses to the drop, colour blooms into the
 * ink, a loader arc spins on it and its edge keeps rippling until the work is done; then the colour drains
 * back into black ink. Times ms unless noted, distances CSS px.
 */
export const INK_LOADING = {
  /** The glow's palette (glow.ts): violet, blue, teal. In the drop it runs violet → blue → teal (hue 0 … 2/3). */
  palette: ["#7c5cff", "#3b82f6", "#2dd4bf"] as [string, string, string],
  /** Colour seeping into the drop once the collapsing ink has landed. */
  bloomMs: 450,
  /** Colour draining back into black ink when the work is done. */
  drainMs: 400,
  /** … and when the person opens the dock while Claude works (the open tab is black ink). */
  drainOpenMs: 180,
  /** Pause after the drain before an automatically collapsed dock pours back open. */
  reopenDelayMs: 250,
  /** The bloom starts as the collapsing ink lands: morph position below this (0 = the drop). */
  landAt: 0.02,
  /** After an automatic collapse the colour wells up this far below the centre, where Send sat (px). */
  originDy: 8,
  /** Colour front while blooming / draining: outline noise (fraction of its radius) and soft edge (blur σ px). */
  frontNoise: 0.16,
  frontSoft: 2.2,
  /** Each colour blob starts spreading this far into the bloom (fraction), so the hues arrive one by one. */
  blobDelay: [0, 0.12, 0.24] as [number, number, number],
  /** Breath period (s): the glow's, counted from the same start, so the drop swells with the screen edges. */
  breathS: 2.4,
  /** Hue drift: the colours slide along the palette by up to ± `hueSwing` cycles, at most `hueDrift`
   * cycles per s (the glow's speed; one sway ≈ 30 s), plus an extra shift at the top of each breath.
   * Inside the drop the palette runs violet → blue → teal and stops there (never wrapping back to
   * violet), so a drift turns the drop more violet or more teal without ever drawing a stripe. */
  hueDrift: 0.035,
  hueSwing: 0.18,
  hueBreath: 0.1,
  /** How much of the palette spans the drop (cycles; violet 0, blue 1/3, teal 2/3). */
  hueSpan: 0.62,
  /** Where along the gradient (fraction of the drop's diameter) the span starts and ends, like the
   * Figma gradient's 21% / 82% stops: solid colour before and after. */
  spanFrom: 0.21,
  spanTo: 0.82,
  /** Colour blobs swell this much at the top of a breath (fraction of their radius). */
  breatheBlob: 0.14,
  /** Underlying linear gradient: direction (deg, y down, violet → teal), sway (± deg) and sway period (s). */
  baseAngle: 64,
  baseSway: 24,
  baseSwayS: 9.6,
  /** Soft colour blobs (radial, opaque core → transparent rim) drifting over it: palette position (0 … hueSpan,
   * where on the gradient their colour comes from), radius, orbit centre (dx, dy from the drop's centre), orbit
   * radii, period (s; negative runs the other way), phase (rad). Away from home they carry their colour along. */
  blobs: [
    { hue: 0, r: 18, dx: -10, dy: -9, rx: 8, ry: 7, period: 5.3, phase: 0.4 },
    { hue: 0.33, r: 16, dx: 9, dy: -3, rx: 7, ry: 9, period: -7.1, phase: 2.1 },
    { hue: 0.62, r: 14, dx: 6, dy: 13, rx: 9, ry: 6, period: 6.2, phase: 4.0 },
  ],
  /** Edge while loading: sustained ambient shimmer (px; hover level is INK_WAVES.ambientHover). */
  ambient: 2,
  /** … breathing with the glow (px of radius). */
  breatheEdge: 0.6,
  /** … and gentle self-impulses: one every [min, max] s, this big (px, outward or inward). */
  impulseEvery: [0.8, 1.8] as [number, number],
  impulse: 1.1,
  /** Ripple (px) kicked into the edge as the colour front reaches it, and as the drain closes over it. */
  ripple: 1.3,
  /** Tiny splash on bloom / drain: droplets, radius range (px), throw range (px), flight range (ms). */
  splashDrops: 2,
  splashR: [6, 7.5] as [number, number],
  splashDist: [10, 16] as [number, number],
  splashMs: [360, 440] as [number, number],
  /** Loader arc: one turn per `spinMs`; with reduced motion one turn per `spinReducedMs` (0 = still). */
  spinMs: 900,
  spinReducedMs: 0, // reduced motion: a still arc
};

/** The open dock's tab (72 × 312, with 40 px fillets above and below) and the closed drop's diameter. */
export const TAB_W = 72;
export const TAB_H = 312;
export const FILLET = 40;
export const DROP = 52;

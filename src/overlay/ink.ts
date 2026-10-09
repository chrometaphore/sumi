/**
 * Sumi ink engine — PUBLIC API (stable contract).
 *
 * Implementation
 * - Morph (open / close), satellite droplets and splash: plain black SVG shapes inside ONE inline
 *   <svg>, grouped under a gooey metaball filter (feTurbulence → feDisplacementMap → feGaussianBlur
 *   → feColorMatrix alpha threshold) and animated per frame from a small spring integrator. The
 *   filter is ramped to identity and removed once the morph settles.
 * - Surface (both rest states, hover): ONE procedural outline per state — the open tab with its two
 *   concave fillets (the exact geometry of corner-top/bottom.svg, now drawn in code), or the closed
 *   drop's circle — rendered through a 1D damped wave field that runs along the whole outline
 *   (`WaveField`). Pointer motion near the edge ripples it, direction-aware (pushing toward / pulling
 *   away dents / lifts it, sliding along it launches a crest that travels the way the pointer went);
 *   an ambient travelling shimmer swells while the pointer is near; everything settles back to the
 *   exact Figma geometry and the frame loop stops. All tuning lives in `INK_WAVES`.
 * - Ink modals (popover, menu, notes panel) get the same surface through `createInkSkin`: an SVG ink
 *   layer behind their content draws their rounded rect through the same wave field.
 * - `inkReveal` / `inkHide` animate a noisy `clip-path: path()` blob.
 * - Loading (`dock.setLoading`): while Claude works the ink is filled with an SVG pattern — black,
 *   plus a living gradient (soft radial blobs in the glow's palette over a swaying linear gradient)
 *   that blooms in from a noisy, soft-edged front and drains out the same way. The drop's edge keeps
 *   rippling (sustained ambient + self-impulses) and a loader arc spins on it. Tuning: `INK_LOADING`.
 * Icons and buttons are never filtered. Everything degrades to plain CSS / static outlines and never
 * throws into the page. Reduced motion: no waves, no wobble, no satellites; 120 ms fades only.
 *
 * DOM contract
 * - `dock.el`: append to the shadow root. position:fixed; right:0; top:50%; translateY(-50%).
 *   It is sized to the open footprint (72 × (312 + 2·40)) and is pointer-events:none except over ink.
 * - `dock.content`: absolutely positioned 72 × 312 box exactly over the tab. The UI fills it.
 *   Direct or nested children marked `[data-ink-item]` get the staggered entrance on open.
 *   Hidden (visibility:hidden, pointer-events:none) while closed.
 * - The drop (closed state) is owned by the dock: clicking it calls `open()` then `opts.onOpen`.
 *   The UI calls `dock.close()` from its own Close button, then `opts.onClose` fires.
 * - `setLoading(true)` collapses an open dock on its own (`opts.onClose({ auto: true })`) and pours it
 *   back open when loading ends (`opts.onOpen({ auto: true })`) unless the person opened or closed it
 *   meanwhile; `auto` changes are not the person's preference.
 *
 * Modules: tuning (ink/tuning.ts), the shared frame scheduler (ink/scheduler.ts), the wave surface
 * (ink/wavefield.ts), the goo filter (ink/goo.ts), paused-WAAPI choreography (ink/choreo.ts).
 */
import { css, svgEl, warn } from "./util";
import { Choreo, shift } from "./ink/choreo";
import { createGoo, type Goo } from "./ink/goo";
import { approach, clamp, clamp01, easeOut3, fmt, fmt3, lerp, seeded, smooth, stepSpring } from "./ink/math";
import { clock, docHidden, prefersReducedMotion, schedule, unschedule, type Ticker } from "./ink/scheduler";
import { DROP, FILLET, INK_DROP, INK_LOADING, INK_WAVES, TAB_H, TAB_W } from "./ink/tuning";
import { hubAdd, hubRemove, inkCircle, inkOutlinePath, inkRoundRect, WaveField, type InkOutline, type WaveClient } from "./ink/wavefield";

export { DROP, FILLET, INK_DROP, INK_LOADING, INK_WAVES, TAB_H, TAB_W } from "./ink/tuning";
export { inkShutdown, prefersReducedMotion } from "./ink/scheduler";
export { inkCircle, inkOutlinePath, inkRoundRect, type InkArc, type InkLine, type InkOutline, type InkSeg } from "./ink/wavefield";

/** Why the dock opened / closed: `auto` = on its own (collapsing for loading, pouring back after it). */
export interface InkDockChange {
  auto: boolean;
}

export interface InkDockOptions {
  /** Builds the drop icon (an inline SVG; the closed state's glyph). */
  dropIcon: () => Element;
  /** Builds the loader arc, spun on the drop while loading. */
  loaderIcon?: () => Element;
  startOpen?: boolean;
  onOpen?: (change: InkDockChange) => void;
  onClose?: (change: InkDockChange) => void;
}

export interface InkDock {
  readonly el: HTMLElement;
  readonly content: HTMLElement;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** A small ink splash on the dock, e.g. after sending notes. */
  splash(): void;
  /**
   * Claude is working (true) or done (false). On: an open dock collapses to the drop (remembered, not
   * the person's preference), colour blooms into the drop and a loader arc spins on it while its edge
   * ripples. Off: the colour drains back into black ink and a remembered dock pours back open, unless
   * the person opened or closed the dock meanwhile. Idempotent; never throws.
   */
  setLoading(on: boolean): void;
  destroy(): void;
}

export interface Point {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------------------------------------
 * Geometry (dock-local CSS px: origin = top-left of the 72 × 392 dock box; x = 72 is the viewport's
 * right edge)
 * --------------------------------------------------------------------------------------------- */

const DOCK_H = TAB_H + 2 * FILLET; // 392
const AXIS_X = TAB_W - 36; // drop centre x == tool column axis (right − 36)
const MID_Y = DOCK_H / 2;
const R_DROP = DROP / 2;
const R_TAB = 36; // the tab's left radius
const PAD = 48; // svg overdraw left / top / bottom (satellites, splash, waves, wobble)
const EXT = 48; // ink continues past the viewport's right edge so the goo never erodes that edge
const SVG_W = TAB_W + PAD + EXT;
const SVG_H = DOCK_H + 2 * PAD;
/** Fillet geometry, from corner-*.svg (40 × 40, ink in the corner next to the tab and the viewport
 * edge): a concave arc of radius 39.352 centred at (0.648, 39.352) of the asset box. */
const F_R = 39.352;
/** The asset's own path (corner-bottom.svg, verbatim): used for the fillets while they pour in. */
const FILLET_D =
  "M40 0V40H39.9922C39.9957 39.7844 40 39.568 40 39.3516C39.9998 17.6183 22.3818 0 0.648438 0C0.431865 0 0.215742 0.00432627 0 0.0078125V0H40Z";
const SHADOW_A = 0.25; // closed drop: box-shadow 6px 6px 20px rgba(0,0,0,.25) …
// … which as a CSS filter is drop-shadow(6px 6px 10px): Chromium treats drop-shadow's blur as the
// Gaussian's standard deviation, i.e. twice as soft as the same box-shadow (verified against the render).
const SHADOW_BLUR = 10;
/** Ink modals: `--ink-shadow` (0 14px 36px .26, 0 2px 8px .16) as drop-shadows of the ink layer. */
const SKIN_SHADOW = "drop-shadow(0 2px 4px rgba(0,0,0,.16)) drop-shadow(0 14px 18px rgba(0,0,0,.26))";

/** Springs (unit mass). Open: ζ 0.74, ~2.5% overshoot, settles ≈ 540 ms. Close: ζ 0.52, a ~15%
 * undershoot that reads as a squash-and-wobble of the drop, settles ≈ 420 ms. */
const SPRING_OPEN = { k: 200, c: 2 * 0.74 * Math.sqrt(200), thr: 0.004 };
const SPRING_CLOSE = { k: 300, c: 2 * 0.52 * Math.sqrt(300), thr: 0.02 };

/** Content choreography (ms). */
const ITEM_DELAY = 200; // ≈ 40% into the open morph
const ITEM_STAGGER = 40;
const ITEM_MS = 260;
const ITEM_EASE = "cubic-bezier(.2,.8,.2,1)";
const CLOSE_FADE_MS = 90;
const REDUCED_MS = 120;
const SAFETY_MS = 1800; // force-settle if frames never arrive (e.g. a throttled background iframe)
const COLOUR_FRAME_MS = 60; // the loading colour's steady drift is redrawn at most this often

interface Geom {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  rx: number;
  ry: number;
  /** fillet scale 0..1 (from their joint at the viewport edge) */
  s: number;
}

/**
 * Body shape for a morph position p (0 = closed drop, 1 = open tab). p < 0 is the close
 * undershoot (squash), p > 1 the open overshoot (a little extra stretch).
 */
function geomAt(p: number): Geom {
  if (p <= 0) {
    const q = Math.min(-p, 0.5) * 0.55;
    const w = DROP * (1 + q);
    const h = DROP * (1 - q);
    return { x0: AXIS_X - w / 2, x1: AXIS_X + w / 2, y0: MID_Y - h / 2, y1: MID_Y + h / 2, rx: w / 2, ry: h / 2, s: 0 };
  }
  const t = Math.min(p, 1);
  const o = Math.max(p - 1, 0);
  // the drop slides right into the viewport edge …
  const x1 = lerp(AXIS_X + R_DROP, TAB_W + EXT, smooth(t / 0.34));
  // … its trailing side lags behind, then spreads back out to the tab's left edge …
  const x0 = lerp(AXIS_X - R_DROP, 0, smooth((t - 0.12) / 0.88)) + 12 * Math.sin(Math.PI * clamp01(t / 0.7)) ** 2 - o * 26;
  // … while it stretches vertically into the tab.
  const h = lerp(DROP, TAB_H, smooth((t - 0.06) / 0.94)) + o * 170;
  const cap = lerp(R_DROP, R_TAB, smooth(t / 0.6));
  const w = x1 - x0;
  // the fillets pour in from their joint at the edge as soon as the mass touches it
  const s = Math.min(1.06, easeOut3((t - 0.18) / 0.82) + o * 1.5);
  return { x0, x1, y0: MID_Y - h / 2, y1: MID_Y + h / 2, rx: Math.min(cap, w / 2), ry: Math.min(cap, h / 2), s };
}

/** x of the body's left outline at height y. */
function leftEdge(g: Geom, y: number): number {
  const top = g.y0 + g.ry;
  const bot = g.y1 - g.ry;
  if (y >= top && y <= bot) return g.x0;
  const cy = y < top ? top : bot;
  const dy = Math.min(1, Math.abs(y - cy) / Math.max(g.ry, 0.001));
  return g.x0 + g.rx * (1 - Math.sqrt(1 - dy * dy));
}

/* ------------------------------------------------------------------------------------------------
 * Ink skin: the dock's wavy surface for any ink box (note popover, More menu, notes panel)
 * --------------------------------------------------------------------------------------------- */

export interface InkSkinOptions {
  /** Outline in host-local CSS px (border box w × h). Default: the host's own rounded rect. */
  shape?: (w: number, h: number) => InkOutline;
  /** How far the ink layer reaches past the box, so waves can swell outward (px). */
  overflow?: number;
  /** CSS filter of the ink layer (its drop shadow). Default: `--ink-shadow` as drop-shadows. */
  shadow?: string;
}

export interface InkSkin {
  /** The SVG ink layer (first child of the host), or null when the skin could not be built. */
  readonly layer: SVGSVGElement | null;
  /** Re-measure the host now (the skin also follows it with a ResizeObserver). */
  refresh(): void;
  destroy(): void;
}

const skinOf = new WeakMap<HTMLElement, InkSkin>();

/** Internal handle on a skin for the ink drop (inkDropIn / inkDropOut), which takes over its look. */
interface SkinCtl {
  /** The skin's ink layer (hidden while a drop draws the ink instead). */
  readonly layer: SVGSVGElement;
  /** Hold the surface at its exact rest outline and ignore the pointer (true), or let it live again. */
  hold(on: boolean): void;
  /** Bump the edge nearest each viewport point by `a` px (outward if positive) and let it ripple. */
  kick(points: ReadonlyArray<{ x: number; y: number; a: number }>): void;
}
const skinCtl = new WeakMap<HTMLElement, SkinCtl>();

/**
 * Give an ink surface the dock's living edge. The host's own background and box-shadow are replaced
 * by an SVG ink layer (first child, absolutely positioned, z-index −1, pointer-events none, a few px
 * larger than the box) that draws its outline through the wave engine; the host's content stays on
 * top and fully interactive. Works with `inkReveal` / `inkHide` (their clip-path clips the layer
 * too). The host must be a positioned element that forms a stacking context (fixed + z-index).
 */
export function createInkSkin(host: HTMLElement, opts: InkSkinOptions = {}): InkSkin {
  try {
    return buildSkin(host, opts);
  } catch (e) {
    warn(e, "ink skin (keeping the plain CSS surface)");
    return { layer: null, refresh() {}, destroy() {} };
  }
}

function buildSkin(host: HTMLElement, opts: InkSkinOptions): InkSkin {
  skinOf.get(host)?.destroy();
  const E = Math.max(0, opts.overflow ?? INK_WAVES.clamp + 4);
  const svg = svgEl("svg", { "aria-hidden": "true", focusable: "false", preserveAspectRatio: "none" });
  // sized in px from the host's exact (fractional) border box, so the outline lands on its edges
  css(svg, {
    position: "absolute", left: `${-E}px`, top: `${-E}px`, width: `calc(100% + ${2 * E}px)`, height: `calc(100% + ${2 * E}px)`,
    "z-index": "-1", "pointer-events": "none", overflow: "hidden", display: "block", margin: "0",
    filter: opts.shadow ?? SKIN_SHADOW,
  });
  const path = svgEl("path", { fill: "#000" }, svg);

  let w = 0;
  let h = 0;
  let radius = 18;
  let field: WaveField | null = null;
  let restD = "";
  let shownD = "";
  let broken = false;
  let destroyed = false;
  let running = false;
  let held = false; // an ink drop owns the look: rest outline, no pointer ripples
  let lastT = clock();

  const shapeOf = (W: number, H: number): InkOutline =>
    opts.shape ? opts.shape(W, H) : inkRoundRect(W, H, Math.min(radius, W / 2, H / 2));

  const paint = (): void => {
    const d = field && !broken ? field.path(0) : restD;
    if (d !== shownD) {
      shownD = d;
      path.setAttribute("d", d);
    }
  };

  const fail = (e: unknown): void => {
    if (broken) return;
    broken = true;
    warn(e, "ink skin (static outline from now on)");
    unschedule(ticker);
    running = false;
    field = null;
    try {
      paint();
    } catch {
      /* ignore */
    }
  };

  /** The host's border box, unrounded (offsetWidth/Height round, which would misplace the edges). */
  const boxSize = (entry?: ResizeObserverEntry): [number, number] => {
    try {
      const b = entry?.borderBoxSize?.[0];
      if (b && b.inlineSize > 0 && b.blockSize > 0) return [b.inlineSize, b.blockSize];
      const cs = getComputedStyle(host);
      if (cs.boxSizing === "border-box") {
        const bw = parseFloat(cs.width);
        const bh = parseFloat(cs.height);
        if (bw > 0 && bh > 0) return [bw, bh];
      }
    } catch {
      /* fall through */
    }
    return [host.offsetWidth, host.offsetHeight];
  };

  const resize = (entry?: ResizeObserverEntry): void => {
    if (destroyed) return;
    if (host.hidden) return;
    const [W, H] = boxSize(entry);
    if (!(W > 0 && H > 0) || (Math.abs(W - w) < 0.01 && Math.abs(H - h) < 0.01 && restD)) return;
    w = W;
    h = H;
    try {
      const r = parseFloat(getComputedStyle(host).borderTopLeftRadius);
      if (r >= 0) radius = r;
    } catch {
      /* keep */
    }
    svg.setAttribute("viewBox", `${-E} ${-E} ${fmt3(W + 2 * E)} ${fmt3(H + 2 * E)}`);
    svg.style.setProperty("width", `${fmt3(W + 2 * E)}px`);
    svg.style.setProperty("height", `${fmt3(H + 2 * E)}px`);
    const o = shapeOf(W, H);
    restD = inkOutlinePath(o);
    if (!broken) {
      try {
        const f = new WaveField(o);
        if (field) f.adopt(field);
        field = f;
      } catch (e) {
        fail(e);
      }
    }
    paint();
  };

  const ticker: Ticker = {
    get lowRate() {
      return !!field && !field.hot();
    },
    tick(t: number): boolean {
      if (destroyed || broken || !field) return false;
      try {
        let dt = (t - lastT) / 1000;
        lastT = t;
        if (!(dt > 0)) dt = 0;
        if (dt > 0.1) dt = 0.1;
        if (held || host.hidden || !host.isConnected) {
          field.reset();
          field.leave();
          paint();
          running = false;
          return false;
        }
        field.step(dt);
        paint();
        running = field.awake();
        return running;
      } catch (e) {
        fail(e);
        return false;
      }
    },
    finish(): void {
      if (field) {
        field.reset();
        field.leave();
      }
      running = false;
      try {
        paint();
      } catch (e) {
        fail(e);
      }
    },
  };

  const wake = (): void => {
    if (destroyed || broken || !field) return;
    if (!running) lastT = clock();
    running = true;
    schedule(ticker);
  };

  const client: WaveClient = {
    move(cx, cy, dx, dy) {
      if (destroyed || broken || held || host.hidden || !host.isConnected) return;
      if (!w) resize();
      if (!field || prefersReducedMotion()) return;
      const r = host.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return;
      const sx = w / r.width;
      const sy = h / r.height;
      if (field.feed((cx - r.left) * sx, (cy - r.top) * sy, dx * sx, dy * sy)) wake();
    },
    out() {
      if (!field) return;
      field.leave();
      wake();
    },
  };

  // host: the layer replaces its background and shadow (restored by destroy)
  const saved: Array<[string, string, string]> = [];
  const setHost = (prop: string, value: string): void => {
    saved.push([prop, host.style.getPropertyValue(prop), host.style.getPropertyPriority(prop)]);
    host.style.setProperty(prop, value);
  };
  host.insertBefore(svg, host.firstChild);
  setHost("background", "transparent");
  setHost("box-shadow", "none");
  setHost("isolation", "isolate");
  try {
    if (getComputedStyle(host).position === "static") setHost("position", "relative");
  } catch {
    /* ignore */
  }

  let ro: ResizeObserver | null = null;
  let mo: MutationObserver | null = null;
  try {
    ro = new ResizeObserver((entries) => {
      try {
        resize(entries[entries.length - 1]);
      } catch (e) {
        fail(e);
      }
    });
    ro.observe(host);
  } catch {
    ro = null; // measured lazily on pointer moves instead
  }
  try {
    // UIs rebuild their content with textContent = "": keep the layer as the first child
    mo = new MutationObserver(() => {
      if (!destroyed && host.firstChild !== svg) host.insertBefore(svg, host.firstChild);
    });
    mo.observe(host, { childList: true });
  } catch {
    mo = null;
  }
  hubAdd(client);
  resize();

  const skin: InkSkin = {
    layer: svg,
    refresh() {
      try {
        w = 0;
        resize();
      } catch (e) {
        fail(e);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      hubRemove(client);
      unschedule(ticker);
      ro?.disconnect();
      mo?.disconnect();
      svg.remove();
      for (const [prop, value, prio] of saved.reverse()) {
        if (value) host.style.setProperty(prop, value, prio);
        else host.style.removeProperty(prop);
      }
      if (skinOf.get(host) === skin) skinOf.delete(host);
      if (skinCtl.get(host) === ctl) skinCtl.delete(host);
    },
  };
  const ctl: SkinCtl = {
    layer: svg,
    hold(on) {
      if (destroyed) return;
      held = on;
      try {
        if (!w) resize();
        if (on) {
          unschedule(ticker);
          running = false;
          if (field) {
            field.reset();
            field.leave();
          }
          paint();
        } else lastT = clock();
      } catch (e) {
        fail(e);
      }
    },
    kick(points) {
      if (destroyed || broken || held || prefersReducedMotion()) return;
      try {
        if (!w) resize();
        if (!field) return;
        const r = host.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) return;
        const sx = w / r.width;
        const sy = h / r.height;
        for (const p of points) field.poke((p.x - r.left) * sx, (p.y - r.top) * sy, p.a);
        wake();
      } catch (e) {
        fail(e);
      }
    },
  };
  skinCtl.set(host, ctl);
  skinOf.set(host, skin);
  return skin;
}

/* ------------------------------------------------------------------------------------------------
 * Dock
 * --------------------------------------------------------------------------------------------- */

/**
 * Rest outline of the open dock (dock-local px): the tab with its two concave fillets, continued
 * off-screen past the viewport's right edge (that stretch is `fixed`: an absorbing sponge for
 * ripples, and it covers the full 392 px height like the morph's own edge rect, so the two read the
 * same through the goo at the hand-off). The fillet arcs are the corner-*.svg geometry (radius
 * 39.352, centred 0.648 px inside the dock's top and bottom, 39.352 px left of the viewport edge).
 * The fillet circle and the tab's 36 px corner circle are 0.07 px apart; the outline hops between
 * them where they face each other, so it stays tangent-continuous (the exact union of the shapes
 * differs from this by < 0.1 px, a sliver at the joint).
 */
function dockOutline(): InkOutline {
  const X = TAB_W + EXT;
  const fx = TAB_W - F_R; // fillet circles' centre x (32.648)
  const yT = FILLET; // tab top (40)
  const yB = FILLET + TAB_H; // tab bottom (352)
  const fT = yT - F_R; // top fillet circle centre y (0.648)
  const fB = yB + F_R; // bottom fillet circle centre y (391.352)
  const cT = yT + R_TAB; // tab corner centres y (76, 316), x = 36
  const cB = yB - R_TAB;
  const j = Math.atan2(cT - fT, R_TAB - fx); // where the two circles face each other (≈ 87.45°)
  const P = Math.PI;
  return {
    segs: [
      { kind: "line", x0: X, y0: 0, x1: TAB_W, y1: 0, fixed: true },
      { kind: "line", x0: TAB_W, y0: 0, x1: TAB_W, y1: fT, fixed: true },
      { kind: "arc", cx: fx, cy: fT, r: F_R, a0: 0, a1: j },
      { kind: "arc", cx: R_TAB, cy: cT, r: R_TAB, a0: j - P, a1: -P },
      { kind: "line", x0: 0, y0: cT, x1: 0, y1: cB },
      { kind: "arc", cx: R_TAB, cy: cB, r: R_TAB, a0: P, a1: P - j },
      { kind: "arc", cx: fx, cy: fB, r: F_R, a0: -j, a1: 0 },
      { kind: "line", x0: TAB_W, y0: fB, x1: TAB_W, y1: DOCK_H, fixed: true },
      { kind: "line", x0: TAB_W, y0: DOCK_H, x1: X, y1: DOCK_H, fixed: true },
      { kind: "line", x0: X, y0: DOCK_H, x1: X, y1: 0, fixed: true },
    ],
  };
}

/** The morph's ink shapes: body + fillets (+ edge patches), merged by the goo while they move. */
interface ShapeSet {
  g: SVGGElement;
  ext: SVGRectElement;
  body: SVGRectElement;
  fTop: SVGPathElement;
  fBot: SVGPathElement;
  seamTop: SVGRectElement;
  seamBot: SVGRectElement;
}

function makeShapeSet(parent: Element): ShapeSet {
  const g = svgEl("g", {}, parent);
  const ext = svgEl("rect", { fill: "#000" }, g);
  const body = svgEl("rect", { fill: "#000" }, g);
  // the fillets, drawn from the corner asset's own path data (same 40 × 40 box, same transforms)
  const fTop = svgEl("path", { d: FILLET_D, fill: "#000" }, g);
  const fBot = svgEl("path", { d: FILLET_D, fill: "#000" }, g);
  // 1.5 px patches across each fillet/tab joint (inside both shapes) so no anti-aliasing seam
  // shows when the dock lands on a half pixel.
  const seamTop = svgEl("rect", { fill: "#000" }, g);
  const seamBot = svgEl("rect", { fill: "#000" }, g);
  for (const n of [ext, seamTop, seamBot]) n.style.pointerEvents = "none";
  return { g, ext, body, fTop, fBot, seamTop, seamBot };
}

const setRect = (r: SVGRectElement, x: number, y: number, w: number, h: number, rx = 0, ry = 0): void => {
  r.setAttribute("x", fmt(x));
  r.setAttribute("y", fmt(y));
  r.setAttribute("width", fmt(Math.max(0, w)));
  r.setAttribute("height", fmt(Math.max(0, h)));
  r.setAttribute("rx", fmt(Math.max(0, rx)));
  r.setAttribute("ry", fmt(Math.max(0, ry)));
};

const show = (n: SVGElement, on: boolean): void => {
  const v = on ? "" : "none";
  if (n.style.display !== v) n.style.display = v;
};

function filletTransforms(g: Geom): { top: string; bot: string } {
  const s = g.s;
  const x = TAB_W - FILLET * s;
  // top: the asset flipped vertically, its joint row on the tab's top edge
  return {
    top: `matrix(${fmt(s)} 0 0 ${fmt(-s)} ${fmt(x)} ${fmt(g.y0)})`,
    bot: `matrix(${fmt(s)} 0 0 ${fmt(s)} ${fmt(x)} ${fmt(g.y1)})`,
  };
}

function applyShapeSet(set: ShapeSet, g: Geom): void {
  show(set.body, true);
  setRect(set.body, g.x0, g.y0, g.x1 - g.x0, g.y1 - g.y0, g.rx, g.ry);
  const on = g.s > 0.01;
  show(set.fTop, on);
  show(set.fBot, on);
  show(set.ext, on);
  show(set.seamTop, on);
  show(set.seamBot, on);
  if (!on) return;
  const tf = filletTransforms(g);
  set.fTop.setAttribute("transform", tf.top);
  set.fBot.setAttribute("transform", tf.bot);
  setRect(set.ext, TAB_W, g.y0 - FILLET * g.s, EXT, g.y1 - g.y0 + 2 * FILLET * g.s);
  const sw = 30 * g.s;
  setRect(set.seamTop, TAB_W - sw, g.y0 - 0.75, sw, 1.5);
  setRect(set.seamBot, TAB_W - sw, g.y1 - 0.75, sw, 1.5);
}

function hideShapeSet(set: ShapeSet): void {
  for (const n of [set.body, set.fTop, set.fBot, set.ext, set.seamTop, set.seamBot]) show(n, false);
}

/** Satellites: each flings out while the spring is fast inside its own window of p (so they detach
 * at different moments), snaps out quickly and drifts back gently to re-merge. */
const SATS = [
  { yf: -0.34, ang: 218, r: 7, gain: 6.4, k: 240, c: 27, p0: -0.2, p1: 0.7 },
  { yf: 0.04, ang: 184, r: 6.5, gain: 5.2, k: 260, c: 29, p0: 0.1, p1: 1.2 },
  { yf: 0.46, ang: 148, r: 6.5, gain: 5.8, k: 220, c: 26, p0: -0.2, p1: 0.55 },
];

interface SplashDrop {
  yf: number;
  ang: number;
  dist: number;
  r: number;
  delay: number;
  dur: number;
}

let uidSeq = 0;

/* ---- loading colour helpers ---- */

const rgbCache = new Map<string, [number, number, number]>();
function hexRgb(hex: string): [number, number, number] {
  let c = rgbCache.get(hex);
  if (!c) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    const n = m ? parseInt(m[1], 16) : 0;
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, c);
  }
  return c;
}

/** The glow's palette at hue h (cycles violet → blue → teal → violet, smoothstep blends like the shader). */
function glowColor(h: number): string {
  const P = INK_LOADING.palette;
  const x = (((h % 1) + 1) % 1) * 3;
  const i = Math.floor(x) % 3;
  const f = smooth(x - Math.floor(x));
  const a = hexRgb(P[i]);
  const b = hexRgb(P[(i + 1) % 3]);
  return `rgb(${Math.round(lerp(a[0], b[0], f))},${Math.round(lerp(a[1], b[1], f))},${Math.round(lerp(a[2], b[2], f))})`;
}

/** Static CSS look of the loading drop (fallback renderers): soft blobs over the linear gradient. */
function loadingCssBackground(): string {
  const [v, b, t] = INK_LOADING.palette.map(hexRgb);
  const c = (x: number[], a: number): string => `rgba(${x[0]},${x[1]},${x[2]},${a})`;
  return (
    `radial-gradient(circle at 32% 28%, ${c(v, 1)} 0, ${c(v, 0)} 58%), ` +
    `radial-gradient(circle at 72% 78%, ${c(t, 1)} 0, ${c(t, 0)} 60%), ` +
    `linear-gradient(154deg, ${c(v, 1)} 21%, ${c(b, 1)} 52%, ${c(t, 1)} 82%)`
  );
}

/** Spin an icon with a CSS (WAAPI) rotation, or stop it; returns the running animation. */
function spinCss(img: Element, on: boolean, prev: Animation | null): Animation | null {
  if (!on) {
    try {
      prev?.cancel();
    } catch {
      /* ignore */
    }
    return null;
  }
  if (prev) return prev;
  const ms = prefersReducedMotion() ? INK_LOADING.spinReducedMs : INK_LOADING.spinMs;
  if (!(ms > 0) || typeof img.animate !== "function") return null;
  try {
    return img.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: ms, iterations: Infinity });
  } catch {
    return null;
  }
}

/** A 24 px icon slot on the drop (stacked in one grid cell, never hit-tested) holding `make()`'s element. */
function icon(make: () => Element): HTMLElement {
  const box = document.createElement("span");
  css(box, { width: "24px", height: "24px", display: "block", "pointer-events": "none", "grid-area": "1 / 1" });
  const g = make() as SVGElement;
  css(g, { width: "100%", height: "100%", display: "block" });
  box.appendChild(g);
  return box;
}

export function createInkDock(opts: InkDockOptions): InkDock {
  try {
    return createGooDock(opts);
  } catch (e) {
    warn(e, "ink dock (falling back to plain CSS)");
    return createPlainDock(opts);
  }
}

function createGooDock(opts: InkDockOptions): InkDock {
  const uid = `${(++uidSeq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const el = document.createElement("div");
  el.className = "ink-dock";
  css(el, {
    position: "fixed", right: "0", top: "50%", transform: "translateY(-50%)",
    width: `${TAB_W}px`, height: `${DOCK_H}px`, "pointer-events": "none", "z-index": "6",
  });

  /* ---- svg: goo filter + shapes ---- */
  const svg = svgEl("svg", {
    viewBox: `${-PAD} ${-PAD} ${SVG_W} ${SVG_H}`, width: SVG_W, height: SVG_H, "aria-hidden": "true", focusable: "false",
  });
  css(svg, {
    position: "absolute", left: `${-PAD}px`, top: `${-PAD}px`, width: `${SVG_W}px`, height: `${SVG_H}px`,
    overflow: "hidden", display: "block", "pointer-events": "none",
  });
  const defs = svgEl("defs", {}, svg);
  const gooF = createGoo(defs, `sumi-goo-${uid}`, { x: -PAD, y: -PAD, width: SVG_W, height: SVG_H });

  /* ---- loading: while Claude works the ink is filled with this pattern instead of plain black ---- */
  const LR = R_DROP + INK_WAVES.clamp; // the drop's reach, waves included
  const pid = `sumi-paint-${uid}`;
  const paintPat = svgEl("pattern", { id: pid, patternUnits: "userSpaceOnUse", x: -PAD, y: -PAD, width: SVG_W, height: SVG_H }, defs);
  // a pattern's content is placed relative to its tile: shift it back into the svg's user space
  const paintG = svgEl("g", { transform: `translate(${PAD} ${PAD})` }, paintPat);
  svgEl("rect", { x: -PAD, y: -PAD, width: SVG_W, height: SVG_H, fill: "#000" }, paintG);
  const colour = svgEl("g", {}, paintG);
  colour.style.display = "none";
  const linId = `sumi-lin-${uid}`;
  const lin = svgEl("linearGradient", { id: linId, gradientUnits: "userSpaceOnUse" }, defs);
  const linOffsets = [0, 0.21, 0.365, 0.52, 0.67, 0.82, 1];
  const linStops = linOffsets.map((o) => svgEl("stop", { offset: o }, lin));
  svgEl("circle", { cx: AXIS_X, cy: MID_Y, r: LR + 14, fill: `url(#${linId})` }, colour);
  const blobEls = INK_LOADING.blobs.map((_, i) => {
    const id = `sumi-blob${i}-${uid}`;
    const g = svgEl("radialGradient", { id }, defs);
    const stops = ([[0, 0.92], [0.5, 0.5], [1, 0]] as const).map(([o, a]) => svgEl("stop", { offset: o, "stop-opacity": a }, g));
    return { c: svgEl("circle", { cx: AXIS_X, cy: MID_Y, r: 0, fill: `url(#${id})` }, colour), stops };
  });
  // the colour's front: a noisy, soft-edged blob while it blooms in / drains out, then a still soft disc
  // just past the drop's reach (splash droplets are colour near the drop, black ink farther out)
  const softId = `sumi-soft-${uid}`;
  const softF = svgEl("filter", { id: softId, filterUnits: "userSpaceOnUse", x: -PAD, y: -PAD, width: SVG_W, height: SVG_H }, defs);
  svgEl("feGaussianBlur", { stdDeviation: INK_LOADING.frontSoft }, softF);
  const restR = LR + 8; // the still disc fades out between LR + 1 and LR + 8
  const fadeId = `sumi-fade-${uid}`;
  const fadeG = svgEl("radialGradient", { id: fadeId, gradientUnits: "userSpaceOnUse", cx: AXIS_X, cy: MID_Y, r: restR }, defs);
  svgEl("stop", { offset: fmt3((LR + 1) / restR), "stop-color": "#fff" }, fadeG);
  svgEl("stop", { offset: 1, "stop-color": "#fff", "stop-opacity": 0 }, fadeG);
  const restFront = inkOutlinePath(inkCircle(AXIS_X, MID_Y, restR));
  const maskId = `sumi-front-${uid}`;
  const frontMask = svgEl("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: -PAD, y: -PAD, width: SVG_W, height: SVG_H }, defs);
  const front = svgEl("path", { d: restFront, fill: `url(#${fadeId})` }, frontMask);
  colour.setAttribute("mask", `url(#${maskId})`);

  const ghost = makeShapeSet(svg); // reduced-motion crossfade only, never filtered
  ghost.g.style.pointerEvents = "none";
  ghost.g.style.display = "none";
  const main = makeShapeSet(svg);
  // the ink blocks the page under it (the fillet paths are hit-tested on their ink only)
  for (const n of [main.body, main.fTop, main.fBot]) n.style.pointerEvents = "fill";
  // the resting surface: ONE procedural outline (open tab + fillets, or the drop) through the waves
  const wave = svgEl("path", { fill: "#000", d: "" }, main.g);
  wave.style.pointerEvents = "fill";
  wave.style.display = "none";
  const circle = (): SVGCircleElement => {
    const c = svgEl("circle", { fill: "#000", cx: 0, cy: 0, r: 0 }, main.g);
    c.style.pointerEvents = "none";
    return c;
  };
  const satEls = SATS.map(circle);
  const splashEls = [0, 1, 2, 3, 4].map(circle);
  // everything the goo draws takes the loading paint (the ghost crossfade stays plain black)
  const paintable: SVGElement[] = [wave, main.body, main.fTop, main.fBot, main.ext, main.seamTop, main.seamBot, ...satEls, ...splashEls];

  let openRest = "";
  let closedRest = "";
  let openField: WaveField | null = null;
  let closedField: WaveField | null = null;
  try {
    openRest = inkOutlinePath(dockOutline());
    closedRest = inkOutlinePath(inkCircle(AXIS_X, MID_Y, R_DROP));
  } catch (e) {
    warn(e, "ink dock outline (resting on the morph shapes)");
    openRest = closedRest = "";
  }
  try {
    if (openRest) {
      openField = new WaveField(dockOutline());
      closedField = new WaveField(inkCircle(AXIS_X, MID_Y, R_DROP));
    }
  } catch (e) {
    warn(e, "ink dock waves (static outline)");
    openField = closedField = null;
  }

  /* ---- content + drop button ---- */
  const content = document.createElement("div");
  content.className = "ink-content";
  // the radius only shapes hit-testing of the (transparent) box: the page stays clickable just
  // outside the tab's rounded corners, while overflowing UI children (tooltips) are not clipped
  css(content, {
    position: "absolute", right: "0", top: `${FILLET}px`, width: `${TAB_W}px`, height: `${TAB_H}px`,
    "border-radius": `${R_TAB}px 0 0 ${R_TAB}px`,
  });

  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "ink-drop";
  drop.setAttribute("aria-label", "Open Sumi");
  css(drop, {
    position: "absolute", left: `${AXIS_X - R_DROP}px`, top: `${MID_Y - R_DROP}px`, width: `${DROP}px`, height: `${DROP}px`,
    margin: "0", padding: "0", border: "0", "border-radius": "50%", background: "transparent",
    display: "grid", "place-items": "center", cursor: "pointer", "pointer-events": "auto",
  });
  const dropImg = icon(opts.dropIcon);
  drop.appendChild(dropImg);
  // the loader arc, unmodified, stacked on the drop icon: its wrapper scales and fades with the bloom,
  // the arc itself spins as one compositor animation (spinCss)
  let loaderImg: HTMLElement | null = null;
  let loaderArc: Element | null = null;
  if (opts.loaderIcon) {
    loaderArc = opts.loaderIcon();
    loaderImg = icon(() => loaderArc as Element);
    loaderImg.style.opacity = "0";
    drop.appendChild(loaderImg);
  }

  el.append(svg, content, drop);

  /* ---- state ---- */
  let isOpen = !!opts.startOpen;
  let destroyed = false;
  const spring = { p: isOpen ? 1 : 0, v: 0, target: isOpen ? 1 : 0, k: SPRING_OPEN.k, c: SPRING_OPEN.c, thr: SPRING_OPEN.thr, active: false };
  const sat = SATS.map(() => ({ d: 0, dv: 0 }));
  let goo = 0; // 0..1 filter strength
  let wob = 0; // displacement scale
  let lastT = clock();
  let running = false;
  let splash: { start: number; drops: SplashDrop[]; until?: number } | null = null; // until: ms after start (default 900)
  let fade: { start: number; from: number; to: number } | null = null; // reduced-motion crossfade
  let waiters: Array<() => void> = [];
  let safety = 0;
  let shadowCss = "";
  let contentClip = "";
  let waveD = "";

  /* ---- loading state ---- */
  let loading = false;
  /** the dock was open when loading began (it collapsed on its own): pour it back open when done */
  let restore = false;
  let reopenAt = -1; // ink clock ms, −1 = not scheduled
  let fromSend = false; // the next bloom wells up where Send sat
  /** colour coverage k (0 black ink … 1 full colour), tweening from → to; front origin and noise phases */
  const tint = { k: 0, from: 0, to: 0, t0: 0, dur: 1, ox: AXIS_X, oy: MID_Y, ph: [0, 0, 0, 0] };
  let rippleDue = 0; // a ripple (px) waiting for the drop's resting surface
  let bloomRippled = false;
  let drainSplashed = false;
  let nextImpulse = -1;
  let painted = false;
  let spinAnim: Animation | null = null;
  let iconCss = ["", "", "", ""]; // drop icon opacity / transform, loader opacity / transform
  const colourCache = new Map<Element, string>();
  let colourAt = -Infinity;
  const epoch = clock(); // ≈ the glow's start (both are created together): breaths line up
  const rnd = seeded(0x5e1d);

  /** The surface that is resting (and may ripple) right now: none while the morph runs. */
  const restField = (): WaveField | null => (spring.active || fade ? null : isOpen ? openField : closedField);
  const resetWaves = (): void => {
    for (const f of [openField, closedField]) {
      if (!f) continue;
      f.reset();
      f.leave();
    }
  };

  // content choreography (WAAPI animations, paused and seeked from our own clock)
  const contentAnims = new Choreo();
  let contentStart = 0;
  let contentPhase: "idle" | "in" | "out" = "idle";
  const tx = (px: number): Keyframe => shift(px, 0);

  const cancelContent = (): void => {
    contentAnims.cancel();
    contentPhase = "idle";
  };

  const anim = (node: Element, frames: Keyframe[], dur: number, easing: string, offset: number): void =>
    contentAnims.add(node, frames, dur, easing, offset);

  const startContent = (opening: boolean, reduced: boolean, fromP: number): void => {
    cancelContent();
    const t = clock();
    if (opening) {
      css(content, { visibility: "visible", "pointer-events": "auto" });
      if (reduced) {
        anim(content, [{ opacity: 0 }, { opacity: 1 }], REDUCED_MS, "linear", 0);
        contentStart = t;
        contentAnims.end = REDUCED_MS;
      } else {
        const delay = ITEM_DELAY * clamp01(1 - fromP);
        contentStart = t + delay;
        anim(content, [{ opacity: 0 }, { opacity: 1 }], 140, "linear", -60);
        const items = Array.from(content.querySelectorAll("[data-ink-item]"));
        items.forEach((n, i) => {
          let base = "1";
          try {
            base = getComputedStyle(n).opacity || "1";
          } catch {
            /* ignore */
          }
          anim(n, [{ opacity: 0, ...tx(14) }, { opacity: Number(base), ...tx(0) }], ITEM_MS, ITEM_EASE, i * ITEM_STAGGER);
        });
        contentAnims.end = Math.max(80, (items.length - 1) * ITEM_STAGGER + ITEM_MS);
      }
      contentPhase = "in";
    } else {
      content.style.pointerEvents = "none";
      contentStart = t;
      const dur = reduced ? REDUCED_MS : CLOSE_FADE_MS;
      anim(content, [{ opacity: 1 }, { opacity: 0 }], dur, reduced ? "linear" : "ease-in", 0);
      if (!reduced) {
        for (const n of Array.from(content.querySelectorAll("[data-ink-item]"))) {
          anim(n, [tx(0), tx(8)], dur, "ease-in", 0);
        }
      }
      contentAnims.end = dur;
      contentPhase = "out";
    }
  };

  /** Seek content animations; returns true while they still run. */
  const stepContent = (t: number): boolean => {
    if (contentPhase === "idle") return false;
    if (contentAnims.seek(t - contentStart)) return true;
    // done: an opened content reverts to the UI's own styles; a closed one stays transparent
    // (visibility:hidden) until it opens again.
    if (contentPhase === "out") {
      css(content, { visibility: "hidden", "pointer-events": "none" });
    }
    cancelContent();
    return false;
  };

  const applyStatic = (): void => {
    // plain (rest) presentation of the logical state
    css(content, { visibility: isOpen ? "visible" : "hidden", "pointer-events": isOpen ? "auto" : "none" });
  };

  const resolveWaiters = (): void => {
    const w = waiters;
    waiters = [];
    for (const r of w) r();
    if (safety) clearTimeout(safety);
    safety = 0;
  };

  const settledNow = (): boolean => !spring.active && !fade && contentPhase === "idle";

  /* ---- loading: colour, front and icons ---- */
  const attr = (n: Element, k: string, v: string): void => {
    if (n.getAttribute(k) !== v) n.setAttribute(k, v);
  };
  /** Inline style writes only when the value changed (most frames change nothing but the waves). */
  const written = new Map<string, string>();
  const put = (n: HTMLElement | SVGElement, k: string, v: string): void => {
    const key = `${n === drop ? "d" : "c"}:${k}`;
    if (written.get(key) === v) return;
    written.set(key, v);
    n.style.setProperty(k, v);
  };
  /** The glow's breathing envelope (0 … 1) at ink time t. */
  const glowBreath = (t: number): number => 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - epoch)) / (1000 * Math.max(0.2, INK_LOADING.breathS)));

  const setPainted = (on: boolean): void => {
    if (on === painted) return;
    painted = on;
    const f = on ? `url(#${pid})` : "#000";
    for (const n of paintable) n.setAttribute("fill", f);
    colour.style.display = on ? "" : "none";
  };

  /** The living gradient (blobs drift, breathe and drift in hue) and its front, for coverage tint.k. */
  const renderColour = (t: number, reduced: boolean): void => {
    const L = INK_LOADING;
    const k = tint.k;
    const s = reduced ? 0 : (t - epoch) / 1000; // reduced motion: one still gradient
    const b = reduced ? 0.5 : glowBreath(t);
    const swing = Math.max(0.001, L.hueSwing);
    const hue = swing * Math.sin((s * L.hueDrift) / swing) + L.hueBreath * b;
    const col = (h: number): string => glowColor(clamp(h, 0, 2 / 3)); // violet … teal, no wrap
    const set = (n: Element, c: string): void => {
      if (colourCache.get(n) === c) return;
      colourCache.set(n, c);
      n.setAttribute("stop-color", c);
    };
    // the underlying linear gradient, swaying gently
    const a = ((L.baseAngle + (reduced ? 0 : L.baseSway * Math.sin((2 * Math.PI * s) / Math.max(0.5, L.baseSwayS)))) * Math.PI) / 180;
    // the gradient line spans the drop's box along its direction (like CSS / Figma linear gradients)
    const ca = Math.cos(a) * R_DROP * 1.3;
    const sa = Math.sin(a) * R_DROP * 1.3;
    attr(lin, "x1", fmt(AXIS_X - ca));
    attr(lin, "y1", fmt(MID_Y - sa));
    attr(lin, "x2", fmt(AXIS_X + ca));
    attr(lin, "y2", fmt(MID_Y + sa));
    const span = Math.max(0.01, L.spanTo - L.spanFrom);
    linStops.forEach((n, i) => set(n, col(hue + L.hueSpan * clamp01((linOffsets[i] - L.spanFrom) / span))));
    // the blobs: each wells up from the front's origin, then drifts on its own orbit
    const swell = 1 + L.breatheBlob * (2 * b - 1);
    L.blobs.forEach((B, i) => {
      const el = blobEls[i];
      if (!el) return;
      const d = L.blobDelay[i] ?? 0;
      const e = reduced ? 1 : easeOut3(clamp01((k - d) / Math.max(0.05, 1 - d)));
      const th = B.phase + (2 * Math.PI * s) / (B.period || 1);
      const px = AXIS_X + B.dx + B.rx * Math.cos(th);
      const py = MID_Y + B.dy + B.ry * Math.sin(1.37 * th + B.phase);
      attr(el.c, "cx", fmt(lerp(tint.ox, px, e)));
      attr(el.c, "cy", fmt(lerp(tint.oy, py, e)));
      attr(el.c, "r", fmt(Math.max(0, B.r * swell * (0.35 + 0.65 * e))));
      const c = col(hue + B.hue);
      for (const st of el.stops) set(st, c);
    });
    // the front
    if (reduced || k >= 1) {
      attr(front, "d", restFront);
      attr(front, "fill", `url(#${fadeId})`);
      if (front.hasAttribute("filter")) front.removeAttribute("filter");
      put(colour, "opacity", reduced ? fmt(k) : "");
      return;
    }
    // opened mid-loading: the colour is swallowed as the drop pours into the (black) tab, fading as it shrinks
    put(colour, "opacity", isOpen ? fmt(k) : "");
    const amp = L.frontNoise * (1 + 0.8 * (1 - k));
    const m = smooth(k);
    const ox = lerp(tint.ox, AXIS_X, m);
    const oy = lerp(tint.oy, MID_Y, m);
    // radius at k = 1: just past the drop's edge as it ripples while loading (the still disc takes over there)
    const cover = (R_DROP + 4 + Math.hypot(ox - AXIS_X, oy - MID_Y)) / (1 - Math.min(0.5, amp));
    attr(front, "d", blobPath(ox, oy, Math.max(0.01, k * cover), amp, tint.ph, (t - tint.t0) / 1000));
    attr(front, "fill", "#fff");
    attr(front, "filter", `url(#${softId})`);
  };

  /** Drop icon ⇄ loader crossfade riding on the morph's icon fade `iconK`; the arc spins on the compositor. */
  const renderIcons = (iconK: number, reduced: boolean): void => {
    const sk = loaderImg ? smooth((tint.k - 0.15) / 0.55) : 0;
    const next = [fmt(iconK * (1 - sk)), sk > 0 && !reduced ? `scale(${fmt(1 - 0.3 * sk)})` : "", "", ""];
    if (loaderImg && loaderArc) {
      next[2] = fmt(iconK * sk);
      if (sk > 0.001 && !reduced) next[3] = `scale(${fmt(0.7 + 0.3 * sk)})`;
      spinAnim = spinCss(loaderArc, sk > 0.001, spinAnim);
    }
    if (next[0] !== iconCss[0]) dropImg.style.opacity = next[0];
    if (next[1] !== iconCss[1]) dropImg.style.transform = next[1];
    if (loaderImg && next[2] !== iconCss[2]) loaderImg.style.opacity = next[2];
    if (loaderImg && next[3] !== iconCss[3]) loaderImg.style.transform = next[3];
    iconCss = next;
  };

  /* ---- per-frame render ---- */
  const setGoo = (g: number, w: number, tSec: number): void => {
    gooF.set(main.g, g, w, 0.02 + 0.006 * Math.sin(tSec * 0.5), 0.024 + 0.006 * Math.cos(tSec * 0.37));
  };

  const render = (t: number): void => {
    const p = spring.p;
    const g = geomAt(p);
    const tSec = t / 1000;
    const reduced = prefersReducedMotion();
    setPainted(tint.k > 0.001);
    // the colour drifts slowly: ~15 fps is smooth for it once it has bloomed (the edge keeps its own rate)
    if (painted && (tint.k !== tint.to || !(t - colourAt < COLOUR_FRAME_MS && t >= colourAt))) {
      colourAt = t;
      renderColour(t, reduced);
    }

    if (fade) {
      const k = clamp01((t - fade.start) / REDUCED_MS);
      applyShapeSet(main, geomAt(fade.to));
      applyShapeSet(ghost, geomAt(fade.from));
      ghost.g.style.display = "";
      ghost.g.style.opacity = fmt(1 - k);
      main.g.style.opacity = fmt(k);
      show(wave, false);
    } else {
      if (ghost.g.style.display !== "none") ghost.g.style.display = "none";
      if (main.g.style.opacity !== "") main.g.style.opacity = "";
      const rest = !spring.active && (isOpen ? openRest : closedRest);
      if (rest) {
        // at rest the shapes hand over to the single procedural outline: same geometry, so the
        // switch is invisible (it happens under the goo, which is still ramping out after a morph)
        hideShapeSet(main);
        const f = isOpen ? openField : closedField;
        let d = rest;
        if (f) {
          const W = INK_WAVES;
          let breath = !isOpen && W.breathe > 0
            ? W.breathe * clamp01(f.amb / Math.max(0.01, W.ambientHover)) * Math.sin((2 * Math.PI * f.time) / Math.max(0.2, W.breathePeriod))
            : 0;
          // loading: the drop breathes with the glow at the screen's edges instead
          if (!isOpen && painted && !reduced) breath = lerp(breath, INK_LOADING.breatheEdge * (2 * glowBreath(t) - 1), clamp01(tint.k));
          d = f.path(breath);
        }
        if (d !== waveD) {
          waveD = d;
          wave.setAttribute("d", d);
        }
        show(wave, true);
      } else {
        applyShapeSet(main, g);
        show(wave, false);
      }
    }

    // satellites
    const h = g.y1 - g.y0;
    SATS.forEach((d, i) => {
      const s = sat[i];
      const c = satEls[i];
      if (s.d < 0.4 || fade) {
        if (c.getAttribute("r") !== "0") c.setAttribute("r", "0");
        return;
      }
      const y = MID_Y + d.yf * (h / 2) * 0.8;
      const ax = leftEdge(g, y) + d.r + 1.5;
      const a = (d.ang * Math.PI) / 180;
      c.setAttribute("cx", fmt(ax + Math.cos(a) * s.d));
      c.setAttribute("cy", fmt(y + Math.sin(a) * s.d));
      c.setAttribute("r", fmt(d.r * (0.4 + 0.6 * smooth(s.d / 10)) * clamp01(s.d / 2)));
    });

    // splash droplets
    splashEls.forEach((c, i) => {
      const sd = splash && splash.drops[i];
      const u = sd && splash ? (t - splash.start - sd.delay) / sd.dur : -1;
      if (!sd || u <= 0 || u >= 1) {
        if (c.getAttribute("r") !== "0") c.setAttribute("r", "0");
        return;
      }
      const dd = sd.dist * 4 * u * (1 - u); // out and back, like a thrown drop
      const y = (g.y0 + g.y1) / 2 + sd.yf * (h / 2) * 0.85;
      const ax = leftEdge(g, y) + sd.r + 1;
      const a = (sd.ang * Math.PI) / 180;
      c.setAttribute("cx", fmt(ax + Math.cos(a) * dd));
      c.setAttribute("cy", fmt(y + Math.sin(a) * dd + 9 * u * u)); // a little gravity
      c.setAttribute("r", fmt(sd.r * (1 - 0.25 * Math.sin(Math.PI * u))));
    });

    setGoo(goo, wob, tSec);

    // closed-state drop shadow (fades out as it opens)
    const shadowK = fade ? lerp(1 - smooth(fade.from / 0.5), 1 - smooth(fade.to / 0.5), clamp01((t - fade.start) / REDUCED_MS)) : 1 - smooth(p / 0.5);
    const sc = shadowK > 0.005 ? `drop-shadow(6px 6px ${SHADOW_BLUR}px rgba(0,0,0,${(SHADOW_A * shadowK).toFixed(3)}))` : "none";
    if (sc !== shadowCss) {
      shadowCss = sc;
      svg.style.filter = sc;
    }

    // while morphing, the UI's content is clipped to the ink so icons never float outside it
    let clip = "";
    if (spring.active && contentPhase !== "idle") {
      const top = Math.max(0, g.y0 - FILLET);
      const bottom = Math.max(0, FILLET + TAB_H - g.y1);
      const left = Math.max(0, g.x0);
      const right = Math.max(0, TAB_W - g.x1);
      const rr = g.x1 < TAB_W ? g.rx : 0;
      clip = `inset(${fmt(top)}px ${fmt(right)}px ${fmt(bottom)}px ${fmt(left)}px round ${fmt(g.rx)}px ${fmt(rr)}px ${fmt(rr)}px ${fmt(g.rx)}px / ${fmt(g.ry)}px ${fmt(rr ? g.ry : 0)}px ${fmt(rr ? g.ry : 0)}px ${fmt(g.ry)}px)`;
    }
    if (clip !== contentClip) {
      contentClip = clip;
      content.style.setProperty("clip-path", clip);
    }

    // drop button + icon ride on the drop and fade as it opens
    const iconK = fade ? lerp(fade.from <= 0 ? 1 : 0, fade.to <= 0 ? 1 : 0, clamp01((t - fade.start) / REDUCED_MS)) : 1 - smooth(p / 0.3);
    const vx = (Math.max(g.x0, -20) + Math.min(g.x1, TAB_W)) / 2;
    const vy = (g.y0 + g.y1) / 2;
    put(drop, "transform", fade ? "" : `translate(${fmt(vx - AXIS_X)}px, ${fmt(vy - MID_Y)}px)`);
    renderIcons(iconK, reduced);
    const btnVisible = !isOpen || iconK > 0.01;
    put(drop, "visibility", btnVisible ? "visible" : "hidden");
    put(drop, "pointer-events", isOpen ? "none" : "auto");
  };

  /* ---- ticker ---- */
  const integrate = (dt: number): void => {
    // an inactive spring rests (v = 0): stepping it with k = c = 0 only advances the satellites
    const on = spring.active;
    stepSpring(spring, on ? spring.k : 0, on ? spring.c : 0, spring.target, dt, (h) => {
      const speed = on ? Math.abs(spring.v) : 0;
      SATS.forEach((d, i) => {
        const s = sat[i];
        const win = smooth((spring.p - d.p0) / 0.08) * smooth((d.p1 - spring.p) / 0.08);
        // opening throws a little harder: the mass races off toward the edge, leaving drops behind
        const target = Math.min(34, d.gain * speed * win * (spring.target > 0.5 ? 1.3 : 1));
        const out = target > s.d; // fling out fast, drift back gently
        const a = -(out ? d.k * 2.2 : d.k) * (s.d - target) - (out ? d.c * 1.5 : d.c) * s.dv;
        s.dv += a * h;
        s.d += s.dv * h;
        if (s.d < 0) {
          s.d = 0;
          if (s.dv < 0) s.dv = 0;
        }
      });
    });
  };

  /** Land the spring on its target; `all` also drops the satellites (instant finish). */
  const snapSpring = (all: boolean): void => {
    spring.p = spring.target;
    spring.v = 0;
    spring.active = false;
    if (!all) return;
    for (const s of sat) {
      s.d = 0;
      s.dv = 0;
    }
  };

  /* ---- loading choreography ---- */

  /** A tiny splash off the drop (bloom / drain). */
  const tinySplash = (): void => {
    const L = INK_LOADING;
    const n = Math.max(0, Math.min(splashEls.length, Math.round(L.splashDrops)));
    if (!n || prefersReducedMotion()) return;
    const drops: SplashDrop[] = [];
    for (let i = 0; i < n; i++) {
      const yf = lerp(-0.6, 0.6, (i + 0.5) / n) + (rnd() - 0.5) * 0.3;
      drops.push({
        yf,
        ang: 180 - yf * 110 + (rnd() - 0.5) * 30, // fanned out around the drop's free side
        dist: lerp(L.splashDist[0], L.splashDist[1], rnd()),
        r: lerp(L.splashR[0], L.splashR[1], rnd()),
        delay: rnd() * 50,
        dur: lerp(L.splashMs[0], L.splashMs[1], rnd()),
      });
    }
    // done (and the goo off again) as soon as the last droplet is back
    splash = { start: clock(), drops, until: Math.max(...drops.map((d) => d.delay + d.dur)) + 60 };
  };

  /** Where the colour is heading: full while loading on the landed drop (latched), else black ink. */
  const tintTarget = (): number => {
    if (!loading || isOpen || plain) return 0;
    if (tint.to === 1) return 1;
    if (fade) return 0;
    return !spring.active || spring.p <= INK_LOADING.landAt ? 1 : 0;
  };

  const stepTint = (t: number, reduced: boolean): void => {
    const L = INK_LOADING;
    const want = tintTarget();
    if (want !== tint.to) {
      tint.from = tint.k;
      tint.to = want;
      tint.t0 = t;
      const full = reduced ? REDUCED_MS : want ? L.bloomMs : isOpen ? L.drainOpenMs : L.drainMs;
      tint.dur = Math.max(1, full * Math.abs(want - tint.k));
      if (want) {
        if (tint.k < 0.05) {
          // a fresh bloom: where it wells up, the noise of its front, and the ink it throws off
          tint.ox = AXIS_X;
          tint.oy = MID_Y + (fromSend ? L.originDy : 0);
          tint.ph = [0, 1, 2, 3].map(() => rnd() * Math.PI * 2);
          bloomRippled = false;
          if (!reduced) tinySplash();
        }
        fromSend = false;
      } else drainSplashed = false;
    }
    if (tint.k !== tint.to) {
      const u = clamp01((t - tint.t0) / tint.dur);
      // bloom: wells up quickly, slows as it reaches the edge; drain: retreats at once, closing faster at the end
      const e = reduced ? u : tint.to > tint.from ? 1 - (1 - u) ** 1.6 : u * (0.6 + 0.4 * u);
      tint.k = u >= 1 ? tint.to : lerp(tint.from, tint.to, e);
    }
    if (reduced) return;
    // the colour reaching the edge ripples it; the ink closing back over it splashes a little
    if (tint.to === 1 && !bloomRippled && tint.k >= 0.7) {
      bloomRippled = true;
      rippleDue = L.ripple;
    }
    if (tint.to === 0 && !isOpen && !drainSplashed && tint.from > 0.5 && tint.k <= 0.3) {
      drainSplashed = true;
      rippleDue = L.ripple;
      tinySplash();
    }
  };

  /** Keep the loading drop's edge alive: sustained shimmer, ripples from the colour, self-impulses. */
  const driveEdge = (t: number, reduced: boolean): void => {
    const L = INK_LOADING;
    const f = closedField;
    if (!f) return;
    f.floor = loading && !isOpen && !reduced ? Math.max(0, L.ambient) * clamp01(tint.k) : 0;
    if (reduced || isOpen) {
      rippleDue = 0;
      nextImpulse = -1;
      return;
    }
    if (restField() !== f) return;
    const poke = (a: number, amount: number): void => f.poke(AXIS_X + Math.cos(a) * R_DROP, MID_Y + Math.sin(a) * R_DROP, amount);
    if (rippleDue) {
      const a0 = rnd() * Math.PI * 2;
      for (let i = 0; i < 3; i++) poke(a0 + (i * 2 * Math.PI) / 3, rippleDue);
      rippleDue = 0;
    }
    if (!loading || tint.k < 1) {
      nextImpulse = -1;
      return;
    }
    if (nextImpulse < 0) nextImpulse = t + 600;
    else if (t >= nextImpulse) {
      poke(rnd() * Math.PI * 2, L.impulse * (0.6 + 0.4 * rnd()) * (rnd() < 0.5 ? -1 : 1));
      nextImpulse = t + 1000 * lerp(L.impulseEvery[0], L.impulseEvery[1], rnd());
    }
  };

  /** A dock that collapsed for loading pours back open once the colour has drained (+ a short pause). */
  const stepReopen = (t: number): void => {
    if (loading || !restore || isOpen) {
      reopenAt = -1;
      return;
    }
    if (spring.active || fade || tint.k > 0 || tint.to > 0) {
      reopenAt = -1;
      return;
    }
    if (reopenAt < 0) reopenAt = t + Math.max(0, INK_LOADING.reopenDelayMs);
    else if (t >= reopenAt) {
      reopenAt = -1;
      restore = false;
      void go(true, true);
    }
  };

  const step = (t: number): boolean => {
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;

    const reduced = prefersReducedMotion();
    stepReopen(t);
    integrate(dt);
    if (spring.active) {
      const w = Math.sqrt(spring.k);
      if (Math.abs(spring.p - spring.target) < spring.thr && Math.abs(spring.v) < spring.thr * w) snapSpring(false);
    }
    stepTint(t, reduced);
    driveEdge(t, reduced);

    // the resting surface's waves
    const f = restField();
    if (f) {
      if (reduced) {
        f.reset();
        f.leave();
      } else f.step(dt);
    }

    if (splash && t - splash.start > (splash.until ?? 900)) splash = null;
    const satLive = sat.some((s) => s.d > 0.25 || Math.abs(s.dv) > 0.5);
    if (!satLive) for (const s of sat) s.d = s.dv = 0;
    const contentLive = stepContent(t);
    if (fade && t - fade.start >= REDUCED_MS) fade = null;

    // goo strength & wobble (morph and splash only: the resting surface ripples on its own)
    const want = spring.active || satLive || !!splash ? 1 : 0;
    goo = reduced ? 0 : approach(goo, want, want > goo ? 30 : 9, dt);
    if (goo < 0.01 && !want) goo = 0;
    const wobTarget = reduced ? 0 : Math.min(1.6, Math.abs(spring.v) * 0.3) + (splash ? 1.2 : 0);
    wob = approach(wob, wobTarget, 8, dt);
    if (wob < 0.01 && wobTarget === 0) wob = 0;

    render(t);

    if (settledNow() && waiters.length) resolveWaiters();
    if (!spring.active && !fade && contentPhase === "idle") applyStaticIfIdle();
    const field = restField();
    // loading keeps the loop alive on the coloured drop (blobs, spinner, edge) and until a reopen
    const loadLive =
      tint.k !== tint.to || tintTarget() !== tint.to || (painted && loading && !isOpen && !reduced) || reopenAt >= 0 || (restore && !loading && !isOpen);
    const live = spring.active || !!fade || contentLive || satLive || !!splash || goo > 0 || wob > 0 || (!!field && field.awake()) || loadLive;
    running = live;
    return live;
  };

  const ticker: Ticker = {
    /** ~30 fps is enough once only the ambient shimmer or the loading drop moves (no morph, splash,
     * colour transition or pointer ripple). */
    get lowRate() {
      if (spring.active || fade || contentPhase !== "idle" || splash || goo > 0 || wob > 0 || tint.k !== tint.to) return false;
      if (sat.some((x) => x.d > 0 || x.dv !== 0)) return false;
      const f = restField();
      return !f || !f.hot();
    },
    tick(t: number): boolean {
      if (destroyed || plain) return false;
      try {
        return step(t);
      } catch (e) {
        degrade(e);
        return false;
      }
    },
    finish(): void {
      if (destroyed || plain) return;
      snapSpring(true);
      fade = null;
      splash = null;
      resetWaves();
      goo = 0;
      wob = 0;
      // loading lands on the colour its state asks for; a pending reopen waits for frames again
      tint.k = tint.from = tint.to = loading && !isOpen ? 1 : 0;
      fromSend = false;
      rippleDue = 0;
      nextImpulse = -1;
      reopenAt = -1;
      if (closedField) closedField.floor = 0;
      if (contentPhase !== "idle") {
        if (contentPhase === "out") css(content, { visibility: "hidden", "pointer-events": "none" });
        cancelContent();
      }
      applyStatic();
      try {
        render(clock());
      } catch (e) {
        degrade(e);
      }
      running = false;
      resolveWaiters();
    },
  };

  /* ---- last resort: a static ink dock (one path, or the stub's CSS tab), if the renderer ever fails ---- */
  let plain: { ink: Element } | null = null;
  const applyPlain = (): void => {
    if (!plain) return;
    (plain.ink as HTMLElement).style.display = isOpen ? "" : "none";
    applyStatic();
    drop.style.display = isOpen ? "none" : "grid";
    // loading: a CSS gradient drop with the arc spinning on it
    const on = loading && !isOpen;
    drop.style.background = on ? loadingCssBackground() : "#000";
    dropImg.style.opacity = on && loaderImg ? "0" : "";
    dropImg.style.transform = "";
    if (loaderImg) {
      loaderImg.style.opacity = on ? "1" : "0";
      loaderImg.style.transform = "";
      if (loaderArc) spinAnim = spinCss(loaderArc, on, spinAnim);
    }
  };
  const degrade = (e: unknown): void => {
    if (plain || destroyed) return;
    warn(e, "ink renderer failed, using a static dock");
    unschedule(ticker);
    hubRemove(client);
    running = false;
    try {
      cancelContent();
      content.style.removeProperty("clip-path");
      svg.style.display = "none";
      const ink = plainInk();
      el.insertBefore(ink, content);
      css(drop, { background: "#000", "box-shadow": "6px 6px 20px rgba(0,0,0,.25)", transform: "", visibility: "visible" });
      dropImg.style.opacity = "";
      spinAnim = spinCss(dropImg, false, spinAnim);
      plain = { ink };
      applyPlain();
    } catch (err) {
      warn(err, "ink plain fallback");
    }
    resolveWaiters();
  };

  const applyStaticIfIdle = (): void => {
    if (!isOpen && content.style.visibility !== "hidden") css(content, { visibility: "hidden", "pointer-events": "none" });
  };

  const wake = (): void => {
    if (destroyed || plain) return;
    if (!running) lastT = clock();
    running = true;
    schedule(ticker);
  };

  const go = (open: boolean, auto = false): Promise<void> => {
    if (destroyed) return Promise.resolve();
    if (plain) {
      if (open !== isOpen) {
        isOpen = open;
        applyPlain();
        try {
          (open ? opts.onOpen : opts.onClose)?.({ auto });
        } catch (e) {
          warn(e, open ? "ink onOpen" : "ink onClose");
        }
      }
      return Promise.resolve();
    }
    if (open === isOpen) {
      return settledNow() ? Promise.resolve() : new Promise<void>((r) => waiters.push(r));
    }
    isOpen = open;
    resetWaves(); // the morph takes over from the resting surface
    const reduced = prefersReducedMotion();
    const fromP = spring.p;
    if (reduced) {
      fade = { start: clock(), from: Math.round(clamp01(fromP)), to: open ? 1 : 0 };
      spring.target = open ? 1 : 0;
      snapSpring(true);
    } else {
      const cfg = open ? SPRING_OPEN : SPRING_CLOSE;
      spring.target = open ? 1 : 0;
      spring.k = cfg.k;
      spring.c = cfg.c;
      spring.thr = cfg.thr;
      spring.active = true;
    }
    drop.setAttribute("aria-hidden", open ? "true" : "false");
    drop.tabIndex = open ? -1 : 0;
    startContent(open, reduced, open ? clamp01(fromP) : 1 - clamp01(fromP));
    const done = new Promise<void>((r) => waiters.push(r));
    if (safety) clearTimeout(safety);
    safety = window.setTimeout(() => {
      safety = 0;
      if (waiters.length) {
        unschedule(ticker);
        ticker.finish();
      }
    }, SAFETY_MS);
    wake();
    try {
      (open ? opts.onOpen : opts.onClose)?.({ auto });
    } catch (e) {
      warn(e, open ? "ink onOpen" : "ink onClose");
    }
    return done;
  };

  /* ---- fit short viewports: scale the whole dock around its right-centre anchor ---- */
  let fitScale = 1;
  let box: DOMRect | null = null; // the dock's viewport box (fixed: changes only with the viewport)
  const fit = (): void => {
    box = null;
    try {
      const vh = window.innerHeight;
      if (!vh || vh < 100) return; // hidden or collapsed viewport: keep the last good fit
      const avail = vh - 16;
      fitScale = Math.min(1, avail / DOCK_H);
      el.style.setProperty("transform-origin", "100% 50%");
      el.style.setProperty("transform", fitScale < 1 ? `translateY(-50%) scale(${fitScale.toFixed(4)})` : "translateY(-50%)");
    } catch (e) {
      warn(e, "ink fit");
    }
  };
  fit();
  window.addEventListener("resize", fit);

  /* ---- pointer: ripples on the resting surface (proximity via the shared window listener) ---- */
  const client: WaveClient = {
    move(cx, cy, dx, dy) {
      if (destroyed || plain) return;
      const f = restField();
      if (!f || prefersReducedMotion()) return;
      const r = box || el.getBoundingClientRect(); // includes the fit scale
      if (!(r.width > 0)) return;
      box = r;
      const k = fitScale > 0 ? fitScale : 1;
      if (f.feed((cx - r.left) / k, (cy - r.top) / k, dx / k, dy / k)) wake();
    },
    out() {
      if (destroyed || plain) return;
      openField?.leave();
      closedField?.leave();
      if (restField()) wake();
    },
  };
  hubAdd(client);
  // the frame loop stops while the page is hidden: pick the loading drop (or a pending reopen) back up
  const onVisible = (): void => {
    try {
      if (!destroyed && !plain && !docHidden() && (loading || painted || restore)) wake();
    } catch (e) {
      warn(e, "ink visibility");
    }
  };
  try {
    document.addEventListener("visibilitychange", onVisible);
  } catch {
    /* ignore */
  }
  const onDropClick = (): void => {
    if (!isOpen) void dock.open();
  };
  drop.addEventListener("click", onDropClick);
  main.body.addEventListener("click", onDropClick);
  wave.addEventListener("click", onDropClick);

  const dock: InkDock = {
    el,
    content,
    get isOpen() {
      return isOpen;
    },
    open() {
      try {
        // the person (or the UI on their behalf) moved the dock: forget a loading collapse
        restore = false;
        reopenAt = -1;
        return go(true);
      } catch (e) {
        warn(e, "ink open");
        return Promise.resolve();
      }
    },
    close() {
      try {
        restore = false;
        reopenAt = -1;
        return go(false);
      } catch (e) {
        warn(e, "ink close");
        return Promise.resolve();
      }
    },
    setLoading(on) {
      try {
        on = !!on;
        if (destroyed || on === loading) return;
        loading = on;
        drop.setAttribute("aria-label", on ? "Open Sumi (Claude is working)" : "Open Sumi");
        if (on) {
          reopenAt = -1;
          if (isOpen) {
            // collapse on its own: remembered here, not the person's preference
            restore = true;
            fromSend = true;
            void go(false, true);
          }
        }
        if (plain) {
          applyPlain();
          if (!on && restore && !isOpen) {
            window.setTimeout(() => {
              if (destroyed || loading || !restore || isOpen) return;
              restore = false;
              void go(true, true);
            }, INK_LOADING.drainMs + INK_LOADING.reopenDelayMs);
          }
          return;
        }
        wake();
      } catch (e) {
        warn(e, "ink loading");
      }
    },
    splash() {
      try {
        if (destroyed || plain || prefersReducedMotion()) return;
        // while loading, the drop splashes as the colour blooms in: that absorbs Send's splash
        if (loading && !isOpen) return;
        const n = 3 + Math.floor(Math.random() * 3);
        const drops: SplashDrop[] = [];
        for (let i = 0; i < n; i++) {
          const yf = lerp(-0.7, 0.7, (i + 0.5) / n) + (Math.random() - 0.5) * 0.18;
          drops.push({
            yf,
            // from the tall tab they spurt sideways; from the small drop they fan out around it
            ang: 180 - yf * (isOpen ? 40 : 110) + (Math.random() - 0.5) * 16, // y grows downward
            dist: (isOpen ? 14 : 17) + Math.random() * 12,
            r: 6.5 + Math.random() * 3,
            delay: Math.random() * 90,
            dur: 460 + Math.random() * 180,
          });
        }
        splash = { start: clock(), drops };
        // the surface recoils where each droplet leaves, and those ripples run along the edge
        const f = restField();
        if (f) {
          const g = geomAt(spring.p);
          const h = g.y1 - g.y0;
          for (const sd of drops) {
            const y = (g.y0 + g.y1) / 2 + sd.yf * (h / 2) * 0.85;
            const a = (sd.ang * Math.PI) / 180;
            f.poke(leftEdge(g, y) + Math.cos(a) * 6, y + Math.sin(a) * 6, 1.6);
          }
        }
        wake();
      } catch (e) {
        warn(e, "ink splash");
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unschedule(ticker);
      hubRemove(client);
      if (safety) clearTimeout(safety);
      safety = 0;
      cancelContent();
      spinAnim = spinCss(dropImg, false, spinAnim);
      try {
        document.removeEventListener("visibilitychange", onVisible);
      } catch {
        /* ignore */
      }
      window.removeEventListener("resize", fit);
      drop.removeEventListener("click", onDropClick);
      main.body.removeEventListener("click", onDropClick);
      wave.removeEventListener("click", onDropClick);
      resolveWaiters();
      el.remove();
    },
  };

  // initial rest state
  drop.setAttribute("aria-hidden", isOpen ? "true" : "false");
  drop.tabIndex = isOpen ? -1 : 0;
  applyStatic();
  try {
    render(clock());
  } catch (e) {
    degrade(e);
  }

  return dock;
}

/** Static ink of the open dock for the fallbacks: the procedural outline as one path, or a CSS tab. */
function plainInk(): Element {
  try {
    const s = svgEl("svg", {
      viewBox: `0 0 ${TAB_W + EXT} ${DOCK_H}`, width: TAB_W + EXT, height: DOCK_H, "aria-hidden": "true", focusable: "false",
    });
    css(s, {
      position: "absolute", left: "0", top: "0", width: `${TAB_W + EXT}px`, height: `${DOCK_H}px`,
      overflow: "hidden", display: "block", "pointer-events": "none",
    });
    const p = svgEl("path", { d: inkOutlinePath(dockOutline()), fill: "#000" }, s);
    p.style.pointerEvents = "fill";
    return s;
  } catch {
    const tab = document.createElement("div");
    css(tab, {
      position: "absolute", right: "0", top: `${FILLET}px`, width: `${TAB_W}px`, height: `${TAB_H}px`,
      background: "#000", "border-radius": "36px 0 0 36px", "pointer-events": "auto",
    });
    return tab;
  }
}

/** The plain dock: used when the SVG renderer cannot be built (no motion). */
function createPlainDock(opts: InkDockOptions): InkDock {
  const el = document.createElement("div");
  el.className = "ink-dock";
  css(el, {
    position: "fixed", right: "0", top: "50%", transform: "translateY(-50%)",
    width: `${TAB_W}px`, height: `${TAB_H + 2 * FILLET}px`, "pointer-events": "none", "z-index": "6",
  });

  const ink = plainInk() as HTMLElement;

  const content = document.createElement("div");
  content.className = "ink-content";
  css(content, { position: "absolute", right: "0", top: `${FILLET}px`, width: `${TAB_W}px`, height: `${TAB_H}px` });

  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "ink-drop";
  drop.setAttribute("aria-label", "Open Sumi");
  css(drop, {
    position: "absolute", right: "10px", top: "50%", width: `${DROP}px`, height: `${DROP}px`, margin: `-${DROP / 2}px 0 0`,
    "border-radius": "50%", background: "#000", "box-shadow": "6px 6px 20px rgba(0,0,0,.25)", border: "0",
    display: "grid", "place-items": "center", cursor: "pointer", "pointer-events": "auto",
  });
  const dropImg = icon(opts.dropIcon);
  drop.appendChild(dropImg);
  let loaderImg: HTMLElement | null = null;
  let loaderArc: Element | null = null;
  if (opts.loaderIcon) {
    loaderArc = opts.loaderIcon();
    loaderImg = icon(() => loaderArc as Element);
    loaderImg.style.opacity = "0";
    drop.appendChild(loaderImg);
  }

  el.append(ink, content, drop);

  let isOpen = !!opts.startOpen;
  let loading = false;
  let restore = false;
  let spin: Animation | null = null;
  const apply = (): void => {
    ink.style.display = isOpen ? "" : "none";
    content.style.visibility = isOpen ? "visible" : "hidden";
    content.style.pointerEvents = isOpen ? "auto" : "none";
    drop.style.display = isOpen ? "none" : "grid";
    // loading: a CSS gradient drop with the arc spinning on it
    const on = loading && !isOpen;
    drop.style.background = on ? loadingCssBackground() : "#000";
    dropImg.style.opacity = on && loaderImg ? "0" : "";
    if (loaderImg) {
      loaderImg.style.opacity = on ? "1" : "0";
      if (loaderArc) spin = spinCss(loaderArc, on, spin);
    }
  };
  apply();

  const set = (open: boolean, auto: boolean): void => {
    if (open === isOpen) return;
    isOpen = open;
    apply();
    try {
      (open ? opts.onOpen : opts.onClose)?.({ auto });
    } catch (e) {
      warn(e, open ? "ink onOpen" : "ink onClose");
    }
  };

  const dock: InkDock = {
    el,
    content,
    get isOpen() {
      return isOpen;
    },
    async open() {
      restore = false;
      set(true, false);
    },
    async close() {
      restore = false;
      set(false, false);
    },
    splash() {},
    setLoading(on) {
      try {
        on = !!on;
        if (on === loading) return;
        loading = on;
        drop.setAttribute("aria-label", on ? "Open Sumi (Claude is working)" : "Open Sumi");
        if (on && isOpen) {
          restore = true;
          set(false, true);
        }
        apply();
        if (!on && restore && !isOpen) {
          window.setTimeout(() => {
            if (loading || !restore || isOpen) return;
            restore = false;
            set(true, true);
          }, INK_LOADING.reopenDelayMs);
        }
      } catch (e) {
        warn(e, "ink loading");
      }
    },
    destroy() {
      spin = spinCss(dropImg, false, spin);
      el.remove();
    },
  };
  drop.addEventListener("click", () => void dock.open());
  return dock;
}

/* ------------------------------------------------------------------------------------------------
 * inkReveal / inkHide: a noisy, blobby clip-path that spreads from (or retracts to) an origin
 * --------------------------------------------------------------------------------------------- */

const REVEAL_MS = 320;
const HIDE_MS = 220;
const BLOB_SAMPLES = 40;
const BLOB_AMP = 0.1; // outline noise at full coverage (relative radius)
const REVEAL_BLUR = 6;
const HIDE_BLUR = 3;

interface InkAnim {
  /** coverage 0 (gone) .. 1 (fully shown) */
  c: number;
  saved: { clip: string; filter: string; origin: string };
  cancel(): void;
}

const inkAnims = new WeakMap<HTMLElement, InkAnim>();
let pathSupport: boolean | null = null;
let scaleSupport: boolean | null = null;

function supportsClipPath(): boolean {
  if (pathSupport === null) {
    try {
      pathSupport = !!(window.CSS && CSS.supports("clip-path", 'path("M0 0")'));
    } catch {
      pathSupport = false;
    }
  }
  return pathSupport;
}

function supportsScale(): boolean {
  if (scaleSupport === null) {
    try {
      scaleSupport = !!(window.CSS && CSS.supports("scale", "1"));
    } catch {
      scaleSupport = false;
    }
  }
  return scaleSupport;
}

/** Smooth closed outline: polar noise samples joined with a Catmull-Rom spline (as cubic Béziers). */
function blobPath(ox: number, oy: number, radius: number, amp: number, ph: number[], tSec: number): string {
  const n = BLOB_SAMPLES;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const noise =
      0.5 * Math.sin(3 * a + ph[0] + tSec * 2.1) +
      0.3 * Math.sin(5 * a + ph[1] - tSec * 2.9) +
      0.2 * Math.sin(7 * a + ph[2] + tSec * 3.7) +
      0.12 * Math.sin(11 * a + ph[3] - tSec * 4.3);
    const r = Math.max(0, radius * (1 + amp * (noise / 1.12)));
    xs.push(ox + Math.cos(a) * r);
    ys.push(oy + Math.sin(a) * r);
  }
  let d = `M${fmt(xs[0])} ${fmt(ys[0])}`;
  for (let i = 0; i < n; i++) {
    const i0 = (i - 1 + n) % n;
    const i2 = (i + 1) % n;
    const i3 = (i + 2) % n;
    const c1x = xs[i] + (xs[i2] - xs[i0]) / 6;
    const c1y = ys[i] + (ys[i2] - ys[i0]) / 6;
    const c2x = xs[i2] - (xs[i3] - xs[i]) / 6;
    const c2y = ys[i2] - (ys[i3] - ys[i]) / 6;
    d += `C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(xs[i2])} ${fmt(ys[i2])}`;
  }
  return `${d}Z`;
}

function restoreInk(el: HTMLElement, saved: InkAnim["saved"]): void {
  el.style.setProperty("clip-path", saved.clip);
  el.style.setProperty("filter", saved.filter);
  el.style.setProperty("transform-origin", saved.origin);
}

function runInk(el: HTMLElement, reveal: boolean, origin: Point | undefined, opts: { duration?: number } | undefined): Promise<void> {
  const prev = inkAnims.get(el);
  let c0 = reveal ? 0 : 1;
  let saved: InkAnim["saved"];
  if (prev) {
    c0 = prev.c;
    saved = prev.saved;
    prev.cancel();
  } else {
    if (!reveal && el.hidden) return Promise.resolve();
    saved = {
      clip: el.style.getPropertyValue("clip-path"),
      filter: el.style.getPropertyValue("filter"),
      origin: el.style.getPropertyValue("transform-origin"),
    };
  }
  const target = reveal ? 1 : 0;
  if (reveal) el.hidden = false;

  const finishPlain = (): void => {
    inkAnims.delete(el);
    restoreInk(el, saved);
    if (!reveal) el.hidden = true;
  };

  const full = Math.max(1, opts?.duration ?? (reveal ? REVEAL_MS : HIDE_MS));
  const reduced = prefersReducedMotion();
  const span = Math.abs(target - c0);
  if (span < 0.001 || docHidden()) {
    finishPlain();
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let done = false;
    let timer = 0;
    const state: InkAnim = { c: c0, saved, cancel: () => end(false) };
    let cleanup: () => void = () => {};
    const end = (complete: boolean): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        cleanup();
      } catch {
        /* ignore */
      }
      if (complete) {
        try {
          finishPlain();
        } catch (e) {
          warn(e, "ink reveal");
        }
      }
      resolve();
    };
    inkAnims.set(el, state);

    const rect = el.getBoundingClientRect();
    const w = el.offsetWidth || rect.width;
    const h = el.offsetHeight || rect.height;
    if (!(w > 0 && h > 0)) {
      end(true);
      return;
    }
    // origin in the element's local (untransformed border-box) coordinates
    const sx = rect.width > 0 ? w / rect.width : 1;
    const sy = rect.height > 0 ? h / rect.height : 1;
    const ox = origin ? (origin.x - rect.left) * sx : w / 2;
    const oy = origin ? (origin.y - rect.top) * sy : h / 2;

    // --- reduced motion / no clip-path path(): WAAPI fades (never touch the element's inline opacity)
    if (reduced || !supportsClipPath()) {
      restoreInk(el, saved);
      let base = 1;
      try {
        base = Number(getComputedStyle(el).opacity) || 1;
      } catch {
        /* ignore */
      }
      const dur = (reduced ? REDUCED_MS : full) * span;
      const frames: Keyframe[] = [{ opacity: base * c0 }, { opacity: base * target }];
      if (!reduced && supportsScale()) {
        el.style.setProperty("transform-origin", `${fmt(ox)}px ${fmt(oy)}px`);
        frames[0].scale = String(0.9 + 0.1 * c0);
        frames[1].scale = String(0.9 + 0.1 * target);
      }
      let a: Animation | null = null;
      const start = clock();
      try {
        a = el.animate(frames, { duration: dur, easing: reveal ? "cubic-bezier(.2,.8,.2,1)" : "ease-in", fill: "both" });
      } catch {
        a = null;
      }
      if (!a) {
        end(true);
        return;
      }
      const anim = a;
      cleanup = () => anim.cancel();
      state.cancel = () => {
        const u = clamp01((clock() - start) / dur);
        state.c = c0 + (target - c0) * u;
        end(false);
      };
      anim.finished.then(() => end(true), () => end(false));
      timer = window.setTimeout(() => end(true), dur + 250);
      return;
    }

    // --- the ink blob
    const far = Math.max(Math.hypot(ox, oy), Math.hypot(w - ox, oy), Math.hypot(ox, h - oy), Math.hypot(w - ox, h - oy));
    const cover = far / (1 - BLOB_AMP) + 1;
    const ph = [0, 1, 2, 3].map(() => Math.random() * Math.PI * 2);
    const dur = Math.max(60, full * span);
    // compose the bleed blur with the element's own filter (read with our previous blur removed)
    let filterBase = "";
    try {
      el.style.setProperty("filter", saved.filter);
      const f = getComputedStyle(el).filter;
      if (f && f !== "none") filterBase = ` ${f}`;
    } catch {
      /* ignore */
    }
    const t0 = clock();
    const ease = reveal ? easeOut3 : smooth;
    const paint = (t: number): boolean => {
      const u = clamp01((t - t0) / dur);
      const c = c0 + (target - c0) * ease(u);
      state.c = c;
      const amp = BLOB_AMP + 0.06 * (1 - c);
      const path = blobPath(ox, oy, c * cover, amp, ph, (t - t0) / 1000);
      el.style.setProperty("clip-path", `path("${path}")`);
      const b = reveal ? REVEAL_BLUR * (1 - c) : HIDE_BLUR * (1 - c);
      if (b > 0.05) el.style.setProperty("filter", `blur(${b.toFixed(2)}px)${filterBase}`);
      else el.style.setProperty("filter", saved.filter);
      return u < 1;
    };
    const ticker: Ticker = {
      tick(t: number): boolean {
        if (done) return false;
        if (paint(t)) return true;
        end(true);
        return false;
      },
      finish(): void {
        end(true);
      },
    };
    cleanup = () => {
      unschedule(ticker);
    };
    paint(t0); // first frame now, before the browser paints the un-hidden element
    schedule(ticker);
    timer = window.setTimeout(() => {
      end(true);
    }, dur + 400);
  });
}

/** Reveal an ink surface with a blobby spread from `origin` (viewport px). Resolves when done. */
export async function inkReveal(el: HTMLElement, origin?: Point, opts?: { duration?: number }): Promise<void> {
  try {
    await runInk(el, true, origin, opts);
  } catch (e) {
    warn(e, "ink reveal");
    try {
      inkAnims.delete(el);
      el.style.removeProperty("clip-path");
      el.hidden = false;
    } catch {
      /* ignore */
    }
  }
}

/** Hide an ink surface by retracting toward `origin`. Sets `hidden` when done. */
export async function inkHide(el: HTMLElement, origin?: Point, opts?: { duration?: number }): Promise<void> {
  try {
    await runInk(el, false, origin, opts);
  } catch (e) {
    warn(e, "ink hide");
    try {
      inkAnims.delete(el);
      el.style.removeProperty("clip-path");
      el.hidden = true;
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Ink drop (note popover): `inkDropIn` lands a drop of ink where the gesture ended and spreads it
 * into the card; `inkDropOut` pulls the card back into a droplet. The ink is drawn in a temporary
 * goo layer beside the card (position:fixed, pointer-events:none); the card itself sits at its final
 * place throughout, its skin and content hidden until the hand-off.
 * --------------------------------------------------------------------------------------------- */

export interface InkDropOptions {
  /** Reopening an existing note: a smaller, quicker drop. */
  small?: boolean;
  /** Called once, when the card's content starts to appear (at once when there is no drop). */
  onVisible?: () => void;
}

export interface InkDropOutOptions {
  /** Tiny droplets left behind by the retracting ink (default `INK_DROP.exitDroplets`). */
  droplets?: number;
}

const DROP_Z = "5"; // above the page marks (3), below the dock (6) and everything stacked above it
const DROP_PAD = 48; // goo layer overdraw around what it draws (blur, wobble, droplets)

interface DropBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  r: number;
}

interface Droplet {
  /** launch point and unit direction (viewport px) */
  x: number;
  y: number;
  dx: number;
  dy: number;
  dist: number;
  r: number;
  /** launch time (ms since the phase started) and flight time (ms) */
  at: number;
  dur: number;
  /** falls back into the card (true) or fades where it flew (false); exit droplets: pulled in */
  back: boolean;
  /** where a returning droplet met the card's edge */
  lx?: number;
  ly?: number;
  /** exit droplets (satellites): the corner of the collapsing shape they ride on (signs), and how far they
   * have been flung out of it (px) with its velocity */
  sx?: number;
  sy?: number;
  lp?: number;
  lv?: number;
}

const dropRuns = new WeakMap<HTMLElement, DropRun>();

const boxLerp = (a: DropBox, b: DropBox, t: number): DropBox => ({
  cx: lerp(a.cx, b.cx, t),
  cy: lerp(a.cy, b.cy, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
  r: lerp(a.r, b.r, t),
});
const circleBox = (x: number, y: number, r: number): DropBox => ({ cx: x, cy: y, w: 2 * r, h: 2 * r, r });

/** Stretch a box `s` px along the unit travel (dx, dy): the leading side runs ahead, the trailing side lags half as much. */
function stretchBox(b: DropBox, dx: number, dy: number, s: number): DropBox {
  if (!(s > 0.01)) return b;
  let x0 = b.cx - b.w / 2;
  let x1 = b.cx + b.w / 2;
  let y0 = b.cy - b.h / 2;
  let y1 = b.cy + b.h / 2;
  x1 += s * (dx > 0 ? dx : -dx * 0.5);
  x0 -= s * (dx < 0 ? -dx : dx * 0.5);
  y1 += s * (dy > 0 ? dy : -dy * 0.5);
  y0 -= s * (dy < 0 ? -dy : dy * 0.5);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, r: b.r };
}

/** The point of a rounded box's outline nearest to (x, y), with the outward normal there. */
function edgePoint(b: DropBox, x: number, y: number): [number, number, number, number] {
  const hw = Math.max(0, b.w / 2);
  const hh = Math.max(0, b.h / 2);
  const r = Math.max(0, Math.min(b.r, hw, hh));
  const qx = clamp(x, b.cx - hw + r, b.cx + hw - r);
  const qy = clamp(y, b.cy - hh + r, b.cy + hh - r);
  const ex = x - qx;
  const ey = y - qy;
  const d = Math.hypot(ex, ey);
  if (d > 1e-6) return [qx + (ex / d) * r, qy + (ey / d) * r, ex / d, ey / d];
  // inside the straight band: the nearest side
  const dl = x - (b.cx - hw);
  const dr = b.cx + hw - x;
  const dt = y - (b.cy - hh);
  const db = b.cy + hh - y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return [b.cx - hw, y, -1, 0];
  if (m === dr) return [b.cx + hw, y, 1, 0];
  if (m === dt) return [x, b.cy - hh, 0, -1];
  return [x, b.cy + hh, 0, 1];
}

/** Distance from (x, y) to a rounded box (0 inside). */
function boxDist(b: DropBox, x: number, y: number): number {
  const hw = b.w / 2;
  const hh = b.h / 2;
  const r = Math.max(0, Math.min(b.r, hw, hh));
  const qx = Math.max(Math.abs(x - b.cx) - (hw - r), 0);
  const qy = Math.max(Math.abs(y - b.cy) - (hh - r), 0);
  return Math.max(0, Math.hypot(qx, qy) - r);
}

/**
 * One element's drop: an "in" phase (fall → spread → hand-off to the skin → content), or an "out"
 * phase (content fades, the ink collapses into a droplet at the target). A new phase continues from
 * whatever the previous one is showing, so callers may flip at any time.
 */
class DropRun implements Ticker {
  phase: "in" | "out" | "done" = "in";
  private svg: SVGSVGElement | null = null;
  private grp: SVGGElement | null = null;
  private body: SVGPathElement | null = null;
  private dots: SVGCircleElement[] = [];
  private goo: Goo | null = null;
  private lay: [number, number, number, number] = [0, 0, 0, 0];
  private bodyD = "";
  private bodyT = "";
  private clipD = "";
  private readonly savedClip: string;
  private readonly savedVis: string;
  private radius = 20;
  private F: DropBox;

  private t0 = 0;
  private e = 0;
  private lastT = 0;
  /** the shape drawn last (viewport px) */
  box: DropBox;
  private gk = 0; // goo strength 0..1
  private wob = 0;
  private shownG = -1;

  // in
  private O: Point = { x: 0, y: 0 };
  /** the shape the spread starts from: the landed drop (or what was on screen when an exit turned around) */
  private S: DropBox = circleBox(0, 0, 0);
  private small = false;
  private r0 = 3;
  private r1 = 16;
  private fallMs = 90;
  private spreadMs = 330;
  private sp = { p: 0, v: 0, k: 0, c: 0, t: 0 };
  private travel = 1;
  private splash: Droplet[] = [];
  private settleAt = -1;
  private settleFrom: DropBox | null = null;
  private handedOff = false;
  private onVisible: (() => void) | null = null;
  private contentAt = 0;

  // out
  private B0: DropBox | null = null;
  private T: Point = { x: 0, y: 0 };
  private q = { p: 0, v: 0, t: 0 };
  private rd0 = 10;
  private trail: Droplet[] = [];

  private anims = new Choreo();
  private waiters: Array<() => void> = [];
  private safety = 0;

  constructor(readonly el: HTMLElement, private readonly ctl: SkinCtl, F: DropBox) {
    this.savedClip = el.style.getPropertyValue("clip-path");
    this.savedVis = ctl.layer.style.getPropertyValue("visibility");
    this.F = F;
    this.box = F;
    try {
      this.radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    } catch {
      /* keep */
    }
  }

  /* ---- phases ---- */

  enter(origin: Point | undefined, opts: InkDropOptions): Promise<void> {
    const D = INK_DROP;
    this.settleWaiters();
    const F = (this.F = this.measure() || this.F);
    const fresh = this.phase !== "out"; // a new drop; an exit in flight turns around from where it is
    this.phase = "in";
    this.small = !!opts.small;
    this.onVisible = opts.onVisible || null;
    this.O = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y) ? { x: origin.x, y: origin.y } : { x: F.cx, y: F.cy };
    this.r0 = this.small ? D.smallStartRadius : D.startRadius;
    this.r1 = Math.max(this.r0, this.small ? D.smallLandRadius : D.landRadius);
    const k = this.small ? D.smallSpreadK : D.spreadK;
    const z = this.small ? D.smallSpreadZeta : D.spreadZeta;
    this.spreadMs = D.spreadMs * Math.sqrt(D.spreadK / Math.max(1, k));
    this.handedOff = false;
    this.settleAt = -1;
    this.settleFrom = null;
    this.trail = [];
    this.splash = [];
    if (fresh) {
      this.fallMs = Math.max(1, this.small ? D.smallFallMs : D.fallMs);
      this.sp = { p: 0, v: D.spreadKick, k, c: 2 * z * Math.sqrt(k), t: 0 };
      this.gk = 0;
      this.wob = 0;
      this.S = circleBox(this.O.x, this.O.y, this.r1);
      this.makeSplash();
    } else {
      // turning around mid-exit: spread again from the shape on screen, no new fall
      this.fallMs = 0;
      const from = this.box;
      this.O = { x: from.cx, y: from.cy };
      this.r1 = Math.max(2, Math.min(from.w, from.h) / 2);
      this.S = { ...from };
      this.sp = { p: 0, v: 0, k, c: 2 * z * Math.sqrt(k), t: 0 };
    }
    const S = this.S;
    this.travel = Math.max(
      1,
      Math.abs(F.cx - F.w / 2 - (S.cx - S.w / 2)),
      Math.abs(F.cx + F.w / 2 - (S.cx + S.w / 2)),
      Math.abs(F.cy - F.h / 2 - (S.cy - S.h / 2)),
      Math.abs(F.cy + F.h / 2 - (S.cy + S.h / 2)),
    );
    this.contentAt = this.fallMs + D.contentAt * this.spreadMs;

    this.ctl.hold(true);
    this.ctl.layer.style.setProperty("visibility", "hidden");
    this.startContent(true);
    this.ensureLayer();
    this.t0 = clock();
    this.lastT = this.t0;
    this.e = 0;
    this.box = this.shapeIn(0);
    this.render();
    return this.arm(this.fallMs + this.spreadMs + 1400);
  }

  exit(target: Point | undefined, opts: InkDropOutOptions): Promise<void> {
    const D = INK_DROP;
    this.settleWaiters();
    const F = this.measure() || this.F;
    this.F = F;
    // continue from the shape on screen (mid-drop, mid-exit), or from the card at rest (the skin's outline)
    const onScreen = (this.phase === "in" && !this.handedOff) || this.phase === "out";
    const B0 = onScreen ? this.box : F;
    if (!onScreen) {
      this.gk = 0;
      this.wob = 0;
    }
    this.leftovers();
    this.phase = "out";
    this.B0 = B0;
    this.T = target && Number.isFinite(target.x) && Number.isFinite(target.y) ? { x: target.x, y: target.y } : { x: B0.cx, y: B0.cy };
    this.rd0 = Math.min(D.exitRadius, Math.max(0, Math.min(B0.w, B0.h) / 2));
    this.q = { p: 0, v: 0, t: 0 };
    // tiny droplets: satellites on the corners farthest from the target, flung out as the ink rushes off
    const n = Math.max(0, Math.min(4, Math.round(opts.droplets ?? D.exitDroplets)));
    if (n && Math.min(B0.w, B0.h) > 4 * D.exitDropletR) {
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({
        sx, sy, d: Math.hypot(B0.cx + (sx * B0.w) / 2 - this.T.x, B0.cy + (sy * B0.h) / 2 - this.T.y),
      }));
      corners.sort((a, b) => b.d - a.d);
      for (let i = 0; i < n; i++) {
        const c = corners[i];
        this.trail.push({
          x: 0, y: 0, dx: 0, dy: 0, dist: 0, r: D.exitDropletR * (i ? 0.85 : 1), at: 15 * i, dur: 200, back: true,
          sx: c.sx, sy: c.sy, lp: 0, lv: 0,
        });
      }
    }
    this.handedOff = false;
    this.ctl.hold(true);
    this.ctl.layer.style.setProperty("visibility", "hidden");
    this.startContent(false);
    this.ensureLayer();
    this.t0 = clock();
    this.lastT = this.t0;
    this.e = 0;
    this.box = B0; // from rest: exactly the skin's outline, goo off, so the swap is invisible
    this.render();
    return this.arm(D.exitMs + 1200);
  }

  private arm(ms: number): Promise<void> {
    const done = new Promise<void>((r) => this.waiters.push(r));
    if (this.safety) clearTimeout(this.safety);
    this.safety = window.setTimeout(() => {
      this.safety = 0;
      if (this.phase !== "done") {
        unschedule(this);
        this.finish();
      }
    }, ms);
    schedule(this);
    return done;
  }

  private settleWaiters(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }

  /* ---- ticker ---- */

  tick(t: number): boolean {
    if (this.phase === "done") return false;
    if (!this.el.isConnected) {
      this.finish();
      return false;
    }
    let dt = (t - this.lastT) / 1000;
    this.lastT = t;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    this.e = t - this.t0;
    const F = this.measure();
    if (!F) {
      this.finish();
      return false;
    }
    this.F = F;
    if (this.phase === "in") return this.stepIn(dt);
    return this.stepOut(dt);
  }

  finish(): void {
    if (this.phase === "in") {
      if (!this.handedOff) this.handoff(false);
      this.fireVisible();
      this.cancelAnims();
      this.done();
    } else if (this.phase === "out") {
      this.endOut();
    }
  }

  private done(): void {
    this.phase = "done";
    if (this.safety) clearTimeout(this.safety);
    this.safety = 0;
    unschedule(this);
    if (dropRuns.get(this.el) === this) dropRuns.delete(this.el);
    this.settleWaiters();
  }

  /* ---- in: fall → spread → settle → hand-off ---- */

  private stepIn(dt: number): boolean {
    const D = INK_DROP;
    const e = this.e;
    const F = this.F;
    // the spring runs from the landing on, in fixed sub-steps of its own time
    const st = Math.max(0, e - this.fallMs) / 1000;
    const sp = this.sp;
    if (this.settleAt < 0 && sp.t < st - 1e-9) {
      stepSpring(sp, sp.k, sp.c, 1, st - sp.t);
      sp.t = st;
    }
    if (e >= this.contentAt) this.fireVisible();

    if (!this.handedOff) {
      if (this.settleAt < 0 && e >= this.fallMs) {
        const still = Math.abs(sp.p - 1) * this.travel < D.settlePx && Math.abs(sp.v) * this.travel < 30;
        const airborne = this.splash.some((d) => e < d.at + d.dur);
        if (still && !airborne) {
          this.settleAt = e;
          this.settleFrom = this.box;
        }
      }
      if (this.settleAt >= 0) {
        const tau = (e - this.settleAt) / Math.max(1, D.handoffMs);
        if (tau >= 1 && this.shownG === 0 && this.sameAsF()) {
          // the goo layer already shows exactly the skin's rest outline: swap them
          this.handoff(true);
        } else {
          this.box = tau >= 1 ? F : boxLerp(this.settleFrom || F, F, smooth(tau));
          this.gk = Math.max(0, 1 - tau);
          this.wob = Math.max(0, this.wob * (1 - tau));
          this.render();
        }
      } else {
        this.box = this.shapeIn(e);
        // goo: off while the drop is tiny (it would eat it), full from the impact on
        this.gk = e < this.fallMs ? smooth((e - 0.3 * this.fallMs) / (0.6 * this.fallMs)) : 1;
        const wt = e < this.fallMs ? 0 : Math.min(1.6, Math.abs(sp.v) * 0.25);
        this.wob = approach(this.wob, wt, 10, dt);
        this.render();
      }
    }
    const animsLive = this.stepAnims(e);
    if (this.handedOff && !animsLive) {
      this.done();
      return false;
    }
    return true;
  }

  /** The drop's shape at `e` ms (before settling). */
  private shapeIn(e: number): DropBox {
    const D = INK_DROP;
    const { O, r0, r1 } = this;
    if (e < this.fallMs) {
      const sq = Math.min(D.squashMs, this.fallMs * 0.5);
      const land = this.fallMs - sq;
      if (e < land) {
        const u = clamp01(e / Math.max(1, land));
        return circleBox(O.x, O.y, r0 + (r1 - r0) * u * u); // it falls toward the glass: grows ever faster
      }
      const s = Math.sin((Math.PI * (e - land)) / Math.max(1, sq));
      const k = this.small ? 0.5 : 1;
      const w = 2 * r1 * (1 + D.squashX * k * s);
      const h = 2 * r1 * (1 - D.squashY * k * s);
      return { cx: O.x, cy: O.y, w, h, r: Math.min(w, h) / 2 };
    }
    const F = this.F;
    const p = this.sp.p;
    const S = this.S;
    const b = boxLerp(S, F, p);
    // a growing round drop first, then it squares off into the card's corners
    const k = smooth((p - D.roundUntil) / Math.max(0.05, D.cornersBy - D.roundUntil));
    b.r = Math.min(lerp(Math.min(b.w, b.h) / 2, F.r, k), b.w / 2, b.h / 2);
    let dx = F.cx - O.x;
    let dy = F.cy - O.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) return b;
    dx /= dist;
    dy /= dist;
    return stretchBox(b, dx, dy, Math.sin(Math.PI * clamp01(p)) * D.lead * Math.min(dist, 300));
  }

  private sameAsF(): boolean {
    const a = this.box;
    const b = this.F;
    return Math.abs(a.cx - b.cx) < 1e-3 && Math.abs(a.cy - b.cy) < 1e-3 && Math.abs(a.w - b.w) < 1e-3 && Math.abs(a.h - b.h) < 1e-3;
  }

  private makeSplash(): void {
    const D = INK_DROP;
    const { O, F } = this;
    const rnd = seeded((Math.round(O.x) * 73856093) ^ (Math.round(O.y) * 19349663) ^ (Math.round(F.cx + F.cy) * 83492791));
    const n = this.small ? D.smallSplash : D.splashMin + Math.floor(rnd() * (D.splashMax - D.splashMin + 1));
    const base = rnd() * Math.PI * 2;
    const impact = this.fallMs - Math.min(D.squashMs, this.fallMs * 0.5);
    const sc = this.small ? 0.75 : 1;
    for (let i = 0; i < n; i++) {
      const a = base + (i * Math.PI * 2) / n + (rnd() - 0.5) * 0.7;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      const dist = lerp(D.splashDist[0], D.splashDist[1], rnd()) * sc + this.r1 * 0.4;
      const ax = O.x + dx * dist;
      const ay = O.y + dy * dist;
      this.splash.push({
        x: O.x, y: O.y, dx, dy, dist,
        r: lerp(D.splashR[0], D.splashR[1], rnd()) * (this.small ? 0.85 : 1),
        at: impact + rnd() * 18,
        dur: lerp(D.splashMs[0], D.splashMs[1], rnd()) * (this.small ? 0.8 : 1),
        back: boxDist(F, ax, ay) <= D.splashReach,
      });
    }
  }

  /** The card's skin takes over: same outline, same shadow; then its edge ripples from the splash. */
  private handoff(kick: boolean): void {
    this.handedOff = true;
    this.removeLayer();
    this.setClip("");
    this.ctl.layer.style.setProperty("visibility", this.savedVis);
    this.ctl.hold(false);
    if (!kick) return;
    const D = INK_DROP;
    const pts: Array<{ x: number; y: number; a: number }> = [{ x: this.O.x, y: this.O.y, a: D.ripple * (this.small ? 0.7 : 1) }];
    for (const d of this.splash) if (d.back && d.lx !== undefined && d.ly !== undefined) pts.push({ x: d.lx, y: d.ly, a: D.rippleDroplet });
    this.ctl.kick(pts);
  }

  private fireVisible(): void {
    const f = this.onVisible;
    if (!f) return;
    this.onVisible = null;
    try {
      f();
    } catch (e) {
      warn(e, "ink drop onVisible");
    }
  }

  /* ---- out: content fades, the ink collapses into a droplet at the target ---- */

  /** Droplets still in the air when the exit starts get pulled back in with the rest. */
  private leftovers(): void {
    const out: Droplet[] = [];
    const e = this.e;
    if (this.phase === "in" && !this.handedOff) {
      for (const c of this.dropletCircles(e)) out.push({ x: c[0], y: c[1], dx: 0, dy: 0, dist: 0, r: c[2], at: 0, dur: 120, back: true });
    } else if (this.phase === "out") {
      for (const c of this.trailCircles(e)) out.push({ x: c[0], y: c[1], dx: 0, dy: 0, dist: 0, r: c[2], at: 0, dur: 120, back: true });
    }
    this.splash = [];
    this.trail = out.filter((d) => d.r > 1);
  }

  private stepOut(dt: number): boolean {
    const D = INK_DROP;
    const e = this.e;
    const q = this.q;
    const k = D.exitK;
    const c = 2 * D.exitZeta * Math.sqrt(k);
    const st = e / 1000;
    if (q.t < st - 1e-9) stepSpring(q, k, c, 1, st - q.t, (h) => {
      q.t += h;
      // satellites (as on the dock): flung out of the trailing corners while the ink rushes off, they
      // snap out fast and drift back to re-merge
      for (const d of this.trail) {
        if (d.lp === undefined || d.lv === undefined) continue;
        const target = q.t * 1000 < d.at ? 0 : Math.min(26, 3.4 * Math.abs(q.v));
        const out = target > d.lp;
        d.lv += (-(out ? 520 : 240) * (d.lp - target) - (out ? 40 : 26) * d.lv) * h;
        d.lp += d.lv * h;
        if (d.lp < 0) {
          d.lp = 0;
          if (d.lv < 0) d.lv = 0;
        }
      }
    });
    const B0 = this.B0 || this.F;
    const T = this.T;
    const shrink = smooth((e - D.exitShrinkAt) / Math.max(1, D.exitMs - D.exitShrinkAt));
    const rd = this.rd0 * (1 - shrink);
    const b = boxLerp(B0, circleBox(T.x, T.y, rd), q.p);
    // the card's corners melt first: it pulls itself into a round drop as it goes
    b.r = Math.max(0, Math.min(lerp(B0.r, Math.min(b.w, b.h) / 2, smooth((q.p - 0.05) / 0.6)), b.w / 2, b.h / 2));
    let dx = T.x - B0.cx;
    let dy = T.y - B0.cy;
    const dist = Math.hypot(dx, dy);
    if (dist >= 1) {
      dx /= dist;
      dy /= dist;
      this.box = stretchBox(b, dx, dy, Math.sin(Math.PI * clamp01(q.p)) * D.lead * Math.min(dist, 300) * (1 - shrink));
    } else this.box = b;
    this.gk = Math.min(1, this.gk + dt * 25); // ramps in over 40 ms when it starts from the skin at rest
    this.wob = approach(this.wob, Math.min(1.6, Math.abs(q.v) * 0.25) * this.gk, 10, dt);
    this.render();
    this.stepAnims(e);
    const trailing = this.trail.some((d) => e < d.at + d.dur);
    if (e >= D.exitMs && !trailing) {
      this.endOut();
      return false;
    }
    return true;
  }

  private endOut(): void {
    this.el.hidden = true;
    this.removeLayer();
    this.cancelAnims();
    this.setClip("");
    this.ctl.layer.style.setProperty("visibility", this.savedVis);
    this.ctl.hold(false);
    this.done();
  }

  /* ---- content ---- */

  private startContent(entering: boolean): void {
    const D = INK_DROP;
    const items = Array.from(this.el.children).filter(
      (n) => n !== this.ctl.layer && n instanceof HTMLElement && !n.hidden,
    ) as HTMLElement[];
    // what is on screen now (a running entrance may be half way)
    const now = items.map((n) => {
      try {
        return Number(getComputedStyle(n).opacity);
      } catch {
        return 1;
      }
    });
    this.cancelAnims();
    if (entering) {
      let i = 0;
      let end = 0;
      for (const n of items) {
        if (!(n.offsetHeight > 0)) continue; // e.g. an empty reply box: no gap in the stagger
        let base = 1;
        try {
          base = Number(getComputedStyle(n).opacity) || 1;
        } catch {
          /* ignore */
        }
        const off = this.contentAt + i * D.stagger;
        this.anim(n, [{ opacity: 0, ...shift(0, D.itemRise) }, { opacity: base, ...shift(0, 0) }], D.itemMs, ITEM_EASE, off);
        end = off + D.itemMs;
        i++;
      }
      this.anims.end = end;
    } else {
      items.forEach((n, i) => {
        const from = Number.isFinite(now[i]) ? now[i] : 1;
        if (from > 0.001) this.anim(n, [{ opacity: from }, { opacity: 0 }], INK_DROP.exitFadeMs, "ease-in", 0);
        else this.anim(n, [{ opacity: 0 }, { opacity: 0 }], 1, "linear", 0);
      });
      this.anims.end = Infinity; // held until the exit ends (the card is hidden first)
    }
  }

  private anim(n: HTMLElement, frames: Keyframe[], dur: number, easing: string, offset: number): void {
    this.anims.add(n, frames, dur, easing, offset);
  }

  /** Seek the content animations to `e`; false once they are over (an entrance then reverts to CSS). */
  private stepAnims(e: number): boolean {
    if (!this.anims.size) return false;
    if (this.anims.seek(e)) return true;
    this.cancelAnims();
    return false;
  }

  private cancelAnims(): void {
    this.anims.cancel();
  }

  /* ---- drawing ---- */

  private measure(): DropBox | null {
    let r: DOMRect;
    try {
      r = this.el.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!(r.width > 0 && r.height > 0)) return null;
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, r: Math.min(this.radius, r.width / 2, r.height / 2) };
  }

  private ensureLayer(): void {
    if (this.svg) return;
    const parent = this.el.parentNode;
    if (!parent) throw new Error("ink drop: card is not in the DOM");
    const uid = `${(++uidSeq).toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const svg = svgEl("svg", { "aria-hidden": "true", focusable: "false" });
    let shadow = SKIN_SHADOW;
    try {
      const f = this.ctl.layer.style.getPropertyValue("filter");
      if (f) shadow = f;
    } catch {
      /* keep */
    }
    css(svg, {
      position: "fixed", left: "0", top: "0", width: "0", height: "0", "z-index": DROP_Z, "pointer-events": "none",
      overflow: "hidden", display: "block", margin: "0", filter: shadow,
    });
    const defs = svgEl("defs", {}, svg);
    this.goo = createGoo(defs, `sumi-drop-${uid}`);
    this.grp = svgEl("g", {}, svg);
    this.body = svgEl("path", { fill: "#000", d: "" }, this.grp);
    this.dots = [];
    this.svg = svg;
    this.bodyD = "";
    this.bodyT = "";
    this.shownG = -1;
    this.lay = [0, 0, 0, 0];
    parent.insertBefore(svg, this.el);
  }

  private removeLayer(): void {
    if (this.svg) this.svg.remove();
    this.svg = null;
    this.grp = null;
    this.body = null;
    this.dots = [];
    this.goo = null;
    this.shownG = -1;
  }

  /** Grow the layer so it covers [x0, y0, x1, y1] (viewport px) with room to spare. */
  private fit(x0: number, y0: number, x1: number, y1: number): void {
    const svg = this.svg;
    const goo = this.goo;
    if (!svg || !goo) return;
    const L = this.lay;
    const m = 16; // margin that must stay free for the blur and the wobble
    if (L[2] > L[0] && x0 - m >= L[0] && y0 - m >= L[1] && x1 + m <= L[2] && y1 + m <= L[3]) return;
    let a = Math.floor(x0 - DROP_PAD);
    let b = Math.floor(y0 - DROP_PAD);
    let c = Math.ceil(x1 + DROP_PAD);
    let d = Math.ceil(y1 + DROP_PAD);
    if (L[2] > L[0]) {
      a = Math.min(a, L[0]);
      b = Math.min(b, L[1]);
      c = Math.max(c, L[2]);
      d = Math.max(d, L[3]);
    }
    this.lay = [a, b, c, d];
    const w = c - a;
    const h = d - b;
    svg.setAttribute("viewBox", `${a} ${b} ${w} ${h}`);
    css(svg, { left: `${a}px`, top: `${b}px`, width: `${w}px`, height: `${h}px` });
    for (const [k, v] of [["x", a], ["y", b], ["width", w], ["height", h]] as const) goo.filter.setAttribute(k, String(v));
  }

  private setGoo(g: number, w: number): void {
    if (!this.goo || !this.grp) return;
    const ts = this.e / 1000;
    this.shownG = this.goo.set(this.grp, g, w, 0.02 + 0.006 * Math.sin(ts * 3), 0.024 + 0.006 * Math.cos(ts * 2.3));
  }

  /** Splash droplets (and the puddle left at the impact point) at `e`: [x, y, r] each. */
  private dropletCircles(e: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    if (this.phase !== "in") return out;
    const D = INK_DROP;
    // the puddle at the impact point drains into the ink as it spreads away
    if (e >= this.fallMs && this.settleAt < 0) {
      const rt = this.r1 * (1 - smooth(this.sp.p / Math.max(0.05, D.tailUntil)));
      if (rt > 0.5) out.push([this.O.x, this.O.y, rt]);
    }
    for (const d of this.splash) {
      const u = (e - d.at) / d.dur;
      if (u <= 0 || u >= 1) continue;
      const ax = d.x + d.dx * d.dist;
      const ay = d.y + d.dy * d.dist;
      if (d.back) {
        // thrown out, then falls back onto the nearest edge of the ink (which is spreading meanwhile)
        const [ex, ey, nx, ny] = edgePoint(this.box, ax, ay);
        const px = ex - nx * d.r * 0.6;
        const py = ey - ny * d.r * 0.6;
        const cx = 2 * ax - (d.x + px) / 2;
        const cy = 2 * ay - (d.y + py) / 2;
        const a = (1 - u) * (1 - u);
        const b = 2 * u * (1 - u);
        const c = u * u;
        out.push([a * d.x + b * cx + c * px, a * d.y + b * cy + c * py, d.r * (1 - 0.2 * Math.sin(Math.PI * u))]);
        d.lx = ex;
        d.ly = ey;
      } else {
        // flies off and dries out
        const k = easeOut3(u) * 1.3;
        out.push([d.x + d.dx * d.dist * k, d.y + d.dy * d.dist * k, d.r * (1 - smooth(u))]);
      }
    }
    return out;
  }

  /** Exit droplets at `e`: left behind by the retracting ink, then pulled back into it. */
  private trailCircles(e: number): Array<[number, number, number]> {
    const out: Array<[number, number, number]> = [];
    if (this.phase !== "out") return out;
    const b = this.box;
    for (const d of this.trail) {
      const u = clamp01((e - d.at) / d.dur);
      if (u >= 1) continue;
      const rr = d.r * (1 - u * u * u);
      if (d.sx !== undefined && d.sy !== undefined && d.lp !== undefined) {
        // tucked inside the corner's arc at rest (so it adds nothing until it is flung), out along the diagonal
        const r = Math.max(0, Math.min(b.r, b.w / 2, b.h / 2));
        const k = Math.SQRT1_2 * (Math.max(0, r - 1.1 * d.r) + d.lp);
        out.push([b.cx + d.sx * (Math.max(0, b.w / 2 - r) + k), b.cy + d.sy * (Math.max(0, b.h / 2 - r) + k), rr]);
      } else {
        const k = smooth(u);
        out.push([lerp(d.x, b.cx, k), lerp(d.y, b.cy, k), rr]);
      }
    }
    return out;
  }

  private render(): void {
    if (!this.svg || !this.body) return;
    const b = this.box;
    const circles = this.phase === "in" ? this.dropletCircles(this.e) : this.trailCircles(this.e);
    let x0 = b.cx - b.w / 2;
    let y0 = b.cy - b.h / 2;
    let x1 = b.cx + b.w / 2;
    let y1 = b.cy + b.h / 2;
    for (const [x, y, r] of circles) {
      x0 = Math.min(x0, x - r);
      y0 = Math.min(y0, y - r);
      x1 = Math.max(x1, x + r);
      y1 = Math.max(y1, y + r);
    }
    this.fit(x0, y0, x1, y1);

    // body: the same rounded-rect outline the skin draws (cubic arcs), so the hand-off is exact
    const d = b.w > 0.05 && b.h > 0.05 ? inkOutlinePath(inkRoundRect(b.w, b.h, b.r)) : "";
    if (d !== this.bodyD) {
      this.bodyD = d;
      this.body.setAttribute("d", d);
    }
    const tr = `translate(${fmt3(b.cx - b.w / 2)} ${fmt3(b.cy - b.h / 2)})`;
    if (tr !== this.bodyT) {
      this.bodyT = tr;
      this.body.setAttribute("transform", tr);
    }
    // droplets
    while (this.dots.length < circles.length && this.grp) {
      const c = svgEl("circle", { fill: "#000", cx: 0, cy: 0, r: 0 }, this.grp);
      this.dots.push(c);
    }
    this.dots.forEach((c, i) => {
      const s = circles[i];
      if (!s || s[2] <= 0.05) {
        if (c.getAttribute("r") !== "0") c.setAttribute("r", "0");
        return;
      }
      c.setAttribute("cx", fmt(s[0]));
      c.setAttribute("cy", fmt(s[1]));
      c.setAttribute("r", fmt(s[2]));
    });
    this.setGoo(this.gk, this.wob);

    // the card's content never shows outside the ink
    const F = this.F;
    const t = b.cy - b.h / 2 - (F.cy - F.h / 2);
    const r = F.cx + F.w / 2 - (b.cx + b.w / 2);
    const bt = F.cy + F.h / 2 - (b.cy + b.h / 2);
    const l = b.cx - b.w / 2 - (F.cx - F.w / 2);
    const clip = t > 0.01 || r > 0.01 || bt > 0.01 || l > 0.01
      ? `inset(${fmt(Math.max(0, t))}px ${fmt(Math.max(0, r))}px ${fmt(Math.max(0, bt))}px ${fmt(Math.max(0, l))}px round ${fmt(Math.max(0, b.r))}px)`
      : "";
    this.setClip(clip);
  }

  private setClip(clip: string): void {
    if (clip === this.clipD) return;
    this.clipD = clip;
    if (clip) this.el.style.setProperty("clip-path", clip);
    else if (this.savedClip) this.el.style.setProperty("clip-path", this.savedClip);
    else this.el.style.removeProperty("clip-path");
  }

  /** Tear down without motion (fallbacks): content and skin as at rest, layer gone. */
  dispose(): void {
    this.removeLayer();
    this.cancelAnims();
    this.setClip("");
    try {
      this.ctl.layer.style.setProperty("visibility", this.savedVis);
      this.ctl.hold(false);
    } catch {
      /* ignore */
    }
    this.phase = "done";
    if (this.safety) clearTimeout(this.safety);
    this.safety = 0;
    unschedule(this);
    if (dropRuns.get(this.el) === this) dropRuns.delete(this.el);
    this.settleWaiters();
  }
}

/** Stop any blob reveal / hide on `el` (the drop replaces it), restoring the styles it borrowed. */
function stopBlob(el: HTMLElement): void {
  const prev = inkAnims.get(el);
  if (!prev) return;
  try {
    prev.cancel();
  } catch {
    /* ignore */
  }
  inkAnims.delete(el);
  restoreInk(el, prev.saved);
}

/**
 * The note popover lands as a drop of ink at `origin` (viewport px: where the gesture ended, or the
 * note's badge with `small`) that spreads into the card, then hands over to the card's ink skin. The
 * card (`el`, already placed and skinned with `createInkSkin`) is shown at once at its final place;
 * its content enters while the ink settles. Resolves when everything is done; never throws. Without
 * a skin, with reduced motion or on any error it falls back to `inkReveal`.
 */
export async function inkDropIn(el: HTMLElement, origin?: Point, opts: InkDropOptions = {}): Promise<void> {
  let run: DropRun | undefined;
  try {
    run = dropRuns.get(el);
    const ctl = skinCtl.get(el);
    if (prefersReducedMotion() || !ctl || !el.parentNode || docHidden()) {
      run?.dispose();
      run = undefined;
      try {
        opts.onVisible?.();
      } catch (e) {
        warn(e, "ink drop onVisible");
      }
      return await inkReveal(el, origin);
    }
    stopBlob(el);
    el.hidden = false;
    if (!run) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) throw new Error("ink drop: card has no size");
      const radius = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
      run = new DropRun(el, ctl, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, r: radius });
      dropRuns.set(el, run);
    }
    await run.enter(origin, opts);
  } catch (e) {
    warn(e, "ink drop in (plain reveal)");
    try {
      run?.dispose();
    } catch {
      /* ignore */
    }
    try {
      opts.onVisible?.();
    } catch {
      /* ignore */
    }
    await inkReveal(el, origin);
  }
}

/**
 * Close the note popover: its content fades, the ink springs back into a droplet that shrinks into
 * `target` (the note's badge; the drop's origin when there is none), shedding a tiny droplet or two.
 * Continues from whatever is on screen (e.g. Esc mid-spread). Sets `el.hidden` when done; never
 * throws (falls back to `inkHide`).
 */
export async function inkDropOut(el: HTMLElement, target?: Point, opts: InkDropOutOptions = {}): Promise<void> {
  let run: DropRun | undefined;
  try {
    run = dropRuns.get(el);
    const ctl = skinCtl.get(el);
    if (!run && el.hidden) return;
    if (prefersReducedMotion() || !ctl || !el.parentNode || docHidden()) {
      run?.dispose();
      run = undefined;
      return await inkHide(el, target);
    }
    stopBlob(el);
    if (!run) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) throw new Error("ink drop: card has no size");
      const radius = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
      run = new DropRun(el, ctl, { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, r: radius });
      run.phase = "done"; // nothing on screen yet but the card at rest
      dropRuns.set(el, run);
    }
    await run.exit(target, opts);
  } catch (e) {
    warn(e, "ink drop out (plain hide)");
    try {
      run?.dispose();
    } catch {
      /* ignore */
    }
    await inkHide(el, target);
  }
}

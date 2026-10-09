/**
 * Never-throw wrappers around the ink engine's surface motion (ink.ts `inkReveal` / `inkHide`, and
 * the note card's `inkDropIn` / `inkDropOut`), plus a small controller for persistent surfaces
 * (menu, panel, tooltip, hint).
 *
 * The engine reverses an in-flight reveal/hide on the same element by itself, continuing from the
 * current coverage, so callers may flip a surface at any time. These wrappers only add a safety
 * net: if an animation never settles we force its end state, unless a newer one took over.
 */
import { inkDropIn, inkDropOut, inkHide, inkReveal, type InkDropOptions, type Point } from "./ink";
import { warn } from "./util";

/** Upper bound for one reveal/hide; past it we force the end state ourselves. */
const MAX_MS = 1400;
const gen = new WeakMap<HTMLElement, number>();

function bump(el: HTMLElement): number {
  const g = (gen.get(el) || 0) + 1;
  gen.set(el, g);
  return g;
}

function settle(p: Promise<void> | void): Promise<void> {
  return Promise.race([
    Promise.resolve(p).catch(warn),
    new Promise<void>((r) => window.setTimeout(r, MAX_MS)),
  ]);
}

/** Reveal an ink surface from `origin` (viewport px). Always resolves; ends visible unless superseded. */
export async function reveal(el: HTMLElement, origin?: Point): Promise<void> {
  const g = bump(el);
  let p: Promise<void> | void = undefined;
  try {
    p = inkReveal(el, origin);
  } catch (e) {
    warn(e);
  }
  await settle(p);
  if (gen.get(el) === g) el.hidden = false;
}

/** Retract an ink surface toward `origin`. Always resolves; ends hidden unless superseded. */
export async function retract(el: HTMLElement, origin?: Point): Promise<void> {
  const g = bump(el);
  let p: Promise<void> | void = undefined;
  try {
    p = inkHide(el, origin);
  } catch (e) {
    warn(e);
  }
  await settle(p);
  if (gen.get(el) === g) el.hidden = true;
}

/** Pour the note card in as a drop of ink from `origin` (viewport px). Always resolves; ends visible unless superseded. */
export async function dropIn(el: HTMLElement, origin?: Point, opts?: InkDropOptions): Promise<void> {
  const g = bump(el);
  let p: Promise<void> | void = undefined;
  try {
    p = inkDropIn(el, origin, opts);
  } catch (e) {
    warn(e);
  }
  await settle(p);
  if (gen.get(el) === g) el.hidden = false;
}

/** Pull the note card back into a droplet that vanishes at `target`. Always resolves; ends hidden unless superseded. */
export async function dropOut(el: HTMLElement, target?: Point): Promise<void> {
  const g = bump(el);
  let p: Promise<void> | void = undefined;
  try {
    p = inkDropOut(el, target);
  } catch (e) {
    warn(e);
  }
  await settle(p);
  if (gen.get(el) === g) el.hidden = true;
}

/** Measure an element as if shown, without painting it (all synchronous). */
export function measure(el: HTMLElement): DOMRect {
  const was = el.hidden;
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.hidden = was;
  return r;
}

/** A persistent ink surface. `isOpen` is the wanted state, true from the moment `show` is called. */
export class InkLayer {
  private want = false;

  constructor(readonly el: HTMLElement) {
    el.hidden = true;
    el.setAttribute("inert", "");
  }

  get isOpen(): boolean {
    return this.want;
  }

  show(origin?: Point): void {
    if (this.want) return;
    this.want = true;
    this.el.removeAttribute("inert");
    void reveal(this.el, origin);
  }

  hide(origin?: Point): void {
    if (!this.want) return;
    this.want = false;
    this.el.setAttribute("inert", ""); // no clicks or focus while it retracts
    void retract(this.el, origin);
  }

  /** Hide at once, without motion (e.g. the dock collapsed under it). */
  reset(): void {
    this.want = false;
    bump(this.el);
    this.el.setAttribute("inert", "");
    this.el.hidden = true;
  }
}

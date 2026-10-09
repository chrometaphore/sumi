/**
 * Shared frame scheduler: one requestAnimationFrame loop for every dock, skin, reveal, drop and the
 * processing glow. When every live ticker only needs a low rate (ambient shimmer, the loading drop,
 * the glow), frames are paced to ~30 fps by a timer that runs them (the browser paints the changes at
 * its next vsync) instead of a requestAnimationFrame at the display's rate. The loop stops as soon as
 * nothing is live, and while the document is hidden.
 */
import { warn } from "../util";

export interface Ticker {
  /** Advance to `now` (ms) and render. Return true to keep running. */
  tick(now: number): boolean;
  /** Jump to the end state immediately (document hidden, errors). */
  finish(): void;
  /** True while ~30 fps is enough for this ticker (read after each tick). */
  readonly lowRate?: boolean;
}

const LOW_FRAME_MS = 1000 / 30;

const tickers = new Set<Ticker>();
let rafId = 0;
let timer = 0;
let lastRun = -Infinity;
let visHooked = false;

export const clock = (): number => performance.now();

export const docHidden = (): boolean => {
  try {
    return document.hidden === true;
  } catch {
    return false;
  }
};

let reducedMql: MediaQueryList | null | undefined;

/** One MediaQueryList for the whole engine (this is asked every frame). */
export function prefersReducedMotion(): boolean {
  try {
    if (reducedMql === undefined) reducedMql = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    return !!reducedMql && reducedMql.matches;
  } catch {
    return false;
  }
}

function runTickers(t: number): void {
  for (const k of Array.from(tickers)) {
    let keep = false;
    try {
      keep = k.tick(t);
    } catch (e) {
      warn(e, "ink frame");
      try {
        k.finish();
      } catch {
        /* ignore */
      }
    }
    if (!keep) tickers.delete(k);
  }
}

function finishAll(): void {
  for (const k of Array.from(tickers)) {
    tickers.delete(k);
    try {
      k.finish();
    } catch (e) {
      warn(e, "ink finish");
    }
  }
}

function stopFrames(): void {
  if (rafId) cancelAnimationFrame(rafId);
  if (timer) clearTimeout(timer);
  rafId = timer = 0;
}

function onVisibility(): void {
  if (docHidden()) {
    stopFrames();
    finishAll();
  } else ensureLoop();
}

function frame(): void {
  rafId = 0;
  lastRun = clock();
  runTickers(lastRun);
  ensureLoop();
}

function request(): void {
  try {
    rafId = requestAnimationFrame(frame);
  } catch (e) {
    warn(e, "ink raf");
    finishAll();
  }
}

function lowOnly(): boolean {
  for (const k of tickers) if (!k.lowRate) return false;
  return true;
}

function ensureLoop(): void {
  if (rafId || timer || !tickers.size) return;
  if (!visHooked) {
    visHooked = true;
    try {
      document.addEventListener("visibilitychange", onVisibility);
    } catch {
      /* ignore */
    }
  }
  if (docHidden()) {
    finishAll();
    return;
  }
  if (lowOnly()) {
    timer = window.setTimeout(() => {
      timer = 0;
      if (!rafId) frame();
    }, Math.max(1, lastRun + LOW_FRAME_MS - clock()));
    return;
  }
  request();
}

/** Run `t` every frame until its tick returns false. A full-rate ticker cuts a low-rate wait short. */
export function schedule(t: Ticker): void {
  tickers.add(t);
  if (timer && !t.lowRate) {
    clearTimeout(timer);
    timer = 0;
  }
  ensureLoop();
}

export function unschedule(t: Ticker): void {
  tickers.delete(t);
}

/** Stop the shared frame loop and drop its document listener (overlay teardown, after every dock/skin is destroyed). */
export function inkShutdown(): void {
  stopFrames();
  tickers.clear();
  if (visHooked) {
    visHooked = false;
    try {
      document.removeEventListener("visibilitychange", onVisibility);
    } catch {
      /* ignore */
    }
  }
}

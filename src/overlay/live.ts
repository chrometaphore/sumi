/**
 * Live reload for static mode (Sumi serving local files). Subscribes to
 * /__sumi/api/events (server-sent events): CSS-only changes swap the matching
 * <link rel=stylesheet> with a cache-busted copy, anything else reloads the page,
 * waiting while a note is being written so nothing typed is lost.
 * Inert in proxy mode (never started). Never throws into the page.
 */
import type { LiveChange } from "../shared/types";
import { api } from "./api";
import { warn } from "./util";

export interface LiveHooks {
  /** True while reloading would lose something (an unsaved note, a save in flight, a gesture). */
  busy(): boolean;
  notify(message: string): void;
  /** Stylesheets changed in place: re-anchor pins. */
  relayout(): void;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;
const BUSY_POLL_MS = 300;
const SWAP_TIMEOUT_MS = 4000;

let started = false;
let stopFn: (() => void) | null = null;

/** Stop listening for good (SumiApp.destroy). */
export function stopLive(): void {
  const f = stopFn;
  stopFn = null;
  if (f) f();
}

/** Did the server mark this page as served from local files? */
export function staticFlag(): boolean {
  try {
    return !!(window as any).__SUMI_STATIC__;
  } catch {
    return false;
  }
}

/** Start listening (idempotent). */
export function startLive(hooks: LiveHooks): void {
  if (started) return;
  if (typeof EventSource === "undefined") return;
  started = true;

  let es: EventSource | null = null;
  let retryMs = MIN_RETRY_MS;
  let retryTimer = 0;
  let reloadTimer = 0;
  let reloading = false;
  let told = false;
  /** Old <link> elements being replaced: never swap them again. */
  const retiring = new WeakSet<Element>();

  const close = () => {
    if (!es) return;
    try {
      es.close();
    } catch {
      /* ignore */
    }
    es = null;
  };

  const scheduleReconnect = () => {
    if (retryTimer || reloading) return;
    const wait = retryMs + Math.random() * 250;
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      connect();
    }, wait);
  };

  const connect = () => {
    if (es || reloading) return;
    try {
      es = new EventSource(api.eventsUrl());
    } catch (e) {
      warn(e);
      es = null;
      scheduleReconnect();
      return;
    }
    es.addEventListener("hello", () => {
      retryMs = MIN_RETRY_MS;
    });
    es.addEventListener("change", (ev) => {
      try {
        onChange(JSON.parse(String((ev as MessageEvent).data)) as LiveChange);
      } catch (e) {
        warn(e);
      }
    });
    es.addEventListener("error", () => {
      // Use our own backoff instead of the browser's fixed retry (server restarts, laptop sleep).
      close();
      scheduleReconnect();
    });
  };

  const reload = () => {
    if (reloadTimer) return;
    const tick = () => {
      reloadTimer = 0;
      let busy = false;
      try {
        busy = hooks.busy();
      } catch {
        busy = false;
      }
      if (!busy) {
        reloading = true;
        close();
        try {
          location.reload();
        } catch (e) {
          warn(e);
        }
        return;
      }
      if (!told) {
        told = true;
        try {
          hooks.notify("Files changed. The page reloads once this note is saved.");
        } catch {
          /* ignore */
        }
      }
      reloadTimer = window.setTimeout(tick, BUSY_POLL_MS);
    };
    tick();
  };

  const onChange = (ev: LiveChange) => {
    const files = Array.isArray(ev && ev.files) ? ev.files.filter((f) => typeof f === "string") : [];
    if (ev && ev.css === true && files.length && !reloadTimer && swapStylesheets(files)) {
      try {
        hooks.relayout();
      } catch {
        /* ignore */
      }
      return;
    }
    reload();
  };

  /** Swap every <link rel=stylesheet> pointing at a changed file. False (and no swap) when one is not linked. */
  const swapStylesheets = (files: string[]): boolean => {
    const wanted = new Set(files.map((f) => f.replace(/^\/+/, "")));
    const found = new Set<string>();
    const swaps: Array<[HTMLLinkElement, URL]> = [];
    for (const link of Array.from(document.querySelectorAll<HTMLLinkElement>("link[rel][href]"))) {
      if (retiring.has(link) || !/(^|\s)stylesheet(\s|$)/i.test(link.rel)) continue;
      let u: URL;
      try {
        u = new URL(link.href, location.href);
      } catch {
        continue;
      }
      if (u.origin !== location.origin) continue;
      let path = u.pathname;
      try {
        path = decodeURIComponent(path);
      } catch {
        /* keep */
      }
      path = path.replace(/^\/+/, "");
      if (!wanted.has(path)) continue;
      found.add(path);
      swaps.push([link, u]);
    }
    // A changed file that no <link> points at (e.g. pulled in with @import): reload instead.
    if (found.size !== wanted.size) return false;
    const stamp = String(Date.now());
    for (const [link, u] of swaps) {
      u.searchParams.set("sumi", stamp);
      const next = link.cloneNode(false) as HTMLLinkElement;
      next.href = u.href;
      retiring.add(link);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        link.remove(); // the old sheet stays until the new one has loaded: no flash
        try {
          hooks.relayout();
        } catch {
          /* ignore */
        }
      };
      next.addEventListener("load", finish);
      next.addEventListener("error", finish);
      window.setTimeout(finish, SWAP_TIMEOUT_MS);
      link.after(next);
    }
    return true;
  };

  const onHide = () => close();
  const onShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted && !es && !reloading) {
      retryMs = MIN_RETRY_MS;
      connect();
    }
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  stopFn = () => {
    reloading = true; // nothing reconnects or reloads from here on
    window.clearTimeout(retryTimer);
    window.clearTimeout(reloadTimer);
    retryTimer = reloadTimer = 0;
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
    close();
  };
  connect();
}

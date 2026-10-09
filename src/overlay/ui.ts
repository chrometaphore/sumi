/** The overlay application: Sumi ink dock, modes, pins/regions, popover, menu, notes panel, toasts, sync. */
import type { Annotation, AnnotationStatus, Intent, Stroke } from "../shared/types";
import { api, ApiError } from "./api";
import { Brush, BRUSH_MAX, BRUSH_MIN, BRUSH_STEP, strokePath } from "./brush";
import { captureElement, captureRegion, captureStroke, pageInfo } from "./context";
import { createGlow, type Glow } from "./glow";
import { ICONS, sumiSvg, type SumiIconName } from "./icons";
import { staticFlag, startLive, stopLive } from "./live";
import { createInkDock, createInkSkin, DROP, FILLET, INK_LOADING, inkShutdown, TAB_H, TAB_W, type InkDock, type InkDockChange, type InkSkin, type Point } from "./ink";
import { Marquee, type ViewRect } from "./marquee";
import { elementAt, forwardWheel, Picker, tagLabel } from "./picker";
import { refineSources } from "./sourcemap";
import { CSS, GAP, TIP_GAP, toolRowY } from "./styles";
import { dropIn, dropOut, InkLayer, measure, retract, reveal } from "./surface";
import { TopLayer } from "./toplayer";
import { adoptCss, clamp, collapse, deepActiveElement, genId, guard, h, isEditable, isMac, isTypingEvent, plural, roveFocus, safe, svgEl, truncate, viewW, warn } from "./util";

type Mode = "none" | "pin" | "marquee" | "brush";
type Tool = Exclude<Mode, "none">;

const POLL_MS = 2000;
/** Polling backs off up to this while the server is unreachable. */
const POLL_MAX_MS = 30_000;
const OPEN_KEY = "sumi:open";
/** The open note card, kept across reloads of the tab (sessionStorage). */
const DRAFT_KEY = "sumi:draft";
const DRAFT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** A sent note counts as "Claude is working" this long after sending, even when no agent is listening. */
const WORKING_FRESH_MS = 2 * 60 * 1000;
/** After this many times the page removes our host, give up and tear down. */
const REATTACH_CAP = 50;

const TOOLS: Tool[] = ["pin", "marquee", "brush"];
const TOOL_LABEL: Record<Tool, string> = { pin: "Pin", marquee: "Marquee", brush: "Brush" };
const TOOL_KEY: Record<Tool, string> = { pin: "P", marquee: "M", brush: "B" };
const TOOL_ARIA: Record<Tool, string> = { pin: "Pin an element", marquee: "Mark an area", brush: "Brush over an area" };

const STATUS_LABEL: Record<AnnotationStatus, string> = {
  draft: "Draft",
  sent: "Sent to Claude",
  "needs-input": "Claude has a question",
  resolved: "Resolved",
};

const INTENT_LABEL: Record<Intent, string> = {
  text: "Text",
  style: "Style",
  image: "Image",
  layout: "Layout",
  remove: "Remove",
  add: "Add",
  bug: "Bug",
  other: "Other",
};

/** Events that must not leak from the overlay UI into the page's own handlers. */
const ISOLATED_EVENTS = [
  "keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut",
  "pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu",
  "touchstart", "touchend", "focusin", "focusout", "wheel",
];

interface Mark {
  pin: HTMLButtonElement;
  num: HTMLElement;
  sub: HTMLElement;
  tip: HTMLElement;
  /** Marquee rectangle (div) or brush stroke (svg). */
  region?: HTMLElement | SVGSVGElement;
  key: string;
  /** What layout() wrote last (it only writes what changed). */
  pos: string;
  regionPos: string;
  flags: string;
}

/** Badges move with the independent `translate` property (no layout, composes with their hover scale). */
const PIN_TRANSLATE = safe(() => window.CSS.supports("translate", "1px 1px"), false);

interface Pop {
  id: string;
  isNew: boolean;
  el: HTMLDivElement;
  note: HTMLTextAreaElement;
  answer: HTMLTextAreaElement | null;
  startNote: string;
  replyKey: string;
  replyBox: HTMLDivElement;
  statusEl: HTMLElement;
  deleteBtn: HTMLButtonElement;
  deleteArmed: number;
  /** The card's living ink edge (torn down with the card). */
  skin: InkSkin;
  /** New notes: where the gesture ended (the card's ink drop landed there). */
  origin?: Point;
  /** Keys typed while the card is still ink (focus pending); flushed into the note on focus. */
  typeahead?: string;
  /** Where typeahead goes (the note, or the answer box). */
  typeTarget: HTMLTextAreaElement;
  /** Shown when the page keeps keyboard focus away from the card (focus traps). */
  stealHint: HTMLElement;
}

/** A server write, applied optimistically over server state until it lands (or fails for good). */
interface Op {
  apply(list: Annotation[]): Annotation[];
  run(): Promise<unknown>;
  failMsg: string;
  /** HTTP statuses that mean "already done" (e.g. 404 on delete). */
  okStatus?: number[];
  attempts: number;
  inflight: boolean;
  retryAt: number;
  done(result: unknown): void;
}

/** What survives a reload of the tab while a note card is open. */
interface Draft {
  v: 1;
  path: string;
  id: string;
  isNew: boolean;
  /** New notes: the captured annotation itself (it exists nowhere else yet). */
  annotation?: Annotation;
  note: string;
  caret: number;
  answer?: string;
  at: number;
}

interface DockRefs {
  tools: Record<Tool, HTMLButtonElement>;
  send: HTMLButtonElement;
  count: HTMLElement;
  more: HTMLButtonElement;
  close: HTMLButtonElement;
  /** Keyboard order (arrow keys move between these). */
  order: HTMLButtonElement[];
}

interface TipSpec {
  label: string;
  key?: string;
  sub?: string;
  /** Greyed out: the action is not available right now. */
  dim?: boolean;
}

let gradSeq = 0;
/**
 * Give an SVG its own violet → blue → teal gradient (the loading drop's palette) spanning its own box,
 * and return a `url(#…)` paint for strokes. userSpaceOnUse so straight, zero-height strokes still paint.
 */
function inkGradient(svg: SVGSVGElement): string {
  const id = `sumi-grad-${(++gradSeq).toString(36)}`;
  const defs = svgEl("defs");
  const g = svgEl("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1: "0%", y1: "0%", x2: "100%", y2: "100%" });
  const [violet, blue, teal] = INK_LOADING.palette;
  for (const [off, c] of [["0.21", violet], ["0.52", blue], ["0.82", teal]] as const) g.appendChild(svgEl("stop", { offset: off, "stop-color": c }));
  defs.appendChild(g);
  svg.insertBefore(defs, svg.firstChild);
  return `url(#${id})`;
}

/** A Figma icon from assets/sumi as inline SVG, unmodified; state colours come from CSS filters. */
function sumiIcon(name: SumiIconName): HTMLSpanElement {
  const icon = sumiSvg(name);
  if (name === "pin") icon.setAttribute("class", "si-pin");
  else if (name === "more" || name === "close") icon.setAttribute("class", "si-soft");
  return h("span", { class: "si", attrs: { "aria-hidden": "true" } }, [icon]);
}

function readOpen(): boolean {
  try {
    const v = window.localStorage.getItem(OPEN_KEY);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    /* storage blocked: state just won't persist */
  }
}

export class SumiApp {
  private dp: HTMLDivElement;
  private capture: HTMLDivElement;
  private hl: HTMLDivElement;
  private tgt: HTMLDivElement;
  private marqueeBox: HTMLDivElement;
  private brushLayer: SVGSVGElement;
  private brushCursor: HTMLDivElement;
  private brushSlider: HTMLInputElement | null = null;
  private brushSizeLabel: HTMLElement | null = null;
  private marks: HTMLDivElement;
  private panel: HTMLDivElement;
  private menu: HTMLDivElement;
  private hint: HTMLDivElement;
  private tip: HTMLDivElement;
  private toasts: HTMLDivElement;
  private panelLayer: InkLayer;
  private menuLayer: InkLayer;
  private hintLayer: InkLayer;
  private tipLayer: InkLayer;
  private dock: InkDock;
  private refs!: DockRefs;

  private picker: Picker;
  private marquee: Marquee;
  private brush: Brush;

  /** What the overlay shows: server state with the pending writes applied over it. */
  private annotations: Annotation[] = [];
  /** Last state the server reported (plus writes that have landed since). */
  private server: Annotation[] = [];
  /** Writes not yet confirmed by the server, oldest first (sent one at a time, retried on failure). */
  private ops: Op[] = [];
  private pumping = false;
  private opTimer = 0;
  private revision: number | null = null;
  private connected = true;
  /** An agent is waiting for feedback (server-reported). */
  private agentListening = false;
  private reqSeq = 0;
  private minSeq = 0;
  private pollTimer = 0;
  private polling = false;
  private failStreak = 0;
  private toldForbidden = false;

  private mode: Mode = "none";
  private pending: Annotation | null = null;
  private pop: Pop | null = null;
  private panelOpen = false;
  private menuKey = "";
  private shortcutsOpen = false;
  private hoverId: string | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private pointerDownOnCapture = false;
  private swallowUp = false;
  /** Pin mode: the element under the pointer when it went down (what the click pins). */
  private pinTarget: Element | null = null;

  private tips = new Map<HTMLElement, () => TipSpec>();
  private tipFor: HTMLElement | null = null;
  private tipTimer = 0;
  private tipHiddenAt = 0;

  private markEls = new Map<string, Mark>();
  /** Async source-map refinement started at capture time, awaited (briefly) before saving. */
  private refining = new Map<string, Promise<void>>();
  private elCache = new Map<string, Element | null>();
  private requery = true;
  private layoutQueued = false;
  private path = location.pathname;
  private reattachCount = 0;
  private glow: Glow | null = null;
  private glowOn: boolean | null = null;

  private destroyed = false;
  /** Undo functions for everything registered outside the shadow root. */
  private cleanups: Array<() => void> = [];
  private timers = new Set<number>();
  private layoutRaf = 0;
  private mo: MutationObserver | null = null;
  private skins: InkSkin[] = [];
  private unstyle: () => void;
  private topLayer: TopLayer;
  private draftChecked = false;
  private unloadGuard = false;
  private readonly onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!this.hasUnsavedText()) return;
    e.preventDefault();
    e.returnValue = "";
  };

  constructor(private host: HTMLElement, private shadow: ShadowRoot) {
    // A constructable sheet: a page CSP that blocks <style> elements cannot strip Sumi's styling.
    this.unstyle = adoptCss(shadow, CSS);
    this.topLayer = new TopLayer(host, shadow);

    this.dp = h("div", { class: "dp" });
    this.capture = h("div", { class: "capture", attrs: { hidden: "" } });

    const hlPrimary = h("b");
    const hlSecondary = h("i");
    const hlSize = h("span", { class: "dim" });
    this.hl = h("div", { class: "hl", attrs: { hidden: "" } }, [h("div", { class: "hl-label" }, [hlPrimary, hlSecondary, hlSize])]);
    this.tgt = h("div", { class: "tgt", attrs: { hidden: "" } });
    const marqueeSize = h("span", { class: "dim" });
    this.marqueeBox = h("div", { class: "marquee", attrs: { hidden: "" } }, [marqueeSize]);
    const livePath = svgEl("path", { class: "stroke-path" });
    const liveGroup = svgEl("g");
    liveGroup.appendChild(livePath);
    this.brushLayer = svgEl("svg", { class: "live-stroke", "data-s": "draft", hidden: "", "aria-hidden": "true" });
    this.brushLayer.appendChild(liveGroup);
    livePath.setAttribute("stroke", inkGradient(this.brushLayer));
    this.brushCursor = h("div", { class: "brush-cursor", attrs: { hidden: "" } });
    this.marks = h("div", { class: "marks" });

    // Ink surfaces: each emerges from the dock with inkReveal and retracts with inkHide.
    this.panel = h("div", { class: "panel ink", attrs: { role: "dialog", "aria-label": "Sumi notes" } });
    // The menu box holds the role=menu list, the shortcuts sheet and the credit link (not menu items).
    this.menu = h("div", { class: "menu ink" });
    this.hint = h("div", { class: "mode-hint ink", attrs: { role: "status" } });
    this.tip = h("div", { class: "tt ink", attrs: { "aria-hidden": "true" } });
    this.toasts = h("div", { class: "toasts" });
    this.panelLayer = new InkLayer(this.panel);
    this.menuLayer = new InkLayer(this.menu);
    // The notes panel and the menu share the dock's living ink edge (waves along their outline).
    this.skins.push(createInkSkin(this.panel), createInkSkin(this.menu));
    this.hintLayer = new InkLayer(this.hint);
    this.tipLayer = new InkLayer(this.tip);
    this.menu.addEventListener("keydown", guard((e: KeyboardEvent) => this.onMenuKey(e)));

    this.dock = this.buildDock(readOpen());
    this.dp.classList.toggle("dock-open", this.dock.isOpen);

    this.dp.append(
      this.capture, this.hl, this.tgt, this.marqueeBox, this.brushLayer, this.marks, this.brushCursor,
      this.panel, this.menu, this.hint, this.dock.el, this.tip, this.toasts
    );
    shadow.appendChild(this.dp);
    // Processing glow goes in last, at the top z-level (pointer-events:none, translucent),
    // so it wraps the viewport above the dock, popover and pins.
    try {
      this.glow = createGlow(shadow);
    } catch (e) {
      warn(e);
    }

    this.picker = new Picker(host, this.hl, hlPrimary, hlSecondary, hlSize);
    this.marquee = new Marquee(this.marqueeBox, marqueeSize);
    this.brush = new Brush(this.brushLayer, liveGroup, livePath, this.brushCursor);
  }

  // ------------------------------------------------------------------ boot

  start(): void {
    // Keep overlay interactions away from the page's own listeners (bubble phase).
    for (const type of ISOLATED_EVENTS) {
      this.shadow.addEventListener(type, (e) => e.stopPropagation());
    }
    this.topLayer.sync(false); // a modal dialog may already be open

    const c = this.capture;
    c.addEventListener("pointermove", guard((e: PointerEvent) => this.onCaptureMove(e)));
    c.addEventListener("pointerdown", guard((e: PointerEvent) => this.onCaptureDown(e)));
    c.addEventListener("pointerup", guard((e: PointerEvent) => this.onCaptureUp(e)));
    c.addEventListener("pointercancel", guard(() => this.cancelGesture()));
    c.addEventListener("pointerleave", guard(() => {
      if (this.mode === "pin") this.picker.clear();
      if (!this.brush.active) this.brush.hideCursor();
    }));
    c.addEventListener("wheel", guard((e: WheelEvent) => forwardWheel(e, this.host)), { passive: false });

    this.listen(window, "keydown", (e: KeyboardEvent) => this.onKey(e), true);
    this.listen(window, "pointerdown", (e: PointerEvent) => this.onWindowPointerDown(e), true);
    this.listen(window, "scroll", () => this.queueLayout(), { capture: true, passive: true });
    this.listen(window, "resize", () => {
      this.requery = true;
      this.queueLayout();
      this.placeFloating();
    }, { passive: true });
    this.listen(window, "pagehide", () => this.saveDraft()); // latest caret for the restored card
    this.listen(window, "popstate", () => this.checkPath());
    this.listen(window, "hashchange", () => this.checkPath());
    this.listen(document, "visibilitychange", () => {
      // Polling pauses while the tab is hidden; catch up at once when it comes back.
      if (!document.hidden) this.schedulePoll(0);
    });
    // Top layer: fullscreen, and page popovers opening above us while we are up there.
    this.listen(document, "fullscreenchange", () => this.topLayer.sync());
    this.listen(document, "webkitfullscreenchange", () => this.topLayer.sync());
    this.listen(document, "toggle", (e: Event) => {
      if (e.target !== this.host && this.topLayer.active && (e as any).newState === "open") this.topLayer.sync();
    }, true);

    try {
      this.mo = new MutationObserver(guard((records: MutationRecord[]) => this.onMutations(records)));
      this.mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (e) {
      warn(e);
    }

    // Fallback for CSS animations / transitions that move elements without DOM mutations; also
    // client-side navigations that bypass popstate, and the working state's 2-minute window.
    this.every(() => {
      if (this.markEls.size) {
        this.requery = true;
        this.queueLayout();
      }
      this.checkPath();
      this.renderGlow();
    }, 1000);

    this.renderAll();
    if (staticFlag()) this.startLive();
    void this.poll();
  }

  // ------------------------------------------------------------------ lifecycle

  /** addEventListener outside the shadow root, undone by destroy(). */
  private listen(t: EventTarget, type: string, fn: (e: any) => unknown, opts?: AddEventListenerOptions | boolean): void {
    const g = guard(fn);
    t.addEventListener(type, g, opts);
    this.cleanups.push(() => t.removeEventListener(type, g, opts));
  }

  /** setTimeout cleared by destroy(). */
  private later(fn: () => unknown, ms: number): number {
    const id = window.setTimeout(() => {
      this.timers.delete(id);
      if (!this.destroyed) guard(fn)();
    }, ms);
    this.timers.add(id);
    return id;
  }

  private cancel(id: number): void {
    if (!id) return;
    window.clearTimeout(id);
    this.timers.delete(id);
  }

  private every(fn: () => unknown, ms: number): void {
    const id = window.setInterval(guard(fn), ms);
    this.cleanups.push(() => window.clearInterval(id));
  }

  /**
   * Remove the overlay from the page: listeners, observers, timers, frames, the glow (and its WebGL
   * context), the dock, live reload and the host. Idempotent. Unsaved local edits are dropped.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const f of this.cleanups.splice(0)) safe(f, undefined);
    safe(() => this.mo?.disconnect(), undefined);
    this.mo = null;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    window.clearTimeout(this.pollTimer);
    window.clearTimeout(this.opTimer);
    window.clearTimeout(this.tipTimer);
    if (this.lingerTimer !== null) window.clearTimeout(this.lingerTimer);
    if (this.layoutRaf) cancelAnimationFrame(this.layoutRaf);
    this.layoutRaf = 0;
    safe(() => stopLive(), undefined);
    this.setUnloadGuard(false);
    for (const op of this.ops.splice(0)) safe(() => op.done(null), undefined);
    const p = this.pop;
    this.pop = null;
    if (p) safe(() => p.skin.destroy(), undefined);
    for (const sk of this.skins.splice(0)) safe(() => sk.destroy(), undefined);
    safe(() => this.glow?.destroy(), undefined);
    this.glow = null;
    safe(() => this.dock.destroy(), undefined);
    safe(() => inkShutdown(), undefined);
    safe(() => this.topLayer.release(), undefined);
    safe(() => this.unstyle(), undefined);
    safe(() => this.host.remove(), undefined);
  }

  /** Static mode only: reload / restyle the page when the served files change. */
  private startLive(): void {
    startLive({
      busy: () => this.hasUnsavedWork(),
      notify: (msg) => this.toast(msg),
      relayout: () => {
        this.requery = true;
        this.queueLayout();
      },
    });
  }

  /** True while a page reload would lose something: an open note with edits, a save, a gesture. */
  private hasUnsavedWork(): boolean {
    if (this.ops.length > 0 || this.marquee.active || this.brush.active) return true;
    const p = this.pop;
    if (!p) return false;
    if (p.isNew || this.popEdited(p)) return true;
    return !!(p.answer && p.answer.value.trim());
  }

  /** Text the person typed that the server does not have yet (guards closing / reloading the tab). */
  private hasUnsavedText(): boolean {
    if (this.ops.length > 0) return true;
    const p = this.pop;
    if (!p) return false;
    if (this.popEdited(p, true)) return true;
    return !!(p.answer && p.answer.value.trim());
  }

  /** beforeunload is only registered while there is something to lose (it costs the page its bfcache). */
  private setUnloadGuard(on: boolean): void {
    if (on === this.unloadGuard) return;
    this.unloadGuard = on;
    if (on) window.addEventListener("beforeunload", this.onBeforeUnload);
    else window.removeEventListener("beforeunload", this.onBeforeUnload);
  }

  private syncUnloadGuard(): void {
    if (!this.destroyed) this.setUnloadGuard(this.hasUnsavedText());
  }

  private onMutations(records: MutationRecord[]): void {
    if (this.destroyed) return;
    if (!this.host.isConnected) {
      // Removed by the page (or with the modal dialog we sat in): put it back where it belongs.
      const was = this.topLayer.parent;
      const ours = was !== null && !was.isConnected; // the dialog we sat in went away (not the page fighting us)
      if (!ours && ++this.reattachCount > REATTACH_CAP) {
        warn("the page keeps removing the overlay; Sumi stopped");
        this.destroy();
        return;
      }
      if (document.documentElement) this.topLayer.sync();
    } else if (TopLayer.touchesDialogs(records)) {
      this.topLayer.sync();
    }
    if (!this.markEls.size && this.mode === "none" && !this.pop) return;
    for (const r of records) {
      if (r.target === this.host) continue;
      this.requery = true;
      this.queueLayout();
      return;
    }
  }

  // ------------------------------------------------------------------ sync

  /** Poll forever: every 2 s while connected, backing off to 30 s while the server is unreachable,
   * paused while the tab is hidden. */
  private async poll(): Promise<void> {
    if (this.destroyed || this.polling) return;
    if (document.hidden) return; // visibilitychange restarts it
    this.polling = true;
    let ok = false;
    try {
      ok = await this.refresh();
    } catch (e) {
      warn(e);
    } finally {
      this.polling = false;
      this.failStreak = ok ? 0 : this.failStreak + 1;
      const delay = ok ? POLL_MS : Math.min(POLL_MAX_MS, POLL_MS * 2 ** Math.max(0, this.failStreak - 1));
      if (!document.hidden) this.schedulePoll(delay);
    }
  }

  private schedulePoll(ms: number): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = 0;
    if (this.destroyed) return;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = 0;
      void this.poll();
    }, ms);
  }

  /** Fetch server state. True when the server answered. Never throws. */
  private async refresh(): Promise<boolean> {
    if (this.destroyed) return false;
    const seq = ++this.reqSeq;
    try {
      const s = await api.state();
      if (this.destroyed) return true;
      this.setConnected(true);
      if (s && s.mode === "static") this.startLive(); // also covers pages whose CSP blocked the inline flag
      // A poll that started before a write landed, or one racing a write in flight, would show
      // stale data: keep the local truth until the next poll.
      const stale = seq < this.minSeq || this.ops.some((o) => o.inflight);
      if (!stale) {
        this.minSeq = seq;
        if (s && s.revision !== this.revision) {
          this.revision = s.revision;
          this.server = Array.isArray(s.annotations) ? s.annotations.filter((a) => a && typeof a.id === "string") : [];
          this.recompute();
          this.renderAll();
        }
      }
      const listening = !!s && (s as unknown as { agentListening?: unknown }).agentListening === true;
      if (listening !== this.agentListening) {
        this.agentListening = listening;
        this.renderGlow();
      }
      // The server is back: retry failed writes now instead of waiting out their backoff.
      if (this.ops.length && !this.pumping) {
        for (const o of this.ops) o.retryAt = 0;
        this.pumpSoon(0);
      }
      this.restoreDraft();
      return true;
    } catch (e) {
      if (this.destroyed) return false;
      if (seq >= this.minSeq) this.setConnected(false, e);
      if (this.agentListening) {
        this.agentListening = false; // nobody can be listening through a server we cannot reach
        this.renderGlow();
      }
      this.restoreDraft(true);
      return false;
    } finally {
      if (!this.destroyed) this.checkPath();
    }
  }

  /** Recompute what the overlay shows: server state with every pending write applied, oldest first. */
  private recompute(): void {
    let list = this.server;
    for (const op of this.ops) {
      try {
        list = op.apply(list);
      } catch (e) {
        warn(e);
      }
    }
    this.annotations = list;
  }

  /**
   * Queue a server write. It shows at once (applied over server state, so a poll can never erase it),
   * is sent after the writes before it, and is retried with backoff while the server is unreachable.
   * Resolves with the server's answer, or null when the write was refused for good.
   */
  private enqueue<T>(apply: (list: Annotation[]) => Annotation[], run: () => Promise<T>, failMsg: string, okStatus?: number[]): Promise<T | null> {
    if (this.destroyed) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      this.ops.push({ apply, run, failMsg, okStatus, attempts: 0, inflight: false, retryAt: 0, done: resolve as (r: unknown) => void });
      this.recompute();
      this.renderAll();
      this.syncUnloadGuard();
      void this.pump();
    });
  }

  private pumpSoon(ms: number): void {
    window.clearTimeout(this.opTimer);
    this.opTimer = 0;
    if (this.destroyed) return;
    this.opTimer = window.setTimeout(() => {
      this.opTimer = 0;
      void this.pump();
    }, Math.max(0, ms));
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    try {
      while (this.ops.length && !this.destroyed) {
        const op = this.ops[0];
        const wait = op.retryAt - Date.now();
        if (wait > 0) {
          this.pumpSoon(wait);
          return;
        }
        op.inflight = true;
        let result: unknown = null;
        let ok = false;
        let err: unknown = null;
        try {
          result = await op.run();
          ok = true;
        } catch (e) {
          err = e;
          if (e instanceof ApiError && op.okStatus && op.okStatus.includes(e.status)) ok = true;
        }
        op.inflight = false;
        if (this.destroyed) return;
        const permanent = !ok && err instanceof ApiError && err.status >= 400 && err.status < 500 && ![403, 408, 425, 429].includes(err.status);
        if (ok || permanent) {
          this.ops.shift();
          // Polls that started before this write landed are stale; the next one brings the truth.
          this.minSeq = ++this.reqSeq;
          this.revision = null;
          if (ok) {
            this.server = safe(() => op.apply(this.server), this.server);
            this.setConnected(true);
          } else {
            warn(err);
            this.toast(op.failMsg, true);
          }
          this.recompute();
          this.renderAll();
          this.syncUnloadGuard();
          op.done(ok ? result : null);
          continue;
        }
        op.attempts++;
        op.retryAt = Date.now() + Math.min(POLL_MAX_MS, 1000 * 2 ** op.attempts);
        if (op.attempts === 1) {
          warn(err);
          this.toast(`${op.failMsg} Retrying…`, true);
        }
        this.setConnected(false, err);
        this.pumpSoon(op.retryAt - Date.now());
        return;
      }
    } finally {
      this.pumping = false;
    }
    if (!this.destroyed) void this.refresh();
  }

  private setConnected(ok: boolean, err?: unknown): void {
    if (!ok && err instanceof ApiError && err.status === 403 && !this.toldForbidden) {
      // The server restarted with a new session key: this page's copy of the overlay is stale.
      this.toldForbidden = true;
      this.toast("Sumi restarted. Reload the page to reconnect.", true);
    }
    if (ok === this.connected) return;
    this.connected = ok;
    this.renderDock();
    this.renderMenu();
  }

  private checkPath(): void {
    const p = location.pathname;
    if (p === this.path) return;
    this.path = p;
    if (this.pop) this.closePopover(true, false);
    this.elCache.clear();
    this.requery = true;
    this.renderMarks();
    this.renderPanel();
    this.renderGlow(); // "working" is per page
  }

  // ------------------------------------------------------------------ dock

  private buildDock(startOpen: boolean): InkDock {
    // createInkDock never throws: it falls back to a static dock by itself
    const dock = createInkDock({
      dropIcon: () => sumiSvg("drop"),
      loaderIcon: () => sumiSvg("loader"),
      startOpen,
      // `auto`: the dock collapsed for "Claude is working" (or poured back after it) on its own
      onOpen: guard((c?: InkDockChange) => this.onDockOpen(!!c?.auto)),
      onClose: guard((c?: InkDockChange) => this.onDockClose(!!c?.auto)),
    });

    const tools = {} as Record<Tool, HTMLButtonElement>;
    for (const t of TOOLS) {
      const b = h(
        "button",
        {
          class: "dk",
          attrs: {
            type: "button",
            "aria-pressed": "false",
            "aria-label": TOOL_ARIA[t],
            "aria-keyshortcuts": TOOL_KEY[t],
            "data-ink-item": "",
          },
          on: { click: () => this.setMode(t) },
        },
        [sumiIcon(t)]
      );
      this.addTip(b, () => ({ label: TOOL_LABEL[t], key: TOOL_KEY[t] }));
      tools[t] = b;
    }

    const count = h("span", { class: "dk-count", attrs: { hidden: "", "aria-hidden": "true" } });
    const send = h(
      "button",
      {
        class: "dk-send",
        attrs: { type: "button", "aria-label": "Send to Claude", "aria-disabled": "true", "data-ink-item": "" },
        on: { click: () => this.onSendClick() },
      },
      [h("span", { class: "dk-pill" }, [sumiSvg("send")]), count]
    );
    this.addTip(send, () => ({ label: "Send to Claude", dim: !this.connected || !this.sendableCount() }));

    const more = h(
      "button",
      {
        class: "dk",
        attrs: { type: "button", "aria-label": "More", "aria-haspopup": "menu", "aria-expanded": "false", "aria-controls": "sumi-menu", "data-ink-item": "" },
        on: { click: (e: MouseEvent) => this.toggleMenu(e.detail === 0) },
      },
      [sumiIcon("more")]
    );
    this.addTip(more, () => ({ label: "More", sub: this.connected ? undefined : "offline" }));

    const close = h(
      "button",
      {
        class: "dk",
        attrs: { type: "button", "aria-label": "Minimize Sumi", "data-ink-item": "" },
        on: { click: () => this.collapse() },
      },
      [sumiIcon("close")]
    );
    this.addTip(close, () => ({ label: "Minimize", key: "Esc" }));

    const col = h("div", { class: "dock-col", attrs: { role: "toolbar", "aria-label": "Sumi", "aria-orientation": "vertical" } }, [
      h("div", { class: "dock-tools" }, [tools.pin, tools.marquee, tools.brush]),
      send,
      h("div", { class: "dock-sec" }, [more, close]),
    ]);
    col.addEventListener("keydown", guard((e: KeyboardEvent) => this.onDockKey(e)));
    dock.content.appendChild(col);

    this.refs = { tools, send, count, more, close, order: [tools.pin, tools.marquee, tools.brush, send, more, close] };
    return dock;
  }

  /** Drafts plus a new note being written right now (Send commits it first). */
  private sendableCount(): number {
    const drafts = this.annotations.filter((a) => a.status === "draft").length;
    return drafts + (this.pop && this.pop.isNew ? 1 : 0);
  }

  private renderDock(): void {
    const r = this.refs;
    if (!r) return;
    for (const t of TOOLS) {
      r.tools[t].classList.toggle("on", this.mode === t);
      r.tools[t].setAttribute("aria-pressed", String(this.mode === t));
    }
    const n = this.sendableCount();
    r.count.textContent = String(n);
    r.count.hidden = n === 0;
    const canSend = this.connected && n > 0;
    r.send.setAttribute("aria-disabled", String(!canSend));
    r.send.setAttribute(
      "aria-label",
      !this.connected ? "Send to Claude (offline)" : n ? `Send ${plural(n, "new note")} to Claude` : "Send to Claude (nothing new to send)"
    );
    r.more.setAttribute("aria-label", this.connected ? "More" : "More (offline: can't reach the Sumi server)");
    r.more.setAttribute("aria-expanded", String(this.menuLayer.isOpen));
    this.dp.classList.toggle("dock-open", this.dock.isOpen);
    if (this.tipFor && this.tipLayer.isOpen) this.showTip(this.tipFor); // keep a visible label current
  }

  /** Left edge (viewport x) and top of the ink tab. */
  private tabRect(): { left: number; top: number } {
    const r = safe(() => this.dock.content.getBoundingClientRect(), null);
    if (r && r.width > 0 && r.height > 0) return { left: r.left, top: r.top };
    return { left: viewW() - TAB_W, top: window.innerHeight / 2 - TAB_H / 2 };
  }

  /** Collapse back to the drop. Closes everything that hangs off the dock first. */
  private collapse(): void {
    this.onDockClose();
    try {
      void this.dock.close().catch(warn);
    } catch (e) {
      warn(e);
    }
  }

  /** `auto`: the dock moved on its own (loading), which is not the person's preference. */
  private onDockOpen(auto = false): void {
    if (!auto) writeOpen(true);
    this.dp.classList.add("dock-open");
    this.renderDock();
    this.queueLayout(); // badges move out of the dock's way
  }

  private onDockClose(auto = false): void {
    if (!auto) writeOpen(false);
    const hadFocus = this.focusInDock();
    this.hideTip(true);
    this.closeMenu();
    this.setPanel(false);
    if (this.mode !== "none") this.setMode("none");
    this.hintLayer.reset();
    this.dp.classList.remove("dock-open");
    this.renderDock();
    this.queueLayout();
    if (hadFocus) this.focusDockButton();
  }

  /** Is keyboard focus on the dock (its buttons, or the closed drop)? */
  private focusInDock(): boolean {
    const a = this.shadow.activeElement;
    return !!a && this.dock.el.contains(a);
  }

  /** Is keyboard focus anywhere inside the overlay? */
  private focusInOverlay(): boolean {
    return safe(() => document.activeElement === this.host || !!this.shadow.activeElement, false);
  }

  /** Put focus back on the dock: the active tool (or Pin) when open, the drop when collapsed. */
  private focusDockButton(prefer?: HTMLElement | null): void {
    if (this.dock.isOpen) {
      const el = prefer && prefer.isConnected ? prefer : this.refs.tools[this.mode === "none" ? "pin" : this.mode];
      safe(() => el.focus({ preventScroll: true }), undefined);
      return;
    }
    // The drop only becomes focusable once the collapse has drawn it: retry for a few frames.
    const drop = this.dock.el.querySelector<HTMLElement>(".ink-drop");
    if (!drop) return;
    let tries = 0;
    const attempt = () => {
      if (this.destroyed || this.dock.isOpen) return;
      const d = document.activeElement;
      if (tries > 0 && d && d !== this.host && d !== document.body) return; // the person moved on
      safe(() => drop.focus({ preventScroll: true }), undefined);
      if (this.shadow.activeElement !== drop && ++tries < 90) requestAnimationFrame(guard(attempt));
    };
    attempt();
  }

  /**
   * Where pins must not sit: the dock's footprint (the open tab with its fillets, or the closed drop
   * with its rippling edge), so a click on a badge can never land on a dock button. Mirrors the
   * dock's fit-to-viewport scale (ink.ts `fit`).
   */
  private dockZone(vw: number, vh: number): { left: number; top: number; bottom: number } {
    const dockH = TAB_H + 2 * FILLET;
    const k = vh >= 100 ? Math.min(1, (vh - 16) / dockH) : 1;
    if (this.dock.isOpen) {
      const half = (dockH * k) / 2;
      return { left: vw - TAB_W * k, top: vh / 2 - half, bottom: vh / 2 + half };
    }
    const r = (DROP / 2 + 8) * k;
    const cx = vw - 36 * k; // the drop sits on the tool column's axis, 36px from the edge
    return { left: cx - r, top: vh / 2 - r, bottom: vh / 2 + r };
  }

  private onDockKey(e: KeyboardEvent): void {
    roveFocus(e, this.refs.order, this.shadow.activeElement);
  }

  private onSendClick(): void {
    if (this.refs.send.getAttribute("aria-disabled") === "true") return;
    void this.sendDrafts();
  }

  // ------------------------------------------------------------------ tooltips

  private addTip(b: HTMLElement, spec: () => TipSpec): void {
    this.tips.set(b, spec);
    b.addEventListener("pointerenter", guard(() => this.tipEnter(b, false)));
    b.addEventListener("pointerleave", guard(() => this.tipLeave(b)));
    b.addEventListener("focus", guard(() => {
      if (safe(() => b.matches(":focus-visible"), false)) this.tipEnter(b, true);
    }));
    b.addEventListener("blur", guard(() => this.tipLeave(b)));
  }

  private tipEnter(b: HTMLElement, now: boolean): void {
    window.clearTimeout(this.tipTimer);
    // Instant while a label is up (or just went down), so sweeping along the dock feels continuous.
    const warm = this.tipLayer.isOpen || Date.now() - this.tipHiddenAt < 450;
    if (now || warm) this.showTip(b);
    else this.tipTimer = window.setTimeout(guard(() => this.showTip(b)), 280);
  }

  private tipLeave(b: HTMLElement): void {
    window.clearTimeout(this.tipTimer);
    if (this.tipFor !== b) return;
    this.tipTimer = window.setTimeout(guard(() => this.hideTip()), 70);
  }

  private showTip(b: HTMLElement): void {
    if (!this.dock.isOpen || !b.isConnected) return;
    // The notes panel and the menu fill the space beside the dock; labels would land on top of them.
    if (this.panelOpen || this.menuLayer.isOpen) {
      this.hideTip(true);
      return;
    }
    // The menu, or the mode hint on the active tool's row, already stands where the label would go.
    if ((b === this.refs.more && this.menuLayer.isOpen) || (this.mode !== "none" && b === this.refs.tools[this.mode] && this.hintLayer.isOpen)) {
      this.hideTip(true);
      return;
    }
    const spec = this.tips.get(b);
    const s = spec ? spec() : null;
    if (!s) return;
    this.tip.textContent = "";
    this.tip.append(h("span", { class: s.dim ? "dim" : "", text: s.label }));
    if (s.sub) this.tip.append(h("span", { class: "sub", text: s.sub }));
    if (s.key) this.tip.append(h("span", { class: "kbd", text: s.key }));
    this.tip.classList.toggle("plain", !s.key);
    const r = b.getBoundingClientRect();
    const cy = r.top + r.height / 2;
    this.tip.style.right = `${Math.round(viewW() - this.tabRect().left + TIP_GAP)}px`;
    this.tip.style.top = `${Math.round(cy - 14)}px`;
    this.tipFor = b;
    this.tipLayer.show({ x: r.left, y: cy });
  }

  private hideTip(now = false): void {
    window.clearTimeout(this.tipTimer);
    const b = this.tipFor;
    this.tipFor = null;
    if (!this.tipLayer.isOpen) return;
    this.tipHiddenAt = Date.now();
    if (now) {
      this.tipLayer.reset();
      return;
    }
    const r = b && b.isConnected ? b.getBoundingClientRect() : null;
    this.tipLayer.hide(r ? { x: r.left, y: r.top + r.height / 2 } : undefined);
  }

  // ------------------------------------------------------------------ more menu

  private moreOrigin(): Point {
    const r = this.refs.more.getBoundingClientRect();
    return { x: r.left, y: r.top + r.height / 2 };
  }

  private toggleMenu(viaKeyboard: boolean): void {
    if (this.menuLayer.isOpen) this.closeMenu();
    else this.openMenu(viaKeyboard);
  }

  private openMenu(focusFirst: boolean): void {
    if (!this.dock.isOpen || this.menuLayer.isOpen) return;
    this.hideTip(true);
    this.setPanel(false);
    this.menuKey = "";
    this.dp.classList.add("menu-open");
    this.renderMenu(true); // fill and place it first: the ink pours out from the More button into its final box
    this.menuLayer.show(this.moreOrigin());
    this.refs.more.setAttribute("aria-expanded", "true");
    if (focusFirst) {
      const first = this.menu.querySelector<HTMLButtonElement>(".mi:not(:disabled)");
      if (first) safe(() => first.focus({ preventScroll: true }), undefined);
    }
  }

  private closeMenu(returnFocus = false): void {
    if (!this.menuLayer.isOpen) return;
    const a = this.shadow.activeElement;
    if (a && this.menu.contains(a)) returnFocus = true; // focus never falls into the void
    this.menuLayer.hide(this.moreOrigin());
    this.dp.classList.remove("menu-open");
    this.refs.more.setAttribute("aria-expanded", "false");
    if (returnFocus) safe(() => this.refs.more.focus({ preventScroll: true }), undefined);
  }

  private renderMenu(force = false): void {
    if (!force && !this.menuLayer.isOpen) return;
    const total = this.annotations.length;
    const resolved = this.annotations.filter((a) => a.status === "resolved").length;
    const copyable = this.annotations.some((a) => a.status === "draft" || a.status === "sent");
    const key = [total, resolved, copyable, this.shortcutsOpen, this.panelOpen].join("|");
    if (key === this.menuKey) return;
    this.menuKey = key;

    // Keep keyboard focus on the same row across a rebuild.
    const items = () => Array.from(this.menu.querySelectorAll<HTMLButtonElement>(".mi"));
    const focusIdx = items().indexOf(this.shadow.activeElement as HTMLButtonElement);

    const mi = (
      icon: string,
      label: string,
      onClick: () => unknown,
      extra: { right?: Node | null; disabled?: boolean; attrs?: Record<string, string> } = {}
    ): HTMLButtonElement => {
      const b = h("button", { class: "mi", attrs: { type: "button", role: "menuitem", ...(extra.attrs || {}) }, on: { click: onClick } });
      b.innerHTML = icon;
      b.append(h("span", { text: label }), h("span", { class: "grow" }));
      if (extra.right) b.append(extra.right);
      b.disabled = !!extra.disabled;
      return b;
    };

    const notes = mi(ICONS.list, "Notes", () => {
      this.closeMenu();
      this.setPanel(true);
    }, { right: h("span", { class: "n", text: String(total) }), attrs: { "aria-haspopup": "dialog" } });
    const copy = mi(ICONS.copy, "Copy for Claude", () => {
      this.closeMenu();
      void this.copyForClaude();
    }, { disabled: !copyable });
    const clear = mi(ICONS.sweep, "Clear resolved", () => {
      this.closeMenu();
      void this.clearResolved();
    }, { right: resolved ? h("span", { class: "n", text: String(resolved) }) : null, disabled: resolved === 0 });
    const chev = h("span", { html: ICONS.chevron });
    const chevSvg = chev.firstElementChild;
    if (chevSvg) chevSvg.setAttribute("class", "chev");
    const keysBtn = mi(ICONS.keyboard, "Shortcuts", () => {
      this.shortcutsOpen = !this.shortcutsOpen;
      this.renderMenu();
      this.placeMenu();
    }, { right: chevSvg || null, attrs: { "aria-expanded": String(this.shortcutsOpen) } });

    keysBtn.setAttribute("aria-controls", "sumi-keys");
    this.menu.textContent = "";
    // Only menu items (and a separator) inside role=menu; the shortcuts sheet and the credit follow it.
    this.menu.append(
      h("div", { class: "menu-list", attrs: { role: "menu", id: "sumi-menu", "aria-label": "Sumi" } }, [
        notes,
        copy,
        clear,
        h("div", { class: "menu-sep", attrs: { role: "separator" } }),
        keysBtn,
      ])
    );
    if (this.shortcutsOpen) {
      const k = (...keys: string[]) => h("span", { class: "kk" }, keys.map((t) => h("span", { class: "kbd", text: t })));
      const rows: Array<[HTMLElement, string]> = [
        [k("P"), "Pin an element"],
        [k("M"), "Mark an area"],
        [k("B"), "Brush over an area"],
        [k("[", "]"), "Brush size"],
        [k(isMac ? "⌘" : "Ctrl", "↵"), "Save note"],
        [k("Esc"), "Close · stop · minimize"],
      ];
      const grid = h("div", { class: "keys", attrs: { role: "group", id: "sumi-keys", "aria-label": "Keyboard shortcuts" } });
      for (const [keys, label] of rows) grid.append(keys, h("span", { text: label }));
      this.menu.append(grid);
    }
    this.menu.append(
      h("div", { class: "menu-credit" }, [
        "made by ",
        h("a", { text: "chrometaphore.com", attrs: { href: "https://chrometaphore.com", target: "_blank", rel: "noopener noreferrer" } }),
      ])
    );
    this.placeMenu();
    if (focusIdx >= 0) {
      const again = items()[focusIdx];
      if (again) safe(() => again.focus({ preventScroll: true }), undefined);
    }
  }

  /** Bottom-align the menu with the dock's secondary pill, growing upward; keep it on screen. */
  private placeMenu(): void {
    const vh = window.innerHeight;
    const c = this.refs.close.getBoundingClientRect();
    const ht = measure(this.menu).height || 200;
    const top = clamp(c.bottom + 4 - ht, 12, Math.max(12, vh - ht - 12));
    this.menu.style.right = `${Math.round(viewW() - this.tabRect().left + GAP)}px`;
    this.menu.style.top = `${Math.round(top)}px`;
  }

  private onMenuKey(e: KeyboardEvent): void {
    roveFocus(e, Array.from(this.menu.querySelectorAll<HTMLButtonElement>(".mi:not(:disabled)")), this.shadow.activeElement, true);
  }

  /** Re-anchor everything that hangs off the dock (after a resize). */
  private placeFloating(): void {
    this.hideTip(true);
    if (this.hintLayer.isOpen) this.placeHint();
    if (this.menuLayer.isOpen) this.placeMenu();
  }

  // ------------------------------------------------------------------ modes

  private setMode(m: Mode): void {
    if (this.mode === m) m = "none";
    if (this.pop && m !== "none") this.closePopover(true);
    this.mode = m;
    // Activate the capture layer synchronously and reset any half-finished gesture, so a drag
    // that starts right after clicking a dock button is never lost.
    this.cancelGesture();
    this.capture.hidden = m === "none";
    this.capture.classList.toggle("brush-mode", m === "brush");
    void this.capture.offsetWidth; // flush style so hit-testing sees the layer immediately
    this.picker.clear();
    this.brush.hideCursor();
    if (m !== "none") {
      this.setPanel(false);
      this.closeMenu();
      if (this.tipFor === this.refs.tools[m]) this.hideTip(true); // the hint takes this row
    }
    this.renderHint();
    if (this.lastPointer) {
      if (m === "pin") this.picker.move(this.lastPointer.x, this.lastPointer.y);
      else if (m === "brush") this.brush.hover(this.lastPointer.x, this.lastPointer.y);
    }
    this.renderDock();
  }

  private cancelGesture(): void {
    this.marquee.cancel();
    this.brush.cancel();
    this.pointerDownOnCapture = false;
    this.swallowUp = false;
    this.pinTarget = null;
  }

  /** Rebuild the hint for the current mode, then place / show / hide it. */
  private renderHint(): void {
    const m = this.mode;
    this.brushSlider = null;
    this.brushSizeLabel = null;
    if (m !== "none") {
      this.hint.textContent = "";
      this.hint.classList.toggle("interactive", m === "brush");
      const esc = () => h("span", { class: "kbd", text: "Esc" });
      const sep = () => h("span", { class: "sep", text: "·" });
      if (m === "pin") {
        this.hint.append("Click any element to pin a note", sep(), esc());
      } else if (m === "marquee") {
        this.hint.append("Drag over an area to mark it", sep(), esc());
      } else {
        const slider: HTMLInputElement = h("input", {
          class: "size-slider",
          attrs: {
            type: "range",
            min: String(BRUSH_MIN),
            max: String(BRUSH_MAX),
            step: String(BRUSH_STEP),
            "aria-label": "Brush size",
            title: "Brush size ([ / ])",
          },
          on: { input: (): void => this.setBrushSize(Number(slider.value)) },
        });
        slider.value = String(this.brush.size);
        const label = h("span", { class: "size-val", text: `${this.brush.size} px` });
        this.brushSlider = slider;
        this.brushSizeLabel = label;
        this.hint.append(
          "Paint over an area",
          slider,
          label,
          h("span", { class: "kbd", text: "[" }),
          h("span", { class: "kbd", text: "]" }),
          sep(),
          esc()
        );
      }
    }
    this.updateHint();
  }

  /** Show the hint beside the active tool's row while a mode is on (and no popover is open). */
  private updateHint(): void {
    const show = this.mode !== "none" && !this.pop && this.dock.isOpen;
    if (show) {
      const origin = this.placeHint();
      this.hintLayer.show(origin);
    } else if (this.hintLayer.isOpen) {
      const t = this.tabRect();
      this.hintLayer.hide({ x: t.left + 16, y: this.hintCenterY() });
    }
  }

  private hintCenterY(): number {
    const top = parseFloat(this.hint.style.top);
    return Number.isFinite(top) ? top + 16 : window.innerHeight / 2;
  }

  private placeHint(): Point | undefined {
    const m = this.mode;
    if (m === "none") return undefined;
    const t = this.tabRect();
    const cy = t.top + toolRowY(TOOLS.indexOf(m));
    this.hint.style.right = `${Math.round(viewW() - t.left + GAP)}px`;
    this.hint.style.top = `${Math.round(cy - 16)}px`;
    return { x: t.left + 16, y: cy };
  }

  private setBrushSize(n: number): void {
    const v = this.brush.setSize(n);
    if (this.brushSlider && this.brushSlider.value !== String(v)) this.brushSlider.value = String(v);
    if (this.brushSizeLabel) this.brushSizeLabel.textContent = `${v} px`;
  }

  private onCaptureMove(e: PointerEvent): void {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (this.mode === "marquee") {
      this.marquee.move(e.clientX, e.clientY);
      return;
    }
    if (this.mode === "brush") {
      const events = this.brush.active ? safe(() => e.getCoalescedEvents(), [] as PointerEvent[]) : [];
      if (events.length) for (const ce of events) this.brush.move(ce.clientX, ce.clientY);
      else this.brush.move(e.clientX, e.clientY);
      return;
    }
    if (this.mode === "pin" && !this.pop) this.queueLayout();
  }

  private onCaptureDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.pointerDownOnCapture = true;
    this.swallowUp = false;
    if (this.pop) {
      // First click outside an open popover just closes it.
      this.closePopover(true, false);
      this.swallowUp = true;
      return;
    }
    safe(() => this.capture.setPointerCapture(e.pointerId), undefined);
    // Pin what was under the pointer when it went down: the page may re-render before it comes up.
    if (this.mode === "pin") this.pinTarget = elementAt(e.clientX, e.clientY, this.host);
    else if (this.mode === "marquee") this.marquee.down(e.clientX, e.clientY);
    else if (this.mode === "brush") this.brush.down(e.clientX, e.clientY);
  }

  private onCaptureUp(e: PointerEvent): void {
    if (!this.pointerDownOnCapture) return;
    this.pointerDownOnCapture = false;
    safe(() => this.capture.releasePointerCapture(e.pointerId), undefined);
    if (this.swallowUp) {
      this.swallowUp = false;
      return;
    }
    const at: Point = { x: e.clientX, y: e.clientY }; // the note's ink drop lands where the gesture ended
    if (this.mode === "pin") {
      const down = this.pinTarget;
      this.pinTarget = null;
      const el = down && down.isConnected ? down : elementAt(e.clientX, e.clientY, this.host);
      if (el) this.createElementAnnotation(el, at);
    } else if (this.mode === "marquee") {
      const r = this.marquee.up(e.clientX, e.clientY);
      if (r) this.createRegionAnnotation(r, at);
    } else if (this.mode === "brush") {
      const s = this.brush.up(e.clientX, e.clientY);
      if (s) this.createBrushAnnotation(s, at);
    }
  }

  private nextN(): number {
    let max = 0;
    for (const a of this.annotations) if (typeof a.n === "number" && a.n > max) max = a.n;
    if (this.pending && this.pending.n > max) max = this.pending.n;
    return max + 1;
  }

  private newAnnotation(kind: "element" | "region"): Annotation {
    return {
      id: genId(),
      n: this.nextN(),
      kind,
      intent: "other",
      note: "",
      status: "draft",
      createdAt: new Date().toISOString(),
      page: pageInfo(),
    };
  }

  private createElementAnnotation(el: Element, at?: Point): void {
    const a = this.newAnnotation("element");
    a.target = captureElement(el);
    this.refining.set(a.id, refineSources([a.target]));
    this.picker.clear();
    this.pending = a;
    this.elCache.set(a.id, el);
    this.renderMarks();
    this.openPopover(a, true, at);
  }

  private createRegionAnnotation(r: ViewRect, at?: Point): void {
    this.openRegionNote(captureRegion(r, (el) => el === this.host, (x, y) => elementAt(x, y, this.host)), at);
  }

  private createBrushAnnotation(s: Stroke, at?: Point): void {
    this.openRegionNote(captureStroke(s, (el) => el === this.host, (x, y) => elementAt(x, y, this.host)), at);
  }

  private openRegionNote(region: NonNullable<Annotation["region"]>, at?: Point): void {
    const a = this.newAnnotation("region");
    a.region = region;
    this.refining.set(a.id, refineSources([...region.elements, region.container]));
    this.pending = a;
    this.renderMarks();
    this.openPopover(a, true, at);
  }

  private async awaitRefine(id: string): Promise<void> {
    const p = this.refining.get(id);
    if (!p) return;
    this.refining.delete(id);
    await Promise.race([p, new Promise<void>((r) => window.setTimeout(r, 1500))]);
  }

  // ------------------------------------------------------------------ keyboard / outside clicks

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing || this.destroyed) return;
    const inOverlay = this.focusInOverlay();
    // Pin mode: Enter pins the focused page element (the keyboard way to pick one).
    if (e.key === "Enter" && this.mode === "pin" && !this.pop && !inOverlay && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      const el = this.focusedPageElement();
      if (el) {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.pinFocused(el);
        return;
      }
    }
    // A note card is still pouring in: what the person types belongs to the note (even if a page field
    // still has focus), not to shortcuts or the page. Buffering ends when the drop has landed.
    const p = this.pop;
    if (p && p.typeahead !== undefined && !(inOverlay && isTypingEvent(e)) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (e.key.length === 1 || e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        p.typeahead = e.key === "Backspace" ? p.typeahead.slice(0, -1) : p.typeahead + e.key;
        return;
      }
    }
    if (isTypingEvent(e)) return; // text fields handle their own Esc / Cmd+Enter
    if (e.key === "Escape") {
      if (this.handleEscape(inOverlay)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && this.pop) {
      e.preventDefault();
      e.stopImmediatePropagation();
      void this.savePopover();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === "[" || e.key === "]") && this.mode === "brush") {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setBrushSize(this.brush.size + (e.key === "]" ? BRUSH_STEP : -BRUSH_STEP));
      if (this.lastPointer && !this.brush.active) this.brush.hover(this.lastPointer.x, this.lastPointer.y);
      return;
    }
    if (e.repeat || e.shiftKey) return;
    // Tool keys belong to the page unless the dock is out, and never while the page is being typed in
    // (also text fields inside the page's own shadow roots).
    if (!this.dock.isOpen || isEditable(deepActiveElement())) return;
    const k = (e.key || "").toLowerCase();
    const next: Mode | null = k === "p" ? "pin" : k === "m" ? "marquee" : k === "b" ? "brush" : null;
    if (next) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.setMode(next);
    }
  }

  /**
   * Esc unwinds one Sumi layer at a time: gesture → popover → menu / panel → mode. With none of them
   * up it belongs to the page, unless focus is in the overlay; it collapses the dock only when focus
   * is on the dock. True when Sumi consumed it.
   */
  private handleEscape(inOverlay: boolean): boolean {
    if (this.marquee.active || this.brush.active) {
      this.cancelGesture();
      return true;
    }
    if (this.pop) {
      this.closePopover(true);
      return true;
    }
    if (this.menuLayer.isOpen) {
      this.closeMenu(true);
      return true;
    }
    if (this.panelOpen) {
      this.setPanel(false);
      return true;
    }
    if (this.mode !== "none") {
      const tool = this.refs.tools[this.mode];
      const refocus = inOverlay;
      this.setMode("none");
      if (refocus) this.focusDockButton(tool);
      return true;
    }
    if (!inOverlay) return false;
    if (this.dock.isOpen && this.focusInDock()) this.collapse();
    return true;
  }

  /** The page element that has keyboard focus (through open shadow roots), or the hovered one. */
  private focusedPageElement(): Element | null {
    const top = safe(() => document.activeElement, null);
    if (top && top !== this.host && top !== document.body && top !== document.documentElement) {
      return deepActiveElement() || top;
    }
    return this.picker.current && this.picker.current.isConnected ? this.picker.current : null;
  }

  private pinFocused(el: Element): void {
    let r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      safe(() => el.scrollIntoView({ block: "nearest" }), undefined);
      r = el.getBoundingClientRect();
    }
    const at: Point = {
      x: clamp(r.left + Math.min(r.width / 2, 24), 12, viewW() - 12),
      y: clamp(r.top + Math.min(r.height / 2, 24), 12, window.innerHeight - 12),
    };
    this.createElementAnnotation(el, at);
  }

  private onWindowPointerDown(e: PointerEvent): void {
    const path = safe(() => e.composedPath(), [] as EventTarget[]);
    if (this.menuLayer.isOpen && !path.includes(this.menu) && !path.includes(this.refs.more)) this.closeMenu();
    if (!this.pop) return;
    if (path.includes(this.host)) return;
    this.closePopover(true, false); // the click moves focus where it lands
  }

  // ------------------------------------------------------------------ marks (pins + regions)

  /** Resolved notes linger this long on the page (green check, then fade), then only live in the list. */
  private static readonly RESOLVED_LINGER_MS = 2200;
  private static readonly RESOLVED_FADE_AT_MS = 1500;
  private resolvedSeen = new Map<string, number>();
  private lingerTimer: number | null = null;

  /** When a resolved note was first seen as resolved by this overlay (server time if plausible). */
  private resolvedSince(a: Annotation): number {
    let t = this.resolvedSeen.get(a.id);
    if (t === undefined) {
      const server = a.resolvedAt ? Date.parse(a.resolvedAt) : NaN;
      // Trust the server's time when present: notes resolved before this page loaded hide at once.
      t = Number.isFinite(server) ? server : Date.now();
      this.resolvedSeen.set(a.id, t);
    }
    return t;
  }

  private visibleAnnotations(): Annotation[] {
    const here = location.pathname;
    const now = Date.now();
    let soonest = Infinity;
    const list = this.annotations.filter((a) => {
      if (!a.page || a.page.path !== here || !(a.kind === "region" ? !!a.region : !!a.target)) return false;
      if (a.status !== "resolved") {
        this.resolvedSeen.delete(a.id);
        return true;
      }
      const left = this.resolvedSince(a) + SumiApp.RESOLVED_LINGER_MS - now;
      if (left <= 0) return false;
      soonest = Math.min(soonest, left);
      return true;
    });
    if (soonest !== Infinity && this.lingerTimer === null && !this.destroyed) {
      this.lingerTimer = window.setTimeout(guard(() => {
        this.lingerTimer = null;
        if (!this.destroyed) this.renderMarks();
      }), soonest + 20);
    }
    if (this.pending && !list.some((a) => a.id === this.pending!.id)) list.push(this.pending);
    return list;
  }

  private renderMarks(): void {
    const vis = this.visibleAnnotations();
    const keep = new Set(vis.map((a) => a.id));
    for (const [id, m] of this.markEls) {
      if (keep.has(id)) continue;
      m.pin.remove();
      m.region?.remove();
      this.markEls.delete(id);
      this.elCache.delete(id);
    }
    let created = false;
    for (const a of vis) {
      let m = this.markEls.get(a.id);
      if (!m) {
        m = this.createMark(a);
        this.markEls.set(a.id, m);
        created = true;
      }
      this.updateMark(m, a);
    }
    // A new mark is positioned in this same frame: otherwise it paints once at the viewport's
    // corner (e.g. a saved brush stroke replacing the live one on pointer-up) and then jumps.
    if (created) safe(() => this.layout(), undefined);
    this.queueLayout();
  }

  private createMark(a: Annotation): Mark {
    const num = h("span");
    const sub = h("span", { class: "sub", attrs: { hidden: "" } });
    const tip = h("span", { class: "tip" });
    const pin = h("button", { class: "pin", attrs: { type: "button" } }, [num, sub, tip]);
    const id = a.id;
    pin.addEventListener("click", guard((e: MouseEvent) => {
      e.preventDefault();
      if (this.pop && this.pop.id === id) {
        this.closePopover(true);
        return;
      }
      const ann = this.find(id);
      if (!ann) return;
      if (this.pop) this.closePopover(true);
      this.openPopover(ann, false);
    }));
    pin.addEventListener("pointerenter", () => {
      this.hoverId = id;
      this.queueLayout();
    });
    pin.addEventListener("pointerleave", () => {
      if (this.hoverId === id) this.hoverId = null;
      this.queueLayout();
    });
    let region: HTMLElement | SVGSVGElement | undefined;
    const stroke = a.kind === "region" ? strokeOf(a) : null;
    if (stroke && a.region) {
      // Saved brush stroke: an SVG sized to the stroke bounds, positioned like a marquee region.
      const rr = a.region.rect;
      const svg = svgEl("svg", {
        class: "stroke-region",
        width: String(Math.max(1, rr.width)),
        height: String(Math.max(1, rr.height)),
        "aria-hidden": "true",
      });
      const path = svgEl("path", { class: "stroke-path", d: strokePath(stroke.points, rr.x, rr.y), "stroke-width": String(stroke.size) });
      path.setAttribute("stroke", inkGradient(svg)); // drafts; other statuses recolour via CSS
      svg.appendChild(path);
      region = svg;
      this.marks.appendChild(region);
    } else if (a.kind === "region") {
      region = h("div", { class: "region" });
      this.marks.appendChild(region);
    }
    this.marks.appendChild(pin);
    return { pin, num, sub, tip, region, key: "", pos: "", regionPos: "", flags: "" };
  }

  private updateMark(m: Mark, a: Annotation): void {
    const isPending = !!this.pending && this.pending.id === a.id;
    const key = [a.n, a.status, a.intent, a.note, a.reply || "", isPending].join("\u0001");
    if (m.key === key) return;
    m.key = key;
    m.pin.setAttribute("data-s", a.status);
    m.region?.setAttribute("data-s", a.status);
    m.pin.classList.toggle("pending", isPending);
    m.num.textContent = String(a.n);
    const said = collapse(a.note);
    m.pin.setAttribute("aria-label", `Note ${a.n}, ${STATUS_LABEL[a.status] || a.status}: ${said ? truncate(said, 100) : "no text yet"}`);
    if (a.status === "needs-input") {
      m.sub.hidden = false;
      m.sub.textContent = "?";
    } else if (a.status === "resolved") {
      m.sub.hidden = false;
      m.sub.innerHTML = ICONS.check;
      // Show the check briefly, then fade the mark off the page; the list keeps it.
      const fadeIn = Math.max(0, this.resolvedSince(a) + SumiApp.RESOLVED_FADE_AT_MS - Date.now());
      this.later(() => {
        if (this.markEls.get(a.id) === m) {
          m.pin.classList.add("leaving");
          m.region?.classList.add("leaving");
        }
      }, fadeIn);
    } else {
      m.sub.hidden = true;
    }
    m.tip.textContent = "";
    if (a.intent && a.intent !== "other" && INTENT_LABEL[a.intent]) m.tip.append(h("b", { text: INTENT_LABEL[a.intent] }));
    m.tip.append(truncate(collapse(a.note) || "(no note)", 90));
    if (a.reply) m.tip.append(h("span", { class: "r", text: (a.status === "needs-input" ? "Claude asks: " : "Claude: ") + truncate(a.reply, 120) }));
  }

  private find(id: string): Annotation | undefined {
    if (this.pending && this.pending.id === id) return this.pending;
    return this.annotations.find((a) => a.id === id);
  }

  private resolveElement(a: Annotation): Element | null {
    const sel = a.target && a.target.selector;
    if (!sel) return null;
    const cached = this.elCache.get(a.id);
    if (cached && cached.isConnected && !this.requery) return cached;
    if (cached && cached.isConnected && safe(() => cached.matches(sel), false)) return cached;
    const el = safe(() => document.querySelector(sel), null);
    const ok = el && el !== this.host && !this.host.contains(el) ? el : null;
    this.elCache.set(a.id, ok);
    return ok;
  }

  queueLayout(): void {
    if (this.layoutQueued || this.destroyed) return;
    this.layoutQueued = true;
    this.layoutRaf = requestAnimationFrame(guard(() => {
      this.layoutRaf = 0;
      this.layoutQueued = false;
      if (!this.destroyed) this.layout();
    }));
  }

  /**
   * Place every badge, region and the focus outline. Two passes: all reads (element rects) first, then
   * all writes, so a page with many marks costs one layout per frame, not one per mark. Badges and
   * regions move with transforms (no layout); a write only happens when its value changed.
   */
  private layout(): void {
    const vw = viewW();
    const vh = window.innerHeight;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const stacked = new Map<Element, number>();
    const zone = this.dockZone(vw, vh);
    const PIN = 24;
    const CLEAR = 8; // badges grow ×1.12 on hover and carry a status dot at their corner
    const popId = this.pop ? this.pop.id : null;

    // ---- pass 1: reads only
    const plan: Array<{ m: Mark; a: Annotation; x: number; y: number; detached: boolean }> = [];
    for (const a of this.visibleAnnotations()) {
      const m = this.markEls.get(a.id);
      if (!m) continue;
      let x = 0;
      let y = 0;
      let detached = false;
      let onScreen = true;
      let stackK = 0; // position in a stack of badges on the same element
      if (a.kind === "element" && a.target) {
        const el = this.resolveElement(a);
        const r = el ? el.getBoundingClientRect() : null;
        if (el && r && (r.width > 0 || r.height > 0)) {
          const k = stacked.get(el) || 0;
          stacked.set(el, k + 1);
          stackK = k;
          x = r.right - 12 - k * 26;
          y = r.top - 12;
          onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
        } else {
          detached = true;
          const sr = a.target.rect;
          x = sr.x + sr.width - sx - 12;
          y = sr.y - sy - 12;
          onScreen = y > -24 && y < vh;
        }
      } else if (a.region) {
        const rr = a.region.rect;
        const left = rr.x - sx;
        const top = rr.y - sy;
        // Brush badges sit at the stroke's top-right bound; marquee badges at the top-left corner.
        x = strokeOf(a) ? left + rr.width - 12 : left - 12;
        y = top - 12;
        onScreen = top + rr.height > 0 && top < vh;
      }
      if (onScreen) {
        x = clamp(x, 4, vw - 28);
        y = clamp(y, 4, vh - 28);
        // Never under the dock: a click on the badge must not land on a dock button.
        if (x + PIN + CLEAR > zone.left && y + PIN + CLEAR > zone.top && y - CLEAR < zone.bottom) x = zone.left - PIN - CLEAR - stackK * 26;
      }
      plan.push({ m, a, x: Math.round(x), y: Math.round(y), detached });
    }
    // outline of the hovered / open annotation's element
    const focusId = popId || this.hoverId;
    const fa = focusId ? this.find(focusId) : undefined;
    const fel = fa && fa.kind === "element" && fa.page.path === location.pathname ? this.resolveElement(fa) : null;
    const fr = fa && fel ? fel.getBoundingClientRect() : null;

    // ---- pass 2: writes only
    for (const { m, a, x, y, detached } of plan) {
      if (a.kind === "region" && a.region && m.region) {
        const rr = a.region.rect;
        const rp = `${rr.x - sx}|${rr.y - sy}|${rr.width}|${rr.height}`;
        if (rp !== m.regionPos) {
          m.regionPos = rp;
          m.region.style.transform = `translate(${rr.x - sx}px, ${rr.y - sy}px)`;
          m.region.style.width = `${rr.width}px`;
          m.region.style.height = `${rr.height}px`;
        }
      }
      const pos = `${x}|${y}`;
      if (pos !== m.pos) {
        m.pos = pos;
        if (PIN_TRANSLATE) m.pin.style.setProperty("translate", `${x}px ${y}px`);
        else {
          m.pin.style.left = `${x}px`;
          m.pin.style.top = `${y}px`;
        }
      }
      const hot = this.hoverId === a.id || popId === a.id;
      const flags = [detached, x > vw - 280, popId === a.id, hot].join();
      if (flags === m.flags) continue;
      m.flags = flags;
      m.region?.classList.toggle("hot", hot);
      m.pin.classList.toggle("detached", detached);
      m.region?.classList.toggle("detached", detached);
      m.pin.classList.toggle("tip-left", x > vw - 280);
      m.pin.classList.toggle("active", popId === a.id);
      if (detached) m.pin.title = "This element is no longer on the page";
      else m.pin.removeAttribute("title");
    }
    this.requery = false;
    this.brush.sync();
    if (fa && fr) {
      this.tgt.hidden = false;
      this.tgt.setAttribute("data-s", fa.status);
      this.tgt.style.left = `${fr.left - 3}px`;
      this.tgt.style.top = `${fr.top - 3}px`;
      this.tgt.style.width = `${fr.width + 6}px`;
      this.tgt.style.height = `${fr.height + 6}px`;
    } else {
      this.tgt.hidden = true;
    }

    if (this.mode === "pin" && !this.pop && this.lastPointer) this.picker.move(this.lastPointer.x, this.lastPointer.y);
    if (this.pop) this.positionPopover();
  }

  // ------------------------------------------------------------------ popover

  private titleFor(a: Annotation): { title: string; sub: string } {
    if (a.kind === "region" && a.region) {
      const n = a.region.elements.length;
      return {
        title: `${a.region.tool === "brush" ? "Brushed area" : "Area"} · ${plural(n, "element")}`,
        sub: `${a.region.rect.width} × ${a.region.rect.height} px`,
      };
    }
    const t = a.target;
    if (!t) return { title: "Element", sub: "" };
    const tag = tagLabel(t.tag, t.classes || []);
    const comp = t.components && t.components[0];
    const text = t.name || t.text || "";
    return {
      title: comp ? `${comp} · ${tag}` : tag,
      sub: text ? `“${truncate(text, 60)}”` : t.landmark ? `in ${t.landmark}` : "",
    };
  }

  /** Open the note card. A new note pours out of `origin` (where its gesture ended) as a drop of ink;
   * a reopened one wells up from its badge as a smaller drop. `restore`: a draft kept across a reload. */
  private openPopover(a: Annotation, isNew: boolean, origin?: Point, restore?: Draft): void {
    const { title, sub } = this.titleFor(a);
    const statusEl = h("span", { class: "status", text: isNew ? "New" : STATUS_LABEL[a.status], attrs: { "data-s": a.status } });
    const close = h("button", { class: "icon-btn", title: "Close (Esc)", attrs: { type: "button", "aria-label": "Close" }, on: { click: () => this.closePopover(true) } });
    close.innerHTML = ICONS.x;

    const header = h("div", { class: "pop-h" }, [
      h("div", { class: "pop-t" }, [
        h("div", { class: "pop-title", text: title, title }),
        h("div", { class: "pop-meta" }, [statusEl, sub ? h("span", { class: "pop-sub", text: sub, title: sub }) : null]),
      ]),
      close,
    ]);

    const note = h("textarea", { attrs: { placeholder: "What should change?", rows: "5", "aria-label": "What should change?" } });
    note.value = a.note || "";
    note.addEventListener("keydown", guard((e: KeyboardEvent) => this.onFieldKey(e, "save")));
    note.addEventListener("input", guard(() => this.saveDraft()));

    const deleteBtn = h("button", { class: "btn btn-ghost btn-danger", attrs: { type: "button" }, on: { click: () => this.deleteFromPopover() } }, [
      h("span", { text: "Delete" }),
    ]);
    const save = h("button", { class: "btn btn-primary", text: "Save", attrs: { type: "button" }, on: { click: () => this.savePopover() } });
    const footer = h("div", { class: "pop-f" }, [
      deleteBtn,
      h("span", { class: "grow" }),
      h("span", { class: "hint", text: isMac ? "⌘↵ to save" : "Ctrl+↵ to save" }),
      save,
    ]);
    const stealHint = h("div", { class: "pop-steal", attrs: { role: "status", hidden: "" } });

    const replyBox = h("div");
    const el = h("div", { class: "pop ink", attrs: { role: "dialog", "aria-label": `Note ${a.n}`, hidden: "" } }, [header, replyBox, note, footer, stealHint]);
    this.dp.appendChild(el);
    const skin = createInkSkin(el);

    this.pop = {
      id: a.id,
      isNew,
      el,
      note,
      answer: null,
      startNote: note.value,
      replyKey: "",
      replyBox,
      statusEl,
      deleteBtn,
      deleteArmed: 0,
      skin,
      origin: isNew ? origin : undefined,
      typeTarget: note,
      stealHint,
    };
    this.renderReply(a);
    const pop = this.pop;
    if (restore) {
      note.value = restore.note;
      if (pop.answer && restore.answer) pop.answer.value = restore.answer;
    }
    this.renderMarks();
    this.updateHint();
    this.renderDock();
    // Lay out now (not next frame) so the card and the badge are in place before the drop lands.
    safe(() => this.layout(), undefined);
    const from = (isNew && origin) || this.popOrigin(a.id);
    // Focus the note once the card's content shows (not while it is still ink), unless the person has
    // put focus somewhere else in the meantime.
    const focusTarget = pop.answer || note;
    pop.typeTarget = focusTarget;
    const caret = restore ? clamp(restore.caret, 0, focusTarget.value.length) : -1;
    const shadowBefore = this.shadow.activeElement;
    const docBefore = document.activeElement;
    const movedAway = (): boolean => {
      const s = this.shadow.activeElement;
      if (s && s !== shadowBefore) return true;
      const d = document.activeElement;
      return !!d && d !== docBefore && d !== document.body && d !== this.host;
    };
    let focusDone = false;
    pop.typeahead = "";
    const focus = () => {
      if (focusDone || this.destroyed) return;
      const s = this.shadow.activeElement;
      if (this.pop !== pop || (s && el.contains(s)) || movedAway()) {
        focusDone = true;
        this.flushTypeahead(pop); // keep what was typed for the note; shortcuts work again
        return;
      }
      safe(() => focusTarget.focus({ preventScroll: true }), undefined);
      focusDone = this.shadow.activeElement === focusTarget;
      if (focusDone) {
        const typed = !!pop.typeahead;
        this.flushTypeahead(pop);
        const end = caret >= 0 && !typed ? caret : focusTarget.value.length;
        safe(() => focusTarget.setSelectionRange(end, end), undefined);
      }
    };
    void dropIn(el, from, { small: !isNew, onVisible: focus }).then(() => {
      focus();
      if (focusDone || this.pop !== pop) return;
      // The page took focus back (a focus trap): stop holding keys hostage and say why typing fails.
      focusDone = true;
      this.flushTypeahead(pop);
      pop.stealHint.textContent = "This page is holding keyboard focus, so typing goes to the page. Click the note, or close the page's dialog first.";
      pop.stealHint.hidden = false;
      this.positionPopover();
    });
    if (restore) this.saveDraft();
  }

  /** Move keys buffered while the card poured in into its text box, and stop buffering. */
  private flushTypeahead(p: Pop): void {
    const typed = p.typeahead;
    p.typeahead = undefined;
    if (!typed) return;
    const t = p.typeTarget;
    t.value += typed;
    const end = t.value.length;
    safe(() => t.setSelectionRange(end, end), undefined);
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ------------------------------------------------------------------ drafts across reloads

  private saveDraft(): void {
    const p = this.pop;
    if (!p || this.destroyed) return;
    this.syncUnloadGuard();
    const note = p.note.value;
    const answer = p.answer ? p.answer.value : "";
    const dirty = this.popEdited(p) || !!answer.trim();
    if (!dirty) {
      this.clearDraft();
      return;
    }
    const base = p.isNew && this.pending && this.pending.id === p.id ? this.pending : undefined;
    if (p.isNew && !base) return;
    const t = p.typeTarget;
    const d: Draft = {
      v: 1,
      path: location.pathname,
      id: p.id,
      isNew: p.isNew,
      annotation: base,
      note,
      caret: safe(() => t.selectionStart ?? t.value.length, t.value.length),
      answer: answer || undefined,
      at: Date.now(),
    };
    safe(() => window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)), undefined);
  }

  private clearDraft(): void {
    safe(() => window.sessionStorage.removeItem(DRAFT_KEY), undefined);
  }

  /** Reopen a note card that was being written when the tab reloaded (same page only). */
  private restoreDraft(offline = false): void {
    if (this.draftChecked || this.destroyed) return;
    let d: Draft | null = null;
    try {
      const raw = window.sessionStorage.getItem(DRAFT_KEY);
      d = raw ? (JSON.parse(raw) as Draft) : null;
    } catch {
      d = null;
    }
    if (!d || d.v !== 1 || typeof d.note !== "string" || !d.id || Date.now() - (d.at || 0) > DRAFT_MAX_AGE_MS || d.path !== location.pathname) {
      this.draftChecked = true;
      if (d) this.clearDraft();
      return;
    }
    if (this.pop) return; // the person already opened something: try again later
    const existing = this.annotations.find((x) => x.id === d!.id);
    if (existing) {
      this.draftChecked = true;
      this.openPopover(existing, false, undefined, d);
      return;
    }
    if (d.isNew && d.annotation && d.annotation.id === d.id) {
      this.draftChecked = true;
      const a: Annotation = { ...d.annotation, n: this.nextN() };
      this.pending = a;
      this.renderMarks();
      this.openPopover(a, true, undefined, d);
      return;
    }
    // An edit of a note we do not know (yet): wait for the server; gone after a successful load.
    if (!offline) {
      this.draftChecked = true;
      this.clearDraft();
    }
  }

  /** Centre of the note's badge on the page: where its card pours out of and retracts into. */
  private popOrigin(id: string): Point | undefined {
    const r = this.anchorRect(id);
    return r && (r.width || r.height) ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : undefined;
  }

  private onFieldKey(e: KeyboardEvent, action: "save" | "answer"): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      this.closePopover(true);
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (action === "answer") void this.sendAnswer();
      else void this.savePopover();
    }
  }

  private renderReply(a: Annotation): void {
    const p = this.pop;
    if (!p) return;
    const key = [a.status, a.reply || "", a.answer || ""].join("\u0001");
    if (key === p.replyKey) return;
    p.replyKey = key;
    const keepAnswer = p.answer ? p.answer.value : "";
    p.replyBox.textContent = "";
    p.answer = null;
    if (a.status === "needs-input" && a.reply) {
      const answer = h("textarea", { attrs: { placeholder: "Your answer…", rows: "2", "aria-label": "Your answer" } });
      answer.value = keepAnswer;
      answer.addEventListener("keydown", guard((e: KeyboardEvent) => this.onFieldKey(e, "answer")));
      answer.addEventListener("input", guard(() => this.saveDraft()));
      const btn = h("button", { class: "btn btn-primary", attrs: { type: "button" }, on: { click: () => this.sendAnswer() } }, [
        mirrored(sumiSvg("send")),
        h("span", { text: "Send answer" }),
      ]);
      p.replyBox.appendChild(
        h("div", { class: "reply", attrs: { "data-s": "needs-input" } }, [
          h("span", { class: "reply-label", text: "Claude asks" }),
          a.reply,
          answer,
          h("div", { class: "answer-row" }, [btn]),
        ])
      );
      p.answer = answer;
      if (p.typeTarget !== p.note) p.typeTarget = answer;
    } else if (a.reply || a.answer) {
      const box = h("div", { class: "reply", attrs: { "data-s": a.status === "resolved" ? "resolved" : a.status } });
      if (a.reply) box.append(h("span", { class: "reply-label", text: a.status === "resolved" ? "Done" : "Claude" }), a.reply);
      if (a.answer) box.append(h("span", { class: "you", text: `You answered: ${a.answer}` }));
      p.replyBox.appendChild(box);
    }
  }

  /** Keep an open popover in sync with fresh server state without clobbering what the person is typing. */
  private syncPopover(): void {
    const p = this.pop;
    if (!p || p.isNew) return;
    const a = this.annotations.find((x) => x.id === p.id);
    if (!a) {
      this.dismissPopover();
      return;
    }
    p.statusEl.setAttribute("data-s", a.status);
    p.statusEl.textContent = STATUS_LABEL[a.status];
    this.renderReply(a);
    this.positionPopover();
  }

  /**
   * The badge's box for placing the card. Badges scale (pop-in from .4, ×1.12 while active), so
   * use the transform-invariant centre plus the untransformed layout size: the card is placed
   * once and never shifts when the badge's animation finishes.
   */
  private anchorRect(id: string): DOMRect | null {
    const m = this.markEls.get(id);
    if (!m) return null;
    const b = m.pin.getBoundingClientRect();
    const w = m.pin.offsetWidth || b.width;
    const ht = m.pin.offsetHeight || b.height;
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    return new DOMRect(cx - w / 2, cy - ht / 2, w, ht);
  }

  private positionPopover(): void {
    const p = this.pop;
    if (!p) return;
    const a = this.anchorRect(p.id);
    const vw = viewW();
    const vh = window.innerHeight;
    const box = p.el.hidden ? measure(p.el) : null; // first placement happens before the reveal
    const w = (box ? box.width : p.el.offsetWidth) || 320;
    const ht = (box ? box.height : p.el.offsetHeight) || 220;
    const M = 12;
    // Keep clear of the dock on the right edge (open tab, or the closed drop).
    const rightLimit = vw - (this.dock.isOpen ? TAB_W : DROP + 10) - M;
    const bottomLimit = vh - M;
    let x: number;
    let y: number;
    if (!a) {
      x = (vw - w) / 2;
      y = (vh - ht) / 2;
    } else {
      const options: Array<[number, number]> = [
        [a.right + 10, a.top - 6], // right
        [a.left - 10 - w, a.top - 6], // left
        [a.left + a.width / 2 - w / 2, a.bottom + 10], // below
        [a.left + a.width / 2 - w / 2, a.top - 10 - ht], // above
      ];
      const fits = ([ox, oy]: [number, number]) => ox >= M && oy >= M && ox + w <= rightLimit && oy + ht <= bottomLimit;
      const nudged = options.map(([ox, oy], i): [number, number] =>
        i < 2 ? [ox, clamp(oy, M, Math.max(M, bottomLimit - ht))] : [clamp(ox, M, Math.max(M, rightLimit - w)), oy]
      );
      const pick = nudged.find(fits) || nudged[0];
      x = pick[0];
      y = pick[1];
    }
    x = clamp(x, M, Math.max(M, rightLimit - w));
    y = clamp(y, M, Math.max(M, vh - ht - M));
    p.el.style.left = `${Math.round(x)}px`;
    p.el.style.top = `${Math.round(y)}px`;
  }

  /** Close the card without saving. `returnFocus`: focus was in the card; put it on the badge (or the dock). */
  private dismissPopover(returnFocus = true): void {
    const p = this.pop;
    if (!p) return;
    // The ink collapses into the note's badge; a discarded draft's badge goes away with it, so that
    // one drains back to where its drop landed.
    const badge = this.popOrigin(p.id); // before a discarded pending pin goes away
    const discarding = p.isNew && !!this.pending && this.pending.id === p.id;
    const target = discarding ? p.origin || badge : badge || p.origin;
    const hadFocus = !!this.shadow.activeElement && p.el.contains(this.shadow.activeElement);
    this.pop = null;
    p.typeahead = undefined;
    this.clearDraft();
    if (p.deleteArmed) this.cancel(p.deleteArmed);
    p.el.setAttribute("inert", "");
    const el = p.el;
    void dropOut(el, target).then(() => {
      p.skin.destroy();
      el.remove();
    });
    if (p.isNew && this.pending && this.pending.id === p.id) {
      this.pending = null;
      this.refining.delete(p.id);
    }
    this.updateHint();
    this.renderDock();
    this.renderMarks();
    this.queueLayout();
    this.syncUnloadGuard();
    if (returnFocus && hadFocus) {
      const m = this.markEls.get(p.id);
      if (m && m.pin.isConnected) safe(() => m.pin.focus({ preventScroll: true }), undefined);
      else this.focusDockButton();
    }
  }

  /** The card holds something worth keeping: text in a new note, or a changed note (`typed`: keys still buffered count). */
  private popEdited(p: Pop, typed = false): boolean {
    const note = p.note.value + (typed ? p.typeahead || "" : "");
    return p.isNew ? note.trim() !== "" : note !== p.startNote;
  }

  /** Close the popover; when `commit`, keep meaningful edits (see popEdited). Resolves once a save is queued. */
  private closePopover(commit: boolean, returnFocus = true): Promise<void> {
    const p = this.pop;
    if (!p) return Promise.resolve();
    this.flushTypeahead(p);
    if (commit && this.popEdited(p)) return this.savePopover(returnFocus);
    this.dismissPopover(returnFocus);
    return Promise.resolve();
  }

  private async savePopover(returnFocus = true): Promise<void> {
    const p = this.pop;
    if (!p) return;
    this.flushTypeahead(p);
    const note = p.note.value.replace(/\s+$/, "");
    if (p.isNew) {
      const base = this.pending && this.pending.id === p.id ? this.pending : null;
      if (!base) return this.dismissPopover(returnFocus);
      const a: Annotation = { ...base, note };
      this.pending = null;
      // The new note is in the queue before its pending pin goes: the badge never blinks.
      const saved = this.enqueue(
        (list) => [...list.filter((x) => x.id !== a.id), a],
        async () => {
          await this.awaitRefine(a.id); // source-map refinement (bounded), then save
          return api.upsert(a);
        },
        "Couldn't save the note."
      );
      this.dismissPopover(returnFocus);
      await saved;
      return;
    }
    const a = this.annotations.find((x) => x.id === p.id);
    this.dismissPopover(returnFocus);
    if (!a) return;
    if (note === a.note) return;
    const patch: Partial<Annotation> = { note };
    if (a.status === "resolved") patch.status = "draft"; // edited after it was done: it needs another pass
    const id = a.id;
    await this.enqueue((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)), () => api.patch(id, patch), "Couldn't save the change.");
  }

  private async sendAnswer(): Promise<void> {
    const p = this.pop;
    if (!p || !p.answer) return;
    this.flushTypeahead(p);
    const answer = p.answer.value.trim();
    if (!answer) {
      p.answer.focus();
      return;
    }
    const a = this.annotations.find((x) => x.id === p.id);
    if (!a) return;
    const note = p.note.value.replace(/\s+$/, "");
    const patch: Partial<Annotation> = { answer, status: "sent", sentAt: new Date().toISOString() };
    if (note !== a.note) patch.note = note;
    const id = a.id;
    this.dismissPopover();
    const ok = await this.enqueue(
      (list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)),
      async () => {
        const r = await api.patch(id, patch);
        await api.send([id]).catch(warn); // wake any waiting agent
        return r;
      },
      "Couldn't send the answer."
    );
    if (ok) this.toast("Answer sent to Claude");
  }

  private async deleteFromPopover(): Promise<void> {
    const p = this.pop;
    if (!p) return;
    if (p.isNew) {
      this.dismissPopover();
      return;
    }
    if (!p.deleteArmed) {
      p.deleteBtn.classList.add("confirm");
      const label = p.deleteBtn.querySelector("span");
      if (label) label.textContent = "Delete note?";
      p.deleteArmed = this.later(() => {
        if (this.pop !== p) return;
        p.deleteArmed = 0;
        p.deleteBtn.classList.remove("confirm");
        if (label) label.textContent = "Delete";
      }, 2500);
      return;
    }
    this.cancel(p.deleteArmed);
    p.deleteArmed = 0;
    const id = p.id;
    this.dismissPopover();
    // 404: already gone on the server, which is what we wanted.
    await this.enqueue((list) => list.filter((x) => x.id !== id), () => api.remove(id), "Couldn't delete the note.", [404]);
  }

  // ------------------------------------------------------------------ notes panel

  private setPanel(open: boolean): void {
    if (open && this.mode !== "none") this.setMode("none");
    if (open === this.panelOpen) {
      if (open) this.renderPanel();
      return;
    }
    this.panelOpen = open;
    this.dp.classList.toggle("panel-open", open);
    const origin = { x: this.tabRect().left, y: window.innerHeight / 2 };
    if (open) {
      this.hideTip(true);
      this.closeMenu();
      this.renderPanel();
      this.panelLayer.show(origin);
      // Keyboard focus moves into the panel (first note, else its close button).
      const focusIn = () => {
        if (!this.panelOpen || this.destroyed) return;
        const first = this.panel.querySelector<HTMLElement>(".item") || this.panel.querySelector<HTMLElement>(".icon-btn");
        if (first) safe(() => first.focus({ preventScroll: true }), undefined);
      };
      focusIn();
      if (!this.panel.contains(this.shadow.activeElement)) requestAnimationFrame(guard(focusIn));
    } else {
      const hadFocus = !!this.shadow.activeElement && this.panel.contains(this.shadow.activeElement);
      this.panelLayer.hide(origin);
      if (hadFocus) this.focusDockButton(this.refs.more);
    }
    this.renderMenu();
  }

  private renderPanel(): void {
    if (!this.panelOpen) return;
    const p = this.panel;
    const scrollTop = safe(() => (p.querySelector(".panel-list") as HTMLElement | null)?.scrollTop || 0, 0);
    // Keep keyboard focus on the same control across a rebuild (polls re-render the list).
    const focusables = () => Array.from(p.querySelectorAll<HTMLElement>("button"));
    const focusIdx = focusables().indexOf(this.shadow.activeElement as HTMLElement);
    p.textContent = "";

    const close = h("button", { class: "icon-btn", title: "Close (Esc)", attrs: { type: "button", "aria-label": "Close notes" }, on: { click: () => this.setPanel(false) } });
    close.innerHTML = ICONS.x;
    const total = this.annotations.length;
    p.appendChild(
      h("div", { class: "panel-h" }, [h("div", { class: "ttl" }, ["Notes", h("span", { text: String(total) })]), close])
    );

    const list = h("div", { class: "panel-list" });
    const sorted = [...this.annotations].sort((a, b) => (a.n || 0) - (b.n || 0));
    if (!sorted.length) {
      list.appendChild(
        h("div", { class: "panel-empty" }, [
          "No notes yet. Press ",
          h("span", { class: "kbd", text: "P" }),
          " to pin an element, ",
          h("span", { class: "kbd", text: "M" }),
          " to mark an area or ",
          h("span", { class: "kbd", text: "B" }),
          " to paint over one.",
        ])
      );
    }
    for (const a of sorted) {
      const noteText = collapse(a.note);
      const kind = a.kind === "region" ? (a.region?.tool === "brush" ? "brush" : "marquee") : "pin";
      const kindIcon = h("span", {
        class: "kind",
        title: kind === "brush" ? "Brushed area" : kind === "marquee" ? "Marquee area" : "Element",
      }, [sumiIcon(kind)]);
      const body = h("div", { class: "item-b" }, [
        h("div", { class: "item-meta" }, [
          kindIcon,
          a.intent && a.intent !== "other" ? h("span", { class: "intent", text: INTENT_LABEL[a.intent] || a.intent }) : null,
          h("span", { class: "status", text: STATUS_LABEL[a.status] || a.status, attrs: { "data-s": a.status } }),
          h("span", { class: "path", text: (a.page && a.page.path) || "/", title: (a.page && a.page.url) || "" }),
        ]),
        h("div", { class: "item-note" + (noteText ? "" : " empty"), text: noteText || "(no note)" }),
        a.reply
          ? h("div", { class: "item-reply", attrs: { "data-s": a.status } }, [
              h("b", { text: a.status === "needs-input" ? "Claude asks: " : a.status === "resolved" ? "Done: " : "Claude: " }),
              a.reply,
            ])
          : null,
      ]);
      const item = h(
        "button",
        { class: "item", attrs: { type: "button" }, on: { click: () => this.focusAnnotation(a.id) } },
        [h("span", { class: "badge", text: String(a.n), attrs: { "data-s": a.status } }), body]
      );
      list.appendChild(item);
    }
    p.appendChild(list);
    list.scrollTop = scrollTop;

    const copy = h("button", { class: "btn btn-soft", attrs: { type: "button" }, on: { click: () => this.copyForClaude() } });
    copy.innerHTML = ICONS.copy;
    copy.append(h("span", { text: "Copy for Claude" }));
    copy.disabled = !this.annotations.some((a) => a.status === "draft" || a.status === "sent");
    const resolvedCount = this.annotations.filter((a) => a.status === "resolved").length;
    const clear = h("button", { class: "btn btn-ghost", attrs: { type: "button" }, on: { click: () => this.clearResolved() } });
    clear.innerHTML = ICONS.sweep;
    clear.append(h("span", { text: resolvedCount ? `Clear resolved (${resolvedCount})` : "Clear resolved" }));
    clear.disabled = resolvedCount === 0;
    p.appendChild(h("div", { class: "panel-f" }, [copy, h("span", { class: "grow" }), clear]));
    if (focusIdx >= 0) {
      const all = focusables();
      const again = all[Math.min(focusIdx, all.length - 1)];
      if (again) safe(() => again.focus({ preventScroll: true }), undefined);
    }
  }
  private focusAnnotation(id: string): void {
    const a = this.find(id);
    if (!a) return;
    if (a.page && a.page.path !== location.pathname) {
      let dest = a.page.path;
      try {
        const u = new URL(a.page.url);
        if (u.origin === location.origin) dest = u.pathname + u.search + u.hash;
      } catch {
        /* keep path */
      }
      this.toast(`Opening ${a.page.path}…`);
      location.assign(dest);
      return;
    }
    this.setPanel(false);
    if (a.kind === "element") {
      const el = this.resolveElement(a);
      if (el) safe(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), undefined);
      else if (a.target) window.scrollTo({ top: Math.max(0, a.target.rect.y - window.innerHeight / 3), behavior: "smooth" });
    } else if (a.region) {
      window.scrollTo({ top: Math.max(0, a.region.rect.y - window.innerHeight / 3), behavior: "smooth" });
    }
    if (this.pop) this.closePopover(true);
    this.openPopover(a, false);
  }

  // ------------------------------------------------------------------ actions

  private async sendDrafts(): Promise<void> {
    await this.closePopover(true);
    if (this.destroyed) return;
    if (!this.connected) {
      this.toast("Not connected to Sumi", true);
      return;
    }
    const ids = this.annotations.filter((a) => a.status === "draft").map((a) => a.id);
    if (!ids.length) {
      this.toast(this.annotations.length ? "Everything is already sent" : "Add a note first: press P to pin an element");
      return;
    }
    const now = new Date().toISOString();
    const r = await this.enqueue(
      (list) => list.map((a) => (ids.includes(a.id) && a.status === "draft" ? { ...a, status: "sent" as AnnotationStatus, sentAt: now } : a)),
      () => api.send(ids),
      "Couldn't send."
    );
    if (r) {
      const n = typeof r.sent === "number" ? r.sent : ids.length;
      safe(() => this.dock.splash(), undefined);
      this.toast(`Sent ${plural(n, "note")} to Claude`);
    }
  }

  /** Copy the notes as Markdown for pasting into Claude by hand. Notes stay drafts: nothing is "sent"
   * (no agent is waiting on them, so nothing would ever end the working state). */
  private async copyForClaude(): Promise<void> {
    await this.closePopover(true);
    if (this.destroyed) return;
    const count = this.annotations.filter((a) => a.status === "draft" || a.status === "sent").length;
    let md = "";
    try {
      md = await api.markdown("draft,sent", "clipboard");
    } catch (e) {
      warn(e);
      this.toast("Couldn't build the summary. Is Sumi still running?", true);
      return;
    }
    if (!md.trim()) {
      this.toast("Nothing to copy yet");
      return;
    }
    const ok = await copyText(md, this.shadow);
    if (!ok) {
      this.toast("Couldn't access the clipboard", true);
      return;
    }
    this.toast(`Copied ${plural(count, "note")}. Paste into Claude`);
  }

  private async clearResolved(): Promise<void> {
    const n = this.annotations.filter((a) => a.status === "resolved").length;
    if (!n) return;
    if (this.pop && this.annotations.some((a) => a.id === this.pop!.id && a.status === "resolved")) this.dismissPopover();
    const r = await this.enqueue((list) => list.filter((a) => a.status !== "resolved"), () => api.clearResolved(), "Couldn't clear.");
    if (r) this.toast(`Cleared ${plural(typeof r.deleted === "number" ? r.deleted : n, "resolved note")}`);
  }

  // ------------------------------------------------------------------ toasts

  /** A black ink pill that pours out to the left of the dock, near its bottom. Errors are alerts. */
  toast(message: string, error = false): void {
    if (this.destroyed) return;
    const t = h("div", { class: "toast ink" + (error ? " err" : ""), attrs: { role: error ? "alert" : "status", hidden: "" } });
    t.innerHTML = error ? ICONS.x : ICONS.check;
    t.append(h("span", { text: message }));
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    const edge = (r: DOMRect): Point => ({ x: r.right + GAP, y: r.top + r.height / 2 });
    void reveal(t, edge(measure(t)));
    this.later(() => {
      if (!t.isConnected) return;
      void retract(t, edge(t.getBoundingClientRect())).then(() => t.remove());
    }, error ? 5200 : 2600);
  }

  // ------------------------------------------------------------------ render

  private renderAll(): void {
    this.renderGlow();
    this.renderDock();
    this.renderMarks();
    this.renderPanel();
    this.renderMenu();
    this.syncPopover();
  }

  /**
   * Claude is working on this page: a note here is sent, and an agent is listening for feedback or the
   * note was sent less than two minutes ago. Then the glow wraps the viewport and the dock shows its
   * loading drop. Re-evaluated on every poll, every second and on navigation, so it never sticks.
   */
  private isWorking(): boolean {
    const here = location.pathname;
    const now = Date.now();
    return this.annotations.some((a) => {
      if (a.status !== "sent" || (a.page && a.page.path !== here)) return false;
      if (this.agentListening) return true;
      const t = a.sentAt ? Date.parse(a.sentAt) : NaN;
      return Number.isFinite(t) && now - t < WORKING_FRESH_MS;
    });
  }

  private renderGlow(): void {
    if (this.destroyed) return;
    const on = this.isWorking();
    if (on === this.glowOn) return;
    this.glowOn = on;
    if (this.glow) this.glow.setActive(on);
    safe(() => this.dock.setLoading(on), undefined);
  }
}

function mirrored(el: SVGSVGElement): SVGSVGElement {
  el.setAttribute("class", "mirror");
  return el;
}

/** The stroke of a brushed region, when it has a usable one. */
function strokeOf(a: Annotation): Stroke | null {
  const r = a.region;
  const s = r && r.tool === "brush" ? r.stroke : undefined;
  return s && Array.isArray(s.points) && s.points.length && s.size > 0 ? s : null;
}

async function copyText(text: string, shadow: ShadowRoot): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
    shadow.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

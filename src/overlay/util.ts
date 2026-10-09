/** Small DOM + safety helpers shared by the overlay modules. */

export type Child = Node | string | null | undefined | false;

export interface HProps {
  class?: string;
  text?: string;
  /** Static, trusted markup only (icons). Never pass user or page text here. */
  html?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Record<string, (e: any) => unknown>;
}

/** Log a non-fatal problem (never throws). `where` names the part that failed, e.g. "ink frame". */
export function warn(e: unknown, where?: string): void {
  try {
    if (where) console.warn(`[sumi] ${where}:`, e);
    else console.warn("[sumi]", e);
  } catch {
    /* ignore */
  }
}

/** Set inline style declarations (`important`: with !important, for elements the page may restyle). */
export function css(el: { style: CSSStyleDeclaration }, decls: Record<string, string>, important = false): void {
  for (const k in decls) el.style.setProperty(k, decls[k], important ? "important" : "");
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG element with attributes, optionally appended to `parent`. */
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
  parent?: Element,
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(n);
  return n;
}

/** Wrap a handler so it can never throw (sync or async) into the page. */
export function guard<A extends unknown[]>(fn: (...a: A) => unknown): (...a: A) => void {
  return (...a: A) => {
    try {
      const r = fn(...a) as any;
      if (r && typeof r.then === "function") (r as Promise<unknown>).catch(warn);
    } catch (e) {
      warn(e);
    }
  };
}

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: HProps | null = null,
  children: Child[] = []
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class) el.className = props.class;
    if (props.text != null) el.textContent = props.text;
    if (props.html != null) el.innerHTML = props.html;
    if (props.title) el.title = props.title;
    if (props.attrs) for (const k of Object.keys(props.attrs)) el.setAttribute(k, props.attrs[k]);
    if (props.on) for (const k of Object.keys(props.on)) el.addEventListener(k, guard(props.on[k]));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function collapse(s: string | null | undefined): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + "…" : s;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "a_" + 6 base36 chars. */
export function genId(): string {
  let s = "";
  try {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    for (let i = 0; i < a.length; i++) s += (a[i] % 36).toString(36);
  } catch {
    while (s.length < 6) s += Math.floor(Math.random() * 36).toString(36);
  }
  return "a_" + s;
}

const NON_TEXT_INPUTS = ["button", "submit", "reset", "checkbox", "radio", "range", "color", "file", "image", "hidden"];

export function isEditable(t: unknown): boolean {
  const el = t as any;
  if (!el || el.nodeType !== 1) return false;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !NON_TEXT_INPUTS.includes(String(el.type || "text").toLowerCase());
  return !!el.isContentEditable;
}

/** True when the keyboard event originates from a text field anywhere (page or overlay, incl. shadow DOM). */
export function isTypingEvent(e: Event): boolean {
  const path = safe(() => e.composedPath(), [] as EventTarget[]);
  return isEditable(path[0] || e.target);
}

export const isMac = safe(() => /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent), false);

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Width of the page area (excludes a classic scrollbar, which position:fixed right:0 also excludes). */
export function viewW(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

const ROVE_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * Roving focus for a vertical list (dock, menu): arrows move (wrapping), Home / End jump. With focus
 * outside the list the keys are ignored, unless `enter` (then they focus the first item).
 */
export function roveFocus(e: KeyboardEvent, list: HTMLElement[], active: Element | null, enter = false): void {
  if (!ROVE_KEYS.includes(e.key) || !list.length) return;
  const i = list.indexOf(active as HTMLElement);
  if (i < 0 && !enter) return;
  e.preventDefault();
  const n = list.length;
  const j = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
  list[j].focus();
}

/** The focused element, looking through open shadow roots. */
export function deepActiveElement(): Element | null {
  let a: Element | null = safe(() => document.activeElement, null);
  for (let i = 0; a && i < 32; i++) {
    const inner: Element | null = a.shadowRoot ? a.shadowRoot.activeElement : null;
    if (!inner) break;
    a = inner;
  }
  return a;
}

/**
 * Style a shadow root with a constructable stylesheet: unlike a <style> element it is not subject to
 * the page's CSP (a <meta> `style-src 'self'` would strip it). Falls back to <style> where
 * adoptedStyleSheets is unavailable. Returns an undo.
 */
export function adoptCss(root: ShadowRoot, css: string): () => void {
  try {
    const R = root as ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] };
    if (Array.isArray(R.adoptedStyleSheets) && typeof CSSStyleSheet === "function" && typeof (CSSStyleSheet.prototype as any).replaceSync === "function") {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      R.adoptedStyleSheets = [...R.adoptedStyleSheets, sheet];
      return () => {
        try {
          R.adoptedStyleSheets = (R.adoptedStyleSheets || []).filter((s) => s !== sheet);
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    /* fall back to <style> */
  }
  const style = document.createElement("style");
  style.textContent = css;
  root.insertBefore(style, root.firstChild);
  return () => style.remove();
}

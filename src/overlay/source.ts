/**
 * Framework detection: component chain + source location for a DOM element.
 * Order: React fiber -> Vue 3 / Vue 2 -> Svelte -> build-plugin data attributes.
 * In static mode the server stamps every element with data-sumi-src="file:line:col";
 * that stamp (on the element or its nearest ancestor) wins for `source`.
 * Every detector is defensive and returns partial data rather than throwing.
 */

export interface SourceInfo {
  framework: "react" | "vue" | "svelte" | "html" | "unknown";
  components: string[];
  source?: string;
  /** Raw stack frame behind `source` (React 19), used to refine the line via source maps. */
  frame?: RawFrame;
}

export interface RawFrame {
  url: string;
  line: number;
  col: number;
}

const MAX_COMPONENTS = 6;

/** Framework wrappers that add noise to the component chain. */
const NOISE = new Set([
  "StrictMode", "Suspense", "Fragment", "Profiler", "ErrorBoundary", "Router", "AppRouter", "HotReload",
  "ServerRoot", "Root", "InnerLayoutRouter", "OuterLayoutRouter", "RedirectBoundary", "RedirectErrorBoundary",
  "NotFoundBoundary", "NotFoundErrorBoundary", "LoadingBoundary", "ScrollAndFocusHandler", "InnerScrollAndFocusHandler",
  "RenderFromTemplateContext", "HTTPAccessFallbackBoundary", "HTTPAccessFallbackErrorBoundary", "DevRootHTTPAccessFallbackBoundary",
  "AppDevOverlay", "AppDevOverlayErrorBoundary", "ReactDevOverlay", "PathnameContextProviderAdapter", "Head", "RouterContext",
  "BaseTransition", "Transition", "TransitionGroup", "KeepAlive", "Teleport", "RouterView", "RouterLink", "AppContainer",
]);

function pushName(list: string[], name: unknown): void {
  if (typeof name !== "string") return;
  const n = name.trim();
  if (!/^[A-Z][A-Za-z0-9_$.]*$/.test(n) || NOISE.has(n) || list.includes(n)) return;
  if (list.length < MAX_COMPONENTS) list.push(n);
}

function basename(file: string): string {
  const b = file.split(/[\\/]/).pop() || file;
  return b.replace(/\.[^.]+$/, "");
}

// ---------------------------------------------------------------- stack parsing

const SKIP_FRAME = [
  "node_modules",
  "react-dom",
  "react_jsx",
  "jsx-dev-runtime",
  "jsx-runtime",
  "/@react-refresh",
  "/@vite/",
  "react-stack-top-frame",
  "react_stack_bottom_frame",
  "__sumi",
  "sumi/overlay",
  "/next/dist/",
  "<anonymous>",
  "native code",
];

/** Turn a stack URL into a project-relative path: strip origin, query, bundler prefixes. */
export function cleanSourceUrl(raw: string): string {
  let u = raw.trim();
  let absolute = false;
  u = u.replace(/^webpack-internal:\/\/\/(\([^)]*\)\/)?/, "");
  u = u.replace(/^webpack:\/\/[^/]*\//, "");
  u = u.replace(/^rsc:\/\/[^/]*\/[^/]*\//, "");
  if (/^file:\/\//.test(u)) {
    u = u.replace(/^file:\/\//, "");
    absolute = true;
  }
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  u = u.replace(/[?#].*$/, "");
  if (/^\/@fs\//.test(u)) {
    u = u.replace(/^\/@fs/, "");
    absolute = true;
  }
  if (!absolute) u = u.replace(/^\.?\//, "");
  try {
    u = decodeURIComponent(u);
  } catch {
    /* keep */
  }
  return u;
}

/** First user-land frame in an Error stack (Chrome / Firefox / Safari formats). */
export function frameFromStack(stack: string): { source: string; frame: RawFrame } | undefined {
  for (const rawLine of stack.split("\n")) {
    const line = rawLine.trim();
    if (!line || SKIP_FRAME.some((s) => line.includes(s))) continue;
    let url = "";
    let ln = "";
    let col = "";
    const chrome = /^at (?:.*? \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (chrome) {
      [, url, ln, col] = chrome;
    } else {
      const at = line.indexOf("@");
      const rest = at >= 0 ? line.slice(at + 1) : line;
      const m = /^(.+?):(\d+):(\d+)$/.exec(rest);
      if (!m) continue;
      [, url, ln, col] = m;
    }
    const path = cleanSourceUrl(url);
    if (!path || /^(async|eval)$/.test(path)) continue;
    return { source: `${path}:${ln}:${col}`, frame: { url, line: Number(ln), col: Number(col) } };
  }
  return undefined;
}

export function sourceFromStack(stack: string): string | undefined {
  const f = frameFromStack(stack);
  return f ? f.source : undefined;
}

// ---------------------------------------------------------------- React

function reactFiberOf(el: Element): any {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 60; i++, cur = cur.parentElement) {
    let keys: string[] = [];
    try {
      keys = Object.keys(cur);
    } catch {
      return null;
    }
    for (const k of keys) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return (cur as any)[k];
    }
  }
  return null;
}

function fiberName(f: any): string | undefined {
  const t = f && f.type;
  if (!t || typeof t === "string") return undefined;
  if (typeof t === "function") return t.displayName || t.name;
  if (typeof t === "object") {
    if (typeof t.displayName === "string") return t.displayName;
    if (t.render) return t.render.displayName || t.render.name; // forwardRef
    if (t.type) return typeof t.type === "function" ? t.type.displayName || t.type.name : t.type.displayName; // memo
  }
  return undefined;
}

function fiberSource(f: any): { source: string; frame?: RawFrame } | undefined {
  const ds = f._debugSource;
  if (ds && ds.fileName) {
    return { source: `${cleanSourceUrl(String(ds.fileName))}:${ds.lineNumber ?? 0}${ds.columnNumber != null ? ":" + ds.columnNumber : ""}` };
  }
  const st = f._debugStack;
  if (st) {
    const text = typeof st === "string" ? st : typeof st.stack === "string" ? st.stack : "";
    if (text) return frameFromStack(text);
  }
  return undefined;
}

function detectReact(el: Element): SourceInfo | null {
  const fiber = reactFiberOf(el);
  if (!fiber) return null;
  const info: SourceInfo = { framework: "react", components: [] };
  let f = fiber;
  for (let i = 0; f && i < 400; i++, f = f.return) {
    try {
      if (!info.source && i < 40) {
        const found = fiberSource(f);
        if (found) {
          info.source = found.source;
          info.frame = found.frame;
        }
      }
    } catch {
      /* ignore */
    }
    try {
      pushName(info.components, fiberName(f));
    } catch {
      /* ignore */
    }
    if (info.components.length >= MAX_COMPONENTS && info.source) break;
  }
  return info;
}

// ---------------------------------------------------------------- Vue

function detectVue(el: Element): SourceInfo | null {
  let cur: Element | null = el;
  let inst: any = null;
  let vue2: any = null;
  for (let i = 0; cur && i < 60 && !inst && !vue2; i++, cur = cur.parentElement) {
    inst = (cur as any).__vueParentComponent || null;
    vue2 = (cur as any).__vue__ || null;
  }
  if (!inst && !vue2) return null;
  const info: SourceInfo = { framework: "vue", components: [] };
  if (inst) {
    for (let i = inst; i && info.components.length < MAX_COMPONENTS; i = i.parent) {
      const t = i.type || {};
      const file = typeof t.__file === "string" ? t.__file : "";
      if (!info.source && file) info.source = cleanSourceUrl(file);
      pushName(info.components, t.name || t.__name || (file ? basename(file) : undefined));
    }
  } else {
    for (let vm = vue2; vm && info.components.length < MAX_COMPONENTS; vm = vm.$parent) {
      const o = vm.$options || {};
      const file = typeof o.__file === "string" ? o.__file : "";
      if (!info.source && file) info.source = cleanSourceUrl(file);
      pushName(info.components, o.name || o._componentTag || (file ? basename(file) : undefined));
    }
  }
  return info;
}

// ---------------------------------------------------------------- Svelte

function detectSvelte(el: Element): SourceInfo | null {
  let cur: Element | null = el;
  const info: SourceInfo = { framework: "svelte", components: [] };
  let found = false;
  for (let i = 0; cur && i < 80; i++, cur = cur.parentElement) {
    const meta = (cur as any).__svelte_meta;
    const loc = meta && meta.loc;
    if (!loc || !loc.file) continue;
    found = true;
    const file = String(loc.file);
    if (!info.source) info.source = `${cleanSourceUrl(file)}${loc.line != null ? ":" + loc.line : ""}${loc.column != null ? ":" + loc.column : ""}`;
    pushName(info.components, basename(file));
  }
  return found ? info : null;
}

// ---------------------------------------------------------------- build-plugin attributes

const SOURCE_ATTRS = ["data-insp-path", "data-v-inspector", "data-source-loc", "data-inspector-relative-path"];

function sourceFromAttrs(el: Element): string | undefined {
  let cur: Element | null = el;
  for (let i = 0; cur && i < 40; i++, cur = cur.parentElement) {
    for (const name of SOURCE_ATTRS) {
      const v = cur.getAttribute(name);
      if (!v) continue;
      const m = /^(.*?):(\d+)(?::(\d+))?/.exec(v);
      if (m) return `${cleanSourceUrl(m[1])}:${m[2]}${m[3] ? ":" + m[3] : ""}`;
      return cleanSourceUrl(v);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- static mode stamps

/** Set by Sumi's static file server on every element start tag: "<path>:<line>:<col>". */
export const STAMP_ATTR = "data-sumi-src";

/** The element's own stamp, else its nearest stamped ancestor's (elements built by scripts have none). */
function stampFor(el: Element): string | undefined {
  const own = el.getAttribute(STAMP_ATTR);
  if (own) return own;
  const anc = el.parentElement ? el.parentElement.closest(`[${STAMP_ATTR}]`) : null;
  return (anc && anc.getAttribute(STAMP_ATTR)) || undefined;
}

// ---------------------------------------------------------------- public

export function detectSource(el: Element): SourceInfo {
  let info: SourceInfo | null = null;
  for (const detector of [detectReact, detectVue, detectSvelte]) {
    try {
      info = detector(el);
    } catch {
      info = null;
    }
    if (info) break;
  }
  const out: SourceInfo = info || { framework: "unknown", components: [] };
  let stamp: string | undefined;
  try {
    stamp = stampFor(el);
  } catch {
    stamp = undefined;
  }
  if (stamp) {
    // Static mode: the served file itself is the source. Keep any component chain found above.
    out.framework = "html";
    out.source = stamp;
    delete out.frame;
    return out;
  }
  if (!out.source) {
    try {
      out.source = sourceFromAttrs(el);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Cheap nearest component name, used for the hover label. */
export function nearestComponent(el: Element): string | undefined {
  try {
    const fiber = reactFiberOf(el);
    if (fiber) {
      const names: string[] = [];
      for (let f = fiber, i = 0; f && i < 200 && !names.length; i++, f = f.return) pushName(names, fiberName(f));
      return names[0];
    }
  } catch {
    /* ignore */
  }
  try {
    const v = detectVue(el) || detectSvelte(el);
    return v ? v.components[0] : undefined;
  } catch {
    return undefined;
  }
}

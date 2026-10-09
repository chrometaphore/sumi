/**
 * Builds the context Claude gets for a note: ElementContext (one element), RegionContext (a marquee or
 * brush area: the elements inside it plus their container) and PageInfo. Capture stays cheap on big
 * pages: region candidates are found by walking the tree and skipping whole subtrees that lie outside
 * the area, selectors are verified without rescanning the document per level, and text is read from
 * at most a few hundred characters of a large subtree.
 */
import type { ElementContext, PageInfo, Rect, RegionContext, Stroke } from "../shared/types";
import { strokeBounds } from "./brush";
import { buildSelector, semanticClasses } from "./selector";
import { detectSource, STAMP_ATTR } from "./source";
import { rawFrames } from "./sourcemap";
import { collapse, truncate } from "./util";

const STYLE_KEYS = [
  "color",
  "background-color",
  "font-size",
  "font-family",
  "font-weight",
  "line-height",
  "padding",
  "margin",
  "border-radius",
  "display",
  "text-align",
];

const ATTR_KEYS = ["href", "src", "alt", "type", "placeholder", "name", "aria-label", "title", "data-testid", "role"];

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const OPAQUE = new Set(["svg", "script", "style", "noscript", "template", "canvas", "iframe", "video", "audio", "math"]);

function attempt(fn: () => void): void {
  try {
    fn();
  } catch {
    /* partial data is fine */
  }
}

export function pageInfo(): PageInfo {
  return {
    url: location.href,
    path: location.pathname,
    title: document.title || "",
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

export function pageRect(r: { left: number; top: number; width: number; height: number }): Rect {
  return {
    x: Math.round(r.left + window.scrollX),
    y: Math.round(r.top + window.scrollY),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

// ---------------------------------------------------------------- roles & names

function implicitRole(el: Element): string | undefined {
  const tag = el.localName;
  switch (tag) {
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
      return "heading";
    case "a": case "area":
      return el.hasAttribute("href") ? "link" : undefined;
    case "button": case "summary":
      return "button";
    case "img":
      return el.getAttribute("alt") === "" ? "presentation" : "img";
    case "svg":
      return "img";
    case "nav": return "navigation";
    case "main": return "main";
    case "aside": return "complementary";
    case "form": return "form";
    case "article": return "article";
    case "dialog": return "dialog";
    case "ul": case "ol": case "menu": return "list";
    case "li": return "listitem";
    case "table": return "table";
    case "tr": return "row";
    case "td": return "cell";
    case "th": return "columnheader";
    case "hr": return "separator";
    case "textarea": return "textbox";
    case "select": return el.hasAttribute("multiple") ? "listbox" : "combobox";
    case "option": return "option";
    case "progress": return "progressbar";
    case "figure": return "figure";
    case "p": return "paragraph";
    case "section":
      return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : undefined;
    case "header":
      return el.closest("article, aside, main, nav, section") ? undefined : "banner";
    case "footer":
      return el.closest("article, aside, main, nav, section") ? undefined : "contentinfo";
    case "input": {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "range") return "slider";
      if (t === "search") return "searchbox";
      if (t === "number") return "spinbutton";
      if (t === "hidden") return undefined;
      return "textbox";
    }
  }
  return undefined;
}

function idsText(ids: string): string {
  return ids
    .split(/\s+/)
    .map((id) => collapse(document.getElementById(id)?.textContent))
    .filter(Boolean)
    .join(" ");
}

/** Subtrees up to this many elements read their text with innerText; larger ones with cappedText. */
const SMALL_SUBTREE = 300;
/** Collapsed characters a capped read collects (callers keep at most 200). */
const TEXT_CAP = 240;
const NO_TEXT = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link"]);

function smallSubtree(el: Element): boolean {
  const w = document.createTreeWalker(el, 1 /* NodeFilter.SHOW_ELEMENT */);
  for (let n = 0; n <= SMALL_SUBTREE; n++) if (!w.nextNode()) return true;
  return false;
}

function transformText(t: string, how: string): string {
  if (how === "uppercase") return t.toUpperCase();
  if (how === "lowercase") return t.toLowerCase();
  if (how === "capitalize") return t.replace(/(^|\s)(\S)/g, (_, a: string, b: string) => a + b.toUpperCase());
  return t;
}

/**
 * The start of an element's rendered text, like innerText (hidden subtrees skipped, block boundaries
 * as spaces, text-transform applied), but it stops after `cap` characters instead of walking the whole
 * subtree.
 */
function cappedText(root: Element, cap: number): string {
  let out = "";
  let len = 0;
  let check = cap * 2;
  const visit = (el: Element): boolean => {
    let cs: CSSStyleDeclaration | null = null;
    try {
      cs = getComputedStyle(el);
    } catch {
      cs = null;
    }
    if (cs && cs.display === "none") return true;
    const block = !!cs && !cs.display.startsWith("inline") && cs.display !== "contents";
    if (block || el.localName === "br") out += " ";
    const shown = !cs || (cs.visibility !== "hidden" && cs.visibility !== "collapse");
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        if (!shown) continue;
        const t = n.nodeValue || "";
        out += cs ? transformText(t, cs.textTransform) : t;
        len += t.length;
        if (len > check) {
          if (collapse(out).length > cap) return false;
          check = len * 1.5;
        }
      } else if (n.nodeType === 1 && !NO_TEXT.has((n as Element).localName)) {
        if (!visit(n as Element)) return false;
      }
    }
    if (block) out += " ";
    return true;
  };
  visit(root);
  return collapse(out);
}

/** Rendered text of an element (collapsed). Large subtrees: only their first few hundred characters. */
function visibleText(el: Element): string {
  const anyEl = el as HTMLElement;
  if (typeof anyEl.innerText !== "string") return collapse(el.textContent);
  return smallSubtree(el) ? collapse(anyEl.innerText) : cappedText(el, TEXT_CAP);
}

function accessibleName(el: Element, role: string | undefined): string | undefined {
  const label = el.getAttribute("aria-label");
  if (label && label.trim()) return truncate(collapse(label), 120);
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = idsText(by);
    if (t) return truncate(t, 120);
  }
  if (el.localName === "img" || (el.localName === "input" && el.getAttribute("type") === "image")) {
    const alt = el.getAttribute("alt");
    if (alt != null && alt.trim()) return truncate(collapse(alt), 120);
  }
  if (["input", "textarea", "select"].includes(el.localName)) {
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = collapse(labels[0].textContent);
      if (t) return truncate(t, 120);
    }
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return truncate(collapse(ph), 120);
    if (el.localName === "input" && ["button", "submit", "reset"].includes((el.getAttribute("type") || "").toLowerCase())) {
      const v = (el as HTMLInputElement).value;
      if (v) return truncate(collapse(v), 120);
    }
  }
  if (role && ["heading", "button", "link", "option", "cell", "columnheader", "listitem", "tab", "menuitem", "checkbox", "radio"].includes(role)) {
    const t = visibleText(el);
    if (t) return truncate(t, 120);
  }
  if (el.localName === "svg") {
    const title = el.querySelector("title");
    if (title && collapse(title.textContent)) return truncate(collapse(title.textContent), 120);
  }
  const title = el.getAttribute("title");
  if (title && title.trim()) return truncate(collapse(title), 120);
  return undefined;
}

// ---------------------------------------------------------------- html

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function openTag(el: Element): string {
  let s = "<" + el.localName;
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name;
    if (/^data-v-[0-9a-f]+$/i.test(name) || name.startsWith("__")) continue; // Vue scoped-style hashes
    if (name === STAMP_ATTR) continue; // Sumi's own static-mode stamp: already in `source`
    let value = attr.value;
    if (name === "class") value = value.split(/\s+/).filter(Boolean).join(" ");
    value = /^data:/i.test(value) ? truncate(value, 40) : truncate(value, 100);
    s += value === "" ? ` ${name}` : ` ${name}="${escAttr(value)}"`;
  }
  return s + ">";
}

function serialize(node: Node, depth: number, maxDepth: number): string {
  if (node.nodeType === 3) {
    const raw = (node.nodeValue || "").replace(/\s+/g, " ");
    if (!raw.trim()) return "";
    const lead = raw.startsWith(" ") ? " " : "";
    const trail = raw.endsWith(" ") && raw.length > 1 ? " " : "";
    return lead + escText(truncate(raw.trim(), 120)) + trail;
  }
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.localName;
  const open = openTag(el);
  if (VOID.has(tag)) return open;
  const close = `</${tag}>`;
  // (the overlay's own host can sit inside a modal <dialog> while one is open: never part of the page)
  const kids = Array.from(el.childNodes).filter((n) => (n.nodeType === 1 && (n as Element).localName !== "sumi-root") || (n.nodeType === 3 && collapse(n.nodeValue)));
  if (!kids.length) return open + close;
  if (OPAQUE.has(tag)) return open + "…" + close;
  if (depth >= maxDepth) {
    if (kids.length === 1 && kids[0].nodeType === 3) {
      const t = collapse(kids[0].nodeValue);
      if (t.length <= 60) return open + escText(t) + close;
    }
    return open + "…" + close;
  }
  const MAX_KIDS = 8;
  let inner = kids
    .slice(0, MAX_KIDS)
    .map((k) => serialize(k, depth + 1, maxDepth))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  if (kids.length > MAX_KIDS) inner += "…";
  return open + inner + close;
}

export function compactHtml(el: Element, budget = 600): string {
  let last = "";
  for (const maxDepth of [4, 3, 2, 1, 0]) {
    last = serialize(el, 0, maxDepth);
    if (last.length <= budget) return last;
  }
  return truncate(last, budget);
}

// ---------------------------------------------------------------- styles

function toHex(color: string): string {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(color);
  if (!m) return color;
  const alpha = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  if (alpha < 1) return color.replace(/\s+/g, " ");
  const hex = [m[1], m[2], m[3]].map((v) => Math.round(parseFloat(v)).toString(16).padStart(2, "0")).join("");
  return "#" + hex;
}

function boxShorthand(cs: CSSStyleDeclaration, prop: "padding" | "margin"): string {
  const t = cs.getPropertyValue(`${prop}-top`);
  const r = cs.getPropertyValue(`${prop}-right`);
  const b = cs.getPropertyValue(`${prop}-bottom`);
  const l = cs.getPropertyValue(`${prop}-left`);
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}

function radiusShorthand(cs: CSSStyleDeclaration): string {
  const v = [
    cs.getPropertyValue("border-top-left-radius"),
    cs.getPropertyValue("border-top-right-radius"),
    cs.getPropertyValue("border-bottom-right-radius"),
    cs.getPropertyValue("border-bottom-left-radius"),
  ];
  return v.every((x) => x === v[0]) ? v[0] : v.join(" ");
}

function styleSubset(el: Element): Record<string, string> {
  const cs = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const key of STYLE_KEYS) {
    attempt(() => {
      let v: string;
      if (key === "padding" || key === "margin") v = boxShorthand(cs, key);
      else if (key === "border-radius") v = radiusShorthand(cs);
      else v = cs.getPropertyValue(key);
      if (key === "color" || key === "background-color") v = toHex(v.trim());
      if (key === "font-family") v = truncate(collapse(v), 80);
      if (v) out[key] = v.trim();
    });
  }
  return out;
}

function attributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ATTR_KEYS) {
    const v = el.getAttribute(k);
    if (v == null) continue;
    out[k] = /^data:/i.test(v) ? truncate(v, 60) : truncate(v, 200);
  }
  return out;
}

// ---------------------------------------------------------------- landmark

const LANDMARK_TAGS = new Set(["nav", "main", "header", "footer", "aside", "section", "article", "form", "dialog"]);
const LANDMARK_ROLES = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "region", "article", "form", "dialog", "search"]);

function describeLandmark(el: Element): string {
  const tag = el.localName;
  let name = collapse(el.getAttribute("aria-label"));
  if (!name) {
    const by = el.getAttribute("aria-labelledby");
    if (by) name = idsText(by);
  }
  if (!name && tag !== "nav" && tag !== "form") {
    const heading = el.querySelector("h1, h2, h3, h4, h5, h6, [role=heading]");
    if (heading) name = collapse(heading.textContent);
  }
  if (name) return `${tag} "${truncate(name, 40)}"`;
  const id = el.getAttribute("id");
  if (id) return `${tag}#${id}`;
  const cls = semanticClasses(el, 1)[0];
  return cls ? `${tag}.${cls}` : tag;
}

/** Landmark descriptions, shared by the captures of one region (they often sit in the same landmark). */
let landmarkMemo: Map<Element, string> | null = null;

function landmarkOf(el: Element): string | undefined {
  let cur: Element | null = el.parentElement;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    const role = cur.getAttribute("role");
    if (LANDMARK_TAGS.has(cur.localName) || (role && LANDMARK_ROLES.has(role))) {
      let d = landmarkMemo?.get(cur);
      if (d === undefined) {
        d = describeLandmark(cur);
        landmarkMemo?.set(cur, d);
      }
      return d;
    }
    cur = cur.parentElement;
  }
  return undefined;
}

// ---------------------------------------------------------------- public

export function captureElement(el: Element): ElementContext {
  const tag = el.localName || el.tagName.toLowerCase();
  const ctx: ElementContext = {
    selector: tag,
    tag,
    classes: [],
    html: "",
    rect: { x: 0, y: 0, width: 0, height: 0 },
    styles: {},
    attributes: {},
    framework: "unknown",
  };
  attempt(() => {
    ctx.selector = buildSelector(el);
  });
  attempt(() => {
    const id = el.getAttribute("id");
    if (id) ctx.id = id;
  });
  attempt(() => {
    ctx.classes = semanticClasses(el);
  });
  attempt(() => {
    const explicit = collapse(el.getAttribute("role"));
    const role = explicit || implicitRole(el);
    if (role) ctx.role = role;
    const name = accessibleName(el, role);
    if (name) ctx.name = name;
  });
  attempt(() => {
    if (el === document.documentElement || el === document.body) {
      const t = document.body ? visibleText(document.body) : "";
      if (t) ctx.text = truncate(t, 200);
    } else {
      const t = visibleText(el);
      if (t) ctx.text = truncate(t, 200);
    }
  });
  attempt(() => {
    ctx.html = compactHtml(el);
  });
  attempt(() => {
    ctx.rect = pageRect(el.getBoundingClientRect());
  });
  attempt(() => {
    ctx.styles = styleSubset(el);
  });
  attempt(() => {
    ctx.attributes = attributes(el);
  });
  attempt(() => {
    const lm = landmarkOf(el);
    if (lm) ctx.landmark = lm;
  });
  attempt(() => {
    const src = detectSource(el);
    ctx.framework = src.framework;
    if (src.components.length) ctx.components = src.components;
    if (src.source) ctx.source = src.source;
    if (src.frame) rawFrames.set(ctx, src.frame);
  });
  return ctx;
}

// ---------------------------------------------------------------- regions

const MEDIA = new Set(["img", "svg", "video", "canvas", "iframe", "audio", "object", "embed"]);
const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "slider", "textbox", "combobox", "option", "searchbox"]);
const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "br", "wbr", "source", "track", "option"]);

function hasOwnText(el: Element): boolean {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
  }
  return false;
}

function isMeaningful(el: Element): boolean {
  const tag = el.localName;
  if (MEDIA.has(tag) || INTERACTIVE_TAGS.has(tag)) return true;
  if (tag === "a" && el.hasAttribute("href")) return true;
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return hasOwnText(el);
}

function isVisible(el: Element): boolean {
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.visibility !== "collapse" && parseFloat(cs.opacity || "1") > 0.02;
}

function commonAncestor(els: Element[]): Element | null {
  if (!els.length) return null;
  let anc: Element | null = els[0].parentElement;
  while (anc && !els.every((e) => anc!.contains(e))) anc = anc.parentElement;
  return anc;
}

interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const outside = (r: { left: number; top: number; right: number; bottom: number }, a: Area): boolean =>
  r.right < a.left || r.left > a.right || r.bottom < a.top || r.top > a.bottom;

/**
 * Visible, meaningful page elements (outer <svg> only) whose viewport rect passes `test`, in document
 * order. `test` only passes rects that touch `area` (viewport px): an element outside it whose whole
 * subtree (the union of its descendants' boxes, from a Range) is outside it too is skipped with that
 * subtree, so a small area on a huge page measures a few hundred elements, not all of them.
 */
function collectCandidates(isOverlay: (el: Element) => boolean, area: Area, test: (r: DOMRect) => boolean): Element[] {
  const candidates: Element[] = [];
  const body = document.body;
  if (!body) return candidates;
  const range = document.createRange();
  let el: Element | null = body.firstElementChild;
  while (el) {
    const r = el.getBoundingClientRect();
    let descend = el.firstElementChild !== null;
    if (outside(r, area)) {
      if (descend) {
        range.selectNodeContents(el);
        if (outside(range.getBoundingClientRect(), area)) descend = false;
      }
    } else if (
      !SKIP.has(el.localName) &&
      !isOverlay(el) &&
      !(el as SVGElement).ownerSVGElement &&
      isMeaningful(el) &&
      r.width >= 1 &&
      r.height >= 1 &&
      test(r) &&
      isVisible(el)
    ) {
      candidates.push(el);
    }
    // next in document order
    if (descend) {
      el = el.firstElementChild;
      continue;
    }
    while (el && el !== body && !el.nextElementSibling) el = el.parentElement;
    el = el && el !== body ? el.nextElementSibling : null;
  }
  range.detach();
  return candidates;
}

/** Drop ancestors of other candidates, cap 12, capture them plus the container. */
function finishRegion(region: RegionContext, candidates: Element[], fallback: () => Element | null): RegionContext {
  landmarkMemo = new Map();
  try {
    return finishRegionWith(region, candidates, fallback);
  } finally {
    landmarkMemo = null;
  }
}

function finishRegionWith(region: RegionContext, candidates: Element[], fallback: () => Element | null): RegionContext {
  const kept: Element[] = [];
  attempt(() => {
    for (const a of candidates) {
      if (!candidates.some((b) => b !== a && a.contains(b))) kept.push(a);
      if (kept.length >= 12) break;
    }
  });
  for (const el of kept) {
    attempt(() => {
      region.elements.push(captureElement(el));
    });
  }
  attempt(() => {
    if (kept.length > 1) {
      const anc = commonAncestor(kept);
      if (anc) region.container = captureElement(anc);
    } else if (kept.length === 0) {
      const el = fallback();
      if (el) region.container = captureElement(el);
    }
  });
  return region;
}

/** `view` is in viewport coordinates (as drawn by the marquee). */
export function captureRegion(
  view: { left: number; top: number; width: number; height: number },
  isOverlay: (el: Element) => boolean,
  fallbackAt: (x: number, y: number) => Element | null
): RegionContext {
  const region: RegionContext = { rect: pageRect(view), tool: "marquee", elements: [] };
  const right = view.left + view.width;
  const bottom = view.top + view.height;
  let candidates: Element[] = [];
  attempt(() => {
    candidates = collectCandidates(isOverlay, { left: view.left, top: view.top, right, bottom }, (r) => {
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return cx >= view.left && cx <= right && cy >= view.top && cy <= bottom;
    });
  });
  return finishRegion(region, candidates, () => fallbackAt(view.left + view.width / 2, view.top + view.height / 2));
}

/** Coverage grid cell size in CSS px (the stroke is rasterised at 1/4 scale). */
const CELL = 4;
/** Keep the offscreen mask bounded for very large strokes. */
const MAX_CELLS = 2_000_000;

interface Mask {
  ox: number;
  oy: number;
  cell: number;
  w: number;
  h: number;
  /** Summed-area table of covered cells, (w + 1) × (h + 1). */
  sat: Int32Array;
}

function rasterise(stroke: Stroke, bounds: Rect): Mask | null {
  let cell = CELL;
  while (Math.ceil(bounds.width / cell) * Math.ceil(bounds.height / cell) > MAX_CELLS) cell *= 2;
  const w = Math.max(1, Math.ceil(bounds.width / cell));
  const h = Math.max(1, Math.ceil(bounds.height / cell));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
  if (!ctx) return null;
  const k = 1 / cell;
  const pts = stroke.points;
  ctx.fillStyle = ctx.strokeStyle = "#000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.size * k;
  ctx.beginPath();
  ctx.moveTo((pts[0].x - bounds.x) * k, (pts[0].y - bounds.y) * k);
  if (pts.length === 1) {
    ctx.arc((pts[0].x - bounds.x) * k, (pts[0].y - bounds.y) * k, (stroke.size / 2) * k, 0, Math.PI * 2);
    ctx.fill();
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo((pts[i].x - bounds.x) * k, (pts[i].y - bounds.y) * k);
    ctx.stroke();
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[(y * w + x) * 4 + 3] >= 128 ? 1 : 0;
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  return { ox: bounds.x, oy: bounds.y, cell, w, h, sat };
}

/** Covered cells in the half-open cell range [x0, x1) × [y0, y1), clipped to the mask. */
function coveredCells(m: Mask, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(m.w, x1);
  y1 = Math.min(m.h, y1);
  if (x1 <= x0 || y1 <= y0) return 0;
  const W = m.w + 1;
  return m.sat[y1 * W + x1] - m.sat[y0 * W + x1] - m.sat[y1 * W + x0] + m.sat[y0 * W + x0];
}

/** First cell index whose centre is at or after page coordinate `v` along an axis. */
function cellFrom(v: number, origin: number, cell: number): number {
  return Math.ceil((v - origin) / cell - 0.5);
}

/** Is the page point under the painted mask? */
function underMask(m: Mask, x: number, y: number): boolean {
  const cx = Math.floor((x - m.ox) / m.cell);
  const cy = Math.floor((y - m.oy) / m.cell);
  return coveredCells(m, cx, cy, cx + 1, cy + 1) > 0;
}

/** Share (0..1) of the page rect's area under the mask, sampled at cell centres. NaN when the rect is smaller than a cell. */
function maskCoverage(m: Mask, left: number, top: number, right: number, bottom: number): number {
  const x0 = cellFrom(left, m.ox, m.cell);
  const x1 = cellFrom(right, m.ox, m.cell);
  const y0 = cellFrom(top, m.oy, m.cell);
  const y1 = cellFrom(bottom, m.oy, m.cell);
  const total = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (!total) return NaN;
  return coveredCells(m, x0, y0, x1, y1) / total;
}

/**
 * Brush region: `stroke` is in page coordinates. Elements count when their centre is under the
 * painted mask or at least half of their area is covered by it.
 */
export function captureStroke(
  stroke: Stroke,
  isOverlay: (el: Element) => boolean,
  fallbackAt: (x: number, y: number) => Element | null
): RegionContext {
  const bounds = strokeBounds(stroke);
  const region: RegionContext = { rect: bounds, tool: "brush", stroke, elements: [] };
  let candidates: Element[] = [];
  attempt(() => {
    const mask = rasterise(stroke, bounds);
    if (!mask) return;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const bx1 = bounds.x + bounds.width;
    const by1 = bounds.y + bounds.height;
    const area = { left: bounds.x - sx, top: bounds.y - sy, right: bx1 - sx, bottom: by1 - sy };
    candidates = collectCandidates(isOverlay, area, (r) => {
      const left = r.left + sx;
      const top = r.top + sy;
      const right = r.right + sx;
      const bottom = r.bottom + sy;
      if (right <= bounds.x || left >= bx1 || bottom <= bounds.y || top >= by1) return false;
      if (underMask(mask, (left + right) / 2, (top + bottom) / 2)) return true;
      const cov = maskCoverage(mask, left, top, right, bottom);
      return cov >= 0.5;
    });
  });
  const first = stroke.points[0];
  return finishRegion(region, candidates, () =>
    first ? fallbackAt(first.x - window.scrollX, first.y - window.scrollY) : null
  );
}

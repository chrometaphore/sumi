/**
 * Icons. `ICONS`: inline SVG glyphs for secondary UI (menu, panel, toasts), 24px grid, stroke =
 * currentColor; static, trusted markup. `sumiSvg`: the dock and tool icons, the Figma assets in
 * ./assets/sumi, rendered unmodified as inline SVG (state colours come from CSS filters).
 */
import { SUMI_ICONS } from "./assets/sumi";

const svg = (body: string, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${body}</svg>`;

export const ICONS = {
  list: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r=".6" fill="currentColor"/><circle cx="4.5" cy="12" r=".6" fill="currentColor"/><circle cx="4.5" cy="18" r=".6" fill="currentColor"/>'),
  check: svg('<path d="M20 6.5 9.5 17 4 11.5"/>', ' stroke-width="3"'),
  x: svg('<path d="M17 7 7 17M7 7l10 10"/>'),
  copy: svg('<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>'),
  sweep: svg('<path d="M4 12.5 9 17.5 20 6.5"/><path d="M4 6.5h6M4 19.5h3"/>'),
  keyboard: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M8 14h8"/>'),
  chevron: svg('<path d="m9 6 6 6-6 6"/>'),
};

export type SumiIconName = keyof typeof SUMI_ICONS;

const SVG_NS = "http://www.w3.org/2000/svg";
/** Everything the bundled assets use. Anything else (foreignObject, script, …) is dropped. */
const ALLOWED = new Set([
  "svg", "g", "path", "circle", "rect", "defs", "filter",
  "feFlood", "feColorMatrix", "feOffset", "feGaussianBlur", "feComposite", "feBlend",
]);
const DROPPED_ATTRS = /^(style|overflow|href|xlink:href|on.*)$/i;
const URL_REF = /url\(#([^)]+)\)/g;

interface Template {
  root: SVGSVGElement;
  /** ids that the asset references (filters): renamed per copy so copies never resolve each other's */
  ids: string[];
}

const templates = new Map<SumiIconName, Template | null>();
let idSeq = 0;

/**
 * Parse one of the known, bundled asset strings (never page or user input) into an inert template:
 * only allowed SVG elements, no style / event / link attributes, ids only where something refers to them.
 */
function parse(markup: string): Template | null {
  try {
    // inline style attributes go before parsing: the parsed document shares the page's CSP, which may
    // refuse them (style-src-attr) and report a violation
    const doc = new DOMParser().parseFromString(markup.replace(/\sstyle="[^"]*"/g, ""), "image/svg+xml");
    const root = doc.documentElement;
    if (!root || root.localName !== "svg" || root.namespaceURI !== SVG_NS || doc.getElementsByTagName("parsererror").length) return null;
    const refs = new Set<string>();
    for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
      if (!ALLOWED.has(el.localName) || el.namespaceURI !== SVG_NS) {
        el.remove();
        continue;
      }
      for (const a of Array.from(el.attributes)) {
        if (DROPPED_ATTRS.test(a.name)) el.removeAttribute(a.name);
        else for (const m of a.value.matchAll(URL_REF)) refs.add(m[1]);
      }
    }
    for (const el of Array.from(root.querySelectorAll("[id]"))) if (!refs.has(el.id)) el.removeAttribute("id");
    const node = document.importNode(root, true) as unknown as SVGSVGElement;
    return { root: node, ids: [...refs] };
  } catch {
    return null; // e.g. a Trusted Types policy that blocks DOMParser: the <img> fallback below
  }
}

/** A fresh inline copy of a Sumi icon (aria-hidden). */
export function sumiSvg(name: SumiIconName): SVGSVGElement {
  let t = templates.get(name);
  if (t === undefined) {
    t = parse(SUMI_ICONS[name]);
    templates.set(name, t);
  }
  if (!t) {
    // Could not parse (should not happen): the asset as an image, which a strict img-src may block.
    const s = document.createElementNS(SVG_NS, "svg");
    const img = document.createElementNS(SVG_NS, "image");
    img.setAttribute("href", `data:image/svg+xml,${encodeURIComponent(SUMI_ICONS[name])}`);
    img.setAttribute("width", "100%");
    img.setAttribute("height", "100%");
    s.appendChild(img);
    s.setAttribute("aria-hidden", "true");
    return s;
  }
  const el = t.root.cloneNode(true) as SVGSVGElement;
  if (t.ids.length) {
    const map = new Map(t.ids.map((id) => [id, `${id}-s${(++idSeq).toString(36)}`]));
    for (const n of [el, ...Array.from(el.querySelectorAll("*"))]) {
      const id = n.getAttribute("id");
      if (id && map.has(id)) n.setAttribute("id", map.get(id)!);
      for (const a of Array.from(n.attributes)) {
        if (a.value.includes("url(#")) n.setAttribute(a.name, a.value.replace(URL_REF, (_, ref: string) => `url(#${map.get(ref) || ref})`));
      }
    }
  }
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("focusable", "false");
  return el;
}

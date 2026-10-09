/** Unique, verified CSS selectors built from stable-looking parts of the DOM. */

export function cssEscape(s: string): string {
  try {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  } catch {
    /* fall through */
  }
  return s.replace(/([^\w-])/g, "\\$1").replace(/^(\d)/, "\\3$1 ");
}

function attrEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Heuristic: class names emitted by CSS-in-JS / CSS modules / scoped styles rather than written by a person. */
export function isGeneratedClass(c: string): boolean {
  if (!c || c.length > 48) return true;
  if (/^(css|sc|jsx|svelte|emotion|astro|styled|ember)-/i.test(c)) return true; // css-1x2y3z, sc-AxjAm, jsx-123, svelte-1abc2d
  if (/^_/.test(c) && /\d/.test(c)) return true; // Vite CSS modules: _title_1x2y3_12
  const tail = c.includes("__") ? c.slice(c.lastIndexOf("__") + 2) : "";
  if (tail.length >= 5 && /\d/.test(tail) && /[A-Za-z]/.test(tail) && !/-/.test(tail)) return true; // Next CSS modules: Hero_title__a1B2c
  if (/[0-9a-f]{8,}/i.test(c) && /\d/.test(c)) return true; // long hex hashes
  if (/^[a-z0-9]{1,3}-[a-z0-9]*\d[a-z0-9]*$/i.test(c) && c.length >= 7 && /[a-z]\d|\d[a-z]/i.test(c.slice(3))) return true; // xy-1a2b3c
  return false;
}

export function classList(el: Element): string[] {
  const raw = el.getAttribute("class") || "";
  return raw.split(/\s+/).filter(Boolean);
}

/** Classes worth showing to a human/agent (generated hashes removed). */
export function semanticClasses(el: Element, max = 12): string[] {
  const out: string[] = [];
  for (const c of classList(el)) {
    if (isGeneratedClass(c) || out.includes(c)) continue;
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** Classes safe and stable enough to put in a selector. */
function selectorClasses(el: Element): string[] {
  return semanticClasses(el, 20)
    .filter((c) => /^-?[A-Za-z_][\w-]*$/.test(c))
    .slice(0, 2);
}

export function isSafeId(id: string): boolean {
  return /^[A-Za-z][\w-]*$/.test(id) && id.length <= 64 && !/\d{4,}/.test(id) && !isGeneratedClass(id);
}

function matchesUniquely(sel: string, el: Element): boolean {
  try {
    const list = document.querySelectorAll(sel);
    return list.length === 1 && list[0] === el;
  } catch {
    return false;
  }
}

function segment(el: Element): string {
  const tag = el.localName || el.tagName.toLowerCase();
  let seg = cssEscape(tag);
  for (const c of selectorClasses(el)) seg += "." + cssEscape(c);
  const parent = el.parentElement;
  if (parent) {
    let same = 0;
    let index = 0;
    let k = 0;
    for (const sib of Array.from(parent.children)) {
      if (sib.localName !== el.localName) continue;
      k++;
      if (sib === el) index = k;
      let m = false;
      try {
        m = sib.matches(seg);
      } catch {
        m = true;
      }
      if (m) same++;
    }
    if (same > 1) seg += `:nth-of-type(${index})`;
  }
  return seg;
}

/** Above this many candidates a level is matched with one querySelectorAll (its nth-of-type caches win). */
const FILTER_MAX = 48;

/**
 * Elements of `set` whose `depth`-th parent matches `seg`: child-combinator chains matched bottom-up,
 * the same set `document.querySelectorAll` would return for the whole chain, without rescanning the
 * document once few candidates are left.
 */
function filterUp(set: Element[], depth: number, seg: string): Element[] {
  const out: Element[] = [];
  for (const x of set) {
    let a: Element | null = x;
    for (let d = 0; d < depth && a; d++) a = a.parentElement;
    if (!a) continue;
    try {
      if (a.matches(seg)) out.push(x);
    } catch {
      return [];
    }
  }
  return out;
}

const only = (set: Element[], el: Element): boolean => set.length === 1 && set[0] === el;

/**
 * A short CSS selector that matches `el` and nothing else in the document (verified): its id or test
 * id when unique, else a child chain of tag / class / nth-of-type segments up to the nearest unique
 * ancestor id (or the root).
 */
export function buildSelector(el: Element): string {
  const doc = el.ownerDocument || document;
  if (el === doc.documentElement) return "html";
  if (el === doc.body) return "body";

  const id = el.getAttribute("id");
  if (id && isSafeId(id)) {
    const s = "#" + cssEscape(id);
    if (matchesUniquely(s, el)) return s;
  }
  const testid = el.getAttribute("data-testid");
  if (testid) {
    const s = `[data-testid="${attrEscape(testid)}"]`;
    if (matchesUniquely(s, el)) return s;
    const t = `${el.localName}${s}`;
    if (matchesUniquely(t, el)) return t;
  }

  const parts: string[] = [];
  /** Elements matching `parts` so far once few do (else null: the chain is checked with querySelectorAll). */
  let set: Element[] | null = null;
  let depth = 0;
  let cur: Element | null = el;
  while (cur && cur !== doc.documentElement) {
    if (cur !== el) {
      const cid = cur.getAttribute("id");
      if (cid && isSafeId(cid) && matchesUniquely("#" + cssEscape(cid), cur)) {
        // "#cid > parts": the elements of the chain whose ancestor at this depth is `cur`
        const s = ["#" + cssEscape(cid), ...parts].join(" > ");
        const anchor = cur;
        const hit = set
          ? only(
              set.filter((x) => {
                let a: Element | null = x;
                for (let d = 0; d < depth && a; d++) a = a.parentElement;
                return a === anchor;
              }),
              el,
            )
          : matchesUniquely(s, el);
        if (hit) return s;
      }
    }
    const seg = cur === doc.body ? "body" : segment(cur);
    parts.unshift(seg);
    const s = parts.join(" > ");
    if (set) set = filterUp(set, depth, seg);
    else {
      let list: NodeListOf<Element> | null = null;
      try {
        list = doc.querySelectorAll(s);
      } catch {
        set = [];
      }
      if (list && list.length <= FILTER_MAX) set = Array.from(list);
    }
    // A lone positional bare tag ("a:nth-of-type(3)") is unique by accident; anchor it one level up.
    const fragile = parts.length === 1 && /:nth-of-type/.test(parts[0]) && !/[.#[]/.test(parts[0]);
    if (!fragile && set && only(set, el)) return s;
    cur = cur.parentElement;
    depth++;
  }
  const full = ["html", ...parts].join(" > ");
  return full;
}

/**
 * Static mode: stamp every element start tag of an HTML file with
 * data-sumi-src="<file>:<line>:<col>" (1-based, position of the "<") and find
 * the real </head> / </body> end tags for the overlay injection.
 *
 * A small, dependency-free scanner modelled on the WHATWG tokenizer. It only
 * ever inserts text right after a start tag's name, and never inside comments,
 * CDATA, attribute values or raw-text elements (script, style, textarea, ...),
 * so the stamped page renders exactly like the original. When in doubt it
 * skips (fewer stamps) rather than risk writing into text.
 *
 * Pure string code (no Node imports) so the smoke test can load it directly.
 */

export const SRC_ATTR = "data-sumi-src";

/** Elements whose content is not markup: skip to the matching end tag. */
const RAW_TEXT = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext",
]);

/** Never stamped: not rendered, or not something a person can point at. */
const NO_STAMP = new Set(["html", "head", "meta", "link", "script", "style", "title", "base"]);

export interface StampResult {
  html: string;
  /** Number of start tags stamped. */
  stamped: number;
  /** Offset in `html` of the first real `</head>` end tag (outside comments and raw text). */
  headEnd?: number;
  /** Offset in `html` of the first real `</body>` end tag. */
  bodyEnd?: number;
}

interface Tag {
  /** Lower-cased tag name. */
  name: string;
  /** Index just after the tag name: where the stamp goes. */
  nameEnd: number;
  /** Index just after the closing ">". */
  end: number;
  /** Lower-cased attribute names. */
  attrs: string[];
  selfClosing: boolean;
}

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f; // /
const DASH = 0x2d; // -
const EQ = 0x3d; // =

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0c || c === 0x0d;
}

function isAlpha(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/**
 * Parse a start or end tag whose name begins at `i` (just after "<" or "</").
 * Returns null when the input ends inside the tag (the browser drops such a tag).
 */
function readTag(s: string, i: number): Tag | null {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isWs(c) || c === SLASH || c === GT) break;
    j++;
  }
  const name = s.slice(i, j).toLowerCase();
  const nameEnd = j;
  const attrs: string[] = [];
  for (;;) {
    while (j < n && isWs(s.charCodeAt(j))) j++;
    if (j >= n) return null;
    let c = s.charCodeAt(j);
    if (c === GT) return { name, nameEnd, end: j + 1, attrs, selfClosing: false };
    if (c === SLASH) {
      if (s.charCodeAt(j + 1) === GT) return { name, nameEnd, end: j + 2, attrs, selfClosing: true };
      j++; // a stray "/" acts like whitespace
      continue;
    }
    // Attribute name. The first character is always part of it (even "=").
    const an = j++;
    while (j < n) {
      c = s.charCodeAt(j);
      if (isWs(c) || c === SLASH || c === GT || c === EQ) break;
      j++;
    }
    attrs.push(s.slice(an, j).toLowerCase());
    while (j < n && isWs(s.charCodeAt(j))) j++;
    if (s.charCodeAt(j) !== EQ) continue;
    j++;
    while (j < n && isWs(s.charCodeAt(j))) j++;
    if (j >= n) return null;
    c = s.charCodeAt(j);
    if (c === 0x22 || c === 0x27) {
      const close = s.indexOf(c === 0x22 ? '"' : "'", j + 1);
      if (close === -1) return null;
      j = close + 1;
    } else if (c !== GT) {
      // Unquoted value: ends at whitespace or ">" (quotes, "<", "=" are part of it).
      while (j < n) {
        c = s.charCodeAt(j);
        if (isWs(c) || c === GT) break;
        j++;
      }
    }
  }
}

/** "</name" (any case) followed by whitespace, "/" or ">" at index `i`. */
function isEndTagAt(s: string, i: number, name: string): boolean {
  if (s.charCodeAt(i) !== LT || s.charCodeAt(i + 1) !== SLASH) return false;
  if (s.slice(i + 2, i + 2 + name.length).toLowerCase() !== name) return false;
  const c = s.charCodeAt(i + 2 + name.length);
  return isWs(c) || c === SLASH || c === GT;
}

/** "<script" (any case) followed by whitespace, "/" or ">" at index `i`. */
function isScriptStartAt(s: string, i: number): boolean {
  if (s.charCodeAt(i) !== LT || s.slice(i + 1, i + 7).toLowerCase() !== "script") return false;
  const c = s.charCodeAt(i + 7);
  return isWs(c) || c === SLASH || c === GT;
}

/** Index of the "</name" that closes a RAWTEXT/RCDATA element whose content starts at `from`, or -1. */
function rawTextEnd(s: string, from: number, name: string): number {
  let i = from;
  for (;;) {
    const lt = s.indexOf("</", i);
    if (lt === -1) return -1;
    if (isEndTagAt(s, lt, name)) return lt;
    i = lt + 2;
  }
}

/**
 * Index of the "</script" that closes a script whose content starts at `from`, or -1.
 * Implements the script data (double) escaped states, so `<!-- <script></script> -->`
 * inside a script does not end it early.
 */
function scriptEnd(s: string, from: number): number {
  const n = s.length;
  let mode = 0; // 0 script data, 1 escaped, 2 double escaped
  let dashes = 0;
  for (let j = from; j < n; j++) {
    const c = s.charCodeAt(j);
    if (mode === 0) {
      if (c !== LT) continue;
      if (s.startsWith("<!--", j)) {
        mode = 1;
        dashes = 2; // "<!-->" closes the escape at once
        j += 3;
        continue;
      }
      if (isEndTagAt(s, j, "script")) return j;
      continue;
    }
    if (c === DASH) {
      dashes++;
      continue;
    }
    if (c === GT && dashes >= 2) {
      mode = 0;
      dashes = 0;
      continue;
    }
    dashes = 0;
    if (c !== LT) continue;
    if (mode === 1) {
      if (isEndTagAt(s, j, "script")) return j;
      if (isScriptStartAt(s, j)) {
        mode = 2;
        j += 7; // the delimiter after "<script" is consumed too
      }
    } else if (isEndTagAt(s, j, "script")) {
      mode = 1;
      j += 8;
    }
  }
  return -1;
}

/** End index (exclusive) of a comment starting at `i` ("<!--"), or -1 when it runs to EOF. */
function commentEnd(s: string, i: number): number {
  const k = i + 4;
  if (s.charCodeAt(k) === GT) return k + 1; // "<!-->"
  if (s.charCodeAt(k) === DASH && s.charCodeAt(k + 1) === GT) return k + 2; // "<!--->"
  const a = s.indexOf("-->", k);
  const b = s.indexOf("--!>", k);
  if (a === -1 && b === -1) return -1;
  if (b === -1 || (a !== -1 && a < b)) return a + 3;
  return b + 4;
}

function lineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x0a) out.push(i + 1);
    else if (c === 0x0d) {
      if (s.charCodeAt(i + 1) === 0x0a) i++;
      out.push(i + 1);
    }
  }
  return out;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Stamp every start tag in `src` with `data-sumi-src="<file>:<line>:<col>"`.
 * `file` is the path shown to the agent (relative to the served folder).
 */
export function stampHtml(src: string, file: string, opts: { stamp?: boolean } = {}): StampResult {
  const doStamp = opts.stamp !== false;
  const n = src.length;
  const starts = lineStarts(src);
  const bom = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fileAttr = escapeAttr(file);
  const out: string[] = [];
  let outLen = 0;
  let copied = 0;
  let stamped = 0;
  let headEnd: number | undefined;
  let bodyEnd: number | undefined;
  let foreign = 0; // depth of <svg>/<math>, where self-closing raw-text tags are really self-closing
  let line = 0; // index into `starts`, advanced monotonically

  const copyTo = (i: number) => {
    if (i <= copied) return;
    const chunk = src.slice(copied, i);
    out.push(chunk);
    outLen += chunk.length;
    copied = i;
  };
  const position = (i: number): string => {
    while (line + 1 < starts.length && starts[line + 1] <= i) line++;
    const col = i - starts[line] + 1 - (line === 0 ? bom : 0);
    return `${line + 1}:${col}`;
  };

  let i = 0;
  scan: while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    const c = src.charCodeAt(lt + 1);

    if (isAlpha(c)) {
      const tag = readTag(src, lt + 1);
      if (!tag) break; // EOF inside a tag
      const name = tag.name;
      if (doStamp && !NO_STAMP.has(name) && !tag.attrs.includes(SRC_ATTR)) {
        copyTo(tag.nameEnd);
        const ins = ` ${SRC_ATTR}="${fileAttr}:${position(lt)}"`;
        out.push(ins);
        outLen += ins.length;
        stamped++;
      }
      i = tag.end;
      if ((name === "svg" || name === "math") && !tag.selfClosing) foreign++;
      if (RAW_TEXT.has(name) && !(foreign > 0 && tag.selfClosing)) {
        if (name === "plaintext") break; // everything after is text
        const end = name === "script" ? scriptEnd(src, i) : rawTextEnd(src, i, name);
        if (end === -1) break;
        i = end; // the end tag itself is handled by the next iteration
      }
      continue;
    }

    if (c === SLASH) {
      const c2 = src.charCodeAt(lt + 2);
      if (isAlpha(c2)) {
        const tag = readTag(src, lt + 2);
        if (!tag) break;
        if (tag.name === "head" && headEnd === undefined) {
          copyTo(lt);
          headEnd = outLen;
        } else if (tag.name === "body" && bodyEnd === undefined) {
          copyTo(lt);
          bodyEnd = outLen;
        } else if ((tag.name === "svg" || tag.name === "math") && foreign > 0) {
          foreign--;
        }
        i = tag.end;
        continue;
      }
      if (c2 === GT) {
        i = lt + 3; // "</>" is dropped
        continue;
      }
      if (lt + 2 >= n) break;
      const gt = src.indexOf(">", lt + 2); // bogus comment
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }

    if (c === 0x21 /* ! */) {
      if (src.startsWith("<!--", lt)) {
        const end = commentEnd(src, lt);
        if (end === -1) break;
        i = end;
        continue;
      }
      if (src.startsWith("<![CDATA[", lt)) {
        // A real CDATA section in SVG/MathML; in HTML it would end at the first ">", but ending at
        // "]]>" is the safe choice: at worst a few tags go unstamped.
        const end = src.indexOf("]]>", lt + 9);
        if (end === -1) break;
        i = end + 3;
        continue;
      }
      const gt = src.indexOf(">", lt + 2); // doctype or bogus comment
      if (gt === -1) break scan;
      i = gt + 1;
      continue;
    }

    if (c === 0x3f /* ? */) {
      const gt = src.indexOf(">", lt + 2);
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }

    i = lt + 1; // a lone "<" is text
  }

  copyTo(n);
  return { html: out.join(""), stamped, headEnd, bodyEnd };
}

/**
 * Insert `tag` before the real </head> (else </body>, else at the end), like the proxy does,
 * using the positions found by the tokenizer. No-op when the overlay is already there.
 */
export function injectStamped(r: StampResult, tag: string): string {
  const html = r.html;
  if (OVERLAY_TAG_RE.test(html)) return html;
  const at = r.headEnd ?? r.bodyEnd;
  if (at === undefined) return html + tag;
  return html.slice(0, at) + tag + html.slice(at);
}

/** An existing overlay <script> tag (e.g. a page saved from a Sumi review). */
const OVERLAY_TAG_RE = /<script\b[^>]*\bsrc\s*=\s*["']?\/__sumi\/overlay\.js/i;

/**
 * Proxy mode: insert `tag` before the real </head> (else </body>, else at the end) of an HTML
 * page without stamping it. Uses the same tokenizer, so a "</head>" inside a script, comment or
 * attribute is not mistaken for the real one.
 */
export function injectOverlay(html: string, tag: string): string {
  return injectStamped(stampHtml(html, "", { stamp: false }), tag);
}

/**
 * Optional, async refinement of React 19 `_debugStack` locations.
 * Stack frames point at the dev server's *transformed* module (e.g. Vite), so the line is off.
 * When the module is same-origin and carries a source map, map the frame back to the original
 * line/column. Best effort: any failure keeps the approximate location.
 */
import type { ElementContext } from "../shared/types";
import { cleanSourceUrl, type RawFrame } from "./source";

/** Raw frames recorded at capture time, keyed by the ElementContext they belong to. */
export const rawFrames = new WeakMap<object, RawFrame>();

interface LoadedMap {
  mapUrl: string;
  sources: string[];
  sourceRoot: string;
  /** The raw `mappings`, one string per generated line. */
  lines: string[];
  /** Decoded lines, filled in order on demand and kept with the map: [genCol, src, line, col] per segment. */
  decoded: Int32Array[];
  /** Running source / line / column after the last decoded line (they are deltas across lines). */
  at: [number, number, number];
}

/** Loaded maps by full module URL (query included: Vite's `?t=` changes after every HMR update). LRU. */
const cache = new Map<string, Promise<LoadedMap | null>>();
const CACHE_MAX = 20;
/** Maps (and modules) above this are skipped: decoding them would stall the page. */
const MAX_MAP_BYTES = 5 * 1024 * 1024;
const MAX_MODULE_BYTES = 8 * 1024 * 1024;

function cached(url: string): Promise<LoadedMap | null> {
  let p = cache.get(url);
  if (p) {
    cache.delete(url); // most recently used last
    cache.set(url, p);
    return p;
  }
  p = load(url).catch(() => null);
  cache.set(url, p);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return p;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

function decodeVlq(seg: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < seg.length; i++) {
    const d = B64_INDEX[seg[i]];
    if (d === undefined) return out;
    value += (d & 31) << shift;
    if (d & 32) {
      shift += 5;
    } else {
      const neg = value & 1;
      value >>>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function sameOrigin(url: string): boolean {
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

async function fetchText(url: string, maxBytes: number, ms = 1500): Promise<string | null> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : 0;
  try {
    const res = await fetch(url, { credentials: "same-origin", signal: ctrl ? ctrl.signal : undefined });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length"));
    if (Number.isFinite(len) && len > maxBytes) {
      ctrl?.abort();
      return null;
    }
    const text = await res.text();
    return text.length > maxBytes ? null : text;
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

async function load(moduleUrl: string): Promise<LoadedMap | null> {
  if (!/^https?:/i.test(moduleUrl) || !sameOrigin(moduleUrl)) return null;
  const code = await fetchText(moduleUrl, MAX_MODULE_BYTES);
  if (!code) return null;
  let ref = "";
  const re = /\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g;
  for (let m = re.exec(code); m; m = re.exec(code)) ref = m[1];
  if (!ref) return null;
  let json: string | null;
  let mapUrl = moduleUrl;
  if (ref.startsWith("data:")) {
    const comma = ref.indexOf(",");
    const meta = ref.slice(5, comma);
    const data = ref.slice(comma + 1);
    const b64 = /;base64/i.test(meta);
    if ((b64 ? data.length * 0.75 : data.length) > MAX_MAP_BYTES) return null;
    json = b64 ? decodeBase64Utf8(data) : decodeURIComponent(data);
  } else {
    mapUrl = new URL(ref, moduleUrl).href;
    if (!sameOrigin(mapUrl)) return null;
    json = await fetchText(mapUrl, MAX_MAP_BYTES);
  }
  if (!json) return null;
  const map = JSON.parse(json);
  if (!map || typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
  return { mapUrl, sources: map.sources, sourceRoot: map.sourceRoot || "", lines: map.mappings.split(";"), decoded: [], at: [0, 0, 0] };
}

/** Decode the map's lines up to `target` (0-based), once: later lookups reuse them. */
function decodeTo(m: LoadedMap, target: number): void {
  const at = m.at;
  for (let i = m.decoded.length; i <= target && i < m.lines.length; i++) {
    const out: number[] = [];
    let gCol = 0;
    for (const seg of m.lines[i].split(",")) {
      if (!seg) continue;
      const v = decodeVlq(seg);
      gCol += v[0] || 0;
      if (v.length < 4) continue;
      at[0] += v[1];
      at[1] += v[2];
      at[2] += v[3];
      out.push(gCol, at[0], at[1], at[2]);
    }
    m.decoded.push(Int32Array.from(out));
  }
}

/** Original position of generated (line, col) (1-based): the last segment at or before the column, else the line's first. */
function originalPosition(m: LoadedMap, line: number, col: number): { src: number; line: number; col: number } | null {
  const target = line - 1;
  if (target < 0) return null;
  decodeTo(m, target);
  const segs = m.decoded[target];
  if (!segs || !segs.length) return null;
  let best = -1;
  for (let k = 0; k < segs.length; k += 4) if (segs[k] <= col - 1) best = k;
  const k = best >= 0 ? best : 0;
  return { src: segs[k + 1], line: segs[k + 2], col: segs[k + 3] };
}

async function refineOne(ctx: ElementContext): Promise<void> {
  const frame = rawFrames.get(ctx);
  if (!frame || !ctx.source) return;
  const m = await cached(frame.url.replace(/#.*$/, ""));
  if (!m) return;
  const pos = originalPosition(m, frame.line, frame.col);
  if (!pos || !m.sources[pos.src]) return;
  const generated = cleanSourceUrl(frame.url);
  const rawSource = m.sourceRoot + m.sources[pos.src];
  let file: string;
  if (/^(\/|[A-Za-z]:[\\/])/.test(rawSource) && !/^\/(src|app|pages|components|lib)\//.test(rawSource)) {
    file = rawSource; // absolute filesystem path
  } else {
    file = cleanSourceUrl(new URL(rawSource, m.mapUrl).href);
  }
  const base = (s: string) => s.split(/[\\/]/).pop() || s;
  if (base(file) === base(generated)) file = generated; // keep the project-relative spelling
  ctx.source = `${file}:${pos.line + 1}:${pos.col + 1}`;
}

/** Refine `source` of each context in place. Never rejects. */
export async function refineSources(ctxs: Array<ElementContext | undefined>): Promise<void> {
  await Promise.all(
    ctxs.map((c) => (c && rawFrames.has(c) ? refineOne(c).catch(() => undefined) : Promise.resolve()))
  );
}

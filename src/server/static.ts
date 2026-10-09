/**
 * Static mode: review a local .html file or folder without a dev server.
 * - resolveTarget(): dev-server URL -> proxy; file:// URL / absolute path / (CLI) relative path -> static.
 * - createStaticHandler(): serves files from the root with traversal, dotfile and symlink-escape
 *   protection; HTML gets data-sumi-src stamps plus the overlay tag.
 */
import type http from "node:http";
import { createReadStream, existsSync, realpathSync, statSync, type Stats } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SUMI_PAGE_HEADERS, injectIntoHtml, isLoopbackHost } from "./proxy";
import { injectStamped, stampHtml } from "./stamp";

export interface ProxyTarget {
  mode: "proxy";
  /** Normalised dev-server URL. */
  target: string;
  /** Identity for idempotent restarts. */
  key: string;
}

export interface StaticTarget {
  mode: "static";
  /** file:// URL of the entry file (of the folder itself when it has no index.html). */
  target: string;
  /** Absolute folder being served. */
  root: string;
  /** Entry path relative to root with "/" separators; "" = folder listing. */
  entry: string;
  key: string;
}

export type ResolvedTarget = ProxyTarget | StaticTarget;

export interface ResolveOptions {
  /** Base for relative paths. Only the CLI passes it; without it relative paths are rejected. */
  cwd?: string;
  /** Allow dev-server URLs on other machines (CLI --allow-remote). Loopback only by default. */
  allowRemote?: boolean;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const HTML_EXT = /\.html?$/i;

/**
 * Turns a target into a proxy or static target.
 * URLs keep their old behaviour (see normalizeTarget); `normalize` is injected to avoid a cycle.
 */
export function resolveTargetWith(
  input: string,
  opts: ResolveOptions,
  normalize: (url: string) => string,
): ResolvedTarget {
  const s = String(input ?? "").trim();
  if (!s) {
    throw new Error(
      "Missing target: the URL of a running dev server (e.g. http://localhost:3000), or the path of an .html file or folder.",
    );
  }
  const proxy = (): ProxyTarget => {
    const target = normalize(s);
    if (!opts.allowRemote && !isLoopbackHost(new URL(target).hostname)) {
      throw new Error(
        `${new URL(target).origin} is not on this computer. Sumi reviews local dev servers only ` +
          "(localhost, 127.0.0.1, ::1 or *.localhost). To proxy another machine anyway, run the CLI with --allow-remote.",
      );
    }
    return { mode: "proxy", target, key: `proxy:${target}` };
  };

  let abs: string;
  if (/^file:/i.test(s)) {
    try {
      abs = fileURLToPath(s);
    } catch (e) {
      throw new Error(`"${s}" is not a usable file:// URL (${(e as Error).message}).`);
    }
  } else if (SCHEME.test(s) || /^:?\d{1,5}$/.test(s)) {
    return proxy();
  } else if (s === "~" || s.startsWith("~/")) {
    abs = join(homedir(), s.slice(1));
  } else if (isAbsolute(s)) {
    abs = resolve(s);
  } else if (/^\.\.?([\\/]|$)/.test(s)) {
    if (!opts.cwd) throw relativeError(s);
    abs = resolve(opts.cwd, s);
  } else if (opts.cwd && existsSync(resolve(opts.cwd, s))) {
    abs = resolve(opts.cwd, s);
  } else if (!opts.cwd && HTML_EXT.test(s.replace(/[?#].*$/, "")) && !s.includes(":")) {
    throw relativeError(s);
  } else {
    return proxy();
  }
  return staticTarget(abs);
}

function relativeError(s: string): Error {
  return new Error(
    `"${s}" is a relative path. Pass an absolute path (e.g. /Users/me/site/index.html) or a file:// URL.`,
  );
}

function staticTarget(abs: string): StaticTarget {
  let st: Stats;
  try {
    st = statSync(abs);
  } catch {
    throw new Error(`No such file or folder: ${abs}`);
  }
  let root: string;
  let entry: string;
  if (st.isDirectory()) {
    root = abs;
    entry = ["index.html", "index.htm"].find((f) => isFile(join(abs, f))) ?? "";
  } else if (st.isFile()) {
    if (!HTML_EXT.test(abs)) {
      throw new Error(`${abs} is not an HTML file. Pass an .html/.htm file, or the folder that contains the page.`);
    }
    root = dirname(abs);
    entry = basename(abs);
    if (entry.startsWith(".")) throw new Error(`${abs} is a hidden file; Sumi never serves dotfiles. Rename it first.`);
  } else {
    throw new Error(`${abs} is not a regular file or folder.`);
  }
  checkRoot(root);
  const target = entry ? pathToFileURL(join(root, entry)).href : pathToFileURL(root.endsWith(sep) ? root : root + sep).href;
  return { mode: "static", target, root, entry, key: `static:${root}\u0000${entry}` };
}

function realOrSelf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Sumi serves every web file under the root, so the root must be a project folder: never the
 * filesystem root, the home folder, or a folder that contains the home folder.
 */
export function checkRoot(root: string): void {
  const real = realOrSelf(root);
  const home = realOrSelf(homedir());
  const parsed = resolve(real);
  const isFsRoot = parsed === resolve(parsed, "..");
  const withSep = (p: string) => (p.endsWith(sep) ? p : p + sep);
  if (isFsRoot || parsed === home || withSep(home).startsWith(withSep(parsed))) {
    throw new Error(
      `Sumi won't serve ${root}: it is ${isFsRoot ? "the root of the disk" : parsed === home ? "your home folder" : "a folder that contains your home folder"}, ` +
        "and every file in it would be reachable from the review page. Pass the folder of the site itself " +
        "(e.g. ~/projects/site or ~/projects/site/index.html).",
    );
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** URL path (leading "/", each segment encoded) for a root-relative path. */
export function urlPathFor(rel: string): string {
  return "/" + rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

// ---------------------------------------------------------------- content types

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".apng": "image/apng",
  ".ogv": "video/ogg",
  ".flac": "audio/flac",
  ".vtt": "text/vtt; charset=utf-8",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".pdf": "application/pdf",
};

/** Content type of a web file, or undefined for anything Sumi does not serve. */
export function contentTypeFor(file: string): string | undefined {
  const ext = extname(file).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPES, ext) ? TYPES[ext] : undefined;
}

/** A file type Sumi serves (and whose changes reload the page). */
export function isWebAsset(file: string): boolean {
  return contentTypeFor(file) !== undefined;
}

// ---------------------------------------------------------------- handler

export interface StaticHandlerOptions {
  /** Folder as the person gave it (shown in pages). */
  root: string;
  /** realpath(root): everything served must resolve inside it. */
  realRoot: string;
  /** Markup injected into every HTML page (overlay tag + static flag). */
  inject: string;
  log?: (s: string) => void;
  /** Called with the real path of every file served (Linux watch fallback). */
  onServe?: (realFile: string) => void;
}

class Reject extends Error {
  constructor(public status: 400 | 404, message: string) {
    super(message);
  }
}

const NO_STORE = "no-store";

export function createStaticHandler(
  opts: StaticHandlerOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const log = opts.log ?? (() => {});
  const realRoot = opts.realRoot;
  const rootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  const inside = (p: string) => p === realRoot || p.startsWith(rootPrefix);
  const hiddenRel = (rel: string) => rel.split(/[\\/]/).some((seg) => seg.startsWith(".") || seg === "");

  /** Resolve a URL path to a real path inside the root, or throw Reject. */
  async function locate(segs: string[]): Promise<{ real: string; st: Stats }> {
    const candidate = join(realRoot, ...segs);
    let real: string;
    let st: Stats;
    try {
      real = await realpath(candidate);
      st = await stat(real);
    } catch {
      throw new Reject(404, "not found");
    }
    if (!inside(real)) throw new Reject(404, "outside the served folder");
    const rel = relative(realRoot, real);
    if (rel && hiddenRel(rel)) throw new Reject(404, "hidden file");
    return { real, st };
  }

  async function sendHtmlFile(req: http.IncomingMessage, res: http.ServerResponse, real: string): Promise<void> {
    const buf = await readFile(real);
    const rel = relative(realRoot, real).split(sep).join("/");
    // UTF-16 pages: serve untouched (inserting ASCII would corrupt them).
    if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
      return send(req, res, 200, "text/html", buf);
    }
    let text: string;
    let latin1 = false;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      // Not UTF-8 (e.g. windows-1252): a byte-for-byte round trip keeps it intact; let the page's
      // <meta charset> decide.
      text = buf.toString("latin1");
      latin1 = true;
    }
    let html: string;
    try {
      html = injectStamped(stampHtml(text, rel), opts.inject);
    } catch (e) {
      log(`sumi: could not stamp ${rel} (${(e as Error).message}); serving it unstamped`);
      html = injectIntoHtml(text, opts.inject);
    }
    const body = latin1 ? Buffer.from(html, "latin1") : Buffer.from(html, "utf8");
    send(req, res, 200, latin1 ? "text/html" : "text/html; charset=utf-8", body);
  }

  function sendFile(req: http.IncomingMessage, res: http.ServerResponse, real: string, st: Stats): void {
    const size = st.size;
    const headers: http.OutgoingHttpHeaders = {
      "content-type": contentTypeFor(real) ?? "application/octet-stream",
      "cache-control": NO_STORE,
      "accept-ranges": "bytes",
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = String(req.headers.range ?? "").trim();
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      } else {
        start = Math.max(0, size - Number(m[2]));
      }
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}`, "cache-control": NO_STORE });
        res.end();
        return;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = size === 0 ? 0 : end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = createReadStream(real, { start, end });
    stream.on("error", (e) => {
      log(`sumi: reading ${real} failed (${e.message})`);
      res.destroy(e);
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { ...SUMI_PAGE_HEADERS, allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE });
      res.end("Method not allowed: Sumi only serves files (GET, HEAD).\n");
      return;
    }
    const rawUrl = req.url || "/";
    const q = rawUrl.search(/[?#]/);
    let pathname = q === -1 ? rawUrl : rawUrl.slice(0, q);
    const query = q === -1 ? "" : rawUrl.slice(q).replace(/#.*$/, "");
    if (!pathname.startsWith("/")) {
      try {
        pathname = new URL(rawUrl).pathname; // absolute-form request target
      } catch {
        return badRequest(res, "malformed request path");
      }
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return badRequest(res, "malformed URL encoding");
    }
    if (decoded.includes("\0") || (process.platform === "win32" && /[\\:]/.test(decoded))) {
      return badRequest(res, "invalid characters in path");
    }
    const segs = decoded.split("/").filter((x) => x !== "");
    if (segs.includes("..")) return badRequest(res, "path escapes the served folder");

    try {
      if (segs.some((x) => x.startsWith("."))) throw new Reject(404, "hidden file");
      const { real, st } = await locate(segs);
      if (st.isDirectory()) {
        if (!pathname.endsWith("/")) {
          // Relative links in the folder's index.html need the trailing slash.
          const location = urlPathFor(segs.join("/")) + (segs.length ? "/" : "") + query;
          res.writeHead(301, { location, "cache-control": NO_STORE, "content-length": 0 });
          res.end();
          return;
        }
        for (const index of ["index.html", "index.htm"]) {
          let found: { real: string; st: Stats } | null = null;
          try {
            found = await locate([...segs, index]);
          } catch {
            found = null;
          }
          if (found && found.st.isFile()) {
            opts.onServe?.(found.real);
            return await sendHtmlFile(req, res, found.real);
          }
        }
        opts.onServe?.(join(real, "index.html"));
        const page = await listingPage(real, realRoot, decoded, opts.root, opts.inject);
        return send(req, res, 200, "text/html; charset=utf-8", Buffer.from(page, "utf8"), SUMI_PAGE_HEADERS);
      }
      if (!st.isFile()) throw new Reject(404, "not a file");
      if (!isWebAsset(real)) throw new Reject(404, "not a web file type");
      opts.onServe?.(real);
      if (/\.html?$/i.test(real)) return await sendHtmlFile(req, res, real);
      sendFile(req, res, real, st);
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      const page = notFoundPage(decoded, opts.root, opts.inject);
      send(req, res, 404, "text/html; charset=utf-8", Buffer.from(page, "utf8"), SUMI_PAGE_HEADERS);
    }
  }

  return (req, res) => {
    handle(req, res).catch((e) => {
      log(`sumi: ${req.method} ${req.url} -> ${(e as Error).message}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { ...SUMI_PAGE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": NO_STORE });
      res.end(`Sumi could not serve this file: ${(e as Error).message}\n`);
    });
  };
}

function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  type: string,
  body: Buffer,
  extra: http.OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, { ...extra, "content-type": type, "cache-control": NO_STORE, "content-length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

function badRequest(res: http.ServerResponse, why: string): void {
  const body = `Bad request: ${why}.\n`;
  res.writeHead(400, {
    ...SUMI_PAGE_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": NO_STORE,
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------- generated pages

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const PAGE_CSS = `
  body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#fff;color:#1f2328}
  main{max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem}
  h1{font-size:1.25rem;margin:0 0 .75rem;font-weight:600}
  p{margin:.5rem 0}
  ul{padding-left:1.25rem}
  li{margin:.2rem 0}
  a{color:#0969da}
  code{font:.85em ui-monospace,SFMono-Regular,Menlo,monospace;background:#f0f2f4;padding:.1rem .35rem;border-radius:.3rem}
  .muted{color:#59636e;font-size:.85rem}
  @media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}a{color:#4493f8}code{background:#1f242c}.muted{color:#9198a1}}
`;

function page(title: string, inject: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_CSS}</style>
${inject}</head><body><main>
${body}
</main></body></html>
`;
}

export function notFoundPage(path: string, root: string, inject: string): string {
  return page(
    "Not found · Sumi",
    inject,
    `<h1>Nothing at <code>${escapeHtml(path || "/")}</code></h1>
<p>Sumi is serving the files in <code>${escapeHtml(root)}</code>, and there is no such file there.</p>
<p><a href="/">See the HTML files in this folder</a></p>
<p class="muted">This page reloads by itself when files in the folder change.</p>`,
  );
}

const MAX_LISTED = 500;
const MAX_DEPTH = 4;

async function htmlFilesUnder(dir: string, realRoot: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, depth: number): Promise<void> => {
    if (out.length >= MAX_LISTED || depth > MAX_DEPTH) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const p = join(d, e.name);
      if (e.isFile() && HTML_EXT.test(e.name)) {
        out.push(relative(dir, p).split(sep).join("/"));
        if (out.length >= MAX_LISTED) return;
      }
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink() || !e.isDirectory()) continue;
      await walk(join(d, e.name), depth + 1);
    }
  };
  if (dir === realRoot || dir.startsWith(realRoot + sep)) await walk(dir, 0);
  return out;
}

export async function listingPage(dirReal: string, realRoot: string, urlPath: string, root: string, inject: string): Promise<string> {
  const files = await htmlFilesUnder(dirReal, realRoot);
  const shown = urlPath.endsWith("/") ? urlPath : urlPath + "/";
  const items = files
    .map((f) => `<li><a href="${escapeHtml(f.split("/").map(encodeURIComponent).join("/"))}">${escapeHtml(f)}</a></li>`)
    .join("\n");
  const where = shown === "/" ? `<code>${escapeHtml(root)}</code>` : `<code>${escapeHtml(shown)}</code>`;
  return page(
    `Index of ${shown} · Sumi`,
    inject,
    `<h1>HTML files in ${where}</h1>
${files.length ? `<p class="muted">No index.html here. Pick a page to review:</p>\n<ul>\n${items}\n</ul>` : `<p>There are no .html files in this folder yet.</p>`}
${files.length >= MAX_LISTED ? `<p class="muted">Showing the first ${MAX_LISTED}.</p>` : ""}
<p class="muted">This page reloads by itself when files in the folder change.</p>`,
  );
}

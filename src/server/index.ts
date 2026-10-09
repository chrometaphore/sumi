/**
 * SumiServer: one HTTP server that serves /__sumi/* (overlay bundle + JSON API)
 * and either reverse-proxies everything else to the target app (proxy mode) or
 * serves a local folder itself with live reload (static mode).
 *
 * Access control: every request must name Sumi itself in its Host header (no DNS rebinding);
 * the API additionally needs the per-session key that is injected into the pages Sumi serves
 * (and written to ~/.sumi/run/<port>.key for `sumi wait`), and rejects foreign Origins.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AnnotationStatus, LiveChange, SessionMode } from "../shared/types";
import { toMarkdown } from "../shared/format";
import { AnnotationStore, STATUSES, StoreError } from "./store";
import { SUMI_PAGE_HEADERS, bareHost, createProxyHandler, createUpgradeHandler, isLoopbackHost } from "./proxy";
import { acquireLock, releaseLock, removeKeyFile, writeKeyFile } from "./runtime";
import { createStaticHandler, resolveTargetWith, urlPathFor, type ResolveOptions, type ResolvedTarget } from "./static";
import { LIMITS, ID_RE, idsSchema } from "./validate";
import { StaticWatcher } from "./watch";

export type { ResolvedTarget, StaticTarget, ProxyTarget } from "./static";
export { SessionLockedError, readKeyFile } from "./runtime";
export { isLoopbackHost } from "./proxy";

export const DEFAULT_PORT = 4848;
/** The overlay tag injected into every page, carrying the session's API key. */
export function overlayTag(key: string): string {
  return `<script src="/__sumi/overlay.js?k=${encodeURIComponent(key)}" defer></script>`;
}
/** Static mode: the overlay tag plus a flag that turns on live reload in the overlay. */
export function staticOverlayTag(key: string): string {
  return `<script>window.__SUMI_STATIC__=1</script>${overlayTag(key)}`;
}
const MAX_WAIT_MS = 120_000;
const SSE_PING_MS = 25_000;
/** Header on every /__sumi/* response, so a second Sumi can tell it is pointed at a Sumi. */
const SUMI_HEADER = "x-sumi";

export interface SumiServerOptions {
  /** Dev-server URL, file:// URL or absolute path (relative paths need `cwd`), or an already resolved target. */
  target: string | ResolvedTarget;
  /** Base directory for relative paths in `target` (the CLI passes process.cwd()); also scopes proxy session files. */
  cwd?: string;
  port?: number;
  overlayPath?: string | URL;
  log?: (s: string) => void;
  /** Override the session file (null disables persistence). Mostly for tests. */
  sessionFile?: string | null;
  /** Allow a dev-server URL on another machine (CLI --allow-remote). */
  allowRemote?: boolean;
  /** Write ~/.sumi/run/<port>.key for `sumi wait` (default true). */
  writeKeyFile?: boolean;
}

/**
 * Accepts "3000", "localhost:3000", "127.0.0.1:5173/app", "http://…", "https://…"
 * and returns a normalised absolute URL string (origin + path, no trailing slash on bare origin).
 */
export function normalizeTarget(input: string): string {
  let s = String(input ?? "").trim();
  if (!s) throw new Error("Missing target URL (e.g. http://localhost:3000).");
  if (/^\d{1,5}$/.test(s)) s = `http://localhost:${s}`;
  else if (/^:\d{1,5}$/.test(s)) s = `http://localhost${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`"${input}" is not a valid URL. Try something like http://localhost:3000.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http:// and https:// targets are supported (got ${u.protocol}).`);
  }
  const path = u.pathname === "/" ? "" : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

/**
 * Like normalizeTarget for URLs, plus local files: a file:// URL, an absolute path, or (with
 * `opts.cwd`, i.e. the CLI) a relative path to an existing .html file or folder -> static mode.
 * Proxy targets must be on this computer unless `opts.allowRemote`.
 */
export function resolveTarget(input: string, opts: ResolveOptions = {}): ResolvedTarget {
  return resolveTargetWith(input, opts, normalizeTarget);
}

/** True when `t` is a loopback dev-server URL on `port`, i.e. Sumi itself if Sumi listens there. */
export function targetsPort(t: ResolvedTarget, port: number): boolean {
  if (t.mode !== "proxy") return false;
  const u = new URL(t.target);
  const p = Number(u.port || (u.protocol === "https:" ? 443 : 80));
  return p === port && isLoopbackHost(u.hostname);
}

export class PortInUseError extends Error {
  readonly code = "EADDRINUSE";
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class SumiServer {
  readonly resolved: ResolvedTarget;
  readonly mode: SessionMode;
  /** Proxy: the dev-server URL. Static: the entry's file:// URL. */
  readonly target: string;
  readonly targetUrl: URL;
  /** Static mode: absolute folder being served. */
  readonly root: string | undefined;
  /** Static mode: entry path relative to root ("" = folder listing). */
  readonly entry: string | undefined;
  /** Identity for idempotent restarts (same app/files + same port = same session). */
  readonly identity: string;
  /** Secret for /__sumi/api/*: injected into served pages, written to ~/.sumi/run/<port>.key. */
  readonly apiKey: string;
  readonly port: number;
  /** Set when the server starts: http://localhost:<port>, or 127.0.0.1 if another app holds [::1]:<port>. */
  reviewUrl: string;
  readonly store: AnnotationStore;
  private readonly overlayPath: string;
  private readonly log: (s: string) => void;
  private readonly writeKey: boolean;
  private readonly allowedHosts: Set<string>;
  private readonly selfOrigins: string[];
  private server: http.Server | null = null;
  private sockets = new Set<import("node:net").Socket>();
  private watcher: StaticWatcher | null = null;
  private sse = new Set<http.ServerResponse>();
  private lockFile: string | null = null;
  private keyWritten = false;

  constructor(opts: SumiServerOptions) {
    this.resolved =
      typeof opts.target === "string"
        ? resolveTarget(opts.target, { cwd: opts.cwd, allowRemote: opts.allowRemote })
        : opts.target;
    this.mode = this.resolved.mode;
    this.target = this.resolved.target;
    this.targetUrl = new URL(this.target);
    this.identity = this.resolved.key;
    this.root = this.resolved.mode === "static" ? this.resolved.root : undefined;
    this.entry = this.resolved.mode === "static" ? this.resolved.entry : undefined;
    this.port = opts.port ?? DEFAULT_PORT;
    this.apiKey = randomBytes(24).toString("base64url");
    this.writeKey = opts.writeKeyFile !== false;
    const hosts = [`localhost:${this.port}`, `127.0.0.1:${this.port}`, `[::1]:${this.port}`];
    if (this.port === 80) hosts.push("localhost", "127.0.0.1", "[::1]");
    this.allowedHosts = new Set(hosts);
    this.selfOrigins = hosts.map((h) => `http://${h}`);
    this.reviewUrl = this.urlFor("localhost");
    this.log = opts.log ?? ((s) => process.stderr.write(s + "\n"));
    const op = opts.overlayPath ?? new URL("./overlay.js", import.meta.url);
    this.overlayPath = op instanceof URL ? fileURLToPath(op) : op.startsWith("file:") ? fileURLToPath(op) : op;
    this.store = new AnnotationStore({
      target: this.target,
      reviewUrl: this.reviewUrl,
      mode: this.mode,
      root: this.root,
      file: opts.sessionFile,
      cwd: opts.cwd,
      log: this.log,
    });
  }

  /** Back-compat alias of `identity`. */
  get key(): string {
    return this.identity;
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Static mode: how files are watched ("recursive", "per-directory" or "off"). */
  get liveReload(): string {
    return this.watcher ? this.watcher.kind : "off";
  }

  private urlFor(host: string): string {
    const origin = `http://${host}:${this.port}`;
    return this.resolved.mode === "static" && this.resolved.entry ? origin + urlPathFor(this.resolved.entry) : origin;
  }

  /** Host header names Sumi itself (localhost, 127.0.0.1 or [::1] on our port). */
  private hostAllowed(host: string | undefined): boolean {
    return !!host && this.allowedHosts.has(host.toLowerCase());
  }

  async start(): Promise<{ reviewUrl: string }> {
    if (this.server) return { reviewUrl: this.reviewUrl };
    if (targetsPort(this.resolved, this.port)) {
      throw new Error(
        `${this.target} is Sumi's own address (port ${this.port}). Pass the URL of your dev server instead, ` +
          "or open the review that is already running there.",
      );
    }
    if (this.resolved.mode === "proxy" && (await looksLikeSumi(this.targetUrl))) {
      throw new Error(
        `${this.targetUrl.origin} is another Sumi review, not your app. Open that review directly, or pass the ` +
          "URL of your dev server.",
      );
    }

    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
    let upgrade: (req: http.IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void;
    let realRoot = "";
    if (this.resolved.mode === "static") {
      try {
        realRoot = realpathSync.native(this.resolved.root);
      } catch (e) {
        throw new Error(`Cannot serve ${this.resolved.root}: ${(e as Error).message}`);
      }
      handler = createStaticHandler({
        root: this.resolved.root,
        realRoot,
        inject: staticOverlayTag(this.apiKey),
        log: this.log,
        onServe: (file) => this.watcher?.noteServed(file),
      });
      upgrade = (_req, socket) => socket.destroy(); // no websockets to forward
    } else {
      const origin = new URL(this.targetUrl.origin);
      handler = createProxyHandler(origin, { injectTag: overlayTag(this.apiKey), selfOrigins: this.selfOrigins, log: this.log });
      upgrade = createUpgradeHandler(origin, { selfOrigins: this.selfOrigins, log: this.log });
    }

    const server = http.createServer((req, res) => {
      if (!this.hostAllowed(req.headers.host)) {
        misdirected(res);
        return;
      }
      const path = (req.url || "/").split("?")[0]!;
      if (path === "/__sumi" || path.startsWith("/__sumi/")) {
        this.handleSumi(req, res).catch((err) => this.sendError(res, err));
        return;
      }
      handler(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      if (!this.hostAllowed(req.headers.host)) {
        socket.end("HTTP/1.1 421 Misdirected Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      if ((req.url || "").startsWith("/__sumi")) {
        socket.destroy();
        return;
      }
      upgrade(req, socket, head);
    });
    server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      else socket.destroy();
    });
    // Long-polls can last up to MAX_WAIT_MS.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE") {
          reject(
            new PortInUseError(
              `Port ${this.port} is already in use. Stop whatever is using it, or pick another port with --port <n>.`,
            ),
          );
        } else if (err.code === "EACCES") {
          reject(new Error(`Not allowed to listen on port ${this.port}. Pick another port with --port <n>.`));
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.port, "127.0.0.1");
    });

    try {
      // Browsers try [::1] first for "localhost": if another app answers there, use 127.0.0.1.
      if (await canConnect("::1", this.port)) {
        this.reviewUrl = this.urlFor("127.0.0.1");
        this.log(`sumi: another app listens on [::1]:${this.port}; using ${this.reviewUrl}`);
      }
      this.store.reviewUrl = this.reviewUrl;
      // One process per session file: two writers would overwrite each other's notes.
      if (this.store.file) {
        this.lockFile = this.store.file + ".lock";
        acquireLock(this.lockFile, { pid: process.pid, port: this.port, reviewUrl: this.reviewUrl });
      }
      if (this.writeKey) {
        writeKeyFile(this.port, this.apiKey);
        this.keyWritten = true;
      }
    } catch (e) {
      if (this.lockFile) releaseLock(this.lockFile, this.port);
      this.lockFile = null;
      await closeServer(server, this.sockets);
      throw e;
    }

    server.on("error", (e) => this.log(`sumi: server error: ${e.message}`));
    this.server = server;
    this.store.setPersist(true);
    if (realRoot) this.startWatcher(realRoot);
    return { reviewUrl: this.reviewUrl };
  }

  private startWatcher(realRoot: string): void {
    const w = new StaticWatcher(realRoot, { log: this.log });
    w.on("change", (ev: LiveChange) => this.broadcast("change", ev));
    try {
      w.start();
    } catch (e) {
      this.log(`sumi: live reload is off (${(e as Error).message})`);
    }
    this.watcher = w;
  }

  /** Send one server-sent event to every connected overlay. */
  private broadcast(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(msg);
      } catch {
        this.sse.delete(res);
      }
    }
  }

  /** Stop listening. `keepSessionFile`: hand the session file to another instance (no final write). */
  async stop(opts: { keepSessionFile?: boolean } = {}): Promise<void> {
    const server = this.server;
    this.server = null;
    this.watcher?.close();
    this.watcher = null;
    for (const res of this.sse) res.end();
    this.sse.clear();
    this.store.releaseWaiters();
    if (!opts.keepSessionFile) this.store.flush();
    this.store.setPersist(false);
    if (this.lockFile) releaseLock(this.lockFile, this.port);
    this.lockFile = null;
    if (this.keyWritten) removeKeyFile(this.port, this.apiKey);
    this.keyWritten = false;
    if (!server) return;
    await closeServer(server, this.sockets);
  }

  // ---------- /__sumi/* ----------

  private async handleSumi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", "http://sumi.local");
    const path = url.pathname;
    const method = (req.method || "GET").toUpperCase();
    res.setHeader(SUMI_HEADER, "1");

    if (path === "/__sumi/overlay.js") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method not allowed");
      let js: Buffer;
      try {
        js = await readFile(this.overlayPath);
      } catch {
        const msg = `/* sumi: overlay bundle not found. Run \`npm run build\`. */\nconsole.warn("sumi: overlay bundle not found; run npm run build");\n`;
        res.writeHead(404, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(msg);
        return;
      }
      // Revalidated on every load (no-cache + ETag): an unchanged bundle costs a 304, and the browser
      // keeps its compiled code cache for it. The bundle holds no secrets (the key is in the page's tag).
      const etag = `"${createHash("sha256").update(js).digest("base64url").slice(0, 27)}"`;
      const headers = {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
        etag,
        "x-content-type-options": "nosniff",
      };
      const inm = req.headers["if-none-match"];
      if (typeof inm === "string" && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, { ...headers, "content-length": js.length });
      res.end(method === "HEAD" ? undefined : js);
      return;
    }

    if (!path.startsWith("/__sumi/api/")) throw new HttpError(404, `unknown sumi path ${path}`);

    // Only Sumi's own pages may call the API: a foreign Origin is refused even with the key.
    const origin = req.headers.origin;
    if (origin !== undefined && !this.selfOrigins.includes(origin.toLowerCase())) throw new HttpError(403, "forbidden");
    const given = String(req.headers["x-sumi-key"] ?? url.searchParams.get("k") ?? "");
    if (!sameKey(given, this.apiKey)) throw new HttpError(403, "forbidden");
    if (method === "OPTIONS") throw new HttpError(405, "method not allowed");
    if (method !== "GET" && method !== "HEAD") {
      const hasBody = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"] || 0) > 0;
      const ctype = String(req.headers["content-type"] || "").split(";")[0]!.trim().toLowerCase();
      if ((hasBody || method === "POST" || method === "PATCH") && ctype !== "application/json") {
        throw new HttpError(415, "Content-Type must be application/json");
      }
    }

    const store = this.store;
    const route = path.slice("/__sumi/api/".length).replace(/\/+$/, "");
    let segs: string[];
    try {
      segs = route.split("/").map((s) => decodeURIComponent(s));
    } catch {
      throw new HttpError(400, "malformed URL encoding");
    }

    switch (true) {
      case route === "state" && method === "GET":
        return json(res, 200, store.state());

      case route === "annotations" && method === "GET":
        return json(res, 200, store.list(parseStatuses(url.searchParams.get("status"))));

      case route === "annotations" && method === "POST": {
        const body = await readJson<unknown>(req);
        return json(res, 200, store.upsert(body));
      }

      case route === "annotations" && method === "DELETE": {
        const statuses = parseStatuses(url.searchParams.get("status"));
        if (!statuses?.length) throw new HttpError(400, "status query parameter is required, e.g. ?status=resolved");
        return json(res, 200, { deleted: store.removeWhere(statuses) });
      }

      case segs.length === 2 && segs[0] === "annotations": {
        const id = segs[1]!;
        if (!ID_RE.test(id)) throw new HttpError(400, "invalid annotation id");
        if (method === "GET") {
          const a = store.get(id);
          if (!a) throw new HttpError(404, `no annotation with id ${id}`);
          return json(res, 200, a);
        }
        if (method === "PATCH") {
          const body = await readJson<Record<string, unknown>>(req);
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
          const a = store.patch(id, body);
          if (!a) throw new HttpError(404, `no annotation with id ${id}`);
          return json(res, 200, a);
        }
        if (method === "DELETE") {
          if (!store.remove(id)) throw new HttpError(404, `no annotation with id ${id}`);
          return json(res, 200, { ok: true });
        }
        throw new HttpError(405, "method not allowed");
      }

      case route === "send" && method === "POST": {
        const body = await readJson<{ ids?: unknown }>(req);
        return json(res, 200, { sent: store.send(requireIds(body?.ids)) });
      }

      case route === "resolve" && method === "POST": {
        const body = await readJson<{ ids?: unknown; reply?: unknown }>(req);
        if (body?.reply !== undefined && (typeof body.reply !== "string" || body.reply.length > LIMITS.reply)) {
          throw new HttpError(400, `reply must be a string of at most ${LIMITS.reply} characters`);
        }
        return json(res, 200, { resolved: store.resolve(requireIds(body?.ids), body?.reply as string | undefined) });
      }

      case route === "ask" && method === "POST": {
        const body = await readJson<{ id?: unknown; question?: unknown }>(req);
        if (
          typeof body?.id !== "string" ||
          !ID_RE.test(body.id) ||
          typeof body?.question !== "string" ||
          !body.question.trim() ||
          body.question.length > LIMITS.reply
        ) {
          throw new HttpError(400, `body must be { id: string, question: string (at most ${LIMITS.reply} characters) }`);
        }
        const a = store.ask(body.id, body.question);
        if (!a) throw new HttpError(404, `no annotation with id ${body.id}`);
        return json(res, 200, a);
      }

      case route === "markdown" && method === "GET": {
        const statuses = parseStatuses(url.searchParams.get("status")) ?? ["draft", "sent"];
        const mode = url.searchParams.get("mode") === "mcp" ? "mcp" : "clipboard";
        const items = store.list(statuses);
        const md = toMarkdown(items, { mode, url: this.target, root: this.root, title: items[0]?.page?.title });
        res.writeHead(200, {
          ...SUMI_PAGE_HEADERS,
          "content-type": "text/markdown; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(md);
        return;
      }

      case route === "events" && method === "GET": {
        if (this.mode !== "static") throw new HttpError(404, "live reload events exist only when Sumi serves local files");
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ live: this.liveReload })}\n\n`);
        this.sse.add(res);
        const ping = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {
            /* closed */
          }
        }, SSE_PING_MS);
        ping.unref?.();
        res.on("close", () => {
          clearInterval(ping);
          this.sse.delete(res);
        });
        return;
      }

      case route === "wait" && method === "GET": {
        const raw = Number(url.searchParams.get("timeout") ?? 50_000);
        const timeout = Number.isFinite(raw) ? Math.max(0, Math.min(raw, MAX_WAIT_MS)) : 50_000;
        const ac = new AbortController();
        const onClose = () => ac.abort();
        res.on("close", onClose);
        const annotations = await store.waitForSent(timeout, ac.signal);
        res.off("close", onClose);
        if (res.destroyed) return;
        return json(res, 200, { annotations });
      }

      default:
        throw new HttpError(404, `no route for ${method} ${path}`);
    }
  }

  private sendError(res: http.ServerResponse, err: unknown): void {
    const status = err instanceof HttpError ? err.status : err instanceof StoreError ? 400 : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) this.log(`sumi: internal error: ${message}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    json(res, status, { error: message });
  }
}

function misdirected(res: http.ServerResponse): void {
  const body = "Misdirected request: Sumi only answers requests addressed to localhost, 127.0.0.1 or [::1].\n";
  res.writeHead(421, {
    ...SUMI_PAGE_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(body);
}

function closeServer(server: http.Server, sockets: Set<import("node:net").Socket>): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const s of sockets) s.destroy();
    sockets.clear();
  });
}

function sameKey(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Does something accept TCP connections on host:port (within `ms`)? */
function canConnect(host: string, port: number, ms = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** Does `target` answer /__sumi/api/state like a Sumi server? (Proxying to a Sumi would loop or nest.) */
export function looksLikeSumi(target: URL, ms = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const req = mod.request(
      {
        method: "GET",
        hostname: bareHost(target.hostname),
        port: target.port || (isHttps ? 443 : 80),
        path: "/__sumi/api/state",
        headers: { host: target.host, accept: "application/json" },
        timeout: ms,
        ...(isHttps ? { rejectUnauthorized: !isLoopbackHost(target.hostname) } : {}),
      },
      (res) => {
        if (res.headers[SUMI_HEADER] !== undefined) {
          res.resume();
          resolve(true);
          return;
        }
        // Older Sumi builds: no header, but a 200 JSON state with reviewUrl + revision.
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (body.length < 65536) body += c;
        });
        res.on("end", () => {
          try {
            const j = JSON.parse(body) as Record<string, unknown>;
            resolve(typeof j?.reviewUrl === "string" && typeof j?.revision === "number");
          } catch {
            resolve(false);
          }
        });
        res.on("error", () => resolve(false));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, {
    ...SUMI_PAGE_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(s),
  });
  res.end(s);
}

function parseStatuses(q: string | null): AnnotationStatus[] | undefined {
  if (!q) return undefined;
  const out: AnnotationStatus[] = [];
  for (const part of q.split(",")) {
    const s = part.trim() as AnnotationStatus;
    if (!s) continue;
    if (!STATUSES.includes(s)) throw new HttpError(400, `unknown status "${s.slice(0, 40)}" (expected ${STATUSES.join(", ")})`);
    out.push(s);
  }
  return out;
}

function requireIds(ids: unknown): string[] {
  const r = idsSchema.safeParse(ids);
  if (!r.success) throw new HttpError(400, `body must include ids: string[] (at most ${LIMITS.idList} valid ids)`);
  return r.data;
}

function readJson<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > LIMITS.bodyBytes) {
      req.resume();
      reject(new HttpError(413, `request body larger than ${LIMITS.bodyBytes} bytes`));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > LIMITS.bodyBytes) {
        failed = true;
        reject(new HttpError(413, `request body larger than ${LIMITS.bodyBytes} bytes`));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
    req.on("end", () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return resolve({} as T);
      try {
        resolve(JSON.parse(text) as T);
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
  });
}

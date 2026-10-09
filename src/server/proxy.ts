/**
 * Hand-rolled reverse proxy: forwards HTTP(S) to the target, injects the
 * overlay <script> into HTML, strips CSP / frame headers, rewrites Location,
 * and tunnels WebSocket upgrades (Vite / Next HMR).
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import type { Duplex } from "node:stream";
import { injectOverlay } from "./stamp";

export interface ProxyOptions {
  injectTag: string;
  /** Origins the browser may use for Sumi itself (http://localhost:<port>, ...). */
  selfOrigins: string[];
  log?: (s: string) => void;
}

const STRIP_RESPONSE = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
]);

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Headers on every page Sumi writes itself: never framed by another site. */
export const SUMI_PAGE_HEADERS: http.OutgoingHttpHeaders = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

/** Largest HTML response buffered for injection; bigger pages pass through without the overlay. */
const MAX_HTML_BYTES = 16 * 1024 * 1024;
/** Largest decompressed HTML. */
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
/** Self-signed certificates are normal for local dev servers: accepted for loopback targets only. */
const httpsLoopbackAgent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

/** "[::1]" -> "::1" (URL.hostname keeps the brackets; sockets and http.request want them off). */
export function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = bareHost(hostname).toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (net.isIPv4(h)) return h.startsWith("127.");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return !!mapped && mapped[1]!.startsWith("127.");
}

/** The origin the browser used to reach Sumi (the Host header is checked against the allowlist first). */
function proxyOrigin(req: http.IncomingMessage): string {
  return `http://${req.headers.host || "localhost"}`;
}

/** Replace a leading Sumi origin with the target origin (for Origin / Referer). */
function swapOrigin(value: string, from: string[], to: string): string {
  for (const f of from) {
    if (value === f || value.startsWith(f + "/")) return to + value.slice(f.length);
  }
  return value;
}

function buildRequestHeaders(req: http.IncomingMessage, target: URL, selfOrigins: string[]): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k)) continue;
    headers[k] = v;
  }
  headers.host = target.host;
  headers["accept-encoding"] = "identity";
  if (typeof headers.origin === "string") headers.origin = swapOrigin(headers.origin, selfOrigins, target.origin);
  if (typeof headers.referer === "string") headers.referer = swapOrigin(headers.referer, selfOrigins, target.origin);
  // A chunked body is re-chunked on the way out. Node does not frame bodies of GET/DELETE/OPTIONS
  // by default, which would let the body bytes reach the upstream as a second request.
  if (req.headers["transfer-encoding"] !== undefined) {
    delete headers["content-length"];
    headers["transfer-encoding"] = "chunked";
  }
  // Page navigations: never let the upstream answer 304 to a cached copy of HTML we rewrote,
  // or the browser keeps serving a page with a stale (or missing) overlay tag.
  if (String(req.headers.accept || "").includes("text/html")) {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }
  // Note: no x-forwarded-host. Host and Origin both point at the target so framework
  // same-origin checks (e.g. Next.js server actions) stay consistent.
  return headers;
}

/** Absolute redirects to the target's own origin come back through Sumi; others are left alone. */
function rewriteLocation(loc: string, target: URL, origin: string): string {
  if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(loc)) return loc; // relative: already fine
  let u: URL;
  try {
    u = new URL(loc, target);
  } catch {
    return loc;
  }
  if (u.origin !== target.origin) return loc;
  return origin + u.pathname + u.search + u.hash;
}

function filterResponseHeaders(
  headers: http.IncomingHttpHeaders,
  target: URL,
  origin: string,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || STRIP_RESPONSE.has(k) || HOP_BY_HOP.has(k)) continue;
    out[k] = v;
  }
  if (typeof out.location === "string") out.location = rewriteLocation(out.location, target, origin);
  return out;
}

/** Insert the overlay tag before the real </head> (else </body>, else at the end). */
export function injectIntoHtml(html: string, tag: string): string {
  return injectOverlay(html, tag);
}

function decode(buf: Buffer, encoding: string | undefined): Buffer {
  const opts = { maxOutputLength: MAX_DECODED_BYTES };
  switch ((encoding || "").trim().toLowerCase()) {
    case "":
    case "identity":
      return buf;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buf, opts);
    case "deflate":
      return zlib.inflateSync(buf, opts);
    case "br":
      return zlib.brotliDecompressSync(buf, opts);
    default:
      throw new Error(`unsupported content-encoding ${encoding}`);
  }
}

/** Readable error text; Node's happy-eyeballs connect errors are AggregateErrors with an empty message. */
export function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { errors?: unknown[] };
  const code = e?.code;
  let msg = e?.message || "";
  if (!msg && Array.isArray(e?.errors) && e.errors.length) {
    msg = e.errors.map((x) => (x as Error)?.message).filter(Boolean).join("; ");
  }
  if (!msg) msg = String(err);
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function errorPage(target: URL, detail: string, injectTag: string): string {
  const t = escapeHtml(target.origin);
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sumi · can't reach ${t}</title>
<style>
  body{font:16px/1.5 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a}
  main{max-width:34rem;padding:2rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  code{background:#e2e8f0;padding:.1rem .35rem;border-radius:.3rem}
  p.small{color:#64748b;font-size:.85rem}
  @media (prefers-color-scheme: dark){body{background:#0f172a;color:#e2e8f0}code{background:#1e293b}p.small{color:#94a3b8}}
</style>
${injectTag}</head><body><main>
<h1>Sumi can't reach ${t}. Is your app running?</h1>
<p>Start your dev server (for example <code>npm run dev</code>), then reload this page.</p>
<p class="small">${escapeHtml(detail)}</p>
</main></body></html>`;
}

export function createProxyHandler(
  target: URL,
  opts: ProxyOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const log = opts.log ?? (() => {});
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;
  const loopback = isLoopbackHost(target.hostname);
  const agent = isHttps ? (loopback ? httpsLoopbackAgent : httpsAgent) : httpAgent;
  const hostname = bareHost(target.hostname);

  return (req, res) => {
    const origin = proxyOrigin(req);
    const upstream = transport.request({
      protocol: target.protocol,
      hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: req.url || "/",
      headers: buildRequestHeaders(req, target, opts.selfOrigins),
      agent,
      ...(isHttps ? { servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: !loopback } : {}),
    });

    const fail = (err: Error) => {
      if (res.destroyed || res.writableEnded) return; // client went away
      log(`sumi: ${req.method} ${req.url} -> ${errorText(err)}`);
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      const body = errorPage(target, errorText(err), opts.injectTag);
      res.writeHead(502, {
        ...SUMI_PAGE_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
    };

    upstream.on("error", fail);
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });

    upstream.on("response", (up) => {
      const status = up.statusCode ?? 502;
      const headers = filterResponseHeaders(up.headers, target, origin);
      const ctype = String(up.headers["content-type"] || "").toLowerCase();
      const canHaveBody = req.method !== "HEAD" && status !== 204 && status !== 304 && !(status >= 100 && status < 200);

      const passThrough = (already: Buffer[]) => {
        res.writeHead(status, up.statusMessage, headers);
        for (const c of already) res.write(c);
        up.pipe(res);
        up.on("error", (e) => res.destroy(e));
      };

      if (!ctype.includes("text/html") || !canHaveBody) {
        passThrough([]);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let streaming = false;
      const onData = (c: Buffer) => {
        chunks.push(c);
        size += c.length;
        if (size > MAX_HTML_BYTES) {
          // Too big to rewrite in memory: send it as is, without the overlay.
          streaming = true;
          up.off("data", onData);
          up.off("end", onEnd);
          up.pause();
          log(`sumi: ${req.url} is larger than ${MAX_HTML_BYTES >> 20} MB; served without the overlay`);
          passThrough(chunks.splice(0));
        }
      };
      const onEnd = () => {
        if (streaming) return;
        const raw = Buffer.concat(chunks);
        let html: string;
        let latin1 = false;
        try {
          const buf = decode(raw, up.headers["content-encoding"]);
          try {
            html = new TextDecoder("utf-8", { fatal: true }).decode(buf);
          } catch {
            html = buf.toString("latin1"); // byte-for-byte round trip for legacy charsets
            latin1 = true;
          }
        } catch (e) {
          // Could not decode (or too large once decoded): pass through untouched rather than corrupt it.
          log(`sumi: ${req.url}: ${(e as Error).message}; served without the overlay`);
          headers["content-length"] = raw.length;
          res.writeHead(status, up.statusMessage, headers);
          res.end(raw);
          return;
        }
        delete headers["content-encoding"];
        const injected = injectIntoHtml(html, opts.injectTag);
        const body = latin1 ? Buffer.from(injected, "latin1") : Buffer.from(injected, "utf8");
        headers["content-length"] = body.length;
        // The body is ours now: drop the upstream validators and do not let it be cached.
        delete headers["etag"];
        delete headers["last-modified"];
        headers["cache-control"] = "no-store";
        res.writeHead(status, up.statusMessage, headers);
        res.end(body);
      };
      up.on("data", onData);
      up.on("end", onEnd);
      up.on("error", fail);
    });

    req.pipe(upstream);
  };
}

export function createUpgradeHandler(
  target: URL,
  opts: { selfOrigins: string[]; log?: (s: string) => void },
): (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void {
  const log = opts.log ?? (() => {});
  const isHttps = target.protocol === "https:";
  const port = Number(target.port || (isHttps ? 443 : 80));
  const hostname = bareHost(target.hostname);
  const loopback = isLoopbackHost(target.hostname);

  return (req, socket, head) => {
    const upstream: net.Socket = isHttps
      ? tls.connect({
          host: hostname,
          port,
          servername: net.isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: !loopback,
        })
      : net.connect({ host: hostname, port });

    const destroyBoth = (err?: Error) => {
      if (err) log(`sumi: websocket ${req.url} -> ${errorText(err)}`);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", destroyBoth);
    socket.on("error", destroyBoth);
    upstream.on("close", () => socket.destroy());
    socket.on("close", () => upstream.destroy());

    upstream.once(isHttps ? "secureConnect" : "connect", () => {
      let head1 = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      const raw = req.rawHeaders;
      for (let i = 0; i < raw.length; i += 2) {
        const name = raw[i]!;
        let value = raw[i + 1]!;
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) continue;
        const lower = name.toLowerCase();
        if (lower === "host") value = target.host;
        else if (lower === "origin") value = swapOrigin(value, opts.selfOrigins, target.origin);
        head1 += `${name}: ${value}\r\n`;
      }
      head1 += "\r\n";
      upstream.write(head1);
      if (head && head.length) upstream.write(head);
      if ("setNoDelay" in socket && typeof (socket as net.Socket).setNoDelay === "function") {
        (socket as net.Socket).setNoDelay(true);
      }
      upstream.setNoDelay(true);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
  };
}

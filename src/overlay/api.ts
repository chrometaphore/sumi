/** Thin fetch client for the Sumi HTTP API (same origin as the reviewed page). */
import type { Annotation, StateResponse } from "../shared/types";

/** Prefix for Sumi URLs (same origin unless window.__SUMI_BASE__ says otherwise). */
export function base(): string {
  try {
    return String((window as any).__SUMI_BASE__ || "");
  } catch {
    return "";
  }
}

function keyFromSrc(src: string | null | undefined): string {
  if (!src) return "";
  try {
    return new URL(src, location.href).searchParams.get("k") || "";
  } catch {
    return "";
  }
}

/**
 * The session key the server put on our own script tag (`/__sumi/overlay.js?k=…`). Read once, while
 * the bundle evaluates (document.currentScript is only set then); the tag is the fallback.
 */
function readKey(): string {
  try {
    const cs = document.currentScript as HTMLScriptElement | null;
    const k = keyFromSrc(cs && cs.src);
    if (k) return k;
  } catch {
    /* fall through */
  }
  try {
    for (const s of Array.from(document.querySelectorAll<HTMLScriptElement>('script[src*="/__sumi/overlay.js"]'))) {
      const k = keyFromSrc(s.src);
      if (k) return k;
    }
  } catch {
    /* no key: the server answers 403 and the overlay shows as offline */
  }
  return "";
}

const KEY = readKey();

export function sessionKey(): string {
  return KEY;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function req(method: string, path: string, body?: unknown, timeoutMs = 8000): Promise<Response> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
  const headers: Record<string, string> = { Accept: "application/json" };
  // Every non-GET request is JSON, with or without a body (the server refuses anything else).
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (KEY) headers["X-Sumi-Key"] = KEY;
  try {
    const res = await fetch(base() + "/__sumi/api" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res.ok) throw new ApiError(`${method} ${path} -> HTTP ${res.status}`, res.status);
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await req(method, path, body);
  return (await res.json()) as T;
}

export const api = {
  state: () => json<StateResponse>("GET", "/state"),
  upsert: (a: Annotation) => json<Annotation>("POST", "/annotations", a),
  patch: (id: string, patch: Partial<Annotation>) => json<Annotation>("PATCH", "/annotations/" + encodeURIComponent(id), patch),
  remove: (id: string) => json<{ ok: boolean }>("DELETE", "/annotations/" + encodeURIComponent(id)),
  send: (ids: string[]) => json<{ sent: number }>("POST", "/send", { ids }),
  clearResolved: () => json<{ deleted: number }>("DELETE", "/annotations?status=resolved"),
  markdown: async (status: string, mode: "clipboard" | "mcp"): Promise<string> => {
    const res = await req("GET", `/markdown?status=${status.replace(/[^a-z,-]/g, "")}&mode=${mode}`);
    return res.text();
  },
  /** Server-sent events URL (EventSource cannot send headers: the key goes in the query). */
  eventsUrl: (): string => base() + "/__sumi/api/events" + (KEY ? "?k=" + encodeURIComponent(KEY) : ""),
};

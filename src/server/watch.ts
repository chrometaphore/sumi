/**
 * Live reload for static mode: watch the served folder and emit debounced
 * "change" events with the root-relative paths of changed web files (html, css, js, images, ...).
 *
 * macOS / Windows: one recursive fs.watch on the root. Linux (no reliable
 * recursive watch): the root plus the directory of every file served, each
 * watched non-recursively.
 */
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isWebAsset } from "./static";

export interface ChangeEvent {
  /** Paths relative to the root, "/" separators, sorted. */
  files: string[];
  /** True when every changed file is a .css file (the page can hot-swap stylesheets). */
  css: boolean;
}

export interface WatcherOptions {
  debounceMs?: number;
  /** Upper bound on how long a burst of events can postpone the notification. */
  maxWaitMs?: number;
  log?: (s: string) => void;
}

const MAX_DIRS = 256;

/** Editor scratch files and other noise that should never reload the page. */
export function ignoredPath(rel: string): boolean {
  if (!rel) return false;
  const segs = rel.split(/[\\/]/);
  if (segs.some((s) => s.startsWith(".") || s === "node_modules")) return true;
  const name = segs[segs.length - 1] ?? "";
  return (
    name.endsWith("~") ||
    /\.(swp|swx|swo|tmp|crswap)$/i.test(name) ||
    /___jb_(tmp|old)___$/.test(name) ||
    name === "4913" // vim's write probe
  );
}

export class StaticWatcher extends EventEmitter {
  private watchers = new Map<string, FSWatcher>();
  private pending = new Set<string>();
  private unknown = false;
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;
  private recursive = false;
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly log: (s: string) => void;

  constructor(readonly root: string, opts: WatcherOptions = {}) {
    super();
    this.debounceMs = opts.debounceMs ?? 80;
    this.maxWaitMs = opts.maxWaitMs ?? 400;
    this.log = opts.log ?? (() => {});
  }

  /** "recursive", "per-directory" or "off". */
  get kind(): string {
    if (!this.watchers.size) return "off";
    return this.recursive ? "recursive" : "per-directory";
  }

  start(): void {
    if (process.platform !== "linux") {
      try {
        const w = watch(this.root, { recursive: true }, (_ev, name) => this.onEvent(this.root, name));
        w.on("error", (e) => this.onError(this.root, e));
        this.watchers.set(this.root, w);
        this.recursive = true;
        return;
      } catch (e) {
        this.log(`sumi: recursive file watching unavailable (${(e as Error).message}); watching served folders only`);
      }
    }
    this.watchDir(this.root);
  }

  /** Linux fallback: also watch the directory of each file the browser asked for. */
  noteServed(file: string): void {
    if (this.recursive || this.closed) return;
    const dir = dirname(file);
    if (dir !== this.root && !dir.startsWith(this.root + sep)) return;
    this.watchDir(dir);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers.values()) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    this.watchers.clear();
    this.removeAllListeners();
  }

  private watchDir(dir: string): void {
    if (this.closed || this.watchers.has(dir) || this.watchers.size >= MAX_DIRS) return;
    const rel = relative(this.root, dir);
    if (rel && ignoredPath(rel)) return;
    try {
      const w = watch(dir, (_ev, name) => this.onEvent(dir, name));
      w.on("error", (e) => this.onError(dir, e));
      this.watchers.set(dir, w);
    } catch (e) {
      this.log(`sumi: cannot watch ${dir} (${(e as Error).message}); live reload is limited`);
    }
  }

  private onError(dir: string, e: Error): void {
    this.log(`sumi: file watcher for ${dir} stopped (${e.message})`);
    const w = this.watchers.get(dir);
    this.watchers.delete(dir);
    try {
      w?.close();
    } catch {
      /* ignore */
    }
  }

  private onEvent(dir: string, name: string | Buffer | null): void {
    if (this.closed) return;
    if (name == null || name === "") {
      this.unknown = true;
    } else {
      const rel = relative(this.root, join(dir, String(name))).split(sep).join("/");
      if (!rel || rel.startsWith("../") || ignoredPath(rel)) return;
      this.pending.add(rel);
    }
    const now = Date.now();
    if (!this.timer) this.firstAt = now;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstAt + this.maxWaitMs - now));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.timer = null;
    // Only files Sumi would serve: other names (folders, databases, editor state) never reach the page.
    const files = [...this.pending].filter(isWebAsset).sort();
    const unknown = this.unknown;
    this.pending.clear();
    this.unknown = false;
    if (!files.length && !unknown) return;
    const css = !unknown && files.length > 0 && files.every((f) => f.toLowerCase().endsWith(".css"));
    this.emit("change", { files, css } satisfies ChangeEvent);
  }
}

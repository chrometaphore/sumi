/**
 * AnnotationStore: in-memory annotation state with JSON persistence at
 * ~/.sumi/sessions/<host>_<port>_<project hash>.json (proxy) or static_<folder>_<hash>.json
 * (static files), and long-poll waiters for "sent" items.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  Annotation,
  AnnotationStatus,
  SessionMode,
  SessionSummary,
  StateResponse,
} from "../shared/types";
import { ensurePrivateDir, pidAlive, sumiDir } from "./runtime";
import { LIMITS, STATUSES as STATUS_LIST, parseAnnotation, repairAnnotation } from "./validate";

export const STATUSES: AnnotationStatus[] = [...STATUS_LIST];

/** Resolved notes older than this are dropped when a session is loaded. */
const RESOLVED_TTL_MS = 30 * 24 * 3600 * 1000;
/** An agent counts as listening for this long after its last wait ended. */
const LISTEN_GRACE_MS = 30_000;

export interface StoreOptions {
  target: string;
  reviewUrl: string;
  /** Defaults to "proxy". */
  mode?: SessionMode;
  /** Absolute folder being served (static mode). */
  root?: string;
  /** Explicit file path; `null` disables persistence; default derives from target (or root). */
  file?: string | null;
  /** Proxy mode: the project the session belongs to (default process.cwd()). */
  cwd?: string;
  saveDelayMs?: number;
  log?: (s: string) => void;
}

export interface ListFilter {
  status?: AnnotationStatus[];
  ids?: string[];
}

type Waiter = (items: Annotation[]) => void;

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/**
 * <host>_<port>_<hash of the project folder>.json: two projects that both run on localhost:3000 keep
 * separate notes.
 */
export function sessionFileFor(target: string, cwd: string = process.cwd()): string {
  const u = new URL(target);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const host = u.hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  return sumiDir("sessions", `${host}_${port}_${shortHash(cwd)}.json`);
}

/** static_<basename-of-root>_<8-char hash of the absolute root>.json */
export function staticSessionFileFor(root: string): string {
  const name = (basename(root) || "root").replace(/[^a-zA-Z0-9.-]/g, "_");
  return sumiDir("sessions", `static_${name}_${shortHash(root)}.json`);
}

export class AnnotationStore extends EventEmitter {
  readonly target: string;
  readonly mode: SessionMode;
  readonly root: string | undefined;
  reviewUrl: string;
  readonly file: string | null;
  revision = 0;
  /** Writes to `file` happen only while this is true (SumiServer turns it on once it holds the lock). */
  persist = false;
  private items = new Map<string, Annotation>();
  private waiters = new Set<Waiter>();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly saveDelayMs: number;
  private readonly log: (s: string) => void;
  private listening = 0;
  private listenEndedAt = 0;
  /** Unsaved changes (including repairs and pruning done while loading). */
  private dirty = false;

  constructor(opts: StoreOptions) {
    super();
    this.target = opts.target;
    this.mode = opts.mode ?? "proxy";
    this.root = opts.root;
    this.reviewUrl = opts.reviewUrl;
    this.file =
      opts.file !== undefined
        ? opts.file
        : this.mode === "static" && this.root
          ? staticSessionFileFor(this.root)
          : sessionFileFor(opts.target, opts.cwd);
    this.saveDelayMs = opts.saveDelayMs ?? 250;
    this.log = opts.log ?? (() => {});
    this.load();
  }

  // ---------- persistence ----------

  private load(): void {
    if (!this.file) return;
    this.cleanTempFiles();
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return; // no file yet
    }
    try {
      const data = JSON.parse(raw) as { revision?: unknown; annotations?: unknown };
      const list = Array.isArray(data?.annotations) ? data.annotations : [];
      const cutoff = Date.now() - RESOLVED_TTL_MS;
      let dropped = 0;
      let repaired = 0;
      let pruned = 0;
      for (const item of list) {
        const r = repairAnnotation(item);
        if ("error" in r) {
          dropped++;
          const id = typeof (item as { id?: unknown })?.id === "string" ? (item as { id: string }).id.slice(0, 64) : "?";
          this.log(`sumi: dropped an invalid note from the session file (id ${id}: ${r.error})`);
          continue;
        }
        const a = r.value;
        if (r.repaired) repaired++;
        if (a.status === "resolved" && a.resolvedAt && Date.parse(a.resolvedAt) < cutoff) {
          pruned++;
          continue;
        }
        if (this.items.size >= LIMITS.annotations) {
          dropped++;
          continue;
        }
        this.items.set(a.id, a);
      }
      if (repaired) this.log(`sumi: trimmed ${repaired} over-long note${repaired === 1 ? "" : "s"} in the session file`);
      if (pruned) this.log(`sumi: removed ${pruned} resolved note${pruned === 1 ? "" : "s"} older than 30 days`);
      if (dropped > 0 && list.length > LIMITS.annotations) this.log(`sumi: kept the first ${LIMITS.annotations} notes`);
      if (typeof data?.revision === "number" && Number.isFinite(data.revision)) {
        this.revision = data.revision;
      }
      if (dropped || repaired || pruned) this.dirty = true;
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        renameSync(this.file, backup);
      } catch {
        /* ignore */
      }
      this.log(`sumi: session file was unreadable (${(err as Error).message}); moved to ${backup}`);
    }
  }

  /** Remove `<file>.tmp-<pid>` leftovers of processes that died mid-write. */
  private cleanTempFiles(): void {
    if (!this.file) return;
    const dir = dirname(this.file);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /\.tmp-(\d+)$/.exec(name);
      if (!m) continue;
      const p = join(dir, name);
      const pid = Number(m[1]);
      let old = false;
      try {
        old = Date.now() - statSync(p).mtimeMs > 3600_000;
      } catch {
        continue;
      }
      if (pid === process.pid || !pidAlive(pid) || old) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Turn writes on (after the session lock is held) or off (before stopping). */
  setPersist(on: boolean): void {
    this.persist = on;
    if (on && this.dirty) this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.file || !this.persist) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  /** Write to disk now (synchronously). Safe to call on shutdown. */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.file || !this.persist) return;
    try {
      ensurePrivateDir(dirname(this.file));
      const tmp = `${this.file}.tmp-${process.pid}`;
      const body = JSON.stringify({
        version: 1,
        target: this.target,
        ...(this.root ? { root: this.root } : {}),
        revision: this.revision,
        annotations: this.list(),
      });
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch (err) {
      this.log(`sumi: could not save session (${(err as Error).message})`);
    }
  }

  private changed(): void {
    this.revision++;
    this.dirty = true;
    this.scheduleSave();
    this.emit("change", this.revision);
    this.wakeWaiters();
  }

  // ---------- queries ----------

  get(id: string): Annotation | undefined {
    return this.items.get(id);
  }

  get size(): number {
    return this.items.size;
  }

  list(filter?: ListFilter | AnnotationStatus[]): Annotation[] {
    const f: ListFilter = Array.isArray(filter) ? { status: filter } : filter ?? {};
    let out = [...this.items.values()];
    if (f.status && f.status.length) {
      const set = new Set(f.status);
      out = out.filter((a) => set.has(a.status));
    }
    if (f.ids) {
      const set = new Set(f.ids);
      out = out.filter((a) => set.has(a.id));
    }
    return out.sort((a, b) => a.n - b.n || a.createdAt.localeCompare(b.createdAt));
  }

  /** True while an agent waits for notes, or did less than 30 s ago. */
  get agentListening(): boolean {
    return this.listening > 0 || Date.now() - this.listenEndedAt < LISTEN_GRACE_MS;
  }

  state(): StateResponse {
    return {
      target: this.target,
      reviewUrl: this.reviewUrl,
      mode: this.mode,
      ...(this.root ? { root: this.root } : {}),
      revision: this.revision,
      annotations: this.list(),
      agentListening: this.agentListening,
    };
  }

  summary(): SessionSummary {
    const counts: Record<AnnotationStatus, number> = { draft: 0, sent: 0, "needs-input": 0, resolved: 0 };
    for (const a of this.items.values()) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return {
      target: this.target,
      reviewUrl: this.reviewUrl,
      mode: this.mode,
      ...(this.root ? { root: this.root } : {}),
      counts,
    };
  }

  // ---------- mutations ----------

  /** Insert or replace by id. Throws StoreError (HTTP 400) on invalid input. */
  upsert(input: unknown): Annotation {
    const r = parseAnnotation(input);
    if (!r.ok) throw new StoreError(`invalid annotation: ${r.error}`);
    const a = r.value;
    const prev = this.items.get(a.id);
    if (!prev && this.items.size >= LIMITS.annotations) {
      throw new StoreError(`this session already has ${LIMITS.annotations} notes; clear resolved ones first`);
    }
    if (prev && prev.status !== a.status) stampStatus(a, prev.status);
    else if (!prev) stampStatus(a, undefined);
    this.items.set(a.id, a);
    this.changed();
    return a;
  }

  /** Merge `partial` into an existing note. Throws StoreError when the result is invalid. */
  patch(id: string, partial: Partial<Annotation>): Annotation | undefined {
    const prev = this.items.get(id);
    if (!prev) return undefined;
    const { id: _ignored, ...rest } = partial ?? {};
    const r = parseAnnotation({ ...prev, ...rest, id });
    if (!r.ok) throw new StoreError(`invalid annotation: ${r.error}`);
    const next = r.value;
    // Answering a question hands the item back to Claude.
    if (
      partial.status === undefined &&
      prev.status === "needs-input" &&
      typeof partial.answer === "string" &&
      partial.answer.trim() !== ""
    ) {
      next.status = "sent";
    }
    if (next.status !== prev.status) stampStatus(next, prev.status);
    this.items.set(id, next);
    this.changed();
    return next;
  }

  remove(id: string): boolean {
    const ok = this.items.delete(id);
    if (ok) this.changed();
    return ok;
  }

  removeWhere(status: AnnotationStatus | AnnotationStatus[]): number {
    const set = new Set(Array.isArray(status) ? status : [status]);
    let n = 0;
    for (const [id, a] of this.items) {
      if (set.has(a.status)) {
        this.items.delete(id);
        n++;
      }
    }
    if (n) this.changed();
    return n;
  }

  send(ids: string[]): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const id of ids ?? []) {
      const a = this.items.get(id);
      if (!a) continue;
      a.status = "sent";
      a.sentAt = now;
      n++;
    }
    if (n) this.changed();
    return n;
  }

  resolve(ids: string[], reply?: string): number {
    const now = new Date().toISOString();
    let n = 0;
    for (const id of ids ?? []) {
      const a = this.items.get(id);
      if (!a) continue;
      a.status = "resolved";
      a.resolvedAt = now;
      if (reply !== undefined && reply !== "") a.reply = reply.slice(0, LIMITS.reply);
      n++;
    }
    if (n) this.changed();
    return n;
  }

  ask(id: string, question: string): Annotation | undefined {
    const a = this.items.get(id);
    if (!a) return undefined;
    a.status = "needs-input";
    a.reply = question.slice(0, LIMITS.reply);
    delete a.answer;
    delete a.resolvedAt;
    this.changed();
    return a;
  }

  answer(id: string, text: string): Annotation | undefined {
    const a = this.items.get(id);
    if (!a) return undefined;
    a.answer = text.slice(0, LIMITS.reply);
    a.status = "sent";
    a.sentAt = new Date().toISOString();
    this.changed();
    return a;
  }

  // ---------- long-poll ----------

  /**
   * Resolves with every `sent` annotation as soon as at least one exists
   * (immediately if some already do), or with [] after `timeoutMs`.
   * While it is pending (and for 30 s after) the agent counts as listening.
   */
  waitForSent(timeoutMs: number, signal?: AbortSignal): Promise<Annotation[]> {
    const now = this.list(["sent"]);
    if (now.length || timeoutMs <= 0 || signal?.aborted) {
      this.listenEndedAt = Date.now();
      return Promise.resolve(now);
    }
    this.listening++;
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done: Waiter = (items) => {
        if (!this.waiters.delete(done)) return;
        this.listening = Math.max(0, this.listening - 1);
        this.listenEndedAt = Date.now();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(items);
      };
      const onAbort = () => done([]);
      timer = setTimeout(() => done([]), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.add(done);
    });
  }

  /** Release every pending waiter with [] (used on shutdown). */
  releaseWaiters(): void {
    for (const w of [...this.waiters]) w([]);
  }

  private wakeWaiters(): void {
    if (!this.waiters.size) return;
    const sent = this.list(["sent"]);
    if (!sent.length) return;
    for (const w of [...this.waiters]) w(sent);
  }
}

export class StoreError extends Error {}

/** Fill sentAt/resolvedAt when status transitions and they are missing. */
function stampStatus(a: Annotation, prev: AnnotationStatus | undefined): void {
  const now = new Date().toISOString();
  if (a.status === "sent" && (prev !== "sent" || !a.sentAt)) a.sentAt = a.sentAt && prev === undefined ? a.sentAt : now;
  if (a.status === "resolved" && !a.resolvedAt) a.resolvedAt = now;
}

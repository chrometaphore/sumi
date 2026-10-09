/**
 * Per-user runtime files under ~/.sumi:
 *   run/<port>.key        the running server's API key (read by `sumi wait`), 0600 in a 0700 dir
 *   sessions/<x>.json.lock  { pid, port, reviewUrl } of the process that owns a session file
 */
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function sumiDir(...parts: string[]): string {
  return join(homedir(), ".sumi", ...parts);
}

/** mkdir -p with mode 0700, tightening the mode of an existing ~/.sumi folder as well. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [dir, dirname(dir)]) {
    if (!d.startsWith(sumiDir())) continue;
    try {
      chmodSync(d, 0o700);
    } catch {
      /* not ours to change */
    }
  }
}

export function keyFileFor(port: number): string {
  return sumiDir("run", `${port}.key`);
}

export function writeKeyFile(port: number, key: string): string {
  const file = keyFileFor(port);
  ensurePrivateDir(dirname(file));
  try {
    unlinkSync(file); // a stale file may have another owner or mode
  } catch {
    /* none */
  }
  writeFileSync(file, key + "\n", { mode: 0o600, flag: "wx" });
  return file;
}

export function readKeyFile(port: number): string | null {
  try {
    const k = readFileSync(keyFileFor(port), "utf8").trim();
    return k || null;
  } catch {
    return null;
  }
}

/** Delete the key file, but only if it still holds our key (another instance may own the port now). */
export function removeKeyFile(port: number, key: string): void {
  if (readKeyFile(port) !== key) return;
  try {
    unlinkSync(keyFileFor(port));
  } catch {
    /* gone */
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockInfo {
  pid: number;
  port: number;
  reviewUrl?: string;
}

export class SessionLockedError extends Error {
  readonly code = "ESUMILOCKED";
  constructor(readonly holder: LockInfo, readonly file: string) {
    super(
      `This page is already being reviewed by another Sumi (process ${holder.pid}) at ` +
        `${holder.reviewUrl ?? `http://localhost:${holder.port}`}. Use that review, or stop it first.`,
    );
  }
}

export function readLock(lockFile: string): LockInfo | null {
  try {
    const d = JSON.parse(readFileSync(lockFile, "utf8")) as Partial<LockInfo>;
    if (typeof d.pid !== "number" || typeof d.port !== "number") return null;
    return { pid: d.pid, port: d.port, ...(typeof d.reviewUrl === "string" ? { reviewUrl: d.reviewUrl } : {}) };
  } catch {
    return null;
  }
}

/**
 * Take the lock for a session file. A lock held by a live process other than this one throws
 * SessionLockedError; a stale lock (dead pid, unreadable) is taken over. This process may re-take
 * its own lock (a restart on another port), which hands the lock to the new port.
 */
export function acquireLock(lockFile: string, info: LockInfo): void {
  ensurePrivateDir(dirname(lockFile));
  const body = JSON.stringify(info);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(lockFile, body, { mode: 0o600, flag: "wx" });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const held = readLock(lockFile);
    if (held && held.pid !== process.pid && pidAlive(held.pid)) throw new SessionLockedError(held, lockFile);
    try {
      unlinkSync(lockFile);
    } catch {
      /* raced with someone else; retry */
    }
  }
  throw new Error(`Could not lock ${lockFile}.`);
}

/** Remove the lock if this process (and this port) still holds it. */
export function releaseLock(lockFile: string, port: number): void {
  const held = readLock(lockFile);
  if (!held || held.pid !== process.pid || held.port !== port) return;
  try {
    unlinkSync(lockFile);
  } catch {
    /* gone */
  }
}

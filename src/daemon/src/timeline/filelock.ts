/**
 * Cross-process file lock for timeline writes.
 *
 * The lock is a DIRECTORY created with `fs.mkdirSync` — `mkdir` is atomic and
 * fails with EEXIST if the directory already exists, which is the classic
 * portable cross-process mutex (no O_EXCL file races, works the same on every
 * platform Node supports). A `meta` file inside records the holder pid + acquire
 * time so a crashed holder's lock can be reclaimed once it goes stale.
 *
 * Synchronous + non-blocking by design: `acquireLock` returns immediately with
 * true/false and the caller decides whether to retry/back off. That keeps the
 * timeline module's append path simple and matches alook's `execenv/filelock.ts`.
 */
import * as fs from "fs";

/** Default age after which a held lock is considered stale and may be reclaimed. */
export const DEFAULT_STALE_MS = 30_000;

const META = "meta.json";

/**
 * Try to acquire the lock at `lockPath`. Returns true if acquired, false if the
 * lock is held (and not yet stale). Synchronous, non-blocking — callers retry/
 * back off themselves. A lock older than `staleMs` is reclaimed (one attempt).
 */
export function acquireLock(lockPath: string, staleMs: number = DEFAULT_STALE_MS): boolean {
  if (tryMkdir(lockPath)) {
    writeMeta(lockPath);
    return true;
  }

  if (isStale(lockPath, staleMs)) {
    reclaim(lockPath);
    if (tryMkdir(lockPath)) {
      writeMeta(lockPath);
      return true;
    }
  }
  return false;
}

/** Release a lock previously acquired with `acquireLock`. Idempotent / best-effort. */
export function releaseLock(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* best-effort: a concurrent reclaim may have removed it already */
  }
}

export function lockPathFor(dir: string, filename: string): string {
  return `${dir}/.${filename}.lock`;
}

function tryMkdir(lockPath: string): boolean {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    // A missing PARENT dir (ENOENT) is a real config error — surface it.
    throw err;
  }
}

function writeMeta(lockPath: string): void {
  try {
    fs.writeFileSync(`${lockPath}/${META}`, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
  } catch {
    /* meta is advisory (for stale detection); acquisition already succeeded */
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  try {
    const raw = fs.readFileSync(`${lockPath}/${META}`, "utf8");
    const acquiredAt = (JSON.parse(raw) as { acquiredAt?: number }).acquiredAt;
    if (typeof acquiredAt === "number") return Date.now() - acquiredAt > staleMs;
  } catch {

  }

  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return false; // lock vanished — let the retry mkdir decide
  }
}

function reclaim(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* someone else may be reclaiming concurrently — the retry mkdir resolves it */
  }
}

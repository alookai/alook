import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { acquireLock, releaseLock, lockPathFor, DEFAULT_STALE_MS } from "./filelock";

let dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "filelock-test-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("filelock", () => {
  it("lockPathFor is a hidden sibling of the target file", () => {
    expect(lockPathFor("/a/b", "2026-06-25.jsonl")).toBe("/a/b/.2026-06-25.jsonl.lock");
  });

  it("acquire succeeds once, then is mutually exclusive until released", () => {
    const lp = lockPathFor(tmpDir(), "day.jsonl");
    expect(acquireLock(lp)).toBe(true);
    expect(acquireLock(lp)).toBe(false); // held
    expect(acquireLock(lp)).toBe(false); // still held
    releaseLock(lp);
    expect(acquireLock(lp)).toBe(true); // reacquirable after release
    releaseLock(lp);
  });

  it("releaseLock is idempotent (no throw on a non-held lock)", () => {
    const lp = lockPathFor(tmpDir(), "day.jsonl");
    expect(() => releaseLock(lp)).not.toThrow();
    acquireLock(lp);
    releaseLock(lp);
    expect(() => releaseLock(lp)).not.toThrow();
  });

  it("reclaims a stale lock (meta older than staleMs)", () => {
    const lp = lockPathFor(tmpDir(), "day.jsonl");
    expect(acquireLock(lp)).toBe(true);
    // Forge an old acquire time in the lock's meta.
    fs.writeFileSync(`${lp}/meta.json`, JSON.stringify({ pid: 999999, acquiredAt: Date.now() - 60_000 }));
    // A fresh acquirer with a 1ms stale window reclaims it.
    expect(acquireLock(lp, 1)).toBe(true);
    releaseLock(lp);
  });

  it("does NOT reclaim a fresh lock", () => {
    const lp = lockPathFor(tmpDir(), "day.jsonl");
    expect(acquireLock(lp)).toBe(true); // meta acquiredAt = now
    expect(acquireLock(lp, DEFAULT_STALE_MS)).toBe(false); // fresh → not reclaimed
    releaseLock(lp);
  });

  it("falls back to dir mtime when meta is missing/corrupt", () => {
    const lp = lockPathFor(tmpDir(), "day.jsonl");
    expect(acquireLock(lp)).toBe(true);
    fs.rmSync(`${lp}/meta.json`, { force: true }); // no meta → use dir mtime
    // Backdate the lock dir so its mtime is unambiguously old, then it's stale.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lp, old, old);
    expect(acquireLock(lp, 1_000)).toBe(true); // old dir mtime → reclaimed
    releaseLock(lp);
  });

  it("throws if the parent directory is missing (real config error, not 'held')", () => {
    const lp = lockPathFor(path.join(os.tmpdir(), "filelock-nope-" + process.pid, "missing"), "day.jsonl");
    expect(() => acquireLock(lp)).toThrow();
  });
});

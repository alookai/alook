import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { killProcessTree, isAlive } from "./kill-tree.js";

// These are real-process integration tests; POSIX-only (group semantics).
const posix = process.platform !== "win32";
const d = posix ? describe : describe.skip;

const spawned: ChildProcess[] = [];

afterEach(() => {
  // Best-effort cleanup of anything a test left alive.
  for (const p of spawned.splice(0)) {
    if (p.pid) {
      try { process.kill(-p.pid, "SIGKILL"); } catch { /* */ }
      try { process.kill(p.pid, "SIGKILL"); } catch { /* */ }
    }
  }
});

/** Spawn a detached node process that prints its child's pid then idles. */
function spawnParentWithChild(): Promise<{ proc: ChildProcess; childPid: number }> {
  // Parent forks a grandchild (both long-lived), prints "GRANDCHILD <pid>".
  const code = `
    const { spawn } = require("child_process");
    const g = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], { stdio: "ignore" });
    process.stdout.write("GRANDCHILD " + g.pid + "\\n");
    setInterval(() => {}, 1e9);
  `;
  const proc = spawn(process.execPath, ["-e", code], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  spawned.push(proc);
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (c: Buffer) => {
      buf += c.toString();
      const m = buf.match(/GRANDCHILD (\d+)/);
      if (m) resolve({ proc, childPid: Number(m[1]) });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("timeout waiting for grandchild")), 5000);
  });
}

/** Spawn a detached node process that ignores SIGTERM and idles. */
function spawnSigtermIgnorer(): ChildProcess {
  const code = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1e9);`;
  const proc = spawn(process.execPath, ["-e", code], {
    detached: true,
    stdio: "ignore",
  });
  spawned.push(proc);
  return proc;
}

const waitFor = async (fn: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
};

d("killProcessTree", () => {
  it("TC1: kills the child and its grandchild via the process group", async () => {
    const { proc, childPid } = await spawnParentWithChild();
    expect(proc.pid).toBeDefined();
    expect(isAlive(proc.pid!)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await killProcessTree(proc.pid!, { graceMs: 2000 });

    expect(await waitFor(() => !isAlive(proc.pid!))).toBe(true);
    expect(await waitFor(() => !isAlive(childPid))).toBe(true);
  });

  it("TC2: escalates to SIGKILL when the target ignores SIGTERM", async () => {
    const proc = spawnSigtermIgnorer();
    // give it a moment to install its SIGTERM trap
    await new Promise((r) => setTimeout(r, 100));
    expect(isAlive(proc.pid!)).toBe(true);

    await killProcessTree(proc.pid!, { graceMs: 300 });

    // SIGTERM is trapped, so only the SIGKILL escalation could have killed it.
    expect(await waitFor(() => !isAlive(proc.pid!))).toBe(true);
  });

  it("TC3: resolves promptly and never throws when the target is already dead", async () => {
    const proc = spawn(process.execPath, ["-e", "process.exit(0)"], { detached: true, stdio: "ignore" });
    await new Promise((r) => proc.on("exit", r));
    const pid = proc.pid!;
    expect(isAlive(pid)).toBe(false);

    const start = Date.now();
    await expect(killProcessTree(pid, { graceMs: 2000 })).resolves.toBeUndefined();
    // Should return almost immediately (no grace wait for a dead pid).
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("ignores invalid pids without throwing", async () => {
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
  });
});

describe("isAlive", () => {
  it("returns true for the current process and false for a never-used pid", () => {
    expect(isAlive(process.pid)).toBe(true);
    // A very high pid is essentially guaranteed not to exist.
    expect(isAlive(2_000_000_000)).toBe(false);
  });
});


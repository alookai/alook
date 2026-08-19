import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { spawnAgentProcess, killProcessTree, isAlive } from "./killTree.js";

/**
 * These tests spawn real child processes rather than mocking
 * `child_process` — the bug this file guards against (silent no-op kill on
 * a non-detached child, see plans/fix-daemon-agent-process-kill.md) is a
 * real OS process-group interaction that a mock would trivially hide.
 */

const spawned: ChildProcess[] = [];

/** A child that just idles until signaled. */
function spawnIdleChild(opts: { detached?: boolean } = {}): ChildProcess {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: opts.detached,
  });
  spawned.push(proc);
  return proc;
}

/** A child that installs a no-op SIGTERM handler, so only SIGKILL kills it. */
function spawnSigtermImmuneChild(opts: { detached?: boolean } = {}): ChildProcess {
  const proc = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore", detached: opts.detached },
  );
  spawned.push(proc);
  return proc;
}

afterEach(() => {
  // Belt-and-suspenders cleanup in case a test fails before its own kill.
  for (const proc of spawned.splice(0)) {
    if (proc.pid && isAlive(proc.pid)) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
});

describe("killProcessTree", () => {
  it("kills a detached child via the process-group signal", async () => {
    const proc = spawnAgentProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    spawned.push(proc);
    await new Promise((r) => proc.once("spawn", r));
    expect(isAlive(proc.pid!)).toBe(true);

    await killProcessTree(proc.pid!, { graceMs: 1000 });

    expect(isAlive(proc.pid!)).toBe(false);
  });

  it("still kills a NON-detached child — regression test for the ESRCH-treated-as-dead bug", async () => {
    // Deliberately spawned WITHOUT detached, reproducing every driver's
    // pre-fix spawn() call. `process.kill(-pid, sig)` throws ESRCH here
    // because the child isn't its own process-group leader; killProcessTree
    // must fall back to signaling the pid directly instead of assuming
    // ESRCH means "already dead".
    const proc = spawnIdleChild({ detached: false });
    await new Promise((r) => proc.once("spawn", r));
    expect(isAlive(proc.pid!)).toBe(true);

    await killProcessTree(proc.pid!, { graceMs: 1000 });

    expect(isAlive(proc.pid!)).toBe(false);
  });

  it("resolves immediately for an already-dead pid without throwing", async () => {
    const proc = spawnIdleChild({ detached: false });
    await new Promise((r) => proc.once("spawn", r));
    const pid = proc.pid!;
    process.kill(pid, "SIGKILL");
    await new Promise((r) => proc.once("exit", r));
    expect(isAlive(pid)).toBe(false);

    await expect(killProcessTree(pid, { graceMs: 1000 })).resolves.toBeUndefined();
  });

  it("no-ops on an invalid pid (0 or negative)", async () => {
    await expect(killProcessTree(0)).resolves.toBeUndefined();
    await expect(killProcessTree(-1)).resolves.toBeUndefined();
  });

  it("escalates to SIGKILL after graceMs when the child ignores SIGTERM", async () => {
    const proc = spawnSigtermImmuneChild({ detached: false });
    await new Promise((r) => proc.once("spawn", r));
    expect(isAlive(proc.pid!)).toBe(true);

    await killProcessTree(proc.pid!, { graceMs: 300 });

    expect(isAlive(proc.pid!)).toBe(false);
  });
});

describe("spawnAgentProcess", () => {
  it("spawns detached on POSIX so killProcessTree's group signal has a group to hit", async () => {
    if (process.platform === "win32") return;
    const proc = spawnAgentProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    spawned.push(proc);
    await new Promise((r) => proc.once("spawn", r));

    // A detached child is its own process-group leader: pgid === pid.
    const { execFileSync } = await import("child_process");
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(proc.pid)], { encoding: "utf8" }).trim();
    expect(Number(out)).toBe(proc.pid);

    process.kill(proc.pid!, "SIGKILL");
  });

  it("pipes stdio and forwards cwd/env/shell", () => {
    const proc = spawnAgentProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: { ...process.env, FOO: "bar" },
      shell: false,
    });
    spawned.push(proc);
    expect(proc.stdin).not.toBeNull();
    expect(proc.stdout).not.toBeNull();
    expect(proc.stderr).not.toBeNull();
  });
});

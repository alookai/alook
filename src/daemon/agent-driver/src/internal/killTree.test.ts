import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnAgentProcess, killProcessTree, isAlive } from "./killTree.js";

/**
 * These tests spawn real child processes rather than mocking
 * `child_process` — the bug this file guards against (silent no-op kill on
 * a non-detached child, see plans/fix-daemon-agent-process-kill.md) is a
 * real OS process-group interaction that a mock would trivially hide.
 */

const spawned: ChildProcess[] = [];
const spawnedDescendantPids: number[] = [];
const tempDirs: string[] = [];

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
  for (const pid of spawnedDescendantPids.splice(0)) {
    if (isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
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

  it("kills runtime descendants before releasing a shell-owning workspace", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-driver-tree-"));
    tempDirs.push(cwd);
    const childModule = join(cwd, "child.mjs");
    const parentModule = join(cwd, "parent.mjs");
    // The root exits on SIGTERM while this descendant deliberately survives it.
    // killProcessTree must keep the detached process group as its authority and
    // escalate before reporting that the tree has stopped.
    writeFileSync(
      childModule,
      "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n",
    );
    writeFileSync(parentModule, `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(childModule)}], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      child.stdout.once("data", () => process.stdout.write(String(child.pid) + "\\n"));
      setInterval(() => {}, 1000);
    `);
    const command = process.platform === "win32" ? join(cwd, "runtime.cmd") : process.execPath;
    const args = process.platform === "win32" ? [] : [parentModule];
    if (process.platform === "win32") {
      writeFileSync(command, `@node "%~dp0\\parent.mjs"\r\n`);
    }
    const proc = spawnAgentProcess(command, args, {
      cwd,
      env: process.env,
      // Exercise the `.cmd` launch shape on Windows: the tracked pid is the
      // command shell, while the runtime and its descendants own the cwd.
      shell: process.platform === "win32",
    });
    spawned.push(proc);
    await new Promise((resolve) => proc.once("spawn", resolve));
    const lines = createInterface({ input: proc.stdout! });
    const childPid = await new Promise<number>((resolve, reject) => {
      lines.once("line", (line) => resolve(Number(line)));
      proc.once("exit", () => reject(new Error("parent exited before reporting its child pid")));
    });
    lines.close();
    spawnedDescendantPids.push(childPid);
    expect(Number.isInteger(childPid)).toBe(true);
    expect(isAlive(proc.pid!)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await killProcessTree(proc.pid!, { graceMs: 300 });

    expect(isAlive(proc.pid!)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    tempDirs.splice(tempDirs.indexOf(cwd), 1);
  });

  it("keeps Windows tree authority when the CLI root exits before its descendant", async () => {
    if (process.platform !== "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "agent-driver-terminal-root-"));
    tempDirs.push(cwd);
    const childModule = join(cwd, "child.mjs");
    const rootModule = join(cwd, "root.mjs");
    const command = join(cwd, "runtime.cmd");
    writeFileSync(childModule, "setInterval(() => {}, 1000);\n");
    writeFileSync(rootModule, `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(childModule)}], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      child.once("spawn", () => {
        process.stdout.write(String(process.pid) + " " + String(child.pid) + "\\n");
        setTimeout(() => process.exit(0), 250);
      });
    `);
    writeFileSync(command, `@node "%~dp0\\root.mjs"\r\n`);

    const proc = spawnAgentProcess(command, [], {
      cwd,
      env: process.env,
      shell: true,
    });
    spawned.push(proc);
    await new Promise((resolve) => proc.once("spawn", resolve));
    const lines = createInterface({ input: proc.stdout! });
    const [rootPid, childPid] = await new Promise<[number, number]>((resolve, reject) => {
      lines.once("line", (line) => {
        const [root, child] = line.split(" ").map(Number);
        resolve([root, child]);
      });
      proc.once("exit", () => reject(new Error("supervisor exited before the fixture reported its pids")));
    });
    lines.close();
    spawnedDescendantPids.push(rootPid, childPid);
    expect(isAlive(rootPid)).toBe(true);
    expect(isAlive(childPid)).toBe(true);

    await new Promise((resolve) => proc.once("exit", resolve));

    // The tracked supervisor exit is the host-release boundary. Descendants
    // and cwd ownership must already be gone here; waiting after exit would
    // hide the exact release race this fixture protects against.
    expect(isAlive(rootPid)).toBe(false);
    expect(isAlive(childPid)).toBe(false);
    rmSync(cwd, { recursive: true, force: true });
    tempDirs.splice(tempDirs.indexOf(cwd), 1);
    await expect(killProcessTree(proc.pid!, { graceMs: 0 })).resolves.toBeUndefined();
  });

  it("rejects when forced POSIX termination cannot make the target exit", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const stopped = killProcessTree(999_999, { graceMs: 0 });
      const rejection = expect(stopped).rejects.toThrow("remained alive after SIGKILL");
      await vi.advanceTimersByTimeAsync(2_100);
      await rejection;
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
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

  it("preserves persistent Windows stdin/stdout, cwd/env, and the exact inner exit code", async () => {
    if (process.platform !== "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "agent-driver-job-stdio-"));
    tempDirs.push(cwd);
    const runtimeModule = join(cwd, "runtime.mjs");
    const command = join(cwd, "runtime.cmd");
    writeFileSync(runtimeModule, `
      import { createInterface } from "node:readline";
      const lines = createInterface({ input: process.stdin });
      let request = 0;
      lines.on("line", (line) => {
        request += 1;
        const result = { line, request, cwd: process.cwd(), env: process.env.ALOOK_JOB_FIXTURE };
        process.stdout.write(JSON.stringify(result) + "\\n", () => {
          if (request === 2) process.exit(37);
        });
      });
    `);
    writeFileSync(command, `@node "%~dp0\\runtime.mjs"\r\n`);
    const proc = spawnAgentProcess(command, [], {
      cwd,
      env: { ...process.env, ALOOK_JOB_FIXTURE: "job-env-ok" },
      shell: true,
    });
    spawned.push(proc);
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => resolve([code, signal]));
    });
    const lines = createInterface({ input: proc.stdout! });
    const responses: string[] = [];
    const response = new Promise<string[]>((resolve, reject) => {
      lines.on("line", (line) => {
        responses.push(line);
        if (responses.length === 2) resolve(responses);
      });
      proc.once("exit", () => reject(new Error("supervisor exited before the stdin roundtrip completed")));
    });

    // Keep stdin open across multiple request/response exchanges. Calling
    // `end()` here would only prove that EOF flushes a buffered pipe, while
    // Codex/Claude/ACP all require a long-lived bidirectional transport.
    proc.stdin!.write("stdio-roundtrip-1\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    proc.stdin!.write("stdio-roundtrip-2\n");

    expect((await response).map((line) => JSON.parse(line))).toEqual([
      {
        line: "stdio-roundtrip-1",
        request: 1,
        cwd,
        env: "job-env-ok",
      },
      {
        line: "stdio-roundtrip-2",
        request: 2,
        cwd,
        env: "job-env-ok",
      },
    ]);
    lines.close();
    await expect(exited).resolves.toEqual([37, null]);
  });
});

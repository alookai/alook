import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { spawnAgentProcess, killProcessTree, isAlive } from "./killTree.js";

/**
 * These tests spawn real child processes rather than mocking
 * `child_process` — the bug this file guards against (silent no-op kill on
 * a non-detached child) is a
 * real OS process-group interaction that a mock would trivially hide.
 */

type ProcessReport = (event: string, detail?: Record<string, unknown>) => void;
type OwnedProcess = { proc: ChildProcess; closed: Promise<void>; cwd?: string; traceDirectory?: string; report?: ProcessReport };
const spawned: OwnedProcess[] = [];

function ownProcess(proc: ChildProcess, diagnostics?: { cwd: string; traceDirectory?: string; report: ProcessReport }): ChildProcess {
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  spawned.push({ proc, closed, ...diagnostics });
  return proc;
}
const spawnedDescendantPids: number[] = [];
const tempDirs: string[] = [];

/** A child that just idles until signaled. */
function spawnIdleChild(opts: { detached?: boolean } = {}): ChildProcess {
  const proc = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    detached: opts.detached,
  });
  ownProcess(proc);
  return proc;
}

/** A child that installs a no-op SIGTERM handler, so only SIGKILL kills it. */
function spawnSigtermImmuneChild(opts: { detached?: boolean } = {}): ChildProcess {
  const proc = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore", detached: opts.detached },
  );
  ownProcess(proc);
  return proc;
}

afterEach(async () => {
  const processes = [...spawned];
  const descendants = [...spawnedDescendantPids];
  const failures: unknown[] = [];
  for (const { proc, report } of processes) {
    report?.("cleanup-start", {
      exitCode: proc.exitCode,
      signalCode: proc.signalCode,
      stdoutEnded: proc.stdout?.readableEnded,
      stdoutClosed: proc.stdout?.closed,
      stderrEnded: proc.stderr?.readableEnded,
      stderrClosed: proc.stderr?.closed,
    });
    if (proc.pid && isAlive(proc.pid)) {
      try {
        await killProcessTree(proc.pid);
        report?.("tree-stopped");
      } catch (error) {
        failures.push(error);
        report?.("tree-stop-error", { name: error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  for (const pid of descendants) {
    if (isAlive(pid)) {
      try {
        await killProcessTree(pid);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, "Owned fixture processes did not terminate");
  for (const { closed, report } of processes) {
    report?.("await-cleanup-close");
    await closed;
    report?.("cleanup-close-observed");
  }
  spawned.splice(0, processes.length);
  spawnedDescendantPids.splice(0, descendants.length);
  for (const dir of [...tempDirs]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    tempDirs.splice(tempDirs.indexOf(dir), 1);
    for (const owner of processes) {
      if (owner.cwd === dir) owner.report?.("cwd-removed");
      if (owner.traceDirectory === dir) owner.report?.("trace-directory-removed");
    }
  }
});

describe("killProcessTree", () => {
  it("kills a detached child via the process-group signal", async () => {
    const proc = spawnAgentProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    ownProcess(proc);
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

  it("retains root process-group authority when the POSIX process-table capture fails", async () => {
    if (process.platform === "win32") return;
    const proc = spawnAgentProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    ownProcess(proc);
    await new Promise((resolve) => proc.once("spawn", resolve));
    const emptyPath = mkdtempSync(join(tmpdir(), "agent-driver-empty-path-"));
    tempDirs.push(emptyPath);
    const originalPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await killProcessTree(proc.pid!, { graceMs: 300 });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(isAlive(proc.pid!)).toBe(false);
  });

  it("ignores unsafe numeric rows in a POSIX process-table capture", async () => {
    if (process.platform === "win32") return;
    const proc = spawnAgentProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(),
      env: process.env,
    });
    ownProcess(proc);
    await new Promise((resolve) => proc.once("spawn", resolve));
    const fakeBin = mkdtempSync(join(tmpdir(), "agent-driver-fake-ps-"));
    tempDirs.push(fakeBin);
    writeFileSync(
      join(fakeBin, "ps"),
      `#!/bin/sh\nprintf '%s\\n' '${String(proc.pid)} ${String(process.pid)} ${String(proc.pid)}' '9007199254740993 ${String(proc.pid)} ${String(proc.pid)}'\n`,
      { mode: 0o755 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      await killProcessTree(proc.pid!, { graceMs: 300 });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(isAlive(proc.pid!)).toBe(false);
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
    ownProcess(proc);
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

  it("kills a Cursor-like MCP subtree that detached into its own process group", async () => {
    if (process.platform === "win32") return;
    const cwd = mkdtempSync(join(tmpdir(), "agent-driver-cursor-mcp-tree-"));
    tempDirs.push(cwd);
    const leafModule = join(cwd, "context7.mjs");
    const mcpModule = join(cwd, "mcp.mjs");
    const cursorModule = join(cwd, "cursor.mjs");
    writeFileSync(
      leafModule,
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n",
    );
    writeFileSync(mcpModule, `
      import { spawn } from "node:child_process";
      const child = spawn(process.execPath, [${JSON.stringify(leafModule)}], {
        cwd: process.cwd(),
        stdio: "ignore",
      });
      child.once("spawn", () => process.stdout.write(String(process.pid) + " " + String(child.pid) + "\\n"));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);
    writeFileSync(cursorModule, `
      import { spawn } from "node:child_process";
      const mcp = spawn(process.execPath, [${JSON.stringify(mcpModule)}], {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      mcp.stdout.once("data", (chunk) => process.stdout.write(String(chunk)));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);

    const cursor = spawnAgentProcess(process.execPath, [cursorModule], {
      cwd,
      env: process.env,
    });
    ownProcess(cursor);
    await new Promise((resolve) => cursor.once("spawn", resolve));
    const lines = createInterface({ input: cursor.stdout! });
    const [mcpPid, context7Pid] = await new Promise<[number, number]>((resolve, reject) => {
      lines.once("line", (line) => {
        const [mcp, context7] = line.split(" ").map(Number);
        resolve([mcp, context7]);
      });
      cursor.once("exit", () => reject(new Error("Cursor fixture exited before reporting its MCP subtree")));
    });
    lines.close();
    spawnedDescendantPids.push(mcpPid, context7Pid);
    const mcpPgid = Number(execFileSync(
      "ps",
      ["-o", "pgid=", "-p", String(mcpPid)],
      { encoding: "utf8" },
    ).trim());
    expect(mcpPgid).toBe(mcpPid);
    expect(mcpPgid).not.toBe(cursor.pid);
    expect(isAlive(cursor.pid!)).toBe(true);
    expect(isAlive(mcpPid)).toBe(true);
    expect(isAlive(context7Pid)).toBe(true);

    await killProcessTree(cursor.pid!, { graceMs: 300 });

    expect(isAlive(cursor.pid!)).toBe(false);
    expect(isAlive(mcpPid)).toBe(false);
    expect(isAlive(context7Pid)).toBe(false);
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
    ownProcess(proc);
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
    ownProcess(proc);
    await new Promise((r) => proc.once("spawn", r));

    // A detached child is its own process-group leader: pgid === pid.
    const out = execFileSync("ps", ["-o", "pgid=", "-p", String(proc.pid)], { encoding: "utf8" }).trim();
    expect(Number(out)).toBe(proc.pid);

    process.kill(proc.pid!, "SIGKILL");
  });

  it("pipes stdio and forwards cwd/env/shell", async () => {
    const keys = ["ALOOK_PROCESS_PARENT_FIXTURE", "ALOOK_PROCESS_CALLER_FIXTURE", "ALOOK_PROCESS_EMPTY_FIXTURE", "ALOOK_WINDOWS_JOB_PAYLOAD", "ALOOK_WINDOWS_JOB_ENV_CHUNK_777"];
    const before = keys.map((key) => process.env[key]);
    const digest = (value: string | undefined) => value === undefined ? null : createHash("sha256").update(value).digest("hex");
    process.env.ALOOK_PROCESS_PARENT_FIXTURE = "parent-only";
    delete process.env.ALOOK_PROCESS_CALLER_FIXTURE;
    delete process.env.ALOOK_PROCESS_EMPTY_FIXTURE;
    process.env.ALOOK_WINDOWS_JOB_PAYLOAD = "ignored-owner-value";
    process.env.ALOOK_WINDOWS_JOB_ENV_CHUNK_777 = "ignored-owner-piece";
    try {
      const replacement: NodeJS.ProcessEnv = {
        FOO: "bar",
        ALOOK_PROCESS_CALLER_FIXTURE: "€€😀",
        ALOOK_PROCESS_PARENT_FIXTURE: undefined,
        ALOOK_PROCESS_EMPTY_FIXTURE: "",
        alook_windows_job_runner: "ignored-caller-owner",
      };
      const environments: (NodeJS.ProcessEnv | undefined)[] = [undefined, {}, replacement];
      for (const env of environments) {
        const expected = env ?? process.env;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const proc = ownProcess(spawnAgentProcess(process.execPath, ["-e", `
          const { createHash } = require("node:crypto");
          const names = ["FOO", "ALOOK_PROCESS_PARENT_FIXTURE", "ALOOK_PROCESS_CALLER_FIXTURE", "ALOOK_PROCESS_EMPTY_FIXTURE"];
          const hashes = Object.fromEntries(names.map(name => [name, process.env[name] === undefined ? null : createHash("sha256").update(process.env[name]).digest("hex")]));
          const ownerKeys = Object.keys(process.env).filter(key => /^ALOOK_WINDOWS_JOB_/i.test(key)).sort();
          process.stdout.write(JSON.stringify({ cwd: process.cwd(), hashes, ownerKeys }));
        `], { cwd: process.cwd(), ...(env === undefined ? {} : { env }), shell: false }));
        expect(proc.stdin).not.toBeNull();
        expect(proc.stdout).not.toBeNull();
        expect(proc.stderr).not.toBeNull();
        proc.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
        proc.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
        await new Promise<void>((resolve, reject) => {
          proc.once("error", reject);
          proc.once("close", (code, signal) => code === 0 && signal === null ? resolve() : reject(new Error("Environment fixture did not exit successfully")));
        });
        expect(Buffer.concat(stderr).toString("utf8")).toBe("");
        expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toEqual({
          cwd: process.cwd(),
          hashes: Object.fromEntries(["FOO", "ALOOK_PROCESS_PARENT_FIXTURE", "ALOOK_PROCESS_CALLER_FIXTURE", "ALOOK_PROCESS_EMPTY_FIXTURE"].map((key) => [key, digest(expected[key])])),
          ownerKeys: process.platform === "win32" ? [] : Object.keys(expected).filter((key) => /^ALOOK_WINDOWS_JOB_/i.test(key)).sort(),
        });
      }
    } finally {
      for (const [index, key] of keys.entries()) {
        if (before[index] === undefined) delete process.env[key];
        else process.env[key] = before[index];
      }
    }
  });

  it("supports a runtime that explicitly ignores stdin", async () => {
    const proc = spawnAgentProcess(process.execPath, ["-e", "process.exit(0)"], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
    });
    ownProcess(proc);
    expect(proc.stdin).toBeNull();
    await new Promise((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", resolve);
    });
  });

  it("starts an owned native process with an isolated PATH and preserves raw Unicode output", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "agent-driver-isolated-env-"));
    tempDirs.push(cwd);
    const traceDirectory = mkdtempSync(join(tmpdir(), "agent-driver-phase-trace-"));
    tempDirs.push(traceDirectory);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const started = performance.now();
    const requestedNs = process.hrtime.bigint();
    let firstOutputNs: bigint | undefined;
    let pid: number | null = null;
    const collectPhases = (event: string) => {
      const stages = ["ps-enter", "add-type-ready", "native-created", "native-resumed", "runner-enter", "target-spawn", "target-enter"] as const;
      type Phase = { stage: string; pid: number; childPid?: number; clock: string; committed?: boolean; ticks?: string; frequency?: string; highResolution?: boolean; nanoseconds?: string; node?: string; platform?: string; arch?: string; traceEnvironmentPresent?: boolean };
      const phases: Partial<Record<(typeof stages)[number], Phase>> = {};
      const problems: { stage: string; problem: string }[] = [];
      const observedNs = process.hrtime.bigint();
      for (const stage of stages) {
        const path = join(traceDirectory, `${stage}.json`);
        try {
          let committed = true;
          let serialized: string;
          try {
            serialized = readFileSync(path, "utf8");
          } catch (error) {
            if (!existsSync(`${path}.tmp`)) throw error;
            serialized = readFileSync(`${path}.tmp`, "utf8");
            committed = false;
            problems.push({ stage, problem: error instanceof Error && "code" in error ? String(error.code) : "final-marker-unavailable" });
          }
          const input: unknown = JSON.parse(serialized.replace(/^\uFEFF/, ""));
          if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid-record");
          const record = input as Record<string, unknown>;
          if (record.stage !== stage || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) throw new Error("invalid-identity");
          const phase: Phase = { stage, pid: record.pid as number, clock: String(record.clock), committed };
          if (stage === "native-created" || stage === "native-resumed" || stage === "target-spawn") {
            if (!Number.isSafeInteger(record.childPid) || (record.childPid as number) <= 0) throw new Error("invalid-child-pid");
            phase.childPid = record.childPid as number;
          }
          if (stage === "runner-enter" || stage === "target-spawn" || stage === "target-enter") {
            if (record.clock !== "node-hrtime" || typeof record.nanoseconds !== "string" || !/^\d+$/.test(record.nanoseconds)
              || typeof record.node !== "string" || typeof record.platform !== "string" || typeof record.arch !== "string") throw new Error("invalid-node-clock");
            Object.assign(phase, { nanoseconds: record.nanoseconds, node: record.node, platform: record.platform, arch: record.arch });
            if (stage === "target-enter") {
              phase.traceEnvironmentPresent = record.traceEnvironmentPresent === true;
              if (record.traceEnvironmentPresent !== false) problems.push({ stage, problem: "private-trace-env-not-proven-absent" });
            }
          } else {
            if (record.clock !== "windows-qpc-stopwatch" || typeof record.ticks !== "string" || !/^\d+$/.test(record.ticks)
              || typeof record.frequency !== "string" || !/^[1-9]\d*$/.test(record.frequency) || typeof record.highResolution !== "boolean") throw new Error("invalid-native-clock");
            Object.assign(phase, { ticks: record.ticks, frequency: record.frequency, highResolution: record.highResolution });
          }
          phases[stage] = phase;
        } catch (error) {
          const problem = error instanceof Error && "code" in error ? String(error.code) : error instanceof Error ? error.message : "unknown";
          problems.push({ stage, problem });
        }
        if (existsSync(`${path}.tmp`)) problems.push({ stage, problem: "unfinished-marker-write" });
      }
      const native = stages.slice(0, 4).map((stage) => phases[stage]);
      const nodes = stages.slice(4).map((stage) => phases[stage]);
      const complete = stages.every((stage) => phases[stage]) && problems.length === 0;
      const associations = native.every((phase) => phase?.pid === pid)
        && phases["native-created"]?.childPid === phases["runner-enter"]?.pid
        && phases["native-resumed"]?.childPid === phases["runner-enter"]?.pid
        && phases["runner-enter"]?.pid === phases["target-spawn"]?.pid
        && phases["target-spawn"]?.childPid === phases["target-enter"]?.pid;
      const providers = process.platform === "win32" && process.arch === "x64" && process.version === "v22.23.4"
        && native.every((phase) => phase?.highResolution === true && phase.frequency === phases["ps-enter"]?.frequency)
        && nodes.every((phase) => phase?.node === process.version && phase.platform === process.platform && phase.arch === process.arch);
      const nanoseconds = (phase: Phase): bigint => phase.clock === "node-hrtime"
        ? BigInt(phase.nanoseconds!) : BigInt(phase.ticks!) * 1_000_000_000n / BigInt(phase.frequency!);
      const ordered = (names: (typeof stages)[number][]) => names.every((stage, index) => index === 0
        || phases[names[index - 1]] && phases[stage] && nanoseconds(phases[names[index - 1]]!) <= nanoseconds(phases[stage]!));
      const causalOrdering = ordered(["ps-enter", "add-type-ready", "native-created", "native-resumed"])
        && ordered(["native-created", "runner-enter", "target-enter"])
        && ordered(["runner-enter", "target-spawn"])
        && (!firstOutputNs || !phases["target-enter"] || nanoseconds(phases["target-enter"]) <= firstOutputNs);
      const inInvocation = Object.values(phases).every((phase) => {
        const ns = nanoseconds(phase);
        return ns >= requestedNs && ns <= observedNs;
      });
      const crossClockQualified = complete && associations && providers && causalOrdering && inInvocation;
      const interval = (from: Phase | undefined, to: Phase | undefined): string => {
        if (!from || !to || from.committed === false || to.committed === false) return "UNKNOWN";
        const sameClock = from.pid === to.pid && from.clock === to.clock
          && (from.clock === "node-hrtime" || from.highResolution === true && to.highResolution === true && from.frequency === to.frequency);
        if (!sameClock && !crossClockQualified) return "UNKNOWN";
        const gap = nanoseconds(to) - nanoseconds(from);
        return gap >= 0n ? gap.toString() : "UNKNOWN";
      };
      const parentPhase = (ns: bigint): Phase => ({ stage: "parent", pid: process.pid, clock: "node-hrtime", nanoseconds: ns.toString() });
      console.info("AGENT_DRIVER_PHASES", JSON.stringify({
        case: "isolated-path-unicode", event, pid, cwd, traceDirectory, observedNs: observedNs.toString(),
        observationStatus: complete ? "complete" : "incomplete", problems, phases,
        crossClockQualification: crossClockQualified ? "qualified-node22.23.4-qpc" : "UNKNOWN",
        qualification: { associations, providers, causalOrdering, inInvocation, parentNode: process.version, platform: process.platform, arch: process.arch },
        intervalNs: {
          requestToPs: interval(parentPhase(requestedNs), phases["ps-enter"]),
          addType: interval(phases["ps-enter"], phases["add-type-ready"]),
          nativePreparationAndCreate: interval(phases["add-type-ready"], phases["native-created"]),
          assignAndResume: interval(phases["native-created"], phases["native-resumed"]),
          resumeToRunner: interval(phases["native-resumed"], phases["runner-enter"]),
          runnerToTargetSpawn: interval(phases["runner-enter"], phases["target-spawn"]),
          spawnToTargetEntry: interval(phases["target-spawn"], phases["target-enter"]),
          targetEntryToObservedOutput: firstOutputNs ? interval(phases["target-enter"], parentPhase(firstOutputNs)) : "UNKNOWN",
        },
      }));
    };
    const report: ProcessReport = (event, detail = {}) => {
      const ns = process.hrtime.bigint();
      if (event.endsWith("-data") && firstOutputNs === undefined) firstOutputNs = ns;
      console.info("AGENT_DRIVER_PROCESS", JSON.stringify({
        case: "isolated-path-unicode",
        event,
        elapsedMs: performance.now() - started,
        hrtimeNs: ns.toString(),
        pid,
        cwd,
        stdoutBytes: stdout.reduce((bytes, chunk) => bytes + chunk.length, 0),
        stderrBytes: stderr.reduce((bytes, chunk) => bytes + chunk.length, 0),
        ...detail,
      }));
      if (event === "cleanup-start" || event === "cleanup-close-observed") collectPhases(event);
    };
    report("spawn-requested", { node: process.version, platform: process.platform, arch: process.arch });
    const proc = (() => {
      const before = process.env.ALOOK_PROCESS_PARENT_FIXTURE;
      process.env.ALOOK_PROCESS_PARENT_FIXTURE = "parent-only";
      try {
        return ownProcess(spawnAgentProcess(process.execPath, ["-e", `
      try {
        const nanoseconds = process.hrtime.bigint().toString();
        const { writeFileSync, renameSync } = require("node:fs");
        const path = ${JSON.stringify(join(traceDirectory, "target-enter.json"))};
        writeFileSync(path + ".tmp", JSON.stringify({ stage: "target-enter", pid: process.pid, clock: "node-hrtime", nanoseconds, node: process.version, platform: process.platform, arch: process.arch, traceEnvironmentPresent: Object.hasOwn(process.env, "ALOOK_WINDOWS_JOB_TRACE") }));
        renameSync(path + ".tmp", path);
      } catch {}
      const { createHash } = require("node:crypto");
      if (createHash("sha256").update(process.env.PATH ?? "").digest("hex") !== ${JSON.stringify(createHash("sha256").update(cwd).digest("hex"))} || process.env.ALOOK_PROCESS_PARENT_FIXTURE !== undefined || Object.keys(process.env).some(key => /^ALOOK_WINDOWS_JOB_/i.test(key))) {
        throw new Error("Isolated target environment contract failed");
      }
      const { writeSync } = require("node:fs");
      writeSync(1, Buffer.from("€€😀"));
      writeSync(2, Buffer.from("₿₩😀"));
    `], { cwd, env: { PATH: cwd }, stdin: "ignore", traceDirectory }), { cwd, traceDirectory, report });
      } finally {
        if (before === undefined) delete process.env.ALOOK_PROCESS_PARENT_FIXTURE;
        else process.env.ALOOK_PROCESS_PARENT_FIXTURE = before;
      }
    })();
    pid = proc.pid ?? null;
    report("spawn-returned");
    proc.once("spawn", () => report("spawn"));
    proc.once("error", (error: NodeJS.ErrnoException) => report("error", { name: error.name, code: error.code ?? null }));
    proc.once("exit", (code, signal) => report("exit", { code, signal }));
    proc.once("close", (code, signal) => report("close", { code, signal }));
    for (const [name, stream, chunks] of [["stdout", proc.stdout!, stdout], ["stderr", proc.stderr!, stderr]] as const) {
      stream.on("data", (chunk: Buffer) => { chunks.push(chunk); report(`${name}-data`, { bytes: chunk.length }); });
      stream.once("end", () => report(`${name}-end`));
      stream.once("close", () => report(`${name}-close`));
      stream.once("error", (error: NodeJS.ErrnoException) => report(`${name}-error`, { name: error.name, code: error.code ?? null }));
    }
    report("await-close");
    await new Promise<void>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        if (code === 0 && signal === null) resolve();
        else reject(new Error(`Isolated process exited: code=${code}, signal=${signal}, stderr=${Buffer.concat(stderr).toString("utf8")}`));
      });
    });
    expect(Buffer.concat(stdout).toString("utf8")).toBe("€€😀");
    expect(Buffer.concat(stderr).toString("utf8")).toBe("₿₩😀");
    report("assertions-passed");
  });

  it("preserves persistent Windows stdin/stdout, cwd/env, and the exact inner exit code", async () => {
    if (process.platform !== "win32") return;
    const base = mkdtempSync(join(tmpdir(), "agent-driver-job-stdio-"));
    tempDirs.push(base);
    const cwd = join(base, "daemon", "agent-fresh");
    mkdirSync(cwd, { recursive: true });
    const runtimeModule = join(base, "runtime.mjs");
    const command = join(base, "runtime.cmd");
    const largeEnvironment = {
      ALOOK_JOB_LARGE_A: "€😀".repeat(4096),
      ALOOK_JOB_LARGE_B: "₿😃".repeat(4096),
      ALOOK_JOB_LARGE_C: "₩😄".repeat(4096),
    };
    const largeEnvironmentDigest = createHash("sha256").update(JSON.stringify(Object.values(largeEnvironment))).digest("hex");
    const shellValue = "caller-env-is-not-the-dispatcher";
    const shellDigest = createHash("sha256").update(shellValue).digest("hex");
    writeFileSync(runtimeModule, `
      import { createInterface } from "node:readline";
      import { createHash } from "node:crypto";
      const lines = createInterface({ input: process.stdin });
      let request = 0;
      lines.on("line", (line) => {
        request += 1;
        const largeEnvironment = [process.env.ALOOK_JOB_LARGE_A, process.env.ALOOK_JOB_LARGE_B, process.env.ALOOK_JOB_LARGE_C];
        const result = { line, request, cwd: process.cwd(), env: process.env.ALOOK_JOB_FIXTURE,
          largeEnvironmentDigest: createHash("sha256").update(JSON.stringify(largeEnvironment)).digest("hex"),
          shellDigest: createHash("sha256").update(process.env.ComSpec).digest("hex") };
        process.stdout.write(JSON.stringify(result) + "\\n", () => {
          if (request === 2) process.exit(37);
        });
      });
    `);
    writeFileSync(command, `@node "%~dp0\\runtime.mjs"\r\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, ALOOK_JOB_FIXTURE: "job-env-ok", ...largeEnvironment };
    for (const key of Object.keys(env)) if (key.toUpperCase() === "COMSPEC") delete env[key];
    env.ComSpec = shellValue;
    const proc = spawnAgentProcess(command, ["app-server", "--listen", "stdio://"], {
      cwd,
      env,
      shell: true,
    });
    ownProcess(proc);
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code, signal) => resolve([code, signal]));
    });
    const lines = createInterface({ input: proc.stdout! });
    const readResponse = () => new Promise<string>((resolve, reject) => {
      const onExit = () => {
        lines.off("line", onLine);
        reject(new Error("supervisor exited before the stdin roundtrip completed"));
      };
      const onLine = (line: string) => {
        proc.off("exit", onExit);
        resolve(line);
      };
      lines.once("line", onLine);
      proc.once("exit", onExit);
    });

    // Keep stdin open across multiple request/response exchanges. Calling
    // `end()` here would only prove that EOF flushes a buffered pipe, while
    // Codex/Claude/ACP all require a long-lived bidirectional transport.
    const firstResponse = readResponse();
    proc.stdin!.write("stdio-roundtrip-1\n");
    const first = await firstResponse;
    const exitStartedAt = Date.now();
    const secondResponse = readResponse();
    proc.stdin!.write("stdio-roundtrip-2\n");
    const second = await secondResponse;

    expect([first, second].map((line) => JSON.parse(line))).toEqual([
      {
        line: "stdio-roundtrip-1",
        request: 1,
        cwd,
        env: "job-env-ok",
        largeEnvironmentDigest,
        shellDigest,
      },
      {
        line: "stdio-roundtrip-2",
        request: 2,
        cwd,
        env: "job-env-ok",
        largeEnvironmentDigest,
        shellDigest,
      },
    ]);
    lines.close();
    await expect(exited).resolves.toEqual([37, null]);
    // Releasing the supervisor's own child handle must happen before job
    // accounting drain; otherwise even this naturally exited tree waits 5s.
    expect(Date.now() - exitStartedAt).toBeLessThan(4_000);
  });
});

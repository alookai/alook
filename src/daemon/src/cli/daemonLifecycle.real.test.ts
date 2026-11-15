import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { daemonStart } from "./daemonStart";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cli = path.join(packageRoot, "src", "cli", "index.ts");
const secret = "cmk_B0_REAL_PROCESS_SECRET";
const machineId = "cm_machine_real_123456";
const tempDirs: string[] = [];
const spawnedProcesses = new Set<ChildProcess>();

function makeBaseDir(): string {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-b0-real-"));
  tempDirs.push(baseDir);
  const daemonsDir = path.join(baseDir, "daemons");
  fs.mkdirSync(daemonsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(daemonsDir, `${machineId}.credential.json`),
    JSON.stringify({ credential: secret, machineId }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    fs.chmodSync(daemonsDir, 0o777);
    fs.chmodSync(path.join(daemonsDir, `${machineId}.credential.json`), 0o644);
  }
  return baseDir;
}

function makeEmptyBaseDir(): string {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "alook-b0-real-empty-"));
  tempDirs.push(baseDir);
  return baseDir;
}

function cliArgs(baseDir: string, foreground = false): string[] {
  return [
    cli,
    "daemon",
    "start",
    ...(foreground ? ["--foreground"] : []),
    "--machine-key", secret,
    "--server-url", "http://127.0.0.1:9",
    "--ws-url", "ws://127.0.0.1:9",
    "--base-dir", baseDir,
  ];
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv = {}): ChildProcess {
  const child = spawn(process.execPath, ["--import", tsxLoader, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawnedProcesses.add(child);
  return child;
}

async function collect(child: ChildProcess, observeOutput?: (chunk: string) => void): Promise<{ code: number | null; output: string }> {
  let output = "";
  const appendOutput = (chunk: unknown): void => {
    const text = String(chunk);
    output += text;
    try { observeOutput?.(text); } catch {}
  };
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      spawnedProcesses.delete(child);
      resolve({ code, output });
    });
  });
}

async function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
  return collect(spawnCli(args, env));
}

async function waitFor(predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition timed out");
}

function pidfile(baseDir: string): string {
  return path.join(baseDir, "daemons", machineId, "daemon.pid");
}

function readOwner(baseDir: string): { pid: number; machineId: string; ownerToken: string } {
  return JSON.parse(fs.readFileSync(pidfile(baseDir), "utf8"));
}

function readCheckpoint(checkpointFile: string): { parentPid: number; childPid: number } | undefined {
  try {
    return JSON.parse(fs.readFileSync(checkpointFile, "utf8"));
  } catch {
    return undefined;
  }
}

function blockRunnerStartup(baseDir: string): { checkpointFile: string; env: NodeJS.ProcessEnv; release: () => void } {
  const checkpointFile = path.join(baseDir, "checkpoint-runner-startup.json");
  const preload = path.join(baseDir, "block-runner-startup.cjs");
  fs.writeFileSync(preload, [
    'if (process.argv.slice(2).join(" ") === "daemon run") {',
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(checkpointFile)}, JSON.stringify({ parentPid: process.ppid, childPid: process.pid }));`,
    'const view = new Int32Array(new SharedArrayBuffer(4));',
    `while (!fs.existsSync(${JSON.stringify(`${checkpointFile}.continue`)})) Atomics.wait(view, 0, 0, 25);`,
    '}',
  ].join("\n"));
  return {
    checkpointFile,
    env: { NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(preload)}`].filter(Boolean).join(" ") },
    release: () => fs.writeFileSync(`${checkpointFile}.continue`, ""),
  };
}

function daemonLogRecords(baseDir: string): Array<{ message: string; fields: Record<string, unknown> }> {
  return fs.readFileSync(path.join(path.dirname(pidfile(baseDir)), "daemon.log"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function daemonIsReady(baseDir: string): boolean {
  const logPath = path.join(path.dirname(pidfile(baseDir)), "daemon.log");
  if (!fs.existsSync(pidfile(baseDir)) || !fs.existsSync(logPath)) return false;
  try {
    return daemonLogRecords(baseDir).some((record) => record.message === "daemon up");
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform === "win32") return true;
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

function processDescription(pid: number): string {
  if (process.platform === "win32") {
    return execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
    ], { encoding: "utf8" });
  }
  return execFileSync("ps", ["eww", "-p", String(pid), "-o", "command="], { encoding: "utf8" });
}

function reportDelayedShutdownFailure(baseDir: string, marker: string, parent: ChildProcess, output: string, elapsedMs: number): void {
  try {
    const ownerPath = pidfile(baseDir);
    let ownerPid: number | null = null;
    let ownerReadable = false;
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as { pid?: unknown };
      if (Number.isSafeInteger(owner.pid)) ownerPid = owner.pid as number;
      ownerReadable = true;
    } catch {}
    let messages: string[] = [];
    let logReadable = false;
    try { messages = daemonLogRecords(baseDir).map(record => record.message); logReadable = true; } catch {}
    console.error("DAEMON_DELAYED_SHUTDOWN_OBSERVATION", JSON.stringify({
      sampledAt: new Date().toISOString(), elapsedMs,
      observerConfiguredInWorker: process.env.NODE_OPTIONS?.includes("llvm-phase-preload") ?? false,
      worker: process.env.VITEST_WORKER_ID ?? null,
      launcher: { pid: process.pid, execPath: process.execPath, node: process.version, platform: process.platform },
      parent: { pid: parent.pid ?? null, exitCode: parent.exitCode, signalCode: parent.signalCode },
      owner: { present: fs.existsSync(ownerPath), readable: ownerReadable, pid: ownerPid },
      markerPresent: fs.existsSync(marker),
      daemonLog: { present: fs.existsSync(path.join(path.dirname(ownerPath), "daemon.log")), readable: logReadable },
      daemonPhases: {
        startup: logReadable ? messages.includes("daemon startup") : null, up: logReadable ? messages.includes("daemon up") : null,
        shutdown: logReadable ? messages.includes("shutting down…") : null, teardownFailed: logReadable ? messages.includes("daemon teardown failed") : null,
      },
      parentOutput: {
        timedOut: output.includes("daemon start timed out"),
        exitedBeforeReady: output.includes("daemon child exited before ready"),
        invalidAcknowledgment: output.includes("invalid prepared acknowledgment"),
      },
    }));
  } catch {}
}

async function stop(baseDir: string): Promise<void> {
  await runCli([cli, "daemon", "stop", machineId, "--base-dir", baseDir]);
}

afterEach(async () => {
  for (const child of spawnedProcesses) {
    if (child.pid && alive(child.pid)) process.kill(child.pid, "SIGKILL");
  }
  spawnedProcesses.clear();
  for (const baseDir of tempDirs.splice(0)) {
    if (fs.existsSync(pidfile(baseDir))) {
      const owner = readOwner(baseDir);
      if (alive(owner.pid)) process.kill(owner.pid, "SIGKILL");
    }
    for (const file of fs.readdirSync(baseDir).filter((entry) => entry.startsWith("checkpoint-") && entry.endsWith(".json"))) {
      const checkpoint = JSON.parse(fs.readFileSync(path.join(baseDir, file), "utf8")) as { parentPid: number; childPid: number };
      for (const pid of [checkpoint.parentPid, checkpoint.childPid]) {
        if (alive(pid)) process.kill(pid, "SIGKILL");
      }
    }
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

describe("daemon lifecycle real processes", () => {
  it("reconnects without a local record, persists the exact machine, and stops the real daemon", async () => {
    const baseDir = makeEmptyBaseDir();
    const requests: unknown[] = [];
    const server = createServer(async (req, res) => {
      if (req.url !== "/api/community/daemon/activate") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        credential: secret, machineId, expiresAt: null, sessionOutcome: "committed",
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const serverUrl = `http://127.0.0.1:${address.port}`;
    try {
      const result = await runCli([
        cli, "daemon", "reconnect", "--id", machineId,
        "--machine-key", "cmt_synthetic_reconnect",
        "--server-url", serverUrl, "--ws-url", "ws://127.0.0.1:9",
        "--base-dir", baseDir,
      ]);
      expect(result.code, result.output).toBe(0);
      expect(result.output).not.toContain(secret);
      expect(requests).toEqual([expect.objectContaining({ expectedMachineId: machineId })]);
      const owner = readOwner(baseDir);
      expect(owner.machineId).toBe(machineId);
      expect(alive(owner.pid)).toBe(true);
      const record = JSON.parse(fs.readFileSync(path.join(baseDir, "daemons", `${machineId}.credential.json`), "utf8"));
      expect(record).toMatchObject({ schemaVersion: 1, machineId, credential: secret, serverUrl });
      await stop(baseDir);
      await waitFor(() => !alive(owner.pid));
      expect(fs.existsSync(pidfile(baseDir))).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);

  it("starts detached while offline, persists no secret, and stops by stable machine id", async () => {
    const baseDir = makeBaseDir();
    const envProbe = path.join(baseDir, "runner-env.cjs");
    const envResult = path.join(baseDir, "runner-env.json");
    const registryKey = Object.keys(process.env).find((key) => key.toLowerCase() === "npm_config_registry") ?? "npm_config_registry";
    fs.writeFileSync(envProbe, [
      'if (process.argv.slice(2).join(" ") === "daemon run") {',
      `require("node:fs").writeFileSync(${JSON.stringify(envResult)}, JSON.stringify({`,
      'package: process.env.npm_config_package ?? null,',
      'upperPackage: process.env.NPM_CONFIG_PACKAGE ?? null,',
      'registry: process.env.npm_config_registry,',
      '})); }',
    ].join("\n"));
    const started = await runCli(cliArgs(baseDir), {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(envProbe)}`].filter(Boolean).join(" "),
      npm_config_package: "@alook/daemon@latest",
      NPM_CONFIG_PACKAGE: "@alook/daemon@latest",
      [registryKey]: "https://registry.example.test",
    });
    expect(started.code).toBe(0);
    expect(started.output).toContain("started in background");
    expect(JSON.parse(fs.readFileSync(envResult, "utf8"))).toEqual({
      package: null,
      upperPackage: null,
      registry: "https://registry.example.test",
    });
    const owner = readOwner(baseDir);
    expect(alive(owner.pid)).toBe(true);
    expect(owner).toMatchObject({ machineId });
    expect(JSON.stringify(owner)).not.toContain(secret);
    expect(processDescription(owner.pid)).not.toContain(secret);
    const daemonDir = path.dirname(pidfile(baseDir));
    const logPath = path.join(daemonDir, "daemon.log");
    expect(fs.readFileSync(logPath, "utf8")).not.toContain(secret);
    expect(daemonLogRecords(baseDir)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "daemon startup",
        fields: expect.objectContaining({ machineId, version: expect.any(String) }),
      }),
      expect.objectContaining({ message: "daemon up" }),
    ]));
    if (process.platform !== "win32") {
      expect(fs.statSync(daemonDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(pidfile(baseDir)).mode & 0o777).toBe(0o600);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(baseDir, "daemons", `${machineId}.credential.json`)).mode & 0o777).toBe(0o600);
    }
    await stop(baseDir);
    await waitFor(() => !alive(owner.pid));
    expect(fs.existsSync(pidfile(baseDir))).toBe(false);
  }, 120_000);

  it("fails a fresh bare credential offline without creating a hash-derived machine directory", async () => {
    const baseDir = makeEmptyBaseDir();
    const result = await runCli(cliArgs(baseDir));
    expect(result.output).toContain("fetch failed");
    const daemonsDir = path.join(baseDir, "daemons");
    expect(fs.existsSync(daemonsDir) ? fs.readdirSync(daemonsDir) : []).toEqual([]);
  }, 60_000);

  it("foreground owns the final pidfile with its current pid and rejects a background contender", async () => {
    const baseDir = makeBaseDir();
    const foreground = spawnCli(cliArgs(baseDir, true));
    const foregroundResult = collect(foreground);
    await waitFor(() => daemonIsReady(baseDir));
    const owner = readOwner(baseDir);
    expect(owner.pid).toBe(foreground.pid);
    const contender = await runCli(cliArgs(baseDir));
    expect(contender.output).toContain("already running");
    expect(readOwner(baseDir)).toEqual(owner);
    await stop(baseDir);
    const completed = await foregroundResult;
    expect(completed.output).toContain("daemon startup");
    expect(completed.output).toContain("daemon up");
    const expectedRecords = [
      "daemon startup",
      "daemon up",
      ...(process.platform === "win32" ? [] : ["shutting down…"]),
    ];
    expect(daemonLogRecords(baseDir).map((record) => record.message)).toEqual(expect.arrayContaining(expectedRecords));
    await waitFor(() => !fs.existsSync(pidfile(baseDir)));
  }, 60_000);

  it("allows exactly one winner in background↔background and foreground↔foreground races", async () => {
    const backgroundBase = makeBaseDir();
    const backgroundResults = await Promise.all([
      collect(spawnCli(cliArgs(backgroundBase))),
      collect(spawnCli(cliArgs(backgroundBase))),
    ]);
    expect(backgroundResults.filter((result) => result.output.includes("started in background"))).toHaveLength(1);
    expect(backgroundResults.filter((result) => result.output.includes("already") || result.output.includes("in progress"))).toHaveLength(1);
    const backgroundOwner = readOwner(backgroundBase);
    expect(alive(backgroundOwner.pid)).toBe(true);
    await stop(backgroundBase);

    const foregroundBase = makeBaseDir();
    const first = spawnCli(cliArgs(foregroundBase, true));
    const second = spawnCli(cliArgs(foregroundBase, true));
    const firstResult = collect(first);
    const secondResult = collect(second);
    await waitFor(() => daemonIsReady(foregroundBase));
    const foregroundOwner = readOwner(foregroundBase);
    expect([first.pid, second.pid]).toContain(foregroundOwner.pid);
    await stop(foregroundBase);
    const results = await Promise.all([firstResult, secondResult]);
    expect(results.filter((result) => result.output.includes("already") || result.output.includes("in progress"))).toHaveLength(1);
    await waitFor(() => !fs.existsSync(pidfile(foregroundBase)));
  }, 60_000);

  it("cleans a timed-out child that has not installed its shutdown handlers", async () => {
    const baseDir = makeBaseDir();
    const startup = blockRunnerStartup(baseDir);
    const shutdownMarker = path.join(baseDir, "early-shutdown.marker");
    const first = spawnCli(cliArgs(baseDir), {
      ...startup.env,
      NODE_ENV: "test",
      ALOOK_DAEMON_TEST_RECEIPT_TIMEOUT_MS: "1500",
      ALOOK_DAEMON_TEST_SHUTDOWN_DELAY_MS: "800",
      ALOOK_DAEMON_TEST_SHUTDOWN_MARKER: shutdownMarker,
    });
    const firstResult = collect(first);
    await waitFor(() => readCheckpoint(startup.checkpointFile) !== undefined);
    const checkpoint = readCheckpoint(startup.checkpointFile)!;
    expect(checkpoint.parentPid).toBe(first.pid);
    const failedStart = await firstResult;
    expect(failedStart.output).toContain("timed out");
    expect(alive(checkpoint.childPid)).toBe(false);
    expect(fs.existsSync(pidfile(baseDir))).toBe(false);
    expect(fs.existsSync(shutdownMarker)).toBe(false);
    expect(daemonIsReady(baseDir)).toBe(false);
    const replacement = await runCli(cliArgs(baseDir));
    expect(replacement.output).toContain("started in background");
    const replacementOwner = readOwner(baseDir);
    expect(replacementOwner.pid).not.toBe(checkpoint.childPid);
    await stop(baseDir);
    await waitFor(() => !alive(replacementOwner.pid) && !fs.existsSync(pidfile(baseDir)));
  }, 60_000);

  it("keeps ownership until a timed-out child has actually exited", async () => {
    const baseDir = makeBaseDir();
    const startup = blockRunnerStartup(baseDir);
    const shutdownMarker = path.join(baseDir, "delayed-shutdown.marker");
    const first = spawnCli(cliArgs(baseDir), {
      ...startup.env,
      NODE_ENV: "test",
      ALOOK_DAEMON_TEST_RECEIPT_TIMEOUT_MS: "1500",
      ALOOK_DAEMON_TEST_RECEIPT_TIMEOUT_AFTER_READY: "1",
      ALOOK_DAEMON_TEST_SKIP_READY: "1",
      ALOOK_DAEMON_TEST_SHUTDOWN_DELAY_MS: "800",
      ALOOK_DAEMON_TEST_SHUTDOWN_MARKER: shutdownMarker,
    });
    let parentOutput = "";
    const firstResult = collect(first, chunk => { parentOutput += chunk; });
    await waitFor(() => readCheckpoint(startup.checkpointFile) !== undefined);
    const checkpoint = readCheckpoint(startup.checkpointFile)!;
    expect(checkpoint.parentPid).toBe(first.pid);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(first.exitCode).toBeNull();
    expect(alive(checkpoint.childPid)).toBe(true);
    expect(readOwner(baseDir).pid).toBe(checkpoint.childPid);
    expect(fs.existsSync(shutdownMarker)).toBe(false);
    startup.release();
    await waitFor(() => daemonIsReady(baseDir));
    const waitStarted = Date.now();
    try {
      await waitFor(() => process.platform === "win32"
        ? fs.existsSync(pidfile(baseDir)) && alive(readOwner(baseDir).pid)
        : fs.existsSync(shutdownMarker));
    } catch (error) {
      reportDelayedShutdownFailure(baseDir, shutdownMarker, first, parentOutput, Date.now() - waitStarted);
      throw error;
    }
    const oldOwner = readOwner(baseDir);
    expect(oldOwner.pid).toBe(checkpoint.childPid);
    if (process.platform !== "win32") {
      expect(fs.readFileSync(shutdownMarker, "utf8")).toBe(String(oldOwner.pid));
    }
    expect(alive(oldOwner.pid)).toBe(true);

    await expect(daemonStart({
      machineKey: secret,
      serverUrl: "http://127.0.0.1:9",
      wsUrl: "ws://127.0.0.1:9",
      baseDir,
      foreground: true,
    })).rejects.toThrow("already running");
    expect(readOwner(baseDir)).toEqual(oldOwner);

    const failedStart = await firstResult;
    expect(failedStart.output).toContain("timed out");
    await waitFor(() => !alive(oldOwner.pid) && !fs.existsSync(pidfile(baseDir)));
    const replacement = await runCli(cliArgs(baseDir));
    expect(replacement.output).toContain("started in background");
    const replacementOwner = readOwner(baseDir);
    expect(replacementOwner.pid).not.toBe(oldOwner.pid);
    await stop(baseDir);
    await waitFor(() => !alive(replacementOwner.pid) && !fs.existsSync(pidfile(baseDir)));
  }, 60_000);

  it("exits and releases ownership exactly once when fatal teardown rejects", async () => {
    const baseDir = makeBaseDir();
    const releaseMarker = path.join(baseDir, "release.marker");
    const started = await runCli(cliArgs(baseDir), {
      NODE_ENV: "test",
      ALOOK_DAEMON_TEST_FATAL_AFTER_READY: "1",
      ALOOK_DAEMON_TEST_STOP_REJECT: "1",
      ALOOK_DAEMON_TEST_RELEASE_MARKER: releaseMarker,
    });
    expect(started.output).toContain("started in background");
    const owner = readOwner(baseDir);

    await waitFor(() => !alive(owner.pid) && !fs.existsSync(pidfile(baseDir)));

    const releases = fs.readFileSync(releaseMarker, "utf8").trim().split("\n");
    expect(releases).toEqual([String(owner.pid)]);
    const records = daemonLogRecords(baseDir);
    expect(records.filter((record) => record.message === "unhandled rejection")).toHaveLength(1);
    expect(records.filter((record) => record.message === "daemon teardown failed")).toHaveLength(1);
    expect(records.filter((record) => record.message === "shutting down…")).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("cmk_B0_FATAL_SECRET");
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "unhandled rejection",
        fields: expect.objectContaining({ errorClass: "Error", error: "test fatal [redacted-token]" }),
      }),
      expect.objectContaining({
        message: "daemon teardown failed",
        fields: expect.objectContaining({ errorClass: "Error", error: "test teardown failed [redacted-token]" }),
      }),
    ]));
  }, 60_000);

  for (const checkpoint of ["after_spawn_before_final", "after_final_before_ipc", "after_ipc_send"] as const) {
    it(`survives parent death at ${checkpoint} with exactly one eventual runner`, async () => {
      const baseDir = makeBaseDir();
      const checkpointFile = path.join(baseDir, `checkpoint-${checkpoint}.json`);
      const parent = spawnCli(cliArgs(baseDir), {
        NODE_ENV: "test",
        ALOOK_DAEMON_TEST_PAUSE_AT: checkpoint,
        ALOOK_DAEMON_TEST_CHECKPOINT_FILE: checkpointFile,
      });
      const parentResult = collect(parent);
      await waitFor(() => readCheckpoint(checkpointFile) !== undefined);
      const state = readCheckpoint(checkpointFile);
      if (!state) throw new Error("checkpoint was not readable after becoming ready");
      process.kill(state.parentPid, "SIGKILL");
      await parentResult;

      if (checkpoint === "after_ipc_send") {
        await waitFor(() => fs.existsSync(pidfile(baseDir)) && alive(readOwner(baseDir).pid));
        const owner = readOwner(baseDir);
        expect(owner.pid).toBe(state.childPid);
        const contender = await runCli(cliArgs(baseDir));
        expect(contender.output).toContain("already running");
        expect(readOwner(baseDir)).toEqual(owner);
        await stop(baseDir);
        return;
      }

      await waitFor(() => !alive(state.childPid));
      const restarted = await runCli(cliArgs(baseDir));
      expect(restarted.output).toContain("started in background");
      const owner = readOwner(baseDir);
      expect(alive(owner.pid)).toBe(true);
      expect(owner.pid).not.toBe(state.childPid);
      await stop(baseDir);
    }, 60_000);
  }
});

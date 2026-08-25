import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestAuthority } from "../src/lib/control-authority.js";
import { createServiceSupervisorRuntime, runServiceSupervisor } from "../src/service-supervisor-runtime.js";

class FakeProcess extends EventEmitter {
  pid = 73_001;
  platform: NodeJS.Platform = "linux";
  env: NodeJS.ProcessEnv = {};
  connected = true;
  exitCode: number | undefined;
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => callback?.(null));
  disconnect = vi.fn(() => { this.connected = false; });
  exit = vi.fn((_code?: number) => undefined) as unknown as NodeJS.Process["exit"];
  kill = vi.fn((_pid: number, _signal?: NodeJS.Signals | number) => {
    throw Object.assign(new Error("missing"), { code: "ESRCH" });
  });
  cwd = vi.fn(() => process.cwd());
}

function child(pid: number) {
  const value = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: PassThrough;
    stderr: PassThrough;
    connected: boolean;
    send: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  };
  value.pid = pid;
  value.exitCode = null;
  value.signalCode = null;
  value.stdout = new PassThrough();
  value.stderr = new PassThrough();
  value.connected = true;
  value.send = vi.fn();
  value.kill = vi.fn(() => {
    value.signalCode = "SIGTERM";
    value.emit("exit", null, "SIGTERM");
    return true;
  });
  value.disconnect = vi.fn(() => { value.connected = false; });
  value.unref = vi.fn();
  return value;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true");
}

async function rawRequest(endpoint: string, value: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let buffer = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${value}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
  });
}

function windowsHarness(records: () => Array<{ pid: number; parentPid: number; birth: string }>) {
  const fakeProcess = new FakeProcess();
  fakeProcess.platform = "win32";
  const watcher = child(75_001);
  const markers = new Map<number, string>();
  let nextMarkerPid = 75_100;
  let spawnCount = 0;
  const taskkill = vi.fn();
  const spawn = vi.fn(() => {
    spawnCount += 1;
    if (spawnCount === 1) {
      setImmediate(() => watcher.stdout.write("ready\n"));
      return watcher;
    }
    const marker = child(nextMarkerPid++);
    const birth = String((BigInt(Date.now()) * 10_000n) + 116_444_736_002_000_000n + BigInt(marker.pid));
    markers.set(marker.pid, birth);
    setTimeout(() => watcher.stdout.write(`${JSON.stringify({
      pid: marker.pid,
      parentPid: fakeProcess.pid,
      eventTime: String(BigInt(birth) + 1n),
    })}\n`), 5);
    return marker;
  });
  const execFileSync = vi.fn((command: string, args: string[]) => {
    if (command === "powershell.exe") {
      return JSON.stringify([
        ...records(),
        ...[...markers].map(([pid, birth]) => ({ pid, parentPid: fakeProcess.pid, birth })),
      ]);
    }
    taskkill(command, args);
    return "";
  });
  const runtime = createServiceSupervisorRuntime({
    process: fakeProcess as unknown as NodeJS.Process,
    spawn: spawn as never,
    execFileSync: execFileSync as never,
  });
  return { execFileSync, fakeProcess, runtime, spawn, taskkill, watcher };
}

const scratchPaths: string[] = [];

afterEach(() => {
  for (const path of scratchPaths.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("service supervisor runtime", () => {
  it("keeps token and process liveness checks fail-closed", () => {
    const fakeProcess = new FakeProcess();
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    expect(runtime.testing.tokenMatches("secret")).toBe(false);
    runtime.testing.setState({
      init: {
        mode: "reservation",
        runId: "run",
        service: "lifecycle",
        token: "secret",
        endpoint: "endpoint",
        heartbeatPath: "heartbeat",
      },
    });
    expect(runtime.testing.tokenMatches(1)).toBe(false);
    expect(runtime.testing.tokenMatches("wrong")).toBe(false);
    expect(runtime.testing.tokenMatches("secret")).toBe(true);

    fakeProcess.kill.mockImplementation(() => true);
    expect(runtime.testing.pidAlive(1)).toBe(true);
    expect(runtime.testing.posixTreeAlive(1)).toBe(true);
    fakeProcess.kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(runtime.testing.pidAlive(1)).toBe(true);
    expect(runtime.testing.posixTreeAlive(1)).toBe(true);
    fakeProcess.kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(runtime.testing.pidAlive(1)).toBe(false);
    expect(runtime.testing.posixTreeAlive(1)).toBe(false);
  });

  it("runs reservation status, token rejection, release, heartbeat, and cleanup in-process", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-reservation-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    const endpoint = join(scratch, "control.sock");
    const heartbeatPath = join(scratch, "heartbeat");
    runtime.run();
    fakeProcess.emit("message", {
      mode: "reservation",
      runId: "run-reservation",
      service: "lifecycle",
      token: "secret-token",
      endpoint,
      heartbeatPath,
    });
    await waitFor(() => fakeProcess.send.mock.calls.some(([message]) => message.type === "acquired"));

    await expect(requestAuthority({ pid: fakeProcess.pid, endpoint, token: "wrong" }, "status"))
      .rejects.toThrow("authority token mismatch");
    await expect(requestAuthority({ pid: fakeProcess.pid, endpoint, token: "secret-token" }, "status"))
      .resolves.toMatchObject({ runId: "run-reservation", childState: "running" });
    await expect(rawRequest(endpoint, JSON.stringify({ token: "secret-token", action: "unknown" })))
      .resolves.toMatchObject({ ok: false, error: "unsupported authority action" });
    await expect(rawRequest(endpoint, "{"))
      .resolves.toMatchObject({ ok: false, error: expect.stringContaining("SyntaxError") });
    await expect(requestAuthority({ pid: fakeProcess.pid, endpoint, token: "secret-token" }, "release"))
      .resolves.toMatchObject({ childState: "stopped" });
    await waitFor(() => fakeProcess.exit.mock.calls.length === 1);
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
    fakeProcess.emit("disconnect");
    expect(fakeProcess.exit).toHaveBeenCalledTimes(2);
    runtime.testing.cleanupEndpoint();
  });

  it("acquires and terminates a service through the real control server with injected process adapters", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-service-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    const runner = child(73_101);
    runner.send.mockImplementation(() => {
      setImmediate(() => runner.emit("message", { type: "runner-acquired", childPid: 73_102 }));
      return true;
    });
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      fork: vi.fn(() => runner) as never,
    });
    const endpoint = join(scratch, "control.sock");
    runtime.run();
    fakeProcess.emit("message", {
      mode: "service",
      runId: "run-service",
      service: "web",
      token: "service-token",
      endpoint,
      command: process.execPath,
      args: ["fixture.js"],
      cwd: scratch,
      env: {},
    });
    await waitFor(() => fakeProcess.send.mock.calls.some(([message]) => message.type === "acquired"));

    const authority = { pid: fakeProcess.pid, endpoint, token: "service-token" };
    await expect(requestAuthority(authority, "status")).resolves.toMatchObject({
      runId: "run-service",
      childPid: runner.pid,
      childState: "running",
    });
    await expect(requestAuthority(authority, "release")).rejects.toThrow("unsupported authority action");
    await expect(requestAuthority(authority, "terminate")).resolves.toMatchObject({ childState: "stopped" });
    await waitFor(() => fakeProcess.exit.mock.calls.length === 1);
    runtime.testing.cleanupEndpoint();
  });

  it("covers control-server startup cleanup and partial requests", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-control-edges-"));
    scratchPaths.push(scratch);
    const endpoint = join(scratch, "control.sock");
    const fakeProcess = new FakeProcess();
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    await expect(runtime.testing.startControlServer()).rejects.toThrow("missing supervisor init");
    writeFileSync(endpoint, "stale\n");
    runtime.testing.setState({
      init: {
        mode: "service",
        runId: "run",
        service: "web",
        token: "token",
        endpoint,
        command: "node",
        args: [],
        cwd: scratch,
        env: {},
      },
    });
    await runtime.testing.startControlServer();
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("{");
    await new Promise((resolve) => setImmediate(resolve));
    socket.destroy();
    runtime.testing.cleanupEndpoint();
    expect(existsSync(endpoint)).toBe(false);
    writeFileSync(endpoint, "orphaned\n");
    runtime.testing.cleanupEndpoint();
    expect(existsSync(endpoint)).toBe(false);
  });

  it("destroys an idle control socket at its local timeout", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-control-timeout-"));
    scratchPaths.push(scratch);
    const endpoint = join(scratch, "control.sock");
    const fakeProcess = new FakeProcess();
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    runtime.testing.setState({
      init: {
        mode: "service",
        runId: "run",
        service: "web",
        token: "token",
        endpoint,
        command: "node",
        args: [],
        cwd: scratch,
        env: {},
      },
    });
    await runtime.testing.startControlServer();
    const socket = createConnection(endpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("close", () => resolve());
      socket.once("error", reject);
    });
    runtime.testing.cleanupEndpoint();
  });

  it.each([false, true])("releases an already-stopped service with live tree=%s", async (treeAlive) => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-release-"));
    scratchPaths.push(scratch);
    const endpoint = join(scratch, "control.sock");
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => {
      if (treeAlive) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    const owned = child(treeAlive ? 73_151 : 73_150);
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    runtime.testing.setState({
      init: {
        mode: "service",
        runId: "run",
        service: "web",
        token: "token",
        endpoint,
        command: "node",
        args: [],
        cwd: scratch,
        env: {},
      },
      child: owned as never,
      status: {
        ok: true,
        runId: "run",
        service: "web",
        supervisorPid: fakeProcess.pid,
        childPid: owned.pid,
        childState: "stopped",
      },
    });
    await runtime.testing.startControlServer();
    const authority = { pid: fakeProcess.pid, endpoint, token: "token" };
    if (treeAlive) {
      await expect(requestAuthority(authority, "release")).rejects.toThrow("is still running");
      runtime.testing.cleanupEndpoint();
    } else {
      await expect(requestAuthority(authority, "release")).resolves.toMatchObject({ childState: "stopped" });
      await waitFor(() => fakeProcess.exit.mock.calls.length === 1);
    }
  });

  it("returns termination failures through the control server", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-terminate-error-"));
    scratchPaths.push(scratch);
    const endpoint = join(scratch, "control.sock");
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => true);
    const owned = child(73_160);
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    runtime.testing.setState({
      init: {
        mode: "service",
        runId: "run",
        service: "web",
        token: "token",
        endpoint,
        command: "node",
        args: [],
        cwd: scratch,
        env: {},
      },
      child: owned as never,
      status: {
        ok: true,
        runId: "run",
        service: "web",
        supervisorPid: fakeProcess.pid,
        childPid: owned.pid,
        childState: "running",
      },
    });
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10_000;
      return now;
    });
    await runtime.testing.startControlServer();
    await expect(requestAuthority({ pid: fakeProcess.pid, endpoint, token: "token" }, "terminate"))
      .rejects.toThrow("survived forced termination");
    runtime.testing.cleanupEndpoint();
  });

  it("reports service-runner errors, exits, and command completion after acquisition", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-runner-events-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    const runner = child(73_170);
    runner.send.mockImplementation(() => {
      setImmediate(() => runner.emit("message", { type: "runner-acquired", childPid: 73_171 }));
      return true;
    });
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      fork: vi.fn(() => runner) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "service",
      runId: "run-events",
      service: "web",
      token: "token",
      endpoint: join(scratch, "control.sock"),
      command: "node",
      args: [],
      cwd: scratch,
      env: {},
    });
    await waitFor(() => fakeProcess.send.mock.calls.some(([message]) => message.type === "acquired"));
    runner.emit("error", new Error("runner ipc error"));
    runner.emit("message", { type: "runner-command-exit", exitCode: 4, exitSignal: null });
    runner.emit("exit", 4, null);
    expect(fakeProcess.send.mock.calls.map(([message]) => message.type)).toEqual(expect.arrayContaining([
      "child-error",
      "child-exit",
    ]));
    runtime.testing.cleanupEndpoint();
  });

  it("ignores the runner exit event after status is already stopped", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-stopped-exit-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    const runner = child(73_175);
    runner.send.mockImplementation(() => {
      setImmediate(() => runner.emit("message", { type: "runner-acquired", childPid: 73_176 }));
      return true;
    });
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      fork: vi.fn(() => runner) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "service",
      runId: "run-stopped",
      service: "web",
      token: "token",
      endpoint: join(scratch, "control.sock"),
      command: "node",
      args: [],
      cwd: scratch,
      env: {},
    });
    await waitFor(() => fakeProcess.send.mock.calls.some(([message]) => message.type === "acquired"));
    runtime.testing.setState({
      status: { ok: true, runId: "run-stopped", service: "web", supervisorPid: fakeProcess.pid, childState: "stopped" },
    });
    const calls = fakeProcess.send.mock.calls.length;
    runner.emit("exit", 0, null);
    expect(fakeProcess.send).toHaveBeenCalledTimes(calls);
    runtime.testing.cleanupEndpoint();
  });

  it.each([
    ["missing pid", (runner: ReturnType<typeof child>) => { runner.pid = 0; }],
    ["early exit", (runner: ReturnType<typeof child>) => {
      runner.send.mockImplementation(() => {
        setImmediate(() => runner.emit("exit", 2, null));
        return true;
      });
    }],
    ["runner error", (runner: ReturnType<typeof child>) => {
      runner.send.mockImplementation(() => {
        setImmediate(() => runner.emit("message", { type: "runner-error", error: "runner rejected" }));
        return true;
      });
    }],
  ])("fails service acquisition for %s", async (_label, configure) => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-acquire-failure-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    const runner = child(73_180);
    configure(runner);
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      fork: vi.fn(() => runner) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "service",
      runId: "run-failure",
      service: "web",
      token: "token",
      endpoint: join(scratch, "control.sock"),
      command: "node",
      args: [],
      cwd: scratch,
      env: {},
    });
    await waitFor(() => fakeProcess.send.mock.calls.some(([message]) => message.type === "supervisor-error"));
    expect(fakeProcess.exitCode).toBe(1);
    runtime.testing.cleanupEndpoint();
  });

  it("bounds a silent service command runner acquisition", async () => {
    vi.useFakeTimers();
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-acquire-timeout-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    const runner = child(73_190);
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      fork: vi.fn(() => runner) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "service",
      runId: "run-timeout",
      service: "web",
      token: "token",
      endpoint: join(scratch, "control.sock"),
      command: "node",
      args: [],
      cwd: scratch,
      env: {},
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fakeProcess.send.mock.calls.some(([message]) => message.type === "supervisor-error")).toBe(true);
    runtime.testing.cleanupEndpoint();
    vi.useRealTimers();
  });

  it("surfaces command-runner acquisition, exit, and forwarding through injected spawn", async () => {
    const fakeProcess = new FakeProcess();
    const command = child(73_201);
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => command) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "command-runner",
      command: process.execPath,
      args: ["fixture.js"],
      cwd: process.cwd(),
      env: {},
    });
    expect(fakeProcess.send).toHaveBeenCalledWith({ type: "runner-acquired", childPid: command.pid }, expect.any(Function));
    command.emit("exit", 0, null);
    expect(fakeProcess.send).toHaveBeenCalledWith(
      { type: "runner-command-exit", exitCode: 0, exitSignal: null },
      expect.any(Function),
    );
    fakeProcess.emit("SIGTERM");
    expect(fakeProcess.exit).toHaveBeenCalledWith(0);
    runtime.testing.cleanupEndpoint();
  });

  it("forwards a pre-exit graceful signal once and reports command errors", () => {
    const fakeProcess = new FakeProcess();
    const command = child(73_211);
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => command) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "command-runner",
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: {},
    });
    fakeProcess.emit("SIGINT");
    fakeProcess.emit("SIGTERM");
    expect(command.kill).toHaveBeenCalledOnce();
    expect(command.kill).toHaveBeenCalledWith("SIGINT");
    command.emit("exit", null, "SIGTERM");
    expect(fakeProcess.exit).toHaveBeenCalledWith(1);

    const errorProcess = new FakeProcess();
    const errorCommand = child(73_212);
    const errorRuntime = createServiceSupervisorRuntime({
      process: errorProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => errorCommand) as never,
    });
    errorRuntime.run();
    errorProcess.emit("message", {
      mode: "command-runner",
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: {},
    });
    errorCommand.emit("error", new Error("command broke"));
    expect(errorProcess.send).toHaveBeenCalledWith(
      { type: "runner-error", error: "command broke" },
      expect.any(Function),
    );
    expect(errorProcess.disconnect).toHaveBeenCalledOnce();
    expect(errorProcess.exit).toHaveBeenCalledWith(1);
  });

  it("fails command-runner startup once and reports the injected spawn error", () => {
    const fakeProcess = new FakeProcess();
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => { throw new Error("spawn failed"); }) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "command-runner",
      command: "npx",
      args: [],
      cwd: process.cwd(),
      env: {},
    });
    expect(fakeProcess.send).toHaveBeenCalledWith(
      { type: "runner-error", error: "Error: spawn failed" },
      expect.any(Function),
    );
    expect(fakeProcess.exitCode).toBe(1);
  });

  it("rejects a command runner without a child PID", () => {
    const fakeProcess = new FakeProcess();
    const command = child(0);
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => command) as never,
    });
    runtime.run();
    fakeProcess.emit("message", {
      mode: "command-runner",
      command: process.execPath,
      args: [],
      cwd: process.cwd(),
      env: {},
    });
    expect(fakeProcess.send).toHaveBeenCalledWith(
      { type: "runner-error", error: "Error: command runner failed to spawn its service root" },
      expect.any(Function),
    );
    expect(fakeProcess.exitCode).toBe(1);
  });

  it("uses a same-watcher live marker as the Windows flush barrier and reaps it", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(73_301);
    const marker = child(73_302);
    let spawnCount = 0;
    const eventTime = String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n);
    const birth = String(BigInt(eventTime) - 10_000n);
    const spawn = vi.fn(() => {
      spawnCount += 1;
      if (spawnCount === 1) {
        setImmediate(() => watcher.stdout.write("ready\n"));
        return watcher;
      }
      setImmediate(() => watcher.stdout.write(`${JSON.stringify({
        pid: marker.pid,
        parentPid: fakeProcess.pid,
        eventTime,
      })}\n`));
      return marker;
    });
    const execFileSync = vi.fn(() => JSON.stringify([{ pid: marker.pid, parentPid: fakeProcess.pid, birth }]));
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: spawn as never,
      execFileSync: execFileSync as never,
    });

    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000)).resolves.toBeUndefined();
    expect(marker.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledTimes(2);
    runtime.testing.cleanupEndpoint();
  });

  it("waits for the exact marker event after its snapshot is visible", async () => {
    const harness = windowsHarness(() => []);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(harness.runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000)).resolves.toBeUndefined();
    expect(harness.execFileSync).toHaveBeenCalled();
    harness.runtime.testing.cleanupEndpoint();
  });

  it("accepts a qualifying marker event already queued by the same watcher", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(75_111);
    const marker = child(75_112);
    const birth = String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n);
    let spawns = 0;
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        return marker;
      }) as never,
      readWindowsProcessSnapshot: vi.fn(() => JSON.stringify({
        pid: marker.pid,
        parentPid: fakeProcess.pid,
        birth,
      })),
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    runtime.testing.recordWindowsStartEvent({
      pid: marker.pid,
      parentPid: fakeProcess.pid,
      eventTime: String(BigInt(birth) + 10_000n),
    });
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000)).resolves.toBeUndefined();
    expect(marker.kill).toHaveBeenCalledOnce();
    runtime.testing.cleanupEndpoint();
  });

  it("fails a marker snapshot loop immediately after the watcher reports malformed data", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(75_121);
    const marker = child(75_122);
    let spawns = 0;
    let runtime: ReturnType<typeof createServiceSupervisorRuntime>;
    runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        return marker;
      }) as never,
      readWindowsProcessSnapshot: vi.fn(() => {
        runtime.testing.recordWindowsStartEvent({ pid: "invalid", parentPid: 0, eventTime: "1" });
        return "";
      }),
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000))
      .rejects.toThrow("invalid event");
    expect(marker.kill).toHaveBeenCalledOnce();
    runtime.testing.cleanupEndpoint();
  });

  it("fails a flush when the injected Windows watcher exits", async () => {
    const harness = windowsHarness(() => []);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    harness.watcher.emit("exit", 1, null);
    await expect(harness.runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000))
      .rejects.toThrow("process watcher exited");
    harness.runtime.testing.cleanupEndpoint();
  });

  it("fails a marker loop if watcher authority disappears after the snapshot", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(75_201);
    watcher.kill.mockImplementation(() => true);
    const marker = child(75_202);
    let spawns = 0;
    let runtime: ReturnType<typeof createServiceSupervisorRuntime>;
    runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        return marker;
      }) as never,
      execFileSync: vi.fn(() => {
        runtime.testing.cleanupEndpoint();
        return "";
      }) as never,
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 100))
      .rejects.toThrow("authority is missing");
  });

  it("enforces the marker-observation deadline after a bounded snapshot", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(75_203);
    const marker = child(75_204);
    let spawns = 0;
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        return marker;
      }) as never,
      execFileSync: vi.fn(() => "") as never,
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    const deadline = Date.now() + 30;
    await expect(runtime.testing.flushWindowsProcessWatcher(deadline)).rejects.toThrow("required marker");
  });

  it.each(["error", "missing"] as const)("fails marker polling on watcher %s", async (failure) => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(failure === "error" ? 75_205 : 75_206);
    if (failure === "missing") watcher.kill.mockImplementation(() => true);
    const marker = child(failure === "error" ? 75_207 : 75_208);
    const markerBirth = String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n);
    let spawns = 0;
    let runtime: ReturnType<typeof createServiceSupervisorRuntime>;
    runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        setTimeout(() => {
          if (failure === "error") watcher.emit("exit", 1, null);
          else runtime.testing.cleanupEndpoint();
        }, 5);
        return marker;
      }) as never,
      execFileSync: vi.fn(() => JSON.stringify({
        pid: marker.pid,
        parentPid: fakeProcess.pid,
        birth: markerBirth,
      })) as never,
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000))
      .rejects.toThrow(failure === "error" ? "process watcher exited" : "authority is missing");
  });

  it("locks the exact Windows runner and service-root creation identities before acquisition", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "alook-runtime-windows-acquire-"));
    scratchPaths.push(scratch);
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(73_601);
    const runner = child(73_602);
    let markerPid = 73_610;
    let spawnCount = 0;
    const markerBirths = new Map<number, string>();
    let runnerBirth = "";
    let rootBirth = "";
    const spawn = vi.fn(() => {
      spawnCount += 1;
      if (spawnCount === 1) {
        setImmediate(() => watcher.stdout.write("ready\n"));
        return watcher;
      }
      const marker = child(markerPid++);
      const birth = String((BigInt(Date.now()) * 10_000n) + 116_444_736_000_000_000n);
      markerBirths.set(marker.pid, birth);
      setImmediate(() => watcher.stdout.write(`${JSON.stringify({
        pid: marker.pid,
        parentPid: fakeProcess.pid,
        eventTime: birth,
      })}\n`));
      return marker;
    });
    runner.send.mockImplementation(() => {
      setTimeout(() => {
        runnerBirth = String((BigInt(Date.now()) * 10_000n) + 116_444_736_000_000_000n);
        rootBirth = String(BigInt(runnerBirth) + 1n);
        watcher.stdout.write(`${JSON.stringify({ pid: runner.pid, parentPid: fakeProcess.pid, eventTime: runnerBirth })}\n`);
        watcher.stdout.write(`${JSON.stringify({ pid: 73_603, parentPid: runner.pid, eventTime: rootBirth })}\n`);
        setTimeout(() => runner.emit("message", { type: "runner-acquired", childPid: 73_603 }), 5);
      }, 5);
      return true;
    });
    const execFileSync = vi.fn(() => JSON.stringify([
      ...(runnerBirth ? [{ pid: runner.pid, parentPid: fakeProcess.pid, birth: runnerBirth }] : []),
      ...(rootBirth ? [{ pid: 73_603, parentPid: runner.pid, birth: rootBirth }] : []),
      ...[...markerBirths].map(([pid, birth]) => ({ pid, parentPid: fakeProcess.pid, birth })),
    ]));
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: spawn as never,
      fork: vi.fn(() => runner) as never,
      execFileSync: execFileSync as never,
    });
    const endpoint = join(scratch, "control.sock");
    runtime.run();
    fakeProcess.emit("message", {
      mode: "service",
      runId: "run-windows",
      service: "web",
      token: "windows-token",
      endpoint,
      command: process.execPath,
      args: [],
      cwd: scratch,
      env: {},
    });
    await waitFor(() => fakeProcess.send.mock.calls.some(([message]) => message.type === "acquired"));
    expect(fakeProcess.send.mock.calls.find(([message]) => message.type === "acquired")?.[0])
      .toMatchObject({ status: { childPid: runner.pid, childState: "running" } });
    runtime.testing.cleanupEndpoint();
  });

  it("selects the newest matching Windows seed pair and rejects missing creation identities", async () => {
    const base = (BigInt(Date.now()) * 10_000n) + 116_444_736_000_000_000n + 1_000_000n;
    const records = [
      { pid: 40, parentPid: 73_001, birth: String(base) },
      { pid: 41, parentPid: 40, birth: String(base + 1n) },
    ];
    const harness = windowsHarness(() => records);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    harness.runtime.testing.setState({ windowsSeedCutoff: base + 10n });
    harness.runtime.testing.recordWindowsStartEvent({ pid: 40, parentPid: harness.fakeProcess.pid, eventTime: String(base) });
    harness.runtime.testing.recordWindowsStartEvent({ pid: 41, parentPid: 40, eventTime: String(base + 1n) });
    harness.runtime.testing.recordWindowsStartEvent({ pid: 40, parentPid: harness.fakeProcess.pid, eventTime: String(base + 2n) });
    harness.runtime.testing.recordWindowsStartEvent({ pid: 41, parentPid: 40, eventTime: String(base + 3n) });
    await expect(harness.runtime.testing.lockOwnedWindowsSeeds(40, 41, Date.now() + 1_000)).resolves.toBeUndefined();

    const missing = windowsHarness(() => []);
    await missing.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    missing.runtime.testing.setState({ windowsSeedCutoff: base + 10n });
    await expect(missing.runtime.testing.lockOwnedWindowsSeeds(50, 51, Date.now() + 1_000))
      .rejects.toThrow("creation identity was not observed");
    missing.runtime.testing.cleanupEndpoint();
  });

  it.each([
    { label: "wrong parent", parentPid: 99_999, emitEvent: true, expected: "parent identity changed" },
    { label: "withheld marker", parentPid: 73_001, emitEvent: false, expected: "required marker" },
    { label: "predated identity", parentPid: 73_001, emitEvent: true, expected: "predates", predated: true },
  ])("fails closed and reaps a Windows marker for $label", async ({ parentPid, emitEvent, expected, predated }) => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(73_401);
    const marker = child(73_402);
    const birth = predated
      ? "1"
      : String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n);
    let spawnCount = 0;
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawnCount += 1;
        if (spawnCount === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        if (emitEvent) {
          setImmediate(() => watcher.stdout.write(`${JSON.stringify({
            pid: marker.pid,
            parentPid,
            eventTime: String(BigInt(birth) + 10_000n),
          })}\n`));
        }
        return marker;
      }) as never,
      execFileSync: vi.fn(() => JSON.stringify([{ pid: marker.pid, parentPid, birth }])) as never,
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 80)).rejects.toThrow(expected);
    expect(marker.kill).toHaveBeenCalledOnce();
    runtime.testing.cleanupEndpoint();
  });

  it("rejects same-PID marker reuse after watcher observation and always reaps the marker", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(73_411);
    const marker = child(73_412);
    const firstBirth = String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n);
    let spawns = 0;
    let snapshots = 0;
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        setImmediate(() => watcher.stdout.write(`${JSON.stringify({
          pid: marker.pid,
          parentPid: fakeProcess.pid,
          eventTime: String(BigInt(firstBirth) + 10_000n),
        })}\n`));
        return marker;
      }) as never,
      readWindowsProcessSnapshot: vi.fn(() => {
        snapshots += 1;
        return JSON.stringify({
          pid: marker.pid,
          parentPid: fakeProcess.pid,
          birth: snapshots === 1 ? firstBirth : String(BigInt(firstBirth) + 1n),
        });
      }),
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000))
      .rejects.toThrow("identity changed after observation");
    expect(marker.kill).toHaveBeenCalledOnce();
    runtime.testing.cleanupEndpoint();
  });

  it("rejects a marker that exits between watcher observation and identity confirmation", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(73_421);
    const marker = child(73_422);
    const birth = String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n);
    let spawns = 0;
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        spawns += 1;
        if (spawns === 1) {
          setImmediate(() => watcher.stdout.write("ready\n"));
          return watcher;
        }
        setImmediate(() => {
          watcher.stdout.write(`${JSON.stringify({
            pid: marker.pid,
            parentPid: fakeProcess.pid,
            eventTime: String(BigInt(birth) + 10_000n),
          })}\n`);
          marker.exitCode = 1;
        });
        return marker;
      }) as never,
      readWindowsProcessSnapshot: vi.fn(() => JSON.stringify({
        pid: marker.pid,
        parentPid: fakeProcess.pid,
        birth,
      })),
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000))
      .rejects.toThrow("exited before identity confirmation");
    runtime.testing.cleanupEndpoint();
  });

  it("fails closed on watcher EOF and creation-time regression before another marker is spawned", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(73_501);
    const spawn = vi.fn(() => {
      setImmediate(() => watcher.stdout.write("ready\n"));
      return watcher;
    });
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: spawn as never,
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    runtime.testing.recordWindowsStartEvent({ pid: 1, parentPid: 0, eventTime: "500" });
    runtime.testing.recordWindowsStartEvent({ pid: 2, parentPid: 1, eventTime: "499" });
    await expect(runtime.testing.flushWindowsProcessWatcher(Date.now() + 100)).rejects.toThrow("creation time regressed");
    expect(spawn).toHaveBeenCalledOnce();
    runtime.testing.cleanupEndpoint();

    const eofProcess = new FakeProcess();
    eofProcess.platform = "win32";
    const eofWatcher = child(73_502);
    const eofRuntime = createServiceSupervisorRuntime({
      process: eofProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        setImmediate(() => eofWatcher.stdout.write("ready\n"));
        return eofWatcher;
      }) as never,
    });
    await eofRuntime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    eofWatcher.emit("exit", 1, null);
    await expect(eofRuntime.testing.flushWindowsProcessWatcher(Date.now() + 100)).rejects.toThrow("process watcher exited");
    eofRuntime.testing.cleanupEndpoint();
  });

  it("covers Windows marker startup, snapshot, timeout, and exit fail-closed edges", async () => {
    const missingProcess = new FakeProcess();
    missingProcess.platform = "win32";
    const missingRuntime = createServiceSupervisorRuntime({ process: missingProcess as unknown as NodeJS.Process });
    await expect(missingRuntime.testing.flushWindowsProcessWatcher()).rejects.toThrow("authority is missing");
    expect(missingRuntime.testing.windowsOperationTimeout()).toBeGreaterThan(0);
    expect(() => missingRuntime.testing.windowsOperationTimeout(Date.now() - 1)).toThrow("termination deadline exceeded");

    const snapshotProcess = new FakeProcess();
    snapshotProcess.platform = "win32";
    const emptyRuntime = createServiceSupervisorRuntime({
      process: snapshotProcess as unknown as NodeJS.Process,
      execFileSync: vi.fn(() => "") as never,
    });
    expect(emptyRuntime.testing.windowsProcessSnapshot()).toEqual([]);
    const invalidRuntime = createServiceSupervisorRuntime({
      process: snapshotProcess as unknown as NodeJS.Process,
      execFileSync: vi.fn(() => JSON.stringify({ pid: "bad", parentPid: 1, birth: "1" })) as never,
    });
    expect(() => invalidRuntime.testing.windowsProcessSnapshot()).toThrow("invalid record");
    const invalidBirthRuntime = createServiceSupervisorRuntime({
      process: snapshotProcess as unknown as NodeJS.Process,
      readWindowsProcessSnapshot: vi.fn(() => JSON.stringify({ pid: 1, parentPid: 0, birth: "invalid" })),
    });
    expect(() => invalidBirthRuntime.testing.windowsProcessSnapshot()).toThrow("invalid record");

    const noPidProcess = new FakeProcess();
    noPidProcess.platform = "win32";
    const noPidWatcher = child(74_001);
    const noPidMarker = child(0);
    let noPidSpawns = 0;
    const noPidRuntime = createServiceSupervisorRuntime({
      process: noPidProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        noPidSpawns += 1;
        if (noPidSpawns === 1) {
          setImmediate(() => noPidWatcher.stdout.write("ready\n"));
          return noPidWatcher;
        }
        return noPidMarker;
      }) as never,
    });
    await noPidRuntime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(noPidRuntime.testing.flushWindowsProcessWatcher(Date.now() + 100)).rejects.toThrow("marker did not start");
    expect(noPidMarker.kill).toHaveBeenCalledOnce();
    noPidRuntime.testing.cleanupEndpoint();

    const exitProcess = new FakeProcess();
    exitProcess.platform = "win32";
    const exitWatcher = child(74_002);
    const exitMarker = child(74_003);
    let exitSpawns = 0;
    const exitRuntime = createServiceSupervisorRuntime({
      process: exitProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        exitSpawns += 1;
        if (exitSpawns === 1) {
          setImmediate(() => exitWatcher.stdout.write("ready\n"));
          return exitWatcher;
        }
        exitMarker.exitCode = 1;
        return exitMarker;
      }) as never,
      execFileSync: vi.fn(() => "") as never,
    });
    await exitRuntime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(exitRuntime.testing.flushWindowsProcessWatcher(Date.now() + 100))
      .rejects.toThrow("marker exited before observation");
    exitRuntime.testing.cleanupEndpoint();

    const timeoutProcess = new FakeProcess();
    timeoutProcess.platform = "win32";
    const timeoutWatcher = child(74_004);
    const timeoutMarker = child(74_005);
    let timeoutSpawns = 0;
    const timeoutRuntime = createServiceSupervisorRuntime({
      process: timeoutProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        timeoutSpawns += 1;
        if (timeoutSpawns === 1) {
          setImmediate(() => timeoutWatcher.stdout.write("ready\n"));
          return timeoutWatcher;
        }
        return timeoutMarker;
      }) as never,
      execFileSync: vi.fn(() => "") as never,
    });
    await timeoutRuntime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await expect(timeoutRuntime.testing.flushWindowsProcessWatcher(Date.now() + 30))
      .rejects.toThrow("required marker");
    expect(timeoutMarker.kill).toHaveBeenCalledOnce();
    timeoutRuntime.testing.cleanupEndpoint();
  });

  it("propagates creation-qualified Windows ownership and rejects identity drift", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    const watcher = child(74_101);
    let markerPid = 74_110;
    const markerBirths = new Map<number, string>();
    let spawnCount = 0;
    const spawn = vi.fn(() => {
      spawnCount += 1;
      if (spawnCount === 1) {
        setImmediate(() => watcher.stdout.write("ready\n"));
        return watcher;
      }
      const marker = child(markerPid++);
      const birth = String((BigInt(Date.now()) * 10_000n) + 116_444_737_000_000_000n + BigInt(marker.pid));
      markerBirths.set(marker.pid, birth);
      setImmediate(() => watcher.stdout.write(`${JSON.stringify({
        pid: marker.pid,
        parentPid: fakeProcess.pid,
        eventTime: String(BigInt(birth) + 1n),
      })}\n`));
      return marker;
    });
    const execFileSync = vi.fn(() => JSON.stringify([...markerBirths].map(([pid, birth]) => ({
      pid,
      parentPid: fakeProcess.pid,
      birth,
    }))));
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      spawn: spawn as never,
      execFileSync: execFileSync as never,
    });
    await runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    runtime.testing.processWindowsStartEvent({ pid: 10, parentPid: 0, eventTime: 10n, owned: true });
    runtime.testing.processWindowsStartEvent({ pid: 12, parentPid: 11, eventTime: 12n, owned: false });
    runtime.testing.processWindowsStartEvent({ pid: 11, parentPid: 10, eventTime: 11n, owned: false });
    runtime.testing.setState({
      windowsSeedIdentitiesLocked: true,
      ownedWindowsProcesses: [{ pid: 10, parentPid: 0, birth: "10" }],
      latestWindowsStartEvents: [
        { pid: 10, parentPid: 0, eventTime: 10n, owned: true },
        { pid: 11, parentPid: 10, eventTime: 11n, owned: true },
        { pid: 12, parentPid: 11, eventTime: 12n, owned: true },
      ],
    });
    await expect(runtime.testing.refreshOwnedWindowsProcesses(Date.now() + 1_000, [
      { pid: 10, parentPid: 0, birth: "10" },
      { pid: 11, parentPid: 10, birth: "11" },
      { pid: 12, parentPid: 11, birth: "12" },
    ])).resolves.toHaveLength(3);
    await expect(runtime.testing.refreshOwnedWindowsProcesses(Date.now() + 1_000, [
      { pid: 10, parentPid: 0, birth: "changed" },
    ])).rejects.toThrow("identity changed");
    runtime.testing.cleanupEndpoint();
  });

  it("uses the injected WMI snapshot boundary without consulting process env", () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.platform = "win32";
    fakeProcess.env = {
      ALOOK_APP_TEST_REUSE_WINDOWS_COMMAND_ROOT_PID: "1",
      ALOOK_APP_TEST_REUSED_SEED_DESCENDANT_PID: "31",
    };
    const readWindowsProcessSnapshot = vi.fn(() => JSON.stringify([
      { pid: 31, parentPid: 30, birth: "31" },
    ]));
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      readWindowsProcessSnapshot,
    });
    runtime.testing.setState({ commandRootPid: 30, windowsSeedIdentitiesLocked: true });
    expect(runtime.testing.windowsProcessSnapshot()).toEqual([{ pid: 31, parentPid: 30, birth: "31" }]);
    expect(readWindowsProcessSnapshot).toHaveBeenCalledOnce();
  });

  it("fails Windows ownership refresh for a missing parent snapshot or creation event", async () => {
    const harness = windowsHarness(() => []);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    harness.runtime.testing.setState({
      windowsSeedIdentitiesLocked: true,
      ownedWindowsProcesses: [{ pid: 10, parentPid: 0, birth: "10" }],
    });
    await expect(harness.runtime.testing.refreshOwnedWindowsProcesses(Date.now() + 1_000, [
      { pid: 11, parentPid: 10, birth: "11" },
    ])).rejects.toThrow("identity is unavailable");

    harness.runtime.testing.setState({
      ownedWindowsProcesses: [{ pid: 10, parentPid: 0, birth: "10" }],
    });
    await expect(harness.runtime.testing.refreshOwnedWindowsProcesses(Date.now() + 1_000, [
      { pid: 10, parentPid: 0, birth: "10" },
      { pid: 11, parentPid: 10, birth: "11" },
    ])).rejects.toThrow("creation event is unavailable");
    harness.runtime.testing.cleanupEndpoint();
  });

  it("drops exited Windows ownership and reports exact live-tree state", async () => {
    let records = [{ pid: 10, parentPid: 0, birth: "10" }];
    const harness = windowsHarness(() => records);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    harness.runtime.testing.setState({
      windowsSeedIdentitiesLocked: true,
      ownedWindowsProcesses: records,
      latestWindowsStartEvents: [{ pid: 10, parentPid: 0, eventTime: 10n, owned: true }],
    });
    await expect(harness.runtime.testing.ownedTreeAlive(10, Date.now() + 1_000)).resolves.toBe(true);
    records = [];
    await expect(harness.runtime.testing.refreshOwnedWindowsProcesses(Date.now() + 1_000, records)).resolves.toEqual([]);
    await expect(harness.runtime.testing.ownedTreeAlive(10, Date.now() + 1_000)).resolves.toBe(false);
    harness.runtime.testing.cleanupEndpoint();
  });

  it("executes injected POSIX signal, force, and tree-exit paths", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => true);
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    await expect(runtime.testing.signalTree(22, false, Date.now() + 1_000)).resolves.toBeUndefined();
    await expect(runtime.testing.signalTree(22, true, Date.now() + 1_000)).resolves.toBeUndefined();
    expect(fakeProcess.kill).toHaveBeenCalledWith(22, "SIGTERM");
    expect(fakeProcess.kill).toHaveBeenCalledWith(-22, "SIGKILL");
    fakeProcess.kill.mockImplementation((_pid, signal) => {
      if (signal === "SIGKILL") throw new Error("forced signal denied");
      return true;
    });
    await expect(runtime.testing.signalTree(22, true, Date.now() + 1_000))
      .resolves.toEqual(expect.objectContaining({ message: "forced signal denied" }));
    fakeProcess.kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await expect(runtime.testing.waitForTreeExit(22, 20, Date.now() + 100)).resolves.toBe(true);
    await expect(runtime.testing.ownedTreeAlive(22)).resolves.toBe(false);
  });

  it("uses an injected clock and scheduler for bounded tree-exit polling", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => true);
    let current = 0;
    const scheduleTimeout = vi.fn((callback: (...args: unknown[]) => void) => {
      current += 10;
      callback();
      return {} as NodeJS.Timeout;
    });
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      now: () => current,
      scheduleTimeout: scheduleTimeout as never,
    });
    await expect(runtime.testing.waitForTreeExit(22, 20, 100)).resolves.toBe(false);
    expect(scheduleTimeout).toHaveBeenCalledTimes(2);
  });

  it("returns false when a POSIX tree remains alive through the exit deadline", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => true);
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    await expect(runtime.testing.waitForTreeExit(22, 1, Date.now() + 10)).resolves.toBe(false);
  });

  it("returns a POSIX signal error instead of throwing it", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => { throw new Error("signal denied"); });
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    await expect(runtime.testing.signalTree(22, false, Date.now() + 1_000))
      .resolves.toEqual(expect.objectContaining({ message: "signal denied" }));
  });

  it("terminates a live POSIX tree gracefully", async () => {
    const fakeProcess = new FakeProcess();
    let alive = true;
    fakeProcess.kill.mockImplementation((_pid, signal) => {
      if (signal === "SIGTERM") alive = false;
      if (signal === 0 && !alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    const owned = child(74_301);
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    runtime.testing.setState({
      child: owned as never,
      status: { ok: true, runId: "run", service: "web", supervisorPid: fakeProcess.pid, childState: "running" },
    });
    await expect(runtime.testing.terminateOwnedTree()).resolves.toMatchObject({ childState: "stopped" });
    expect(fakeProcess.kill).toHaveBeenCalledWith(owned.pid, "SIGTERM");
  });

  it("escalates a stubborn POSIX tree and reports forced survivors", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => true);
    const owned = child(74_302);
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    runtime.testing.setState({
      child: owned as never,
      status: { ok: true, runId: "run", service: "web", supervisorPid: fakeProcess.pid, childState: "running" },
    });
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10_000;
      return now;
    });
    await expect(runtime.testing.terminateOwnedTree()).rejects.toThrow("survived forced termination");
    expect(fakeProcess.kill).toHaveBeenCalledWith(-owned.pid, "SIGKILL");
  });

  it("rejects escalation if the original child identity changes", async () => {
    const fakeProcess = new FakeProcess();
    fakeProcess.kill.mockImplementation(() => true);
    const owned = child(74_303);
    let reads = 0;
    Object.defineProperty(owned, "pid", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads >= 3 ? 74_304 : 74_303;
      },
    });
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    runtime.testing.setState({
      child: owned as never,
      status: { ok: true, runId: "run", service: "web", supervisorPid: fakeProcess.pid, childState: "running" },
    });
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10_000;
      return now;
    });
    await expect(runtime.testing.terminateOwnedTree()).rejects.toThrow("identity changed before escalation");
  });

  it("runs bounded Windows taskkill targets and aggregates failures", async () => {
    let records = [
      { pid: 20, parentPid: 0, birth: "20" },
      { pid: 21, parentPid: 20, birth: "21" },
    ];
    const harness = windowsHarness(() => records);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    harness.runtime.testing.setState({
      windowsSeedIdentitiesLocked: true,
      ownedWindowsProcesses: records,
      latestWindowsStartEvents: [
        { pid: 20, parentPid: 0, eventTime: 20n, owned: true },
        { pid: 21, parentPid: 20, eventTime: 21n, owned: true },
      ],
    });
    await expect(harness.runtime.testing.signalTree(20, false, Date.now() + 1_000)).resolves.toBeUndefined();
    expect(harness.taskkill).toHaveBeenCalledWith("taskkill", ["/T", "/PID", "20"]);
    harness.taskkill.mockImplementationOnce(() => { throw new Error("taskkill denied"); });
    await expect(harness.runtime.testing.signalTree(20, true, Date.now() + 1_000))
      .resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("taskkill denied") }));
    expect(harness.taskkill).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "20"]);
    records = [];
    harness.runtime.testing.cleanupEndpoint();
  });

  it("covers Windows exit polling before and after its bounded deadline", async () => {
    let records: Array<{ pid: number; parentPid: number; birth: string }> = [];
    const exited = windowsHarness(() => records);
    await exited.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    exited.runtime.testing.setState({
      ownedWindowsProcesses: [{ pid: 60, parentPid: 0, birth: "60" }],
    });
    await expect(exited.runtime.testing.waitForTreeExit(60, 100, Date.now() + 1_000)).resolves.toBe(true);
    exited.runtime.testing.cleanupEndpoint();

    records = [{ pid: 61, parentPid: 0, birth: "61" }];
    const live = windowsHarness(() => records);
    live.fakeProcess.kill.mockImplementation(() => true);
    await live.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    live.runtime.testing.setState({
      windowsSeedIdentitiesLocked: true,
      ownedWindowsProcesses: records,
      latestWindowsStartEvents: [{ pid: 61, parentPid: 0, eventTime: 61n, owned: true }],
    });
    await expect(live.runtime.testing.waitForTreeExit(61, 1, Date.now() + 1_000)).resolves.toBe(false);
    live.runtime.testing.cleanupEndpoint();
  });

  it("kills an in-flight Windows marker during endpoint cleanup", async () => {
    const harness = windowsHarness(() => []);
    await harness.runtime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    const pending = harness.runtime.testing.flushWindowsProcessWatcher(Date.now() + 1_000);
    harness.runtime.testing.cleanupEndpoint();
    await expect(pending).rejects.toThrow("process watcher exited");
  });

  it("terminates absent owned children safely", async () => {
    const fakeProcess = new FakeProcess();
    const runtime = createServiceSupervisorRuntime({ process: fakeProcess as unknown as NodeJS.Process });
    await expect(runtime.testing.terminateOwnedTree()).rejects.toThrow("original child authority is missing");
    const owned = child(74_201);
    runtime.testing.setState({
      child: owned as never,
      status: {
        ok: true,
        runId: "run",
        service: "web",
        supervisorPid: fakeProcess.pid,
        childPid: owned.pid,
        childState: "running",
      },
    });
    fakeProcess.kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    await expect(runtime.testing.terminateOwnedTree()).resolves.toMatchObject({ childState: "stopped" });
  });

  it("rejects malformed watcher events, invalid JSON, startup errors, and readiness timeout", async () => {
    const invalidProcess = new FakeProcess();
    invalidProcess.platform = "win32";
    const invalidRuntime = createServiceSupervisorRuntime({ process: invalidProcess as unknown as NodeJS.Process });
    invalidRuntime.testing.recordWindowsStartEvent({ pid: "bad", parentPid: 1, eventTime: "1" });
    await expect(invalidRuntime.testing.flushWindowsProcessWatcher()).rejects.toThrow("invalid event");

    const timeProcess = new FakeProcess();
    timeProcess.platform = "win32";
    const timeRuntime = createServiceSupervisorRuntime({ process: timeProcess as unknown as NodeJS.Process });
    timeRuntime.testing.recordWindowsStartEvent({ pid: 1, parentPid: 0, eventTime: "not-a-time" });
    await expect(timeRuntime.testing.flushWindowsProcessWatcher()).rejects.toThrow("invalid creation time");

    const jsonProcess = new FakeProcess();
    jsonProcess.platform = "win32";
    const jsonWatcher = child(73_701);
    const jsonRuntime = createServiceSupervisorRuntime({
      process: jsonProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        setImmediate(() => jsonWatcher.stdout.write("ready\nnot-json\n"));
        return jsonWatcher;
      }) as never,
    });
    await jsonRuntime.testing.startWindowsProcessWatcher(Date.now() + 1_000);
    await new Promise((resolve) => setImmediate(resolve));
    await expect(jsonRuntime.testing.flushWindowsProcessWatcher()).rejects.toThrow("invalid JSON");
    jsonRuntime.testing.cleanupEndpoint();

    const errorProcess = new FakeProcess();
    errorProcess.platform = "win32";
    const errorWatcher = child(73_702);
    const errorRuntime = createServiceSupervisorRuntime({
      process: errorProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => {
        setImmediate(() => {
          errorWatcher.stderr.write("wmi denied");
          errorWatcher.emit("error", new Error("watcher failed"));
        });
        return errorWatcher;
      }) as never,
    });
    await expect(errorRuntime.testing.startWindowsProcessWatcher(Date.now() + 1_000)).rejects.toThrow("watcher failed");

    const timeoutProcess = new FakeProcess();
    timeoutProcess.platform = "win32";
    const timeoutWatcher = child(73_703);
    const timeoutRuntime = createServiceSupervisorRuntime({
      process: timeoutProcess as unknown as NodeJS.Process,
      spawn: vi.fn(() => timeoutWatcher) as never,
    });
    await expect(timeoutRuntime.testing.startWindowsProcessWatcher(Date.now() + 20))
      .rejects.toThrow("did not become ready");
  });

  it("keeps separately constructed runtime state and adapters isolated", () => {
    const firstProcess = new FakeProcess();
    firstProcess.pid = 76_001;
    const secondProcess = new FakeProcess();
    secondProcess.pid = 76_002;
    const first = createServiceSupervisorRuntime({ process: firstProcess as unknown as NodeJS.Process });
    first.testing.setState({
      init: {
        mode: "reservation",
        runId: "first",
        service: "lifecycle",
        token: "first-token",
        endpoint: "first-endpoint",
        heartbeatPath: "first-heartbeat",
      },
    });
    const second = createServiceSupervisorRuntime({ process: secondProcess as unknown as NodeJS.Process });
    second.testing.setState({
      init: {
        mode: "reservation",
        runId: "second",
        service: "lifecycle",
        token: "second-token",
        endpoint: "second-endpoint",
        heartbeatPath: "second-heartbeat",
      },
    });
    expect(first.testing.tokenMatches("first-token")).toBe(true);
    expect(first.testing.tokenMatches("second-token")).toBe(false);
    expect(second.testing.tokenMatches("second-token")).toBe(true);
    expect(second.testing.tokenMatches("first-token")).toBe(false);
  });

  it("keeps injected watcher, clock identity, and heartbeat state instance-local during cleanup", () => {
    const fakeProcess = new FakeProcess();
    const watcher = child(76_011);
    const heartbeat = setInterval(() => {}, 60_000);
    heartbeat.unref();
    const clearScheduledInterval = vi.fn((value: NodeJS.Timeout) => clearInterval(value));
    const runtime = createServiceSupervisorRuntime({
      process: fakeProcess as unknown as NodeJS.Process,
      clearScheduledInterval: clearScheduledInterval as never,
    });
    runtime.testing.setState({
      windowsProcessWatcher: watcher as never,
      windowsProcessWatcherError: new Error("watcher error"),
      windowsProcessWatcherStartedAt: 10n,
      heartbeat,
    });
    runtime.testing.cleanupEndpoint();
    expect(watcher.kill).toHaveBeenCalledOnce();
    expect(clearScheduledInterval).toHaveBeenCalledWith(heartbeat);
  });

  it("runs the production constructor without exposing adapter selection", () => {
    const beforeMessage = new Set(process.listeners("message"));
    const beforeDisconnect = new Set(process.listeners("disconnect"));
    runServiceSupervisor();
    for (const listener of process.listeners("message")) {
      if (!beforeMessage.has(listener)) process.removeListener("message", listener);
    }
    for (const listener of process.listeners("disconnect")) {
      if (!beforeDisconnect.has(listener)) process.removeListener("disconnect", listener);
    }
  });
});

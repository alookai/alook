import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const mockRunPreparedDaemon = vi.hoisted(() => vi.fn());

vi.mock("./daemonRunner", async (importOriginal) => ({
  ...await importOriginal<typeof import("./daemonRunner")>(),
  runPreparedDaemon: mockRunPreparedDaemon,
}));

vi.mock("../discovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("../discovery")>(),
  detectRuntimes: vi.fn(async () => []),
  resolveAlookCliPathWithFallback: vi.fn(() => undefined),
}));

import { daemonRunFromIpc, daemonStart, daemonStartById } from "./daemonStart";
import { readDaemonVersion } from "../version";

describe("daemon lifecycle ownership cleanup", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-start-lifecycle-"));
    mockRunPreparedDaemon.mockReset();
    mockRunPreparedDaemon.mockRejectedValue(new Error("runner init failed"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ machineId: "cm_machine_init_failure" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("compare-deletes foreground final ownership and launch lock when runner init fails", async () => {
    const opts = {
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    };

    await expect(daemonStart(opts)).rejects.toThrow("runner init failed");
    const daemonDir = path.join(baseDir, "daemons", "cm_machine_init_failure");
    expect(fs.existsSync(path.join(daemonDir, "daemon.pid"))).toBe(false);
    expect(fs.existsSync(path.join(daemonDir, "daemon.launch.lock"))).toBe(false);

    await expect(daemonStart(opts)).rejects.toThrow("runner init failed");
    expect(mockRunPreparedDaemon).toHaveBeenCalledTimes(2);
  });

  it("recovers malformed final and launch files left by a dead writer", async () => {
    const daemonsDir = path.join(baseDir, "daemons");
    const daemonDir = path.join(daemonsDir, "cm_machine_init_failure");
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(
      path.join(daemonsDir, "cm_machine_init_failure.credential.json"),
      JSON.stringify({ credential: "cmk_test", machineId: "cm_machine_init_failure" }),
    );
    fs.writeFileSync(path.join(daemonDir, "daemon.pid"), JSON.stringify({ pid: 2_147_483_646 }));
    fs.writeFileSync(path.join(daemonDir, "daemon.launch.lock"), '{"pid":2147483646');

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("runner init failed");

    expect(mockRunPreparedDaemon).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(daemonDir, "daemon.pid"))).toBe(false);
    expect(fs.existsSync(path.join(daemonDir, "daemon.launch.lock"))).toBe(false);
  });

  it("never deletes a live final owner while recovering stale ownership", async () => {
    const daemonsDir = path.join(baseDir, "daemons");
    const daemonDir = path.join(daemonsDir, "cm_machine_init_failure");
    const finalPath = path.join(daemonDir, "daemon.pid");
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(
      path.join(daemonsDir, "cm_machine_init_failure.credential.json"),
      JSON.stringify({ credential: "cmk_test", machineId: "cm_machine_init_failure" }),
    );
    const liveOwner = {
      pid: process.pid,
      machineId: "cm_machine_init_failure",
      startedAt: new Date().toISOString(),
      ownerToken: "live-owner",
    };
    fs.writeFileSync(finalPath, JSON.stringify(liveOwner));

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("already running");

    expect(JSON.parse(fs.readFileSync(finalPath, "utf8"))).toEqual(liveOwner);
    expect(mockRunPreparedDaemon).not.toHaveBeenCalled();
  });

  it("rejects a live hash-directory legacy owner without exposing its key", async () => {
    const legacyDir = path.join(baseDir, "daemons", "legacyhash01");
    const legacyPath = path.join(legacyDir, "daemon.pid");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ pid: process.pid, key: "cmk_test" }));

    let failure: Error | undefined;
    try {
      await daemonStart({
        machineKey: "cmk_test",
        serverUrl: "http://server",
        wsUrl: "ws://server",
        baseDir,
        foreground: true,
      });
    } catch (error) {
      failure = error as Error;
    }

    expect(failure?.message).toContain("legacy daemon already running");
    expect(failure?.message).not.toContain("cmk_test");
    expect(JSON.parse(fs.readFileSync(legacyPath, "utf8"))).toEqual({ pid: process.pid, key: "cmk_test" });
    expect(mockRunPreparedDaemon).not.toHaveBeenCalled();
  });

  it("removes a dead legacy owner before migrating to the stable machine id", async () => {
    const legacyDir = path.join(baseDir, "daemons", "legacyhash01");
    const legacyPath = path.join(legacyDir, "daemon.pid");
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({ pid: 2_147_483_646, key: "cmk_test" }));

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("runner init failed");

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "daemons", "cm_machine_init_failure.credential.json"))).toBe(true);
    expect(mockRunPreparedDaemon).toHaveBeenCalledOnce();
  });

  it("upgrades a legacy two-field credential record to a private resumable launch record", async () => {
    const machineId = "cm_machine_init_failure";
    const recordPath = path.join(baseDir, "daemons", `${machineId}.credential.json`);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({ credential: "cmk_test", machineId }), { mode: 0o644 });

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("runner init failed");

    expect(JSON.parse(fs.readFileSync(recordPath, "utf8"))).toEqual({
      schemaVersion: 1,
      credential: "cmk_test",
      machineId,
      serverUrl: "http://server",
      wsUrl: "ws://server",
      daemonVersion: readDaemonVersion(),
    });
    if (process.platform !== "win32") expect(fs.statSync(recordPath).mode & 0o777).toBe(0o600);
  });

  it("starts a saved machine by id using its private launch record", async () => {
    const machineId = "cm_machine_init_failure";
    const recordPath = path.join(baseDir, "daemons", `${machineId}.credential.json`);
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, JSON.stringify({
      schemaVersion: 1,
      credential: "cmk_test",
      machineId,
      serverUrl: "http://server",
      wsUrl: "ws://server",
      daemonVersion: readDaemonVersion(),
    }), { mode: 0o600 });

    await expect(daemonStartById({ id: machineId, baseDir, foreground: true }))
      .rejects.toThrow("runner init failed");

    expect(fetch).not.toHaveBeenCalled();
    expect(mockRunPreparedDaemon).toHaveBeenCalledOnce();
  });

  it("rejects a saved-machine start when the private launch record is absent", async () => {
    await expect(daemonStartById({ id: "cm_missing_machine", baseDir }))
      .rejects.toThrow("launch record is missing");
    expect(mockRunPreparedDaemon).not.toHaveBeenCalled();
  });

  it("blocks normal start during replacement and lets only the matching resume request bypass", async () => {
    const machineId = "cm_machine_init_failure";
    const daemonsDir = path.join(baseDir, "daemons");
    const daemonDir = path.join(daemonsDir, machineId);
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(daemonsDir, `${machineId}.credential.json`), JSON.stringify({
      schemaVersion: 1,
      credential: "cmk_test",
      machineId,
      serverUrl: "http://server",
      wsUrl: "ws://server",
      daemonVersion: readDaemonVersion(),
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(daemonDir, "daemon.replace.lock"), JSON.stringify({
      pid: process.pid,
      machineId,
      startedAt: new Date().toISOString(),
      ownerToken: "replace-owner",
      requestId: "request_1234567890",
    }), { mode: 0o600 });

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("replacement already in progress");
    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
      resumeRequestId: "wrong_request_123456",
    })).rejects.toThrow("replacement already in progress");
    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
      resumeRequestId: "request_1234567890",
    })).rejects.toThrow("runner init failed");
  });

  it.each([
    "../../escape",
    "/absolute",
    "cm_bad\\separator",
    `cm_${"a".repeat(65)}`,
  ])("rejects an unsafe server machine id before deriving filesystem paths: %s", async (machineId) => {
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(
      JSON.stringify({ machineId }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const derivedCredential = path.join(baseDir, "daemons", `${machineId}.credential.json`);
    const derivedDir = path.join(baseDir, "daemons", machineId);

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("invalid machine identity");

    expect(fs.existsSync(derivedCredential)).toBe(false);
    expect(fs.existsSync(derivedDir)).toBe(false);
    expect(mockRunPreparedDaemon).not.toHaveBeenCalled();
  });

  it("validates a persisted credential machine id before acquiring its launch lock", async () => {
    const daemonsDir = path.join(baseDir, "daemons");
    fs.mkdirSync(daemonsDir, { recursive: true });
    fs.writeFileSync(
      path.join(daemonsDir, "stored.credential.json"),
      JSON.stringify({ credential: "cmk_test", machineId: "../../persisted-escape" }),
    );

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      foreground: true,
    })).rejects.toThrow("invalid machine identity");

    expect(fs.existsSync(path.join(baseDir, "persisted-escape"))).toBe(false);
    expect(mockRunPreparedDaemon).not.toHaveBeenCalled();
  });

  it("continues the runner when accepted and ready IPC sends throw after validation", async () => {
    const machineId = "cm_machine_ipc_throw";
    const daemonDir = path.join(baseDir, "daemons", machineId);
    fs.mkdirSync(daemonDir, { recursive: true });
    const prepared = {
      machineId,
      machineKey: "cmk_test",
      serverUrl: "http://server",
      wsUrl: "ws://server",
      baseDir,
      daemonDir,
      statusFilePath: path.join(daemonDir, "status.json"),
      agentCliPath: undefined,
      runtimeReport: [],
      healthyRuntimeIds: [],
      hostname: "host",
      platform: "test",
      arch: "test",
      osRelease: "test",
      daemonVersion: "1.0.0",
      ownerToken: "ipc-owner",
      startedAt: new Date().toISOString(),
    };
    const fakePid = 424_242;
    fs.writeFileSync(path.join(daemonDir, "daemon.pid"), JSON.stringify({
      pid: fakePid,
      machineId,
      startedAt: prepared.startedAt,
      ownerToken: prepared.ownerToken,
    }));
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const ipc = {
      pid: fakePid,
      connected: true,
      send: vi.fn(() => { throw new Error("parent disconnected during send"); }),
      disconnect: vi.fn(),
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return ipc;
      }),
    } as unknown as typeof process;
    mockRunPreparedDaemon.mockImplementation((_value, options) => {
      options.onReady?.({
        pid: fakePid,
        machineId,
        logPath: path.join(daemonDir, "daemon.log"),
        startedAt: prepared.startedAt,
      });
      return new Promise<never>(() => {});
    });

    void daemonRunFromIpc(ipc);
    listeners.get("message")?.({ type: "daemon:prepared", prepared });
    await Promise.resolve();

    expect(mockRunPreparedDaemon).toHaveBeenCalledOnce();
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });
});

describe("daemon runner IPC entry", () => {
  it("fails immediately when the parent disconnected before handlers were installed", async () => {
    const disconnected = {
      connected: false,
      send: vi.fn(),
    } as unknown as typeof process;

    await expect(daemonRunFromIpc(disconnected)).rejects.toThrow("parent disconnected before prepared payload");
  });
});

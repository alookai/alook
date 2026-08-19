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

import {
  acquireDaemonReplacementLock,
  daemonReconnect,
  daemonRunFromIpc,
  daemonStart,
  daemonStartById,
  removeReplacementLockIfMatches,
} from "./daemonStart";
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
    delete process.env.ALOOK_DAEMON_TEST_FAIL_AFTER_ACTIVATE;
    delete process.env.ALOOK_SERVER_URL;
    delete process.env.ALOOK_SERVER_WS_URL;
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function writeReconnectState(machineId = "cm_machine_reconnect") {
    const daemonDir = path.join(baseDir, "daemons", machineId);
    fs.mkdirSync(daemonDir, { recursive: true });
    fs.writeFileSync(path.join(baseDir, "daemons", `${machineId}.credential.json`), JSON.stringify({
      schemaVersion: 1,
      credential: "cmk_old",
      machineId,
      serverUrl: "http://server",
      wsUrl: "ws://server",
      daemonVersion: readDaemonVersion(),
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(daemonDir, "daemon.pid"), JSON.stringify({
      pid: 424_242,
      machineId,
      startedAt: "2026-08-18T00:00:00.000Z",
      ownerToken: "old-owner",
    }), { mode: 0o600 });
    return { machineId, daemonDir };
  }

  it("uses production endpoints when first-pair URL overrides are absent", async () => {
    await expect(daemonStart({
      machineKey: "cmk_test",
      baseDir,
      foreground: true,
    })).rejects.toThrow("runner init failed");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://alook.ai/api/community/daemon/identity",
      expect.any(Object),
    );
    expect(mockRunPreparedDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://alook.ai",
        wsUrl: "wss://alook.ai/api/ws/community-daemon",
      }),
      expect.any(Object),
    );
  });

  it("prefers endpoint environment variables over production defaults", async () => {
    process.env.ALOOK_SERVER_URL = "https://env.example";
    process.env.ALOOK_SERVER_WS_URL = "wss://env.example/control";

    await expect(daemonStart({
      machineKey: "cmk_test",
      baseDir,
      foreground: true,
    })).rejects.toThrow("runner init failed");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://env.example/api/community/daemon/identity",
      expect.any(Object),
    );
    expect(mockRunPreparedDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://env.example",
        wsUrl: "wss://env.example/control",
      }),
      expect.any(Object),
    );
  });

  it("prefers explicit endpoint flags over environment variables", async () => {
    process.env.ALOOK_SERVER_URL = "https://env.example";
    process.env.ALOOK_SERVER_WS_URL = "wss://env.example/control";

    await expect(daemonStart({
      machineKey: "cmk_test",
      serverUrl: "https://flag.example",
      wsUrl: "wss://flag.example/control",
      baseDir,
      foreground: true,
    })).rejects.toThrow("runner init failed");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://flag.example/api/community/daemon/identity",
      expect.any(Object),
    );
    expect(mockRunPreparedDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: "https://flag.example",
        wsUrl: "wss://flag.example/control",
      }),
      expect.any(Object),
    );
  });

  it("fails exact-machine ownership before activation when replacement is already owned", async () => {
    const { machineId, daemonDir } = writeReconnectState();
    fs.writeFileSync(path.join(daemonDir, "daemon.replace.lock"), JSON.stringify({
      pid: process.pid,
      machineId,
      startedAt: new Date().toISOString(),
      ownerToken: "other-owner",
      requestId: "other_request_123456",
    }), { mode: 0o600 });
    const stop = vi.fn(async () => {});

    await expect(daemonReconnect({ id: machineId, machineKey: "cmt_reconnect", baseDir }, {
      isProcessAlive: () => true,
      stopExactDaemonPid: stop,
    })).rejects.toThrow("replacement already in progress");

    expect(fetch).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("ignores an unrelated first-pair coarse owner during exact-machine reconnect", async () => {
    const { machineId } = writeReconnectState();
    const coarsePath = path.join(baseDir, "daemons", ".start.lock");
    fs.writeFileSync(coarsePath, JSON.stringify({
      pid: process.pid,
      machineId: "coarse",
      startedAt: new Date().toISOString(),
      ownerToken: "unrelated-first-pair-owner",
    }), { mode: 0o600 });
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(JSON.stringify({
      credential: "cmk_rotated",
      machineId,
      expiresAt: null,
      sessionOutcome: "committed",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    mockRunPreparedDaemon.mockResolvedValue(undefined);

    await expect(daemonReconnect({ id: machineId, machineKey: "cmt_reconnect", baseDir }, {
      isProcessAlive: () => true,
      stopExactDaemonPid: vi.fn(async () => {}),
      start: (opts) => daemonStart({ ...opts, foreground: true }),
    })).resolves.toBeUndefined();

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(mockRunPreparedDaemon).toHaveBeenCalledOnce();
    expect(JSON.parse(fs.readFileSync(coarsePath, "utf8"))).toMatchObject({
      ownerToken: "unrelated-first-pair-owner",
    });
  });

  it("restores the old epoch only for an explicit pre-commit 4xx", async () => {
    const { machineId } = writeReconnectState();
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: "token mismatch", sessionOutcome: "not_committed" }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));
    const stop = vi.fn(async () => {});
    const resume = vi.fn(async () => {});

    await expect(daemonReconnect({ id: machineId, machineKey: "cmt_reconnect", baseDir }, {
      isProcessAlive: () => true,
      stopExactDaemonPid: stop,
      resume,
    })).rejects.toThrow("token mismatch");

    expect(stop).toHaveBeenCalledWith(424_242);
    expect(resume).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(globalThis.fetch).mock.invocationCallOrder[0]!);
  });

  it.each([
    ["HTTP 500 after a possible commit", () => Promise.resolve(new Response(
      JSON.stringify({ error: "ambiguous", sessionOutcome: "not_committed" }),
      { status: 500, headers: { "content-type": "application/json" } },
    ))],
    ["response loss", () => Promise.reject(new Error("socket reset"))],
    ["retry after a lost committed response", () => Promise.resolve(new Response(
      JSON.stringify({ error: "token already revoked", sessionOutcome: "unknown" }),
      { status: 409, headers: { "content-type": "application/json" } },
    ))],
  ])("never restores a revoked old epoch after %s", async (_name, response) => {
    const { machineId } = writeReconnectState();
    vi.mocked(globalThis.fetch).mockImplementation(response as typeof fetch);
    const resume = vi.fn(async () => {});

    await expect(daemonReconnect({ id: machineId, machineKey: "cmt_reconnect", baseDir }, {
      isProcessAlive: () => true,
      stopExactDaemonPid: vi.fn(async () => {}),
      resume,
    })).rejects.toThrow();

    expect(resume).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(
      path.join(baseDir, "daemons", `${machineId}.credential.json`),
      "utf8",
    ))).toMatchObject({ credential: "cmk_old", machineId });
  });

  it("bounds an unresponsive activation, never resumes the old epoch, and releases replacement ownership", async () => {
    vi.useFakeTimers();
    const { machineId } = writeReconnectState();
    vi.mocked(globalThis.fetch).mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const resume = vi.fn(async () => {});

    const reconnect = daemonReconnect({ id: machineId, machineKey: "cmt_reconnect", baseDir }, {
      isProcessAlive: () => true,
      stopExactDaemonPid: vi.fn(async () => {}),
      resume,
    });
    const rejected = expect(reconnect).rejects.toThrow("activation timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;

    expect(resume).not.toHaveBeenCalled();
    const replacement = acquireDaemonReplacementLock({
      baseDir,
      machineId,
      requestId: "timeout_recovery_probe",
    });
    removeReplacementLockIfMatches(replacement.path, replacement.lock);
  });

  it("persists the rotated epoch offline after local start failure and recovers that exact epoch by id", async () => {
    const { machineId, daemonDir } = writeReconnectState();
    const credentialPath = path.join(baseDir, "daemons", `${machineId}.credential.json`);
    const resume = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const server = {
      status: "online" as "online" | "offline",
      credential: "cmk_old",
      rotations: 0,
    };

    vi.mocked(globalThis.fetch).mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { expectedMachineId?: string };
      expect(body.expectedMachineId).toBe(machineId);
      server.rotations += 1;
      server.status = "offline";
      server.credential = "cmk_rotated";
      return new Response(JSON.stringify({
        credential: server.credential,
        machineId,
        expiresAt: null,
        sessionOutcome: "committed",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    process.env.ALOOK_DAEMON_TEST_FAIL_AFTER_ACTIVATE = "1";
    await expect(daemonReconnect({ id: machineId, machineKey: "cmt_first_rotation", baseDir }, {
      isProcessAlive: () => true,
      stopExactDaemonPid: stop,
      resume,
    })).rejects.toThrow("start failure after activation");

    expect(server).toMatchObject({ status: "offline", credential: "cmk_rotated", rotations: 1 });
    expect(JSON.parse(fs.readFileSync(credentialPath, "utf8"))).toMatchObject({
      credential: "cmk_rotated",
      machineId,
    });
    expect(fs.existsSync(path.join(daemonDir, "daemon.pid"))).toBe(false);
    expect(resume).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();

    delete process.env.ALOOK_DAEMON_TEST_FAIL_AFTER_ACTIVATE;
    mockRunPreparedDaemon.mockImplementationOnce(async (prepared) => {
      expect(prepared.machineKey).toBe("cmk_rotated");
      expect(prepared.machineId).toBe(machineId);
      server.status = "online";
    });
    await expect(daemonStartById({ id: machineId, baseDir, foreground: true })).resolves.toBeUndefined();

    expect(server).toEqual({ status: "online", credential: "cmk_rotated", rotations: 1 });
    expect(JSON.parse(fs.readFileSync(credentialPath, "utf8"))).toMatchObject({
      credential: "cmk_rotated",
      machineId,
    });
    expect(resume).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EventEmitter } from "events";

vi.mock("../daemon/daemon.js", () => ({
  startDaemon: vi.fn(async () => {}),
}));

vi.mock("../daemon/pidfile.js", () => ({
  readDaemonPid: vi.fn(() => null),
  isProcessAlive: vi.fn(() => false),
  removePidFileIfMatches: vi.fn(),
}));

vi.mock("../daemon/config.js", () => ({
  daemonLogFilePath: vi.fn(() => "/tmp/alook/daemon/logs/2026-04-17.log"),
  pidFilePath: vi.fn(() => "/tmp/fake.pid"),
}));

vi.mock("fs", () => ({
  openSync: vi.fn(() => 99),
  closeSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("child_process", () => {
  const { EventEmitter } = require("events");
  return {
    spawn: vi.fn(() => {
      const child = new EventEmitter();
      (child as EventEmitter & { pid: number; unref: () => void }).pid = 40000;
      (child as EventEmitter & { pid: number; unref: () => void }).unref = vi.fn();
      return child;
    }),
  };
});

import { Command } from "commander";
import { spawn } from "child_process";
import { openSync, closeSync, mkdirSync } from "fs";
import { startDaemon } from "../daemon/daemon.js";
import {
  readDaemonPid,
  isProcessAlive,
  removePidFileIfMatches,
} from "../daemon/pidfile.js";
import { daemonCommand } from "./daemon.js";

const startDaemonMock = vi.mocked(startDaemon);
const readDaemonPidMock = vi.mocked(readDaemonPid);
const isProcessAliveMock = vi.mocked(isProcessAlive);
const removePidFileIfMatchesMock = vi.mocked(removePidFileIfMatches);
const spawnMock = vi.mocked(spawn);
const openSyncMock = vi.mocked(openSync);
const closeSyncMock = vi.mocked(closeSync);
const mkdirMock = vi.mocked(mkdirSync);

interface ChildLike extends EventEmitter {
  pid: number;
  unref: ReturnType<typeof vi.fn>;
}

function resetAll() {
  startDaemonMock.mockClear();
  readDaemonPidMock.mockClear();
  readDaemonPidMock.mockReturnValue(null);
  isProcessAliveMock.mockClear();
  isProcessAliveMock.mockReturnValue(false);
  removePidFileIfMatchesMock.mockClear();
  spawnMock.mockClear();
  openSyncMock.mockClear();
  closeSyncMock.mockClear();
  mkdirMock.mockClear();
}

// Mount the daemon subcommand under a root program with the same top-level
// --profile / --server flags as the real CLI, so parentOpts resolution is
// exercised the way users actually invoke it.
async function runCLI(
  args: string[],
  rootFlags: string[] = [],
): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
    out.push(String(m));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation((m: unknown) => {
    err.push(String(m));
  });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((_code?: number) => {
      throw new Error("__exit__");
    }) as never);
  try {
    const program = new Command()
      .name("alook")
      .option("--server <url>", "Server URL")
      .option("--profile <name>", "Profile name");
    program.addCommand(daemonCommand());
    await program.parseAsync([...rootFlags, "daemon", ...args], {
      from: "user",
    });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    warnSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { out, err };
}

describe("daemon status", () => {
  beforeEach(resetAll);

  it("prints 'not running' when no pidfile", async () => {
    const { out } = await runCLI(["status"]);
    expect(out.join("\n")).toContain("Daemon not running.");
  });

  it("prints running + pid when alive", async () => {
    readDaemonPidMock.mockReturnValue(12345);
    isProcessAliveMock.mockReturnValue(true);
    const { out } = await runCLI(["status"]);
    expect(out.join("\n")).toContain("Daemon running (pid=12345)");
  });

  it("prints stale pidfile when pid is dead", async () => {
    readDaemonPidMock.mockReturnValue(99999);
    isProcessAliveMock.mockReturnValue(false);
    const { out } = await runCLI(["status"]);
    expect(out.join("\n")).toContain("stale pidfile");
  });
});

describe("daemon stop", () => {
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
  });

  afterEach(() => {
    killSpy?.mockRestore();
    vi.useRealTimers();
  });

  it("prints 'not running' and does not signal when no pidfile", async () => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { out } = await runCLI(["stop"]);
    expect(out.join("\n")).toContain("Daemon not running.");
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("sends SIGTERM and reports clean stop when process exits", async () => {
    readDaemonPidMock.mockReturnValue(777);
    let alive = true;
    isProcessAliveMock.mockImplementation(() => alive);
    killSpy = vi.spyOn(process, "kill").mockImplementation((_p, sig) => {
      if (sig === "SIGTERM") alive = false;
      return true;
    });

    const promise = runCLI(["stop"]);
    await vi.advanceTimersByTimeAsync(500);
    const { out } = await promise;

    expect(killSpy).toHaveBeenCalledWith(777, "SIGTERM");
    expect(killSpy).not.toHaveBeenCalledWith(777, "SIGKILL");
    expect(out.join("\n")).toContain("Daemon stopped.");
  });

  it("falls back to SIGKILL and removes pidfile when shutdown times out", async () => {
    readDaemonPidMock.mockReturnValue(888);
    let alive = true;
    isProcessAliveMock.mockImplementation(() => alive);
    process.env.ALOOK_SHUTDOWN_TIMEOUT_MS = "1000";

    killSpy = vi.spyOn(process, "kill").mockImplementation((_p, sig) => {
      if (sig === "SIGKILL") alive = false;
      return true;
    });

    const promise = runCLI(["stop"]);
    await vi.advanceTimersByTimeAsync(1500);
    const { out, err } = await promise;

    expect(killSpy).toHaveBeenCalledWith(888, "SIGTERM");
    if (process.platform !== "win32") {
      expect(killSpy).toHaveBeenCalledWith(888, "SIGKILL");
    }
    expect(removePidFileIfMatchesMock).toHaveBeenCalledWith(888, undefined);
    expect(err.join("\n")).toContain("force killing");
    expect(out.join("\n")).toContain("Daemon stopped.");

    delete process.env.ALOOK_SHUTDOWN_TIMEOUT_MS;
  });

  it("cleans up stale pidfile and reports not running when pid is dead", async () => {
    readDaemonPidMock.mockReturnValue(444);
    isProcessAliveMock.mockReturnValue(false);
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const { out } = await runCLI(["stop"]);

    expect(killSpy).not.toHaveBeenCalled();
    expect(removePidFileIfMatchesMock).toHaveBeenCalledWith(444, undefined);
    expect(out.join("\n")).toContain("Daemon not running.");
  });
});

describe("daemon start (foreground)", () => {
  beforeEach(resetAll);

  it("delegates to startDaemon and does not spawn", async () => {
    await runCLI(["start", "--foreground"]);
    expect(startDaemonMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("daemon start (background)", () => {
  beforeEach(() => {
    resetAll();
    vi.useFakeTimers();
    // Default spawn: fresh EventEmitter with fake pid each call
    spawnMock.mockImplementation(() => {
      const { EventEmitter } = require("events");
      const c = new EventEmitter() as ChildLike;
      c.pid = 40000;
      c.unref = vi.fn();
      return c as never;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns detached with log fds and reconstructed args", async () => {
    // Initial pre-check: no daemon running. After spawn: pidfile has pid 55555.
    let calls = 0;
    readDaemonPidMock.mockImplementation(() => (++calls === 1 ? null : 55555));
    isProcessAliveMock.mockImplementation((p: number) => p === 55555);

    const promise = runCLI(["start"]);
    await vi.advanceTimersByTimeAsync(250);
    const { out } = await promise;

    expect(startDaemonMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0];
    expect(call[0]).toBe(process.execPath);
    const args = call[1] as string[];
    expect(args).toContain("daemon");
    expect(args).toContain("start");
    expect(args).toContain("--foreground");
    const opts = call[2] as { detached?: boolean; stdio?: unknown };
    expect(opts.detached).toBe(true);
    expect(Array.isArray(opts.stdio)).toBe(true);
    expect((opts.stdio as unknown[])[0]).toBe("ignore");
    expect((opts.stdio as unknown[])[1]).toBe(99);
    expect((opts.stdio as unknown[])[2]).toBe(99);

    expect(closeSyncMock).toHaveBeenCalledWith(99);

    expect(out.join("\n")).toContain("Daemon started (pid=55555)");
    expect(out.join("\n")).toContain("Logs: /tmp/alook/daemon/logs/2026-04-17.log");
  });

  it("forwards --server to child argv", async () => {
    let calls = 0;
    readDaemonPidMock.mockImplementation(() => (++calls === 1 ? null : 101));
    isProcessAliveMock.mockImplementation((p: number) => p === 101);

    const promise = runCLI(["start", "--server", "http://x.test"]);
    await vi.advanceTimersByTimeAsync(250);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const serverIdx = args.indexOf("--server");
    expect(serverIdx).toBeGreaterThanOrEqual(0);
    expect(args[serverIdx + 1]).toBe("http://x.test");
  });

  it("forwards root-level --profile to child argv", async () => {
    let calls = 0;
    readDaemonPidMock.mockImplementation(() => (++calls === 1 ? null : 202));
    isProcessAliveMock.mockImplementation((p: number) => p === 202);

    const promise = runCLI(["start"], ["--profile", "staging"]);
    await vi.advanceTimersByTimeAsync(250);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const profileIdx = args.indexOf("--profile");
    expect(profileIdx).toBeGreaterThanOrEqual(0);
    expect(args[profileIdx + 1]).toBe("staging");
  });

  it("forwards root-level --server to child argv", async () => {
    let calls = 0;
    readDaemonPidMock.mockImplementation(() => (++calls === 1 ? null : 303));
    isProcessAliveMock.mockImplementation((p: number) => p === 303);

    const promise = runCLI(["start"], ["--server", "http://root.test"]);
    await vi.advanceTimersByTimeAsync(250);
    await promise;

    const args = spawnMock.mock.calls[0][1] as string[];
    const serverIdx = args.indexOf("--server");
    expect(serverIdx).toBeGreaterThanOrEqual(0);
    expect(args[serverIdx + 1]).toBe("http://root.test");
  });

  it("warns and exits non-zero when pidfile never appears", async () => {
    readDaemonPidMock.mockReturnValue(null); // never set
    isProcessAliveMock.mockReturnValue(false);

    const promise = runCLI(["start"]);
    await vi.advanceTimersByTimeAsync(2500);
    const { err } = await promise;

    expect(err.join("\n")).toContain("did not write a pidfile");
    expect(err.join("\n")).toContain("/tmp/alook/daemon/logs/2026-04-17.log");
  });

  it("refuses to start when another daemon is already alive", async () => {
    // Pre-existing alive daemon: readDaemonPid returns pid, isProcessAlive true
    readDaemonPidMock.mockReturnValue(333);
    isProcessAliveMock.mockReturnValue(true);

    const { err } = await runCLI(["start"]);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(err.join("\n")).toContain("Daemon already running (pid=333)");
  });
});

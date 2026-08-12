import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const createDaemonMock = vi.hoisted(() => vi.fn());

vi.mock("../daemon/createDaemon.js", () => ({ createDaemon: createDaemonMock }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});

import type { PreparedDaemon } from "./daemonRunner";
import { runPreparedDaemon } from "./daemonRunner";

describe("daemon runner secure log initialization", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    createDaemonMock.mockReset();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects initialization and never reports ready when a log generation cannot be secured", async () => {
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-security-"));
    dirs.push(daemonDir);
    fs.chmodSync(daemonDir, 0o700);
    fs.writeFileSync(path.join(daemonDir, "daemon.log.1"), "old sensitive log\n");
    fs.chmodSync(path.join(daemonDir, "daemon.log.1"), 0o644);
    vi.mocked(fs.chmodSync).mockClear();
    vi.mocked(fs.chmodSync)
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error("chmod denied"); });
    const releaseOwnership = vi.fn();
    const onReady = vi.fn();
    const prepared = {
      machineId: "machine-1",
      machineKey: "cmk_secret",
      serverUrl: "http://server",
      wsUrl: "wss://server/ws?token=secret",
      baseDir: daemonDir,
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
      ownerToken: "owner",
      startedAt: new Date().toISOString(),
    } satisfies PreparedDaemon;

    await expect(runPreparedDaemon(prepared, {
      foreground: false,
      releaseOwnership,
      onReady,
    })).rejects.toThrow("failed to secure daemon log generations");

    expect(releaseOwnership).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(daemonDir, "daemon.log.1"), "utf8")).toBe("old sensitive log\n");
  });

  it.each(["daemon.log", "daemon.log.1"])("rejects a %s symlink without touching its target", async (generation) => {
    if (process.platform === "win32") return;
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-symlink-"));
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-outside-"));
    dirs.push(daemonDir, outsideDir);
    const outside = path.join(outsideDir, "outside.log");
    fs.writeFileSync(outside, "outside stays unchanged\n", { mode: 0o644 });
    const originalMode = fs.statSync(outside).mode & 0o777;
    fs.symlinkSync(outside, path.join(daemonDir, generation));
    const releaseOwnership = vi.fn();
    const onReady = vi.fn();

    await expect(runPreparedDaemon(preparedFor(daemonDir), {
      foreground: false,
      releaseOwnership,
      onReady,
    })).rejects.toThrow("failed to secure daemon log generations");

    expect(fs.readFileSync(outside, "utf8")).toBe("outside stays unchanged\n");
    expect(fs.statSync(outside).mode & 0o777).toBe(originalMode);
    expect(releaseOwnership).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("rejects a FIFO generation without opening it", async () => {
    if (process.platform === "win32") return;
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-fifo-"));
    dirs.push(daemonDir);
    execFileSync("mkfifo", [path.join(daemonDir, "daemon.log")]);
    const releaseOwnership = vi.fn();
    const onReady = vi.fn();

    await expect(runPreparedDaemon(preparedFor(daemonDir), {
      foreground: false,
      releaseOwnership,
      onReady,
    })).rejects.toThrow("failed to secure daemon log generations");

    expect(releaseOwnership).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
  });

  it("scrubs credential, bearer, and absolute-path details from initialization failures", async () => {
    const daemonDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-runner-init-error-"));
    dirs.push(daemonDir);
    const rawError = "init cmk_PRIVATE Bearer bearer-secret at /Users/alice/private/socket";
    createDaemonMock.mockRejectedValueOnce(new Error(rawError));
    const releaseOwnership = vi.fn();
    const onReady = vi.fn();

    await expect(runPreparedDaemon(preparedFor(daemonDir), {
      foreground: false,
      releaseOwnership,
      onReady,
    })).rejects.toThrow(rawError);

    const records = fs.readFileSync(path.join(daemonDir, "daemon.log"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const failure = records.find((record) => record.message === "daemon runner initialization failed");
    expect(failure).toMatchObject({
      fields: { errorClass: "Error" },
    });
    expect(failure.fields.error).toContain("[redacted-token]");
    expect(failure.fields.error).toContain("Bearer [redacted]");
    expect(failure.fields.error).toContain("[redacted-path]");
    expect(JSON.stringify(failure)).not.toContain("cmk_PRIVATE");
    expect(JSON.stringify(failure)).not.toContain("bearer-secret");
    expect(JSON.stringify(failure)).not.toContain("/Users/alice/private/socket");
    expect(releaseOwnership).toHaveBeenCalledOnce();
    expect(onReady).not.toHaveBeenCalled();
  });
});

function preparedFor(daemonDir: string): PreparedDaemon {
  return {
    machineId: "cm_machine_security_test",
    machineKey: "cmk_secret",
    serverUrl: "http://server",
    wsUrl: "wss://server/ws?token=secret",
    baseDir: daemonDir,
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
    ownerToken: "owner",
    startedAt: new Date().toISOString(),
  };
}

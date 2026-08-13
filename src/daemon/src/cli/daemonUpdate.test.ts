import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readDaemonVersion } from "../version";
import { createDaemonSelfUpdateHandler, daemonReplace } from "./daemonUpdate";

const machineId = "cm_update_unit_123456";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    unref: vi.fn(),
  });
  return child;
}

describe("daemon self-update lifecycle", () => {
  let baseDir: string;
  let daemonDir: string;
  let npmPath: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "daemon-update-unit-"));
    daemonDir = path.join(baseDir, "daemons", machineId);
    fs.mkdirSync(daemonDir, { recursive: true, mode: 0o700 });
    npmPath = path.join(baseDir, "npm-cli.js");
    fs.writeFileSync(npmPath, "", { mode: 0o600 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  function writePid(ownerToken = "owner-secret") {
    const owner = {
      pid: 424_242,
      machineId,
      startedAt: "2026-08-13T08:00:00.000Z",
      ownerToken,
    };
    fs.writeFileSync(path.join(daemonDir, "daemon.pid"), JSON.stringify(owner), { mode: 0o600 });
    return owner;
  }

  function writeLaunch(version: string) {
    fs.writeFileSync(
      path.join(baseDir, "daemons", `${machineId}.credential.json`),
      JSON.stringify({
        schemaVersion: 1,
        credential: "cmk_UNIT_TEST_SECRET",
        machineId,
        serverUrl: "http://server",
        wsUrl: "ws://server",
        daemonVersion: version,
      }),
      { mode: 0o600 },
    );
  }

  it("spawns one fixed latest helper, persists the full tuple, and becomes retryable after early exit", () => {
    const owner = writePid();
    const children = [fakeChild(), fakeChild()];
    const spawnProcess = vi.fn(() => children.shift()!);
    const handle = createDaemonSelfUpdateHandler({
      machineId,
      baseDir,
      pid: owner.pid,
      startedAt: owner.startedAt,
      ownerToken: owner.ownerToken,
    }, { spawnProcess: spawnProcess as typeof import("node:child_process").spawn, npmExecPath: npmPath });

    handle();
    handle();

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawnProcess.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args).toEqual([
      npmPath,
      "exec",
      "--yes",
      "--package=@alook/daemon@latest",
      "--",
      "alook-daemon",
      "daemon",
      "replace",
      "--id",
      machineId,
      "--base-dir",
      baseDir,
      "--request-id",
      expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
    ]);
    expect(options).toMatchObject({ detached: true, shell: false });
    const serializedInvocation = JSON.stringify([command, args, options]);
    expect(serializedInvocation).not.toContain("cmk_UNIT_TEST_SECRET");
    expect(serializedInvocation).not.toContain(owner.ownerToken);

    const intentPath = path.join(daemonDir, "update-intent.json");
    const intent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
    expect(intent).toMatchObject({ schemaVersion: 1, ...owner });
    if (process.platform !== "win32") expect(fs.statSync(intentPath).mode & 0o777).toBe(0o600);

    const first = spawnProcess.mock.results[0]!.value as ChildProcess;
    first.emit("exit", 1, null);
    handle();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("does not spawn when only the pidfile ownerToken differs from the running owner", () => {
    const diskOwner = writePid("replacement-owner");
    const spawnProcess = vi.fn(() => fakeChild());
    const kill = vi.spyOn(process, "kill");
    const handle = createDaemonSelfUpdateHandler({
      machineId,
      baseDir,
      pid: diskOwner.pid,
      startedAt: diskOwner.startedAt,
      ownerToken: "original-running-owner",
    }, { spawnProcess: spawnProcess as typeof import("node:child_process").spawn, npmExecPath: npmPath });

    handle();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(daemonDir, "update-intent.json"))).toBe(false);
  });

  it("keeps ownership untouched when the npm launch context is unavailable", () => {
    const owner = writePid();
    const spawnProcess = vi.fn(() => fakeChild());
    const handle = createDaemonSelfUpdateHandler({
      machineId,
      baseDir,
      pid: owner.pid,
      startedAt: owner.startedAt,
      ownerToken: owner.ownerToken,
    }, {
      spawnProcess: spawnProcess as typeof import("node:child_process").spawn,
      npmExecPath: path.join(baseDir, "missing-npm-cli.js"),
    });

    handle();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(daemonDir, "daemon.pid"), "utf8"))).toEqual(owner);
    expect(fs.existsSync(path.join(daemonDir, "update-intent.json"))).toBe(false);
  });

  it.each([
    ["pid", { pid: 424_243 }],
    ["machineId", { machineId: "cm_update_other_123456" }],
    ["startedAt", { startedAt: "2026-08-13T08:01:00.000Z" }],
    ["ownerToken", { ownerToken: "new-owner" }],
  ])("refuses a late helper whose %s tuple field changed without signaling", async (_field, change) => {
    const intentOwner = writePid("old-owner");
    writeLaunch("0.0.1");
    const requestId = "request_1234567890";
    fs.writeFileSync(path.join(daemonDir, "update-intent.json"), JSON.stringify({
      schemaVersion: 1,
      requestId,
      ...intentOwner,
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(daemonDir, "daemon.pid"), JSON.stringify({
      ...intentOwner,
      ...change,
    }), { mode: 0o600 });
    vi.stubEnv("npm_execpath", npmPath);
    const kill = vi.spyOn(process, "kill");

    await expect(daemonReplace({ id: machineId, baseDir, requestId })).rejects.toThrow(
      "ownership changed before replacement",
    );
    expect(kill).not.toHaveBeenCalled();
  });

  it.each([
    ["same", readDaemonVersion()],
    ["older", "99.0.0"],
  ])("keeps the old daemon alive when the loaded helper is %s", async (_case, recordedVersion) => {
    const owner = writePid();
    writeLaunch(recordedVersion);
    const requestId = "request_1234567890";
    fs.writeFileSync(path.join(daemonDir, "update-intent.json"), JSON.stringify({
      schemaVersion: 1,
      requestId,
      ...owner,
    }), { mode: 0o600 });
    vi.stubEnv("npm_execpath", npmPath);
    const kill = vi.spyOn(process, "kill");

    await daemonReplace({ id: machineId, baseDir, requestId });

    expect(kill).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(daemonDir, "daemon.pid"))).toBe(true);
    expect(fs.existsSync(path.join(daemonDir, "update-intent.json"))).toBe(false);
  });
});

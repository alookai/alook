import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const boundary = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: boundary.spawn }));
vi.mock("../discovery.js", async (original) => ({ ...await original<typeof import("../discovery.js")>(),
  detectRuntimes: vi.fn(async () => []), resolveAlookCliPathWithFallback: vi.fn(() => undefined) }));
import { daemonResume } from "./daemonStart";
import { readDaemonVersion } from "../version";

let baseDir: string;
beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), "alook-resume-spawn-")); boundary.spawn.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(baseDir, { recursive: true, force: true }); });

it.each(["0", "1"])("resumes with the current executable and an owned startup receipt, wrapper=%s", async (wrapper) => {
  const machineId = "cm_resume_spawn_fixture";
  const machineDir = join(baseDir, "daemons", machineId);
  mkdirSync(machineDir, { recursive: true });
  const recordPath = join(baseDir, "daemons", `${machineId}.credential.json`);
  const record = JSON.stringify({ schemaVersion: 1, credential: "cmk_resume_spawn_fixture", machineId,
    serverUrl: "http://fixture.invalid", wsUrl: "ws://fixture.invalid", daemonVersion: readDaemonVersion() });
  writeFileSync(recordPath, record, { mode: 0o600 });
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 424242, exitCode: null, signalCode: null, unref: vi.fn(), kill: vi.fn(),
    send: vi.fn((message, callback) => {
      expect(message.type).toBe("daemon:prepared");
      expect(JSON.parse(readFileSync(join(machineDir, "daemon.pid"), "utf8"))).toMatchObject({
        pid: child.pid, machineId, ownerToken: message.prepared.ownerToken,
      });
      callback();
      queueMicrotask(() => child.emit("message", { pid: child.pid, machineId, startedAt: message.prepared.startedAt, logPath: "fixture.log" }));
    }) });
  boundary.spawn.mockReturnValue(child);
  vi.stubEnv("ALOOK_DAEMON_PACKAGE_WRAPPER", wrapper);
  await daemonResume({ id: machineId, baseDir, requestId: "resume_spawn_fixture" });
  expect(boundary.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath,
    [...process.execArgv, process.argv[1], ...(wrapper === "1" ? ["run"] : ["daemon", "run"])],
    expect.objectContaining({ detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  expect(readFileSync(recordPath, "utf8")).toBe(record);
  expect(child.unref).toHaveBeenCalledOnce();
  expect(child.kill).not.toHaveBeenCalled();
});

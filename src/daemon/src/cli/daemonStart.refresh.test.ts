import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
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
beforeEach(() => { baseDir = mkdtempSync(join(tmpdir(), "alook-refresh-receipt-")); boundary.spawn.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(baseDir, { recursive: true, force: true }); });

it.each(["committed", "commit-send-failed", "ordinary-start"])("commits completion only after a valid startup receipt: %s", async (outcome) => {
  const machineId = "cm_refresh_receipt_fixture";
  const requestId = "26aac14d-dfd6-4e96-821c-ebf538316f79";
  const machineDir = join(baseDir, "daemons", machineId);
  mkdirSync(machineDir, { recursive: true });
  const recordPath = join(baseDir, "daemons", `${machineId}.credential.json`);
  const record = JSON.stringify({ schemaVersion: 1, credential: "cmk_refresh_receipt_fixture", machineId,
    serverUrl: "http://fixture.invalid", wsUrl: "ws://fixture.invalid", daemonVersion: readDaemonVersion() });
  writeFileSync(recordPath, record, { mode: 0o600 });
  const messages: Array<{ type: string }> = [];
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid: 424242, exitCode: null, signalCode: null, unref: vi.fn(),
    kill: vi.fn(() => { child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); return true; }),
    send: vi.fn((message, callback) => {
      messages.push(message);
      if (message.type === "daemon:prepared") {
        callback();
        queueMicrotask(() => child.emit("message", { pid: child.pid, machineId, startedAt: message.prepared.startedAt, logPath: "fixture.log" }));
      } else {
        expect(JSON.parse(readFileSync(join(machineDir, "daemon.pid"), "utf8"))).toMatchObject({ pid: child.pid, machineId });
        callback(outcome === "commit-send-failed" ? new Error("fixture disconnected") : undefined);
      }
    }) });
  boundary.spawn.mockReturnValue(child);
  vi.stubEnv("ALOOK_DAEMON_PACKAGE_WRAPPER", "1");
  const pending = daemonResume({ id: machineId, baseDir, requestId,
    ...(outcome === "ordinary-start" ? {} : { refreshResult: { requestId, status: "complete" as const } }) });
  if (outcome !== "commit-send-failed") await pending;
  else await expect(pending).rejects.toThrow("fixture disconnected");
  expect(messages.map((message) => message.type)).toEqual(outcome === "ordinary-start" ? ["daemon:prepared"] : ["daemon:prepared", "daemon:committed"]);
  if (outcome !== "ordinary-start") expect(messages[1]).toEqual({ type: "daemon:committed", requestId });
  expect(boundary.spawn.mock.calls[0][0]).toBe(process.execPath);
  expect(readFileSync(recordPath, "utf8")).toBe(record);
  expect(child.kill).toHaveBeenCalledTimes(outcome === "commit-send-failed" ? 1 : 0);
  expect(existsSync(join(machineDir, "daemon.pid"))).toBe(outcome !== "commit-send-failed");
});

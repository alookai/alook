import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonRefreshHandler } from "./daemonRefresh";

const requestId = "26aac14d-dfd6-4e96-821c-ebf538316f79";
const otherId = "0325c31a-c586-42c9-9f3f-a1ffce80b7ac";
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context() {
  const baseDir = mkdtempSync(join(tmpdir(), "alook-refresh-unit-"));
  directories.push(baseDir);
  const value = { baseDir, machineId: "cm_refresh_unit", pid: 424242, startedAt: "2026-11-02T00:00:00Z", ownerToken: "owner-fixture" };
  mkdirSync(join(baseDir, "daemons", value.machineId), { recursive: true });
  writeFileSync(join(baseDir, "daemons", value.machineId, "daemon.pid"), JSON.stringify(value));
  return value;
}

describe("Refresh preparation", () => {
  it("keeps the old daemon on environment failure and exposes only a fixed error", async () => {
    const spawnProcess = vi.fn();
    const handler = createDaemonRefreshHandler(context(), { spawnProcess,
      readEnvironment: async () => { throw new Error("PRIVATE_PROVIDER_VALUE"); } });
    expect(await handler(requestId)).toEqual({ requestId, status: "error", code: "environment_unavailable" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("coalesces repeated requests during preparation and rejects competing requests", async () => {
    let fail!: (error: Error) => void;
    const readEnvironment = vi.fn(() => new Promise<NodeJS.ProcessEnv>((_resolve, reject) => { fail = reject; }));
    const handler = createDaemonRefreshHandler(context(), { readEnvironment });
    const pending = handler(requestId);
    expect(await handler(requestId)).toBeUndefined();
    expect(await handler(otherId)).toEqual({ requestId: otherId, status: "error", code: "refresh_in_progress" });
    expect(readEnvironment).toHaveBeenCalledOnce();
    fail(new Error("failed"));
    await pending;
  });

  it("checks ownership again after asynchronous environment capture", async () => {
    const owner = context();
    const spawnProcess = vi.fn();
    const handler = createDaemonRefreshHandler(owner, { spawnProcess, readEnvironment: async () => {
      writeFileSync(join(owner.baseDir, "daemons", owner.machineId, "daemon.pid"), JSON.stringify({ ...owner, pid: 454545 }));
      return { HOME: "/tmp", PATH: "/bin" };
    } });
    expect(await handler(requestId)).toEqual({ requestId, status: "error", code: "ownership_changed" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("launches the current executable and sends the prior environment only over local IPC", async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { send: vi.fn(), unref: vi.fn(), channel: { unref: vi.fn() } });
    const spawnProcess = vi.fn(() => child);
    const handler = createDaemonRefreshHandler(context(), { spawnProcess: spawnProcess as never,
      readEnvironment: async () => ({ HOME: "/tmp", PATH: "/bin", ALOOK_SENTINEL: "new-value" }) });
    const pending = handler(requestId);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    const [file, args, options] = spawnProcess.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe(process.execPath);
    expect(args).toContain("refresh-run");
    expect(args.some((arg) => /^(?:npm|npx|--package=|cmk_)|@latest/.test(arg))).toBe(false);
    expect(options.env.ALOOK_SENTINEL).toBe("new-value");
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ requestId, priorEnvironment: expect.any(Object) }), expect.any(Function));
    child.emit("message", { requestId, status: "error", code: "ownership_changed" });
    expect(await pending).toEqual({ requestId, status: "error", code: "ownership_changed" });
  });

  it("replays the completed startup result instead of restarting a second time", async () => {
    const readEnvironment = vi.fn();
    const handler = createDaemonRefreshHandler(context(), { completedRequestId: () => requestId, readEnvironment });
    expect(await handler(requestId)).toEqual({ requestId, status: "complete" });
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});

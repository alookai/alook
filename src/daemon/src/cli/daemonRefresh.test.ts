import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonRefreshHandler } from "./daemonRefreshHandler";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function context() {
  const baseDir = mkdtempSync(join(tmpdir(), "alook-refresh-unit-"));
  directories.push(baseDir);
  const value = { baseDir, machineId: "cm_refresh_unit", pid: 424242, startedAt: "2026-11-02T00:00:00Z", ownerToken: "owner-fixture" };
  mkdirSync(join(baseDir, "daemons", value.machineId), { recursive: true });
  writeFileSync(join(baseDir, "daemons", value.machineId, "daemon.pid"), JSON.stringify(value));
  return value;
}
function helper() {
  return Object.assign(new EventEmitter(), { send: vi.fn(), unref: vi.fn(), channel: { unref: vi.fn() } }) as unknown as ChildProcess;
}

describe("Refresh preparation", () => {
  it("keeps the old daemon on environment failure and permits a later retry", async () => {
    const spawnProcess = vi.fn();
    const readEnvironment = vi.fn(async () => { throw new Error("environment failed"); });
    const handler = createDaemonRefreshHandler(context(), { spawnProcess, readEnvironment });
    for (let attempt = 0; attempt < 2; attempt++) await expect(handler()).rejects.toThrow("environment failed");
    expect(readEnvironment).toHaveBeenCalledTimes(2);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("coalesces commands while environment preparation is active", async () => {
    let fail!: (error: Error) => void;
    const readEnvironment = vi.fn(() => new Promise<NodeJS.ProcessEnv>((_resolve, reject) => { fail = reject; }));
    const handler = createDaemonRefreshHandler(context(), { readEnvironment });
    const pending = expect(handler()).rejects.toThrow("failed");
    await handler();
    expect(readEnvironment).toHaveBeenCalledOnce();
    fail(new Error("failed"));
    await pending;
  });

  it.each(["before", "after"])("checks ownership %s environment capture", async (stage) => {
    const owner = context();
    const replaceOwner = () => writeFileSync(join(owner.baseDir, "daemons", owner.machineId, "daemon.pid"), JSON.stringify({ ...owner, pid: 454545 }));
    if (stage === "before") replaceOwner();
    const spawnProcess = vi.fn();
    const readEnvironment = vi.fn(async () => { replaceOwner(); return { PATH: "/bin" }; });
    await expect(createDaemonRefreshHandler(owner, { spawnProcess, readEnvironment })()).rejects.toThrow("ownership_changed");
    expect(readEnvironment).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("launches the current executable and sends correlation and prior environment only over local IPC", async () => {
    const child = helper();
    const spawnProcess = vi.fn(() => child);
    vi.stubEnv("ALOOK_DAEMON_PACKAGE_WRAPPER", "1");
    const handler = createDaemonRefreshHandler(context(), { spawnProcess: spawnProcess as never,
      readEnvironment: async () => ({ HOME: "/tmp", PATH: "/bin", ALOOK_SENTINEL: "new-value" }) });
    const pending = handler();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    const [file, args, options] = spawnProcess.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    expect(file).toBe(process.execPath);
    expect(args).toContain("refresh-run");
    expect(args.some((arg) => /^(?:npm|npx|--package=|cmk_)|@latest/.test(arg))).toBe(false);
    expect(options.env).toMatchObject({ ALOOK_SENTINEL: "new-value", ALOOK_DAEMON_PACKAGE_WRAPPER: "1", NODE_ENV: "test" });
    expect(child.send).toHaveBeenCalledWith(expect.objectContaining({ requestId: expect.stringMatching(/^[\da-f-]{36}$/), priorEnvironment: expect.any(Object) }), expect.any(Function));
    await handler();
    expect(spawnProcess).toHaveBeenCalledOnce();
    child.emit("exit", 0);
    await pending;
  });

  it.each(["spawn", "send", "error", "exit"])("releases preparation after helper %s failure", async (stage) => {
    const child = helper();
    child.send = vi.fn((_message, callback) => { if (stage === "send") callback(new Error("send failed")); }) as never;
    const spawnProcess = vi.fn(() => { if (stage === "spawn") throw new Error("spawn failed"); return child; });
    const handler = createDaemonRefreshHandler(context(), { spawnProcess: spawnProcess as never,
      readEnvironment: async () => ({ HOME: "/tmp", PATH: "/bin" }) });
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = expect(handler()).rejects.toThrow();
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(attempt + 1));
      if (stage === "error") child.emit("error", new Error("helper failed"));
      if (stage === "exit") child.emit("exit", 1);
      await pending;
    }
  });
});

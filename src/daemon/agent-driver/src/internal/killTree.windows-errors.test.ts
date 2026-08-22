import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

function fakeChild(): ChildProcess & { kill: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess & { kill: ReturnType<typeof vi.fn> };
}

async function importWithSpawn(spawn: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  vi.doMock("child_process", async () => ({
    ...await vi.importActual<typeof import("child_process")>("child_process"),
    spawn,
  }));
  return import("./killTree.js");
}

afterEach(() => {
  vi.doUnmock("child_process");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.skipIf(process.platform !== "win32")("Windows process-tree error handling", () => {
  it("cleans up and rethrows when the PowerShell supervisor cannot spawn", async () => {
    const spawn = vi.fn(() => { throw new Error("powershell unavailable"); });
    const { spawnAgentProcess } = await importWithSpawn(spawn);

    expect(() => spawnAgentProcess("agent.cmd", [], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
    })).toThrow("powershell unavailable");
  });

  it("surfaces taskkill launch and nonzero-exit failures", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const launchFailure = fakeChild();
    let spawn = vi.fn(() => launchFailure);
    let module = await importWithSpawn(spawn);
    const launchStopping = module.killProcessTree(4_242);
    launchFailure.emit("error", new Error("taskkill unavailable"));
    await expect(launchStopping).rejects.toThrow("failed to launch Windows process-tree termination");

    const exitFailure = fakeChild();
    spawn = vi.fn(() => exitFailure);
    module = await importWithSpawn(spawn);
    const exitStopping = module.killProcessTree(4_242);
    exitFailure.emit("close", 5, null);
    await expect(exitStopping).rejects.toThrow("exit=5");
  });

  it("times out taskkill and kills the stuck helper", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const killer = fakeChild();
    const { killProcessTree } = await importWithSpawn(vi.fn(() => killer));

    const stopping = killProcessTree(4_242);
    const rejected = expect(stopping).rejects.toThrow("termination timed out");
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(killer.kill).toHaveBeenCalledOnce();
  });

  it("waits for delayed process exit and rejects a tree that remains alive", async () => {
    vi.useFakeTimers();
    let checks = 0;
    vi.spyOn(process, "kill").mockImplementation(() => {
      checks += 1;
      if (checks <= 3) return true;
      throw Object.assign(new Error("not found"), { code: "ESRCH" });
    });
    let killer = fakeChild();
    let module = await importWithSpawn(vi.fn(() => killer));
    const delayedExit = module.killProcessTree(4_242);
    killer.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(100);
    await expect(delayedExit).resolves.toBeUndefined();

    vi.restoreAllMocks();
    vi.spyOn(process, "kill").mockImplementation(() => true);
    killer = fakeChild();
    module = await importWithSpawn(vi.fn(() => killer));
    const stuckTree = module.killProcessTree(4_242);
    killer.emit("close", 0, null);
    const rejected = expect(stuckTree).rejects.toThrow("remained alive after taskkill completed");
    await vi.advanceTimersByTimeAsync(2_100);
    await rejected;
  });
});

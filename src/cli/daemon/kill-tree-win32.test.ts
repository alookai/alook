import { describe, it, expect, vi } from "vitest";

// Mock process.platform to "win32" BEFORE kill-tree.ts evaluates isPosix.
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

const execSyncMock = vi.fn();
vi.mock("child_process", () => ({
  execSync: execSyncMock,
}));

const { killProcessTree, isAlive } = await import("./kill-tree.js");

// Restore platform after import so Vitest internals aren't confused.
Object.defineProperty(process, "platform", originalPlatform);

describe("killProcessTree (Windows)", () => {
  it("calls taskkill /PID <pid> /T /F on Windows", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) return true; // isAlive → true
      return true;
    });

    await killProcessTree(9999);

    expect(execSyncMock).toHaveBeenCalledWith("taskkill /PID 9999 /T /F", { stdio: "ignore" });
    killSpy.mockRestore();
  });

  it("does not poll or escalate to SIGKILL on Windows", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) return true;
      return true;
    });

    const start = Date.now();
    await killProcessTree(8888);
    const elapsed = Date.now() - start;

    // Should return immediately — no POLL_MS loop on Windows
    expect(elapsed).toBeLessThan(200);
    expect(execSyncMock).toHaveBeenCalledWith("taskkill /PID 8888 /T /F", { stdio: "ignore" });
    killSpy.mockRestore();
  });

  it("does not throw when taskkill fails (process already dead)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) return true;
      return true;
    });
    execSyncMock.mockImplementationOnce(() => { throw new Error("process not found"); });

    await expect(killProcessTree(7777)).resolves.toBeUndefined();
    killSpy.mockRestore();
  });

  it("skips if process is already dead (isAlive returns false)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    execSyncMock.mockClear();

    await killProcessTree(6666);

    expect(execSyncMock).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});

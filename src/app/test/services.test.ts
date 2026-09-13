import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `alook-test-services-${process.pid}`);
const childMocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  wranglerProcess: vi.fn((args: string[]) => ({ command: "wrangler", args })),
}));

vi.mock("child_process", () => ({
  execSync: childMocks.execSync,
  spawn: childMocks.spawn,
}));

vi.mock("../src/lib/wrangler.js", () => ({
  wranglerProcess: childMocks.wranglerProcess,
}));

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: testDir,
  PID_FILE: join(testDir, ".pids.json"),
  DEFAULT_PORTS: { web: 3000, emailWorker: 8787, wsDo: 8789, queueWorker: 8790 },
  WEB_URL: (port: number) => `http://localhost:${port}`,
}));

describe("services", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalProjectRoot = process.env.ALOOK_PROJECT_ROOT;

  function fakeChild(pid?: number) {
    return {
      pid,
      stderr: { on: vi.fn() },
      stdout: { on: vi.fn() },
      unref: vi.fn(),
    };
  }

  function mockChildren(pids: Array<number | undefined> = [101, 102, 103, 104]) {
    const children = pids.map(fakeChild);
    childMocks.spawn.mockImplementation(() => children.shift()!);
    return children;
  }

  function expectTerminatedPids(pids: number[], platform: "linux" | "win32") {
    if (platform === "win32") {
      expect(process.kill).not.toHaveBeenCalled();
      expect(childMocks.execSync).toHaveBeenCalledTimes(pids.length);
      for (const [index, pid] of pids.entries()) {
        expect(childMocks.execSync).toHaveBeenNthCalledWith(
          index + 1,
          `taskkill /F /T /PID ${pid}`,
          { stdio: "ignore" },
        );
      }
      return;
    }

    expect(childMocks.execSync).not.toHaveBeenCalled();
    expect(process.kill).toHaveBeenCalledTimes(pids.length);
    for (const [index, pid] of pids.entries()) {
      expect(process.kill).toHaveBeenNthCalledWith(index + 1, -pid, "SIGTERM");
    }
  }

  // Windows CI can spend >15s on the cold Vitest transform of services.ts
  // (pulls @alook/shared). Warm the graph once so per-test dynamic imports
  // hit the transform cache instead of timing out.
  beforeAll(async () => {
    await import("../src/lib/pid.js");
    await import("../src/lib/services.js");
    vi.resetModules();
  }, 60_000);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalProjectRoot === undefined) delete process.env.ALOOK_PROJECT_ROOT;
    else process.env.ALOOK_PROJECT_ROOT = originalProjectRoot;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("isRunning", () => {
    it("returns false when no pid file exists", async () => {
      const { isRunning } = await import("../src/lib/services.js");
      expect(isRunning()).toBe(false);
    });

    it("returns false when all pids are dead", async () => {
      const { writePids } = await import("../src/lib/pid.js");
      writePids({ web: 999999, emailWorker: 999998, wsDo: 999997 });
      const { isRunning } = await import("../src/lib/services.js");
      expect(isRunning()).toBe(false);
    });

    it("returns true when any service pid is alive", async () => {
      const { writePids } = await import("../src/lib/pid.js");
      // Use current process pid as a live process
      writePids({ web: 999999, emailWorker: process.pid, wsDo: 999997 });
      const { isRunning } = await import("../src/lib/services.js");
      expect(isRunning()).toBe(true);
    });

    it("returns true when only web is alive (backward compat)", async () => {
      const { writePids } = await import("../src/lib/pid.js");
      writePids({ web: process.pid, emailWorker: 999998, wsDo: 999997 });
      const { isRunning } = await import("../src/lib/services.js");
      expect(isRunning()).toBe(true);
    });
  });

  describe("stopServices", () => {
    it("clears pid file even when no services are running", async () => {
      const { writePids } = await import("../src/lib/pid.js");
      const { stopServices } = await import("../src/lib/services.js");
      const { PID_FILE } = await import("../src/lib/constants.js");

      writePids({ web: 999999 });
      expect(existsSync(PID_FILE)).toBe(true);

      stopServices();
      expect(existsSync(PID_FILE)).toBe(false);
    });
  });

  describe("startServices", () => {
    it("early-returns without spawning when a service pid is already alive", async () => {
      const { writePids } = await import("../src/lib/pid.js");
      const { startServices } = await import("../src/lib/services.js");

      // current process pid is guaranteed alive → the anyAlive guard short-circuits
      writePids({ web: process.pid });
      const logs: string[] = [];
      const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => { logs.push(String(m)); });

      startServices({ web: 3000, emailWorker: 8787, wsDo: 8789, queueWorker: 8790 });
      expect(logs.join("\n")).toContain("already running");
      spy.mockRestore();
    });

    it("spawns all four development services from the project tree", async () => {
      process.env.NODE_ENV = "development";
      process.env.ALOOK_PROJECT_ROOT = "/test/project";
      vi.resetModules();
      mockChildren();
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { startServices } = await import("../src/lib/services.js");

      startServices({ web: 3000, emailWorker: 8787, wsDo: 8789, queueWorker: 8790 });

      expect(childMocks.spawn).toHaveBeenCalledTimes(4);
      expect(childMocks.spawn).toHaveBeenNthCalledWith(
        4,
        "npx",
        expect.arrayContaining(["wrangler", "dev", "--port", "8790"]),
        expect.objectContaining({
          cwd: join("/test/project", "src", "queue-worker"),
          detached: true,
          env: expect.objectContaining({ NODE_ENV: "development" }),
          stdio: ["ignore", expect.any(Number), expect.any(Number)],
        }),
      );
    });

    it("spawns all four packaged services from generated Wrangler commands", async () => {
      process.env.NODE_ENV = "production";
      delete process.env.ALOOK_PROJECT_ROOT;
      vi.resetModules();
      mockChildren();
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { startServices } = await import("../src/lib/services.js");

      startServices({ web: 3000, emailWorker: 8787, wsDo: 8789, queueWorker: 8790 });

      expect(childMocks.wranglerProcess).toHaveBeenCalledTimes(4);
      expect(childMocks.wranglerProcess).toHaveBeenLastCalledWith(
        expect.arrayContaining(["dev", "--port", "8790"]),
      );
      expect(childMocks.spawn).toHaveBeenNthCalledWith(
        4,
        "wrangler",
        expect.arrayContaining(["dev", "--port", "8790"]),
        expect.objectContaining({
          cwd: join(testDir, "queue-worker"),
          detached: true,
          env: expect.objectContaining({ NODE_ENV: "development" }),
          stdio: ["ignore", expect.any(Number), expect.any(Number)],
        }),
      );
    });

    it.each(["linux", "win32"] as const)(
      "terminates already-started children when one service has no pid on %s",
      async (platform) => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
        process.env.NODE_ENV = "production";
        vi.resetModules();
        mockChildren([101, undefined, 103, 104]);
        vi.spyOn(process, "kill").mockImplementation(() => true);
        const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`exit:${code}`);
        }) as never);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { startServices } = await import("../src/lib/services.js");

        expect(() => startServices({
          web: 3000,
          emailWorker: 8787,
          wsDo: 8789,
          queueWorker: 8790,
        })).toThrow("exit:1");
        expect(childMocks.spawn).toHaveBeenCalledTimes(4);
        expectTerminatedPids([101, 103, 104], platform);
        expect(exit).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledWith(1);
      },
    );

    it.each(["linux", "win32"] as const)(
      "cleans up every foreground child on SIGINT exactly once on %s",
      async (platform) => {
        vi.spyOn(process, "platform", "get").mockReturnValue(platform);
        process.env.NODE_ENV = "development";
        process.env.ALOOK_PROJECT_ROOT = "/test/project";
        vi.resetModules();
        mockChildren();
        vi.spyOn(process, "kill").mockImplementation(() => true);
        const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
          throw new Error(`exit:${code}`);
        }) as never);
        const handlers = new Map<string, () => void>();
        vi.spyOn(process, "on").mockImplementation(((event: string, handler: () => void) => {
          handlers.set(event, handler);
          return process;
        }) as never);
        vi.spyOn(console, "log").mockImplementation(() => {});
        const { startServices } = await import("../src/lib/services.js");

        startServices(
          { web: 3000, emailWorker: 8787, wsDo: 8789, queueWorker: 8790 },
          { foreground: true },
        );
        const { PID_FILE } = await import("../src/lib/constants.js");
        expect(existsSync(PID_FILE)).toBe(true);
        expect(() => handlers.get("SIGINT")!()).toThrow("exit:0");
        expect(handlers.get("SIGINT")!()).toBeUndefined();

        expect(childMocks.spawn).toHaveBeenCalledTimes(4);
        expectTerminatedPids([101, 102, 103, 104], platform);
        expect(existsSync(PID_FILE)).toBe(false);
        expect(exit).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
      },
    );
  });
});

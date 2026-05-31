import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `alook-test-services-${process.pid}`);

vi.mock("../src/lib/constants.js", () => ({
  SELF_HOSTED_DIR: testDir,
  PID_FILE: join(testDir, ".pids.json"),
  DEFAULT_PORTS: { web: 3000, emailWorker: 8787, wsDo: 8789 },
  WEB_URL: (port: number) => `http://localhost:${port}`,
}));

describe("services", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  describe("isRunning", () => {
    it("returns false when no pid file exists", async () => {
      const { isRunning } = await import("../src/lib/services.js");
      expect(isRunning()).toBe(false);
    }, 15_000);

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

      startServices({ web: 3000, emailWorker: 8787, wsDo: 8789 });
      expect(logs.join("\n")).toContain("already running");
      spy.mockRestore();
    });
  });
});

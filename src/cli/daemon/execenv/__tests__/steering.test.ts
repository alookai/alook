import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../../../lib/logger.js", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  writeKillIntent,
  readKillIntent,
  clearKillIntent,
  cleanupStaleIntents,
  acquireSteeringLock,
  releaseSteeringLock,
  type KillIntent,
} from "../steering.js";

describe("steering", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = join(tmpdir(), `steering-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe("kill intent files", () => {
    it("writes and reads a superseded kill intent", () => {
      const intent: KillIntent = {
        reason: "superseded",
        targetTaskId: "t_old",
        expectedPid: 12345,
        successorTaskId: "t_new",
      };

      writeKillIntent(baseDir, intent);
      const read = readKillIntent(baseDir, "t_old");

      expect(read).not.toBeNull();
      expect(read!.reason).toBe("superseded");
      expect(read!.targetTaskId).toBe("t_old");
      expect(read!.expectedPid).toBe(12345);
      expect(read!.successorTaskId).toBe("t_new");
    });

    it("writes and reads a cancelled kill intent", () => {
      const intent: KillIntent = {
        reason: "cancelled",
        targetTaskId: "t_cancel",
        expectedPid: 99999,
      };

      writeKillIntent(baseDir, intent);
      const read = readKillIntent(baseDir, "t_cancel");

      expect(read).not.toBeNull();
      expect(read!.reason).toBe("cancelled");
      expect(read!.targetTaskId).toBe("t_cancel");
      expect(read!.expectedPid).toBe(99999);
    });

    it("returns null when no intent file exists", () => {
      expect(readKillIntent(baseDir, "t_nonexistent")).toBeNull();
    });

    it("clears a kill intent", () => {
      writeKillIntent(baseDir, {
        reason: "cancelled",
        targetTaskId: "t_clear",
      });

      expect(readKillIntent(baseDir, "t_clear")).not.toBeNull();
      clearKillIntent(baseDir, "t_clear");
      expect(readKillIntent(baseDir, "t_clear")).toBeNull();
    });

    it("clearKillIntent is a no-op when file does not exist", () => {
      expect(() => clearKillIntent(baseDir, "t_nonexistent")).not.toThrow();
    });

    it("intent file is keyed by task id, not PID", () => {
      writeKillIntent(baseDir, {
        reason: "superseded",
        targetTaskId: "t_abc",
        expectedPid: 11111,
      });

      const intentPath = join(baseDir, ".kill_intents", "t_abc.json");
      expect(existsSync(intentPath)).toBe(true);

      const content = JSON.parse(readFileSync(intentPath, "utf-8"));
      expect(content.expectedPid).toBe(11111);
    });

    it("multiple intents for different tasks coexist", () => {
      writeKillIntent(baseDir, { reason: "superseded", targetTaskId: "t_1" });
      writeKillIntent(baseDir, { reason: "cancelled", targetTaskId: "t_2" });

      expect(readKillIntent(baseDir, "t_1")!.reason).toBe("superseded");
      expect(readKillIntent(baseDir, "t_2")!.reason).toBe("cancelled");
    });
  });

  describe("stale intent cleanup", () => {
    it("does not throw when no intent directory exists", () => {
      expect(() => cleanupStaleIntents(baseDir)).not.toThrow();
    });

    it("does not remove fresh intents", () => {
      writeKillIntent(baseDir, { reason: "cancelled", targetTaskId: "t_fresh" });
      cleanupStaleIntents(baseDir);
      expect(readKillIntent(baseDir, "t_fresh")).not.toBeNull();
    });
  });

  describe("steering lock", () => {
    it("acquires and releases a steering lock", () => {
      const acquired = acquireSteeringLock(baseDir, "conv_thread");
      expect(acquired).toBe(true);

      releaseSteeringLock(baseDir, "conv_thread");
    });

    it("cannot acquire the same lock twice", () => {
      acquireSteeringLock(baseDir, "conv_1");
      const second = acquireSteeringLock(baseDir, "conv_1");
      expect(second).toBe(false);

      releaseSteeringLock(baseDir, "conv_1");
    });

    it("can re-acquire after release", () => {
      acquireSteeringLock(baseDir, "conv_1");
      releaseSteeringLock(baseDir, "conv_1");

      const reacquired = acquireSteeringLock(baseDir, "conv_1");
      expect(reacquired).toBe(true);

      releaseSteeringLock(baseDir, "conv_1");
    });

    it("different context keys do not conflict", () => {
      const first = acquireSteeringLock(baseDir, "conv_1");
      const second = acquireSteeringLock(baseDir, "conv_2");
      expect(first).toBe(true);
      expect(second).toBe(true);

      releaseSteeringLock(baseDir, "conv_1");
      releaseSteeringLock(baseDir, "conv_2");
    });
  });
});

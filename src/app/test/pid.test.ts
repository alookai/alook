import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("../src/lib/constants.js", () => {
  const dir = join(tmpdir(), `alook-test-pid-${process.pid}`);
  return {
    SELF_HOSTED_DIR: dir,
    PID_FILE: join(dir, ".pids.json"),
  };
});

const { readPids, writePids, clearPids, isAlive } = await import("../src/lib/pid.js");
const { PID_FILE, SELF_HOSTED_DIR } = await import("../src/lib/constants.js");

describe("pid", () => {
  beforeEach(() => {
    mkdirSync(SELF_HOSTED_DIR, { recursive: true });
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  });

  afterEach(() => {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  });

  describe("readPids", () => {
    it("returns empty record when no file exists", () => {
      expect(readPids()).toEqual({});
    });

    it("returns parsed pids when file exists", () => {
      const pids = { web: 1234, emailWorker: 5678, wsDo: 9012 };
      writePids(pids);
      expect(readPids()).toEqual(pids);
    });

    it("returns empty record for corrupted file", () => {
      const { writeFileSync } = require("fs");
      writeFileSync(PID_FILE, "not json");
      expect(readPids()).toEqual({});
    });
  });

  describe("writePids", () => {
    it("writes pids with restricted permissions", () => {
      writePids({ web: 100, emailWorker: 200, wsDo: 300 });
      const content = JSON.parse(readFileSync(PID_FILE, "utf-8"));
      expect(content).toEqual({ web: 100, emailWorker: 200, wsDo: 300 });
    });
  });

  describe("clearPids", () => {
    it("removes pid file", () => {
      writePids({ web: 1 });
      expect(existsSync(PID_FILE)).toBe(true);
      clearPids();
      expect(existsSync(PID_FILE)).toBe(false);
    });

    it("does not throw when file does not exist", () => {
      expect(() => clearPids()).not.toThrow();
    });
  });

  describe("isAlive", () => {
    it("returns true for current process", () => {
      expect(isAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent pid", () => {
      expect(isAlive(999999)).toBe(false);
    });
  });
});

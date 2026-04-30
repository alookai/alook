import { describe, it, expect } from "vitest";
import { tmpdir } from "os";
import { join, sep } from "path";
import { tempDir, isPathContained, isWindows } from "./platform.js";

describe("platform", () => {
  describe("tempDir", () => {
    it("returns os tmpdir joined with subdir", () => {
      expect(tempDir("alook-test")).toBe(join(tmpdir(), "alook-test"));
    });
  });

  describe("isPathContained", () => {
    it("returns true for exact match", () => {
      expect(isPathContained("/a/b", "/a/b")).toBe(true);
    });

    it("returns true for child path", () => {
      expect(isPathContained(`/a/b`, `/a/b${sep}c`)).toBe(true);
    });

    it("returns false for sibling with shared prefix", () => {
      expect(isPathContained("/a/b", "/a/bc")).toBe(false);
    });

    it("returns false for parent path", () => {
      expect(isPathContained("/a/b/c", "/a/b")).toBe(false);
    });
  });

  describe("isWindows", () => {
    it("reflects current platform", () => {
      expect(isWindows).toBe(process.platform === "win32");
    });
  });
});

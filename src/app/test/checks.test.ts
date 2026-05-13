import { describe, it, expect, vi, beforeEach } from "vitest";

describe("checks", () => {
  describe("checkNodeVersion", () => {
    it("does not exit for Node >= 20", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);

      const { checkNodeVersion } = await import("../src/lib/checks.js");
      const major = parseInt(process.versions.node.split(".")[0], 10);
      if (major >= 20) {
        expect(() => checkNodeVersion()).not.toThrow();
      }
      exitSpy.mockRestore();
    });
  });

  describe("checkPort", () => {
    it("returns true for an unused port", async () => {
      const { checkPort } = await import("../src/lib/checks.js");
      // Port 0 or a random high port should be unused
      const result = await checkPort(49999);
      expect(result).toBe(true);
    });
  });
});

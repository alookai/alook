import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `alook-test-install-${process.pid}`);

vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: testDir }));

describe("install", () => {
  beforeEach(() => mkdirSync(testDir, { recursive: true }));
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("isInstalled", () => {
    it("returns false when web/wrangler.toml is absent", async () => {
      const { isInstalled } = await import("../src/lib/install.js");
      expect(isInstalled()).toBe(false);
    });

    it("returns true once web/wrangler.toml exists", async () => {
      mkdirSync(join(testDir, "web"), { recursive: true });
      writeFileSync(join(testDir, "web", "wrangler.toml"), "name = 'x'");
      const { isInstalled } = await import("../src/lib/install.js");
      expect(isInstalled()).toBe(true);
    });
  });
});

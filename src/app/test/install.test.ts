import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, existsSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";

const testDir = join(tmpdir(), `alook-test-install-${process.pid}`);
const bundleDir = join(tmpdir(), `alook-test-bundle-${process.pid}`);

const bundledFixtureFiles = [
  "web/wrangler.toml",
  "email-worker/index.js",
  "ws-do/index.js",
  "wake-worker/wrangler.toml",
  "wake-worker/index.js",
];

function createFiles(rootDir: string, files: string[]): void {
  for (const file of files) {
    const path = join(rootDir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "fixture");
  }
}

vi.mock("../src/lib/constants.js", () => ({ SELF_HOSTED_DIR: testDir }));

describe("install", () => {
  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    mkdirSync(bundleDir, { recursive: true });
    createFiles(bundleDir, bundledFixtureFiles);
  });
  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true, force: true });
    vi.resetModules();
  });

  describe("isInstalled", () => {
    it("returns false when required files are absent", async () => {
      const { isInstalled } = await import("../src/lib/install.js");
      expect(isInstalled(bundleDir, testDir)).toBe(false);
    });

    it("returns true once every required file exists", async () => {
      createFiles(testDir, bundledFixtureFiles);
      const { isInstalled } = await import("../src/lib/install.js");
      expect(isInstalled(bundleDir, testDir)).toBe(true);
    });

    it("returns false for a legacy installation without wake-worker", async () => {
      createFiles(testDir, bundledFixtureFiles.filter((file) => !file.startsWith("wake-worker/")));
      const { isInstalled } = await import("../src/lib/install.js");
      expect(isInstalled(bundleDir, testDir)).toBe(false);
    });
  });

  describe("getMissingInstallFiles", () => {
    it("returns all missing required files", async () => {
      createFiles(testDir, ["web/wrangler.toml"]);
      const { getMissingInstallFiles } = await import("../src/lib/install.js");
      expect(getMissingInstallFiles(bundleDir, testDir)).toEqual(
        bundledFixtureFiles.filter((file) => file !== "web/wrangler.toml").sort(),
      );
    });

    it("automatically requires newly bundled files", async () => {
      createFiles(testDir, bundledFixtureFiles);
      createFiles(bundleDir, ["future-worker/nested/entry.js"]);
      const { getMissingInstallFiles } = await import("../src/lib/install.js");
      expect(getMissingInstallFiles(bundleDir, testDir)).toEqual([
        "future-worker/nested/entry.js",
      ]);
    });

    it("treats a directory at a bundled file path as missing", async () => {
      createFiles(testDir, bundledFixtureFiles.filter((file) => file !== "wake-worker/index.js"));
      mkdirSync(join(testDir, "wake-worker/index.js"), { recursive: true });
      const { getMissingInstallFiles } = await import("../src/lib/install.js");
      expect(getMissingInstallFiles(bundleDir, testDir)).toEqual([
        "wake-worker/index.js",
      ]);
    });
  });

  describe("assertInstallationComplete", () => {
    it("names missing files in the error", async () => {
      createFiles(testDir, bundledFixtureFiles.filter((file) => file !== "wake-worker/wrangler.toml"));
      const { assertInstallationComplete } = await import("../src/lib/install.js");
      expect(() => assertInstallationComplete(bundleDir, testDir)).toThrow(
        "Alook installation is incomplete after installing bundled assets. Missing required files: wake-worker/wrangler.toml. Reinstall @alook/app and try again.",
      );
    });

    it("does not throw for a complete installation", async () => {
      createFiles(testDir, bundledFixtureFiles);
      const { assertInstallationComplete } = await import("../src/lib/install.js");
      expect(() => assertInstallationComplete(bundleDir, testDir)).not.toThrow();
    });

    it("limits the missing-file preview for corrupted installations", async () => {
      createFiles(bundleDir, Array.from(
        { length: 12 },
        (_, index) => `future-worker/chunk-${index}.js`,
      ));
      const { assertInstallationComplete } = await import("../src/lib/install.js");
      expect(() => assertInstallationComplete(bundleDir, testDir)).toThrow(
        /, and 7 more\. Reinstall @alook\/app and try again\.$/,
      );
    });
  });
});

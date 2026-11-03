import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { execPackageManagerSync } from "./test-package-manager.js";

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function javascriptFiles(root: string): string[] {
  return readdirSync(root, { recursive: true })
    .filter((name): name is string => typeof name === "string" && name.endsWith(".js"))
    .map((name) => join(root, name));
}

describe("packed daemon agent-driver boundary", () => {
  it("installs and imports without a runtime agent-driver dependency", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "alook-daemon-driver-bundle-"));
    const installRoot = join(root, "consumer");
    tempRoots.push(root);
    writeFileSync(join(root, "package.json"), "{}\n");
    execPackageManagerSync(
      ["pack", "--pack-destination", root],
      { cwd: packageRoot, maxBuffer: 20 * 1024 * 1024 },
    );
    const tarballName = readdirSync(root).find((name) => name.endsWith(".tgz"));
    if (!tarballName) throw new Error("daemon pack did not produce a tarball");

    await execFileAsync("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      join(root, tarballName),
    ], {
      cwd: root,
      maxBuffer: 20 * 1024 * 1024,
      shell: process.platform === "win32",
    });

    const installedRoot = join(installRoot, "node_modules/@alook/daemon");
    const manifest = JSON.parse(readFileSync(join(installedRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies).not.toHaveProperty("@alook/agent-driver");
    for (const file of javascriptFiles(join(installedRoot, "dist"))) {
      expect(readFileSync(file, "utf8"), file).not.toContain("@alook/agent-driver");
    }
    await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      "await import('@alook/daemon')",
    ], { cwd: installRoot, maxBuffer: 10 * 1024 * 1024 });
    if (process.env.ALOOK_NATIVE_SDK_ROOT && process.platform !== "win32") {
      const script = join(packageRoot, "agent-driver", "scripts", "test-bundled-sdk-workers.mjs");
      const { stdout } = await execFileAsync(process.execPath, [
        script,
        pathToFileURL(join(installedRoot, "dist", "index.js")).href,
        process.env.ALOOK_NATIVE_SDK_ROOT,
      ], { cwd: installRoot, maxBuffer: 10 * 1024 * 1024 });
      const reports = stdout.trim().split("\n").map((line) => JSON.parse(line) as { id: string; manager?: string });
      for (const id of ["qoder", "copilot", "cursor-sdk", "pi-durable"]) {
        expect(reports).toContainEqual(expect.objectContaining({ id, results: ["success", "interrupted"], closed: "stopped" }));
        expect(reports).toContainEqual(expect.objectContaining({ id, manager: "wake-during-work", acks: 2, opens: 1, turnActive: false, sessionState: "idle" }));
      }
    }
  });
});

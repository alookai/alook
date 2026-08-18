import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackFile {
  path: string;
}

interface PackResult {
  name: string;
  version: string;
  files: PackFile[];
}

describe("packed @alook/agent-driver", () => {
  it("publishes only the documented ESM and declaration surface", () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const packageVersion = (JSON.parse(readFileSync(`${packageRoot}package.json`, "utf8")) as { version: string }).version;
    execFileSync("pnpm", ["run", "build"], { cwd: packageRoot, stdio: "pipe" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    const [result] = JSON.parse(output) as PackResult[];
    const files = result.files.map((file) => file.path).sort();

    expect(result.name).toBe("@alook/agent-driver");
    expect(result.version).toBe(packageVersion);
    expect(files).toEqual([
      "LICENSE",
      "README.md",
      "dist/contracts.d.ts",
      "dist/contracts.d.ts.map",
      "dist/contracts.js",
      "dist/contracts.js.map",
      "dist/host.d.ts",
      "dist/host.d.ts.map",
      "dist/host.js",
      "dist/host.js.map",
      "dist/index.d.ts",
      "dist/index.d.ts.map",
      "dist/index.js",
      "dist/index.js.map",
      "dist/registry.d.ts",
      "dist/registry.d.ts.map",
      "dist/registry.js",
      "dist/registry.js.map",
      "dist/session.d.ts",
      "dist/session.d.ts.map",
      "dist/session.js",
      "dist/session.js.map",
      "dist/testing.d.ts",
      "dist/testing.d.ts.map",
      "dist/testing.js",
      "dist/testing.js.map",
      "package.json",
    ]);
  }, 30_000);
});

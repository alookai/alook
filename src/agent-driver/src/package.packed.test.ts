import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackFile {
  path: string;
}

interface PackResult {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
}

interface PackageManifest {
  main?: string;
  types?: string;
  exports?: unknown;
}

describe("packed @alook/agent-driver", () => {
  it("resolves fresh workspace consumers from source without a prebuilt dist", () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const daemonRoot = fileURLToPath(new URL("../../daemon/", import.meta.url));
    const manifest = JSON.parse(readFileSync(`${packageRoot}package.json`, "utf8")) as PackageManifest;

    expect(manifest.main).toBe("./src/index.ts");
    expect(manifest.types).toBe("./src/index.ts");
    expect(manifest.exports).toEqual({
      ".": {
        types: "./src/index.ts",
        import: "./src/index.ts",
      },
    });

    const resolved = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", 'console.log(import.meta.resolve("@alook/agent-driver"))'],
      { cwd: daemonRoot, encoding: "utf8" },
    ).trim();
    expect(resolved).toBe(new URL("../src/index.ts", import.meta.url).href);
  });

  it("publishes only the documented ESM and declaration surface", () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const packageVersion = (JSON.parse(readFileSync(`${packageRoot}package.json`, "utf8")) as { version: string }).version;
    const packDirectory = mkdtempSync(join(tmpdir(), "alook-agent-driver-pack-"));
    try {
      const output = execFileSync("pnpm", ["pack", "--json", "--pack-destination", packDirectory], {
        cwd: packageRoot,
        encoding: "utf8",
      });
      const result = JSON.parse(output.slice(output.indexOf("{"))) as PackResult;
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
        "dist/transport.d.ts",
        "dist/transport.d.ts.map",
        "dist/transport.js",
        "dist/transport.js.map",
        "package.json",
      ]);

      const packedManifest = JSON.parse(
        execFileSync("tar", ["-xOf", result.filename, "package/package.json"], { encoding: "utf8" }),
      ) as PackageManifest;
      expect(packedManifest.main).toBe("./dist/index.js");
      expect(packedManifest.types).toBe("./dist/index.d.ts");
      expect(packedManifest.exports).toEqual({
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
        },
      });
    } finally {
      rmSync(packDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});

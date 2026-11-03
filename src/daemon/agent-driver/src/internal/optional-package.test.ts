import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOptionalPackage } from "./optional-package.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function installation() {
  const root = mkdtempSync(join(tmpdir(), "alook-optional-sdk-"));
  roots.push(root);
  return root;
}

function sdk(root: string, version: string): string {
  const directory = join(root, "node_modules", "@fixture", "sdk");
  mkdirSync(join(directory, "dist", "nested"), { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fixture/sdk", version, main: "./dist/nested/index.js" }));
  const entry = join(directory, "dist", "nested", "index.js");
  writeFileSync(entry, "exports.available = true;\n");
  return realpathSync(entry);
}

describe("optional SDK installation discovery", () => {
  it("prefers the local installation over the explicit global npm prefix", () => {
    const local = installation();
    const global = installation();
    const entry = sdk(local, "local");
    sdk(join(global, "lib"), "global");
    expect(resolveOptionalPackage("@fixture/sdk", [join(local, "loader.cjs"), join(global, "lib", "loader.cjs")])).toEqual({ entry, version: "local" });
  });

  it("resolves a global SDK through the installed npm entry", () => {
    const root = installation();
    const lib = join(root, "lib");
    const entry = sdk(lib, "global");
    const npm = join(lib, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(lib, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(npm, "");
    expect(resolveOptionalPackage("@fixture/sdk", [npm])).toEqual({ entry, version: "global" });
  });

  it("returns unavailable for an absent or invalid installation", () => {
    const root = installation();
    expect(resolveOptionalPackage("@fixture/sdk", [join(root, "loader.cjs")])).toBeUndefined();
    sdk(root, "broken");
    rmSync(join(root, "node_modules", "@fixture", "sdk", "dist"), { recursive: true });
    expect(resolveOptionalPackage("@fixture/sdk", [join(root, "loader.cjs")])).toBeUndefined();
  });
});

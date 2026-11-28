import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { shareEditorAssets } from "../scripts/editor-assets.mjs";

const roots = [];
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alook-shared-editor-test-"));
  roots.push(root);
  for (const type of ["sheets", "docs"]) {
    await mkdir(join(root, "editors", type, "assets"), { recursive: true });
    await writeFile(join(root, "editors", type, "index.html"), `<title>${type}</title>`);
    await writeFile(join(root, "editors", type, "assets", "font.woff2"), "same-font");
    await writeFile(join(root, "editors", type, "assets", `${type}.mjs`), `export default ${JSON.stringify(type)};`);
  }
  await writeFile(join(root, "editors", "sheets", "assets", "engine-hash.wasm"), wasm);
  await writeFile(join(root, "sheets.wasm"), wasm);
  await writeFile(join(root, "cli.mjs"), `import { readFileSync } from 'node:fs';
const module = new WebAssembly.Module(readFileSync(new URL("./sheets.wasm", import.meta.url)));
process.stdout.write(JSON.stringify(WebAssembly.Module.exports(module)));
`);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("shares equal assets, preserves both editor pages and executes the CLI with only the shared WASM", async () => {
  const root = await fixture();
  const result = await shareEditorAssets(root);
  expect(result).toMatchObject({ alreadyShared: false, assets: 4, removedBytes: wasm.length + Buffer.byteLength("same-font") });
  expect(await readdir(join(root, "editors", "_shared", "assets"))).toEqual(["docs.mjs", "engine-hash.wasm", "font.woff2", "sheets.mjs"]);
  for (const type of ["docs", "sheets"]) {
    expect(await readFile(join(root, "editors", type, "index.html"), "utf8")).toBe(`<title>${type}</title>`);
    await expect(readdir(join(root, "editors", type, "assets"))).rejects.toMatchObject({ code: "ENOENT" });
  }
  await expect(readFile(join(root, "sheets.wasm"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(execFileSync(process.execPath, [join(root, "cli.mjs")], { encoding: "utf8", timeout: 5_000 })).toBe("[]");
});

it("refuses conflicting filenames before removing any original resource", async () => {
  const root = await fixture();
  await writeFile(join(root, "editors", "docs", "assets", "font.woff2"), "different-font");
  await expect(shareEditorAssets(root)).rejects.toThrow("Editor asset name collision");
  expect(await readFile(join(root, "editors", "docs", "assets", "font.woff2"), "utf8")).toBe("different-font");
  expect(await readFile(join(root, "editors", "sheets", "assets", "font.woff2"), "utf8")).toBe("same-font");
  expect(await readFile(join(root, "sheets.wasm"))).toEqual(wasm);
});

it("removes stale shared output on a complete rebuild and is repeatable after compaction", async () => {
  const root = await fixture();
  await mkdir(join(root, "editors", "_shared", "assets"), { recursive: true });
  await writeFile(join(root, "editors", "_shared", "assets", "old-font.woff2"), "old");
  await shareEditorAssets(root);
  const before = await readFile(join(root, "cli.mjs"));
  await expect(readFile(join(root, "editors", "_shared", "assets", "old-font.woff2"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await shareEditorAssets(root)).toEqual({ alreadyShared: true, removedBytes: 0 });
  expect(await readFile(join(root, "cli.mjs"))).toEqual(before);
  expect(execFileSync(process.execPath, [join(root, "cli.mjs")], { encoding: "utf8", timeout: 5_000 })).toBe("[]");
});

it("rejects partial builds and unknown loaders while retaining all original WASM bytes", async () => {
  const root = await fixture();
  await writeFile(join(root, "cli.mjs"), "throw Error('changed upstream loader')");
  await expect(shareEditorAssets(root)).rejects.toThrow("Pinned local Sheets WASM loader changed");
  expect(await readFile(join(root, "sheets.wasm"))).toEqual(wasm);
  await rm(join(root, "editors", "docs", "assets"), { recursive: true });
  await expect(shareEditorAssets(root)).rejects.toThrow("Rebuild every editor");
  expect(await readFile(join(root, "editors", "sheets", "assets", "engine-hash.wasm"))).toEqual(wasm);
});

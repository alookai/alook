import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePageDirectory } from "./pageDirectory.js";
import { checkZip, unpackZipFile } from "../vendor/open-artifact/zip.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "page-directory-test-")); roots.push(root);
  await writeFile(join(root, ".artifact.json"), JSON.stringify({ type: "page", title: "Test" }));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Test</title>");
  return root;
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it("packs one upstream top folder and excludes unrelated files before uploading", async () => {
  const root = await fixture();
  for (const name of [".git", "node_modules", "assets/node_modules"]) { await mkdir(join(root, name), { recursive: true }); await writeFile(join(root, name, "private"), "excluded"); }
  await writeFile(join(root, ".env"), "excluded"); await writeFile(join(root, ".DS_Store"), "excluded");
  const prepared = await preparePageDirectory(root);
  const checked = checkZip(prepared.bytes, { noun: "Page", maxFiles: 2000, maxBytes: 32 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024 });
  expect(checked.top).toBe("page"); expect(checked.files.map(file => file.path)).toEqual([".artifact.json", "index.html"]);
  expect((await unpackZipFile(prepared.bytes, checked.files[1]!)).toString()).toContain("<title>Test</title>");
});
it("rejects invalid metadata, missing entrypoints and links", async () => {
  const root = await fixture();
  await writeFile(join(root, ".artifact.json"), "not JSON"); await expect(preparePageDirectory(root)).rejects.toThrow("valid .artifact.json");
  await writeFile(join(root, ".artifact.json"), JSON.stringify({ type: "unknown" })); await expect(preparePageDirectory(root)).rejects.toThrow("unsupported type");
  await writeFile(join(root, ".artifact.json"), JSON.stringify({ type: "page" })); await rm(join(root, "index.html")); await expect(preparePageDirectory(root)).rejects.toThrow("requires index.html");
  if (process.platform !== "win32") { await symlink("/etc/hosts", join(root, "leak")); await expect(preparePageDirectory(root)).rejects.toThrow("symbolic links"); }
});
it("rejects expanded files over the bound before reading their data", async () => {
  const root = await fixture(); const fs = await import("node:fs/promises"); const file = await fs.open(join(root, "large"), "w"); await file.truncate(32 * 1024 * 1024 + 1); await file.close();
  await expect(preparePageDirectory(root)).rejects.toThrow("32 MiB");
});

it("rejects directories exceeding the 2,000-file upload bound", async () => {
  const root = await fixture();
  await Promise.all(Array.from({ length: 1999 }, (_, i) => writeFile(join(root, `file-${i}`), "x")));
  await expect(preparePageDirectory(root)).rejects.toThrow("2000 files");
}, 30_000);

it("rejects incompressible archives exceeding the 16 MiB compressed upload bound", async () => {
  const root = await fixture();
  const { randomBytes } = await import("node:crypto");
  await writeFile(join(root, "noise.bin"), randomBytes(17 * 1024 * 1024));
  await expect(preparePageDirectory(root)).rejects.toThrow("16 MiB compressed");
}, 30_000);

it("detects built-in Open Artifact directories from native markers even without .artifact.json", async () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["docs", "doc/doc.json", JSON.stringify({ format: "oa-doc", tabs: {} })],
    ["sheets", "sheet/sheet.json", JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", title: "Budget" })],
    ["slides", "project/deck.json", JSON.stringify({ v: 5, title: "Deck", order: [] })],
    ["whiteboard", "db/board/meta.json", JSON.stringify({ v: 1, title: "Board", order: [] })],
  ];
  for (const [expectedType, relPath, body] of cases) {
    const root = await mkdtemp(join(tmpdir(), `page-marker-${expectedType}-`));
    roots.push(root);
    const dir = join(root, relPath.split("/").slice(0, -1).join("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, relPath), body);
    const prepared = await preparePageDirectory(root);
    expect(prepared.type).toBe(expectedType);
  }
});

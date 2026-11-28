import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const SHARED_EDITOR_BASE = "/_open-artifact/editors/_shared/";

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unexpected editor asset entry: ${path}`);
  }
  return result.sort();
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function shareEditorAssets(runtimeDirectory) {
  const editors = join(runtimeDirectory, "editors");
  const types = (await readdir(editors, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== "_shared").map(entry => entry.name).sort();
  if (!types.length) throw new Error("No built editors found");
  const sources = types.map(type => join(editors, type, "assets"));
  const present = await Promise.all(sources.map(exists));
  const shared = join(editors, "_shared");
  if (present.every(value => !value) && await exists(join(shared, "assets"))) {
    return { alreadyShared: true, removedBytes: 0 };
  }
  if (present.some(value => !value)) throw new Error("Rebuild every editor before sharing its assets");

  const assets = new Map();
  let originalBytes = 0;
  let sharedBytes = 0;
  for (const source of sources) {
    for (const path of await filesUnder(source)) {
      const name = relative(source, path).replaceAll("\\", "/");
      const bytes = await readFile(path);
      originalBytes += bytes.length;
      const previous = assets.get(name);
      if (previous) {
        if (!bytes.equals(await readFile(previous))) throw new Error(`Editor asset name collision: ${name}`);
      } else {
        assets.set(name, path);
        sharedBytes += bytes.length;
      }
    }
  }

  const wasmPath = join(runtimeDirectory, "sheets.wasm");
  const cliPath = join(runtimeDirectory, "cli.mjs");
  const wasm = await readFile(wasmPath);
  const matches = [];
  for (const [name, path] of assets) {
    if (name.endsWith(".wasm") && wasm.equals(await readFile(path))) matches.push(name);
  }
  if (matches.length !== 1) throw new Error("Expected exactly one shared Sheets WASM asset");
  const cli = await readFile(cliPath, "utf8");
  const before = 'new URL("./sheets.wasm", import.meta.url)';
  if (cli.split(before).length !== 2) throw new Error("Pinned local Sheets WASM loader changed");
  const after = `new URL(${JSON.stringify(`./editors/_shared/assets/${matches[0]}`)}, import.meta.url)`;

  const staging = await mkdtemp(join(runtimeDirectory, ".shared-editors-"));
  try {
    for (const [name, path] of assets) {
      const target = join(staging, "assets", name);
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(path, target);
    }
    await rm(shared, { recursive: true, force: true });
    await rename(staging, shared);
    await writeFile(cliPath, cli.replace(before, after));
    await rm(wasmPath);
    for (const source of sources) await rm(source, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { alreadyShared: false, assets: assets.size, originalBytes, sharedBytes, removedBytes: originalBytes - sharedBytes + wasm.length };
}

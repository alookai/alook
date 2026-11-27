import { constants } from "node:fs";
import { lstat, mkdtemp, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { archiveKeeps, foldedName, writeArchive, checkZip, unpackZipFile } from "../vendor/open-artifact/zip.js";

export const PAGE_ARCHIVE_LIMITS = { compressed: 16 * 1024 * 1024, expanded: 32 * 1024 * 1024, files: 2000 } as const;
const types = new Set(["page", "docs", "slides", "sheets", "whiteboard", "design", "data", "motion", "design-system"]);

export async function preparePageDirectory(directory: string) {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) throw new Error("Page source must be a directory");
  const temporary = await mkdtemp(join(tmpdir(), "alook-page-"));
  const snapshot = join(temporary, "page");
  await mkdir(snapshot, { mode: 0o700 });
  let count = 0;
  let expanded = 0;
  const seen = new Set<string>();
  const paths = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (name.toLowerCase() === "node_modules" || !archiveKeeps(path) || !archiveKeeps(foldedName(path))) continue;
      if (name.includes("\\")) throw new Error(`Invalid Page path: ${path}`);
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`Page files cannot be symbolic links: ${path}`);
      if (info.isDirectory()) { await mkdir(join(snapshot, path), { recursive: true, mode: 0o700 }); await walk(path); continue; }
      if (!info.isFile()) throw new Error(`Page holds a non-file entry: ${path}`);
      if (++count > PAGE_ARCHIVE_LIMITS.files) throw new Error("Page exceeds 2000 files");
      const key = foldedName(path);
      if (seen.has(key)) throw new Error(`Duplicate Page path after case/Unicode normalization: ${path}`);
      seen.add(key); paths.add(path);
      if (info.size > PAGE_ARCHIVE_LIMITS.expanded - expanded) throw new Error("Page exceeds 32 MiB unpacked");
      const file = await open(join(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
          size += chunk.length;
          if (size > PAGE_ARCHIVE_LIMITS.expanded - expanded) throw new Error("Page exceeds 32 MiB unpacked");
          chunks.push(chunk);
        }
        expanded += size;
        await writeFile(join(snapshot, path), Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
      } finally { await file.close(); }
    }
  };
  try {
    await walk("");
    let manifest: unknown;
    try { const file = await readFile(join(snapshot, ".artifact.json")); if (file.length > 64 * 1024) throw new Error(); manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file)); }
    catch { throw new Error("Page directory requires a valid .artifact.json object"); }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || !("type" in manifest) || typeof manifest.type !== "string" || !types.has(manifest.type)) throw new Error("Page .artifact.json has an unsupported type");
    if (manifest.type === "page" && !paths.has("index.html")) throw new Error("A generic Page requires index.html");
    const archive = join(temporary, "page.zip");
    await writeArchive(snapshot, archive);
    const size = (await lstat(archive)).size;
    if (size > PAGE_ARCHIVE_LIMITS.compressed) throw new Error("Page archive exceeds 16 MiB compressed");
    const bytes = await readFile(archive);
    const checked = checkZip(bytes, { noun: "Page archive", maxFiles: PAGE_ARCHIVE_LIMITS.files, maxBytes: PAGE_ARCHIVE_LIMITS.expanded, maxFileBytes: PAGE_ARCHIVE_LIMITS.expanded });
    for (const entry of checked.files) await unpackZipFile(bytes, entry);
    return { bytes: new Uint8Array(bytes), type: manifest.type, files: count, expandedBytes: expanded };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

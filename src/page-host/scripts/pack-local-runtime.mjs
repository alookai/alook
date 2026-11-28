import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = resolve(here, ".cache/upstream");
const serverDir = resolve(upstream, "dist/server");
const typesDir = resolve(upstream, "artifact-types");
const distDir = resolve(here, "dist");
const pin = JSON.parse(readFileSync(resolve(here, "upstream.json"), "utf8"));

export const ARTIFACT_TYPES = [
  "data",
  "design",
  "design-system",
  "docs",
  "motion",
  "page",
  "sheets",
  "slides",
  "whiteboard",
];

function writeOctal(buf, offset, length, value) {
  const str = value.toString(8).padStart(length - 1, "0");
  buf.write(str, offset, length - 1, "ascii");
  buf[offset + length - 1] = 0;
}

function splitTarPath(entryPath) {
  const bytes = Buffer.from(entryPath, "utf8");
  if (bytes.length <= 100) return { prefix: "", name: entryPath };
  let splitAt = entryPath.indexOf("/");
  while (splitAt !== -1) {
    const prefix = entryPath.slice(0, splitAt);
    const name = entryPath.slice(splitAt + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { prefix, name };
    }
    splitAt = entryPath.indexOf("/", splitAt + 1);
  }
  throw new Error(`Tar entry path exceeds POSIX ustar limits: ${entryPath}`);
}

function buildTarHeader(entryPath, size, mode, isDir) {
  const header = Buffer.alloc(512, 0);
  const { prefix, name } = splitTarPath(entryPath);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime = epoch 0 for reproducible builds
  header.fill(0x20, 148, 156); // checksum placeholder
  header[156] = isDir ? 0x35 : 0x30; // '5' dir, '0' file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");

  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  const checkStr = checksum.toString(8).padStart(6, "0");
  header.write(checkStr, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

/**
 * Create a bit-for-bit reproducible POSIX ustar .tar.gz archive across macOS/Linux/CI:
 * lexicographically sorted entries, normalized permissions, zero uid/gid/mtime,
 * and zeroed gzip header MTIME/OS fields.
 */
export function createDeterministicTarGz(stageDir, roots) {
  const chunks = [];
  const appendEntry = (relPath, fullPath) => {
    const info = lstatSync(fullPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing symlink in Page runtime archive: ${relPath}`);
    }
    if (info.isDirectory()) {
      const dirName = relPath.endsWith("/") ? relPath : `${relPath}/`;
      chunks.push(buildTarHeader(dirName, 0, 0o755, true));
      const names = readdirSync(fullPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of names) {
        appendEntry(`${relPath}/${name}`, join(fullPath, name));
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error(`Refusing non-file entry in Page runtime archive: ${relPath}`);
    }
    const content = readFileSync(fullPath);
    const mode = (info.mode & 0o111) !== 0 ? 0o755 : 0o644;
    chunks.push(buildTarHeader(relPath, content.length, mode, false));
    chunks.push(content);
    const rem = content.length % 512;
    if (rem !== 0) chunks.push(Buffer.alloc(512 - rem, 0));
  };

  for (const root of [...roots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    appendEntry(root, join(stageDir, root));
  }
  chunks.push(Buffer.alloc(1024, 0)); // two 512-byte EOF blocks

  const gzipped = gzipSync(Buffer.concat(chunks), { level: 9 });
  // Zero gzip header MTIME (bytes 4..7) and set OS byte (9) to 0xff (unknown) for OS-independent hashes.
  gzipped[4] = 0;
  gzipped[5] = 0;
  gzipped[6] = 0;
  gzipped[7] = 0;
  gzipped[9] = 0xff;
  return gzipped;
}

export function computeRuntimeCacheKey() {
  const recipe = createHash("sha256")
    .update(readFileSync(resolve(here, "scripts/build.mjs")))
    .update(readFileSync(resolve(here, "scripts/editor-assets.mjs")))
    .update(readFileSync(resolve(here, "scripts/pack-local-runtime.mjs")))
    .digest("hex");
  return `${pin.version}-${String(pin.revision).slice(0, 12)}-${recipe.slice(0, 12)}`;
}

export function packLocalRuntime() {
  if (!existsSync(join(serverDir, "cli.mjs")) || !existsSync(join(serverDir, "editors/_shared/assets"))) {
    throw new Error("Slimmed upstream runtime not built yet. Run `pnpm --filter @alook/page-host build` first.");
  }

  const cacheKey = computeRuntimeCacheKey();
  const stageDir = resolve(distDir, "local-runtime");
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(join(stageDir, "runtime"), { recursive: true });
  mkdirSync(join(stageDir, "guides"), { recursive: true });

  cpSync(serverDir, join(stageDir, "runtime"), { recursive: true });

  const guideSummary = {};
  for (const type of ARTIFACT_TYPES) {
    const srcTypeDir = join(typesDir, type);
    const skillPath = join(srcTypeDir, "SKILL.md");
    if (!existsSync(skillPath)) throw new Error(`Missing upstream SKILL.md for type: ${type}`);
    const dstTypeDir = join(stageDir, "guides", type);
    mkdirSync(dstTypeDir, { recursive: true });
    cpSync(skillPath, join(dstTypeDir, "SKILL.md"));
    const refDirs = [join(srcTypeDir, "reference"), join(srcTypeDir, "artifact-type", "reference")];
    const refs = [];
    for (const refDir of refDirs) {
      if (!existsSync(refDir)) continue;
      const dstRefDir = join(dstTypeDir, "reference");
      mkdirSync(dstRefDir, { recursive: true });
      for (const name of readdirSync(refDir).filter(f => f.endsWith(".md")).sort()) {
        cpSync(join(refDir, name), join(dstRefDir, name));
        if (!refs.includes(name)) refs.push(name);
      }
    }
    refs.sort();
    guideSummary[type] = refs;
  }

  const manifest = {
    cacheKey,
    version: pin.version,
    upstreamRevision: pin.revision,
    types: ARTIFACT_TYPES,
    guides: guideSummary,
  };
  writeFileSync(join(stageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const tarballName = `alook-page-runtime-${cacheKey}.tar.gz`;
  const tarballPath = resolve(distDir, tarballName);
  rmSync(tarballPath, { force: true });
  const gzipped = createDeterministicTarGz(stageDir, ["manifest.json", "runtime", "guides"]);
  writeFileSync(tarballPath, gzipped);

  const sha256 = createHash("sha256").update(gzipped).digest("hex");
  const bytes = statSync(tarballPath).size;
  writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${tarballName}\n`, "utf8");

  return { cacheKey, stageDir, tarballPath, tarballName, sha256, bytes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = packLocalRuntime();
  console.log(JSON.stringify(result, null, 2));
}

import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PAGE_ARTIFACT_TYPES = [
  "data",
  "design",
  "design-system",
  "docs",
  "motion",
  "page",
  "sheets",
  "slides",
  "whiteboard",
] as const;

export type PageArtifactType = (typeof PAGE_ARTIFACT_TYPES)[number];

const ARTIFACT_TYPE_SET = new Set<string>(PAGE_ARTIFACT_TYPES);

/**
 * Pinned local Open Artifact runtime release.
 * Cache key binds BOTH upstream version/commit AND Alook's overlay build recipe hash
 * so overlay changes never silently reuse an older local cache.
 */
export const PAGE_RUNTIME_PIN = {
  cacheKey: "0.16.3-a325e46c37f9-b8a6621d4f5a",
  sha256: "e6809b5258747a31c0eb2d3a48e258ffbc066870386244e66f61de6b3394e1fd",
  urlForKey: (cacheKey: string) =>
    `https://github.com/alookai/alook/releases/download/page-runtime-${cacheKey}/alook-page-runtime-${cacheKey}.tar.gz`,
} as const;

const MAX_RUNTIME_ARCHIVE_BYTES = 64 * 1024 * 1024;
const LOCK_STALE_MS = 120_000;
const LOCK_WAIT_TIMEOUT_MS = 60_000;

export interface ResolvedPageRuntime {
  cacheKey: string;
  rootDir: string;
  cliPath: string;
  guidesDir: string;
  source: "env" | "cache" | "downloaded";
}

export interface EnsurePageRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  cacheKey?: string;
  downloadUrl?: string;
  sha256?: string;
}

function canonicalDir(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

function runtimeCacheRoot(env: NodeJS.ProcessEnv): string {
  const alookHome = env.ALOOK_HOME?.trim() || join(homedir(), ".alook");
  return join(alookHome, "page-runtime");
}

function isValidRuntimeDir(dir: string): boolean {
  return existsSync(join(dir, "runtime", "cli.mjs")) && existsSync(join(dir, "guides"));
}

function readReadyMarker(dir: string): { cacheKey?: string; sha256?: string } | null {
  try {
    const raw = readFileSync(join(dir, ".ready.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { cacheKey?: string; sha256?: string }) : null;
  } catch {
    return null;
  }
}

function assertDownloadUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Refusing insecure Page runtime download URL: ${rawUrl}`);
  }
  return url;
}

async function acquireInstallLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      return async () => { await rm(lockPath, { force: true }).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const info = await stat(lockPath).catch(() => null);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockPath, { force: true }).catch(() => {});
        continue;
      }
      await new Promise(done => setTimeout(done, 150));
    }
  }
  throw new Error(`Timed out waiting for Page runtime install lock: ${lockPath}`);
}

async function validateArchiveEntries(tarballPath: string): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tzf", tarballPath], { maxBuffer: 8 * 1024 * 1024 });
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) throw new Error("Page runtime archive is empty");
  for (const rawEntry of lines) {
    const entry = rawEntry.replace(/^\.\//, "");
    if (!entry) continue;
    if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:/.test(entry)) {
      throw new Error(`Unsafe absolute path in Page runtime archive: ${rawEntry}`);
    }
    const parts = entry.split(/[\\/]/);
    if (parts.some(part => part === "..")) {
      throw new Error(`Unsafe traversal path in Page runtime archive: ${rawEntry}`);
    }
  }
  const { stdout: verbose } = await execFileAsync("tar", ["-tvzf", tarballPath], { maxBuffer: 16 * 1024 * 1024 });
  for (const line of verbose.split(/\r?\n/).filter(Boolean)) {
    const mode = line[0];
    if (mode === "l" || mode === "h") {
      throw new Error(`Unsafe link entry in Page runtime archive: ${line}`);
    }
  }
}

async function downloadAndVerifyTarball(
  url: string,
  expectedSha256: string,
  destPath: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  assertDownloadUrl(url);
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new Error("Page runtime download requires a pinned 64-hex SHA-256 checksum (or set ALOOK_PAGE_RUNTIME_DIR for a local build)");
  }
  const response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Failed to download Page runtime (${response.status}): ${url}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RUNTIME_ARCHIVE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new Error(`Page runtime archive exceeds the ${MAX_RUNTIME_ARCHIVE_BYTES} byte limit`);
  }
  const hash = createHash("sha256");
  const writer = createWriteStream(destPath, { mode: 0o600 });
  let total = 0;
  let streamError: Error | null = null;
  const onWriterError = (err: Error) => { streamError = err; };
  writer.on("error", onWriterError);
  const reader = response.body.getReader();
  try {
    while (true) {
      if (streamError) throw streamError;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RUNTIME_ARCHIVE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error(`Page runtime archive exceeds the ${MAX_RUNTIME_ARCHIVE_BYTES} byte limit`);
      }
      hash.update(value);
      if (!writer.write(value)) {
        await new Promise<void>((res, rej) => {
          if (streamError) { rej(streamError); return; }
          const onDrain = () => { writer.off("error", onErr); res(); };
          const onErr = (err: Error) => { writer.off("drain", onDrain); rej(err); };
          writer.once("drain", onDrain);
          writer.once("error", onErr);
        });
      }
    }
    await new Promise<void>((res, rej) => {
      if (streamError) { rej(streamError); return; }
      writer.end((err?: Error | null) => (err ? rej(err) : res()));
    });
  } catch (error) {
    writer.destroy();
    throw error;
  } finally {
    writer.off("error", onWriterError);
  }
  const actual = hash.digest("hex");
  if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(`Page runtime SHA-256 mismatch: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}

export async function ensurePageRuntime(options: EnsurePageRuntimeOptions = {}): Promise<ResolvedPageRuntime> {
  const env = options.env ?? process.env;
  const overrideDir = env.ALOOK_PAGE_RUNTIME_DIR?.trim();
  if (overrideDir) {
    const resolved = canonicalDir(overrideDir);
    if (!isValidRuntimeDir(resolved)) {
      throw new Error(`ALOOK_PAGE_RUNTIME_DIR is incomplete (expected runtime/cli.mjs and guides/): ${resolved}`);
    }
    return {
      cacheKey: options.cacheKey ?? PAGE_RUNTIME_PIN.cacheKey,
      rootDir: resolved,
      cliPath: join(resolved, "runtime", "cli.mjs"),
      guidesDir: join(resolved, "guides"),
      source: "env",
    };
  }

  const cacheKey = options.cacheKey ?? env.ALOOK_PAGE_RUNTIME_KEY?.trim() ?? PAGE_RUNTIME_PIN.cacheKey;
  const expectedSha = options.sha256 ?? env.ALOOK_PAGE_RUNTIME_SHA256?.trim() ?? PAGE_RUNTIME_PIN.sha256;
  const downloadUrl = options.downloadUrl ?? env.ALOOK_PAGE_RUNTIME_URL?.trim() ?? PAGE_RUNTIME_PIN.urlForKey(cacheKey);
  const cacheRoot = runtimeCacheRoot(env);
  const targetDir = join(cacheRoot, cacheKey);

  const cachedReady = () => {
    const marker = readReadyMarker(targetDir);
    return Boolean(
      marker
      && marker.cacheKey === cacheKey
      && (!expectedSha || marker.sha256?.toLowerCase() === expectedSha.toLowerCase())
      && isValidRuntimeDir(targetDir),
    );
  };

  if (cachedReady()) {
    const realTarget = canonicalDir(targetDir);
    return {
      cacheKey,
      rootDir: realTarget,
      cliPath: join(realTarget, "runtime", "cli.mjs"),
      guidesDir: join(realTarget, "guides"),
      source: "cache",
    };
  }

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const releaseLock = await acquireInstallLock(join(cacheRoot, `.install-${cacheKey}.lock`));
  const tempRoot = join(tmpdir(), `alook-page-runtime-${randomBytes(6).toString("hex")}`);
  const tarballPath = join(tempRoot, "runtime.tar.gz");
  const stagingDir = join(cacheRoot, `.staging-${cacheKey}-${randomBytes(4).toString("hex")}`);

  try {
    if (cachedReady()) {
      const realTarget = canonicalDir(targetDir);
      return {
        cacheKey,
        rootDir: realTarget,
        cliPath: join(realTarget, "runtime", "cli.mjs"),
        guidesDir: join(realTarget, "guides"),
        source: "cache",
      };
    }

    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    const actualSha = await downloadAndVerifyTarball(downloadUrl, expectedSha, tarballPath, options.fetchImpl ?? fetch);
    await validateArchiveEntries(tarballPath);
    await execFileAsync("tar", ["-xzf", tarballPath, "-C", stagingDir], { maxBuffer: 4 * 1024 * 1024 });

    if (!isValidRuntimeDir(stagingDir)) {
      throw new Error("Extracted Page runtime archive is missing runtime/cli.mjs or guides/");
    }

    await writeFile(
      join(stagingDir, ".ready.json"),
      JSON.stringify({ cacheKey, sha256: actualSha, installedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);

    const realTarget = canonicalDir(targetDir);
    return {
      cacheKey,
      rootDir: realTarget,
      cliPath: join(realTarget, "runtime", "cli.mjs"),
      guidesDir: join(realTarget, "guides"),
      source: "downloaded",
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    await releaseLock();
  }
}

const ALOOK_GUIDE_HEADER = [
  "> **Alook CLI mapping**: Run `alook page local <cmd>` wherever this guide writes `open-artifact <cmd>` or `node .../scripts/cli.mjs <cmd>` (piped stdin like `- <<'EOF'` works directly).",
  "> Inspect locally with `alook page preview --dir <root>` (interactive URL) or `alook page preview --dir <root> --out preview.png` (16:10 screenshot), then upload with `alook page upload --dir <root>`.",
  "",
].join("\n");

export async function readPageGuide(runtime: ResolvedPageRuntime, type?: string, ref?: string) {
  if (!type) {
    return {
      cacheKey: runtime.cacheKey,
      guidesDir: runtime.guidesDir,
      cliMapping: "Run `alook page local <cmd>` wherever upstream guides reference `open-artifact <cmd>` or `scripts/cli.mjs`.",
      types: [...PAGE_ARTIFACT_TYPES],
    };
  }
  if (!ARTIFACT_TYPE_SET.has(type)) {
    throw new Error(`Unknown Page artifact type: ${type}. Supported types: ${PAGE_ARTIFACT_TYPES.join(", ")}`);
  }
  const typeDir = join(runtime.guidesDir, type);
  const refDir = join(typeDir, "reference");
  const references = existsSync(refDir) && statSync(refDir).isDirectory()
    ? readdirSync(refDir).filter(name => name.endsWith(".md")).sort()
    : [];

  if (ref) {
    if (!/^[A-Za-z0-9._-]+\.md$/.test(ref)) {
      throw new Error(`Invalid Page guide reference filename: ${ref}`);
    }
    const refPath = join(refDir, ref);
    if (!existsSync(refPath)) {
      throw new Error(`Reference '${ref}' not found for type '${type}'. Available: ${references.join(", ") || "(none)"}`);
    }
    const content = await readFile(refPath, "utf8");
    return { type, ref, path: refPath, content: `${ALOOK_GUIDE_HEADER}\n${content}` };
  }

  const skillPath = join(typeDir, "SKILL.md");
  if (!existsSync(skillPath)) {
    throw new Error(`Missing SKILL.md for type '${type}' in ${typeDir}`);
  }
  const content = await readFile(skillPath, "utf8");
  const extraNote = type === "page"
    ? "> **Alook `page` note**: Include root `.artifact.json` (`{\"type\":\"page\",\"title\":\"...\"}`) beside `index.html` for `alook page upload`, and read reference files via `alook page guide --type page --ref <file>`.\n\n"
    : "";
  return { type, path: skillPath, references, content: `${ALOOK_GUIDE_HEADER}${extraNote}\n${content}` };
}

export interface LocalCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PageLocalStdinStream extends AsyncIterable<string | Uint8Array> {
  pipe?: (dest: NodeJS.WritableStream) => unknown;
  unpipe?: (dest?: NodeJS.WritableStream) => unknown;
  pause?: () => unknown;
}

export async function runPageLocalCli(
  runtime: ResolvedPageRuntime,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; stdin?: string | Buffer; stdinStream?: PageLocalStdinStream } = {},
): Promise<LocalCliResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  if (!childEnv.OPEN_ARTIFACT_TYPE_SERVER_HOME?.trim()) {
    const stateDir = join(runtimeCacheRoot(childEnv), ".server-state", runtime.cacheKey);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    childEnv.OPEN_ARTIFACT_TYPE_SERVER_HOME = stateDir;
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [runtime.cliPath, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cleanupStdin = () => {
      if (options.stdinStream && child.stdin) {
        try { options.stdinStream.unpipe?.(child.stdin); } catch { /* ignore */ }
        try { options.stdinStream.pause?.(); } catch { /* ignore */ }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
    child.stdin?.on("error", () => { /* ignore EPIPE if child exits before reading all stdin */ });
    child.once("error", (err) => { clearTimeout(timer); cleanupStdin(); rejectPromise(err); });
    child.once("close", (code) => {
      clearTimeout(timer);
      cleanupStdin();
      if (timedOut) {
        rejectPromise(new Error(`Local Page CLI timed out after ${timeoutMs}ms`));
        return;
      }
      resolvePromise({ exitCode: code ?? 1, stdout, stderr });
    });
    if (options.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else if (options.stdinStream && child.stdin) {
      if (typeof options.stdinStream.pipe === "function") {
        options.stdinStream.pipe(child.stdin);
      } else {
        const dest = child.stdin;
        const src = options.stdinStream;
        void (async () => {
          try {
            for await (const chunk of src) {
              if (dest.destroyed) break;
              dest.write(chunk);
            }
          } finally {
            if (!dest.destroyed) dest.end();
          }
        })().catch(() => {});
      }
    } else {
      child.stdin?.end();
    }
  });
}

export async function listInstalledRuntimeKeys(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const root = runtimeCacheRoot(env);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && !e.name.startsWith(".")).map(e => e.name).sort();
  } catch {
    return [];
  }
}

export function ensureRuntimeDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function cleanRuntimeDirSync(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

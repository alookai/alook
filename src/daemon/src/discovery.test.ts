import { describe, it, expect, beforeAll, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  resolveAlookCliPath,
  deriveCliFallbackCandidates,
  resolveAlookCliPathWithFallback,
  detectRuntimes,
  getAvailableRuntimes,
} from "./discovery";

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "discovery-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("resolveAlookCliPath", () => {
  it("finds the dev shim from the real src directory (never the raw .ts entry)", () => {
    // The real discovery.ts lives in src/, so this always exercises the dev
    // branch. It must resolve to the shim, never the raw cli/index.ts.
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const result = resolveAlookCliPath(thisDir);
    expect(result).not.toBeNull();
    expect(fs.existsSync(result!)).toBe(true);
    expect(result!.endsWith("alook-shim.mjs")).toBe(true);
  });

  it("dev shape (moduleDir named `src`): resolves to the sibling scripts/alook-shim.mjs", () => {
    const root = mkTmp();
    const srcDir = path.join(root, "src");
    const scriptsDir = path.join(root, "scripts");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    const shim = path.join(scriptsDir, "alook-shim.mjs");
    fs.writeFileSync(shim, "#!/usr/bin/env node\n", { mode: 0o755 });

    const result = resolveAlookCliPath(srcDir);
    expect(result).toBe(shim);
    // Must be a real, executable-looking entrypoint — not a raw .ts file
    // that would throw ERR_MODULE_NOT_FOUND when exec'd directly.
    expect(result!.endsWith(".ts")).toBe(false);
    expect(fs.readFileSync(result!, "utf8")).toMatch(/^#!/);
  });

  it("dev shape: does NOT fall back to a prebuilt dist/cli/index.js even if one exists", () => {
    // A stale dist/ sitting next to src/ must never be picked while running
    // unbuilt — that would silently serve old CLI behavior after source
    // edits. Only the always-fresh dev shim is a valid target in this shape.
    const root = mkTmp();
    const srcDir = path.join(root, "src");
    const distCliDir = path.join(root, "dist", "cli");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distCliDir, { recursive: true });
    fs.writeFileSync(path.join(distCliDir, "index.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
    // No scripts/alook-shim.mjs created — the dev target genuinely doesn't exist.

    const result = resolveAlookCliPath(srcDir);
    expect(result).toBeNull();
  });

  it("production shape (moduleDir named `dist`): resolves to the sibling cli/index.js", () => {
    const root = mkTmp();
    const distDir = path.join(root, "dist");
    const cliDir = path.join(distDir, "cli");
    fs.mkdirSync(cliDir, { recursive: true });
    const entry = path.join(cliDir, "index.js");
    fs.writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o755 });

    const result = resolveAlookCliPath(distDir);
    expect(result).toBe(entry);
  });

  it("production shape: returns null (not a different guess) when cli/index.js is missing", () => {
    const root = mkTmp();
    const distDir = path.join(root, "dist");
    fs.mkdirSync(distDir, { recursive: true });

    const result = resolveAlookCliPath(distDir);
    expect(result).toBeNull();
  });

  it("returns null for a nonexistent directory", () => {
    const result = resolveAlookCliPath("/tmp/nonexistent-xyz-12345");
    expect(result).toBeNull();
  });
});

describe("deriveCliFallbackCandidates", () => {
  it("returns empty for non-node_modules paths", () => {
    expect(deriveCliFallbackCandidates("/usr/local/bin/alook")).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(deriveCliFallbackCandidates("")).toEqual([]);
  });

  it("derives @alook/daemon candidate from a node_modules path", () => {
    const primary = "/home/user/project/node_modules/@other/pkg/dist/cli/index.js";
    const candidates = deriveCliFallbackCandidates(primary);
    expect(candidates.length).toBe(1);
    expect(candidates[0]).toContain("@alook");
    expect(candidates[0]).toContain("daemon");
    expect(candidates[0]).toContain(path.join("dist", "cli", "index.js"));
  });

  it("excludes the input path from candidates", () => {
    const primary = "/home/user/node_modules/@alook/daemon/dist/cli/index.js";
    const candidates = deriveCliFallbackCandidates(primary);
    expect(candidates).not.toContain(primary);
  });
});

describe("resolveAlookCliPathWithFallback", () => {
  it("returns existing path as-is", () => {
    // Use this test file as a path we know exists
    const thisFile = fileURLToPath(import.meta.url);
    const result = resolveAlookCliPathWithFallback(thisFile);
    expect(result).toBe(thisFile);
  });

  it("returns null resolved path when primary is missing and no fallbacks", () => {
    const result = resolveAlookCliPathWithFallback("/tmp/definitely-does-not-exist-xyz.js");
    // Should return the original (no fallback found either)
    expect(result).toBe("/tmp/definitely-does-not-exist-xyz.js");
  });
});

// `detectRuntimes()` probes every registered runtime by resolving its binary
// on PATH (a spawned subprocess per runtime — `which` on POSIX, `where` on
// Windows). Even a fast per-spawn cost adds up across ~9 runtimes probed
// sequentially, so share ONE probe across all assertions in this describe
// block (via `beforeAll`) instead of re-running it per `it()`.
describe("detectRuntimes", () => {
  let runtimes: Awaited<ReturnType<typeof detectRuntimes>>;

  beforeAll(async () => {
    runtimes = await detectRuntimes();
  }, 30_000);

  it("returns an array of runtime info objects", () => {
    expect(Array.isArray(runtimes)).toBe(true);
    expect(runtimes.length).toBeGreaterThan(0);
    for (const r of runtimes) {
      expect(r).toHaveProperty("id");
      expect(r).toHaveProperty("status");
      // status is always set — either "healthy" or "unhealthy".
      expect(r.status === "healthy" || r.status === "unhealthy").toBe(true);
    }
  });

  it("includes claude in the list", () => {
    const claude = runtimes.find((r) => r.id === "claude");
    expect(claude).toBeDefined();
  });

  it("carries lastError + lastErrorAt on unhealthy entries so /community can surface the reason", () => {
    for (const r of runtimes) {
      if (r.status === "unhealthy") {
        expect(typeof r.lastError).toBe("string");
        expect(typeof r.lastErrorAt).toBe("string");
        // ISO-8601 sanity.
        expect(() => new Date(r.lastErrorAt!).toISOString()).not.toThrow();
      }
    }
  });
});

describe("getAvailableRuntimes", () => {
  it(
    "returns only available runtime IDs",
    async () => {
      const available = await getAvailableRuntimes();
      expect(Array.isArray(available)).toBe(true);
      // At minimum, claude should be available on this dev machine
      // (but don't hard-fail CI if it's not installed)
    },
    30_000,
  );
});

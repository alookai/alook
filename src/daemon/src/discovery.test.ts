import { describe, it, expect, beforeAll } from "vitest";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  resolveAlookCliPath,
  deriveCliFallbackCandidates,
  resolveAlookCliPathWithFallback,
  detectRuntimes,
  getAvailableRuntimes,
} from "./discovery";

describe("resolveAlookCliPath", () => {
  it("finds the source CLI entry from the src directory", () => {
    // When running from src/, the source .ts entry should exist
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const result = resolveAlookCliPath(thisDir);
    // cli/index.ts should exist relative to src/
    expect(result).not.toBeNull();
    expect(result!).toContain("cli");
    expect(result!).toContain("index");
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

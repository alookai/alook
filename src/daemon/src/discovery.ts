
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getDriver, listRuntimeIds, type RuntimeId } from "./drivers/index.js";
import type { RuntimeReasoningCatalog } from "@alook/agent-driver";

/**
 * Locate the Alook agent CLI entry point.
 *
 * This path gets symlinked (POSIX) or `.cmd`-wrapped (Windows) straight into
 * every spawned agent's PATH as `alook` (see `cliLink.ts`) — on POSIX the OS
 * execs it directly, so it MUST be a self-executable entrypoint. The raw TS
 * source (`cli/index.ts`) does NOT qualify: even with a shebang, executing it
 * without `tsx` leaves Node's ESM resolver looking for literal `./*.js`
 * sibling files that only exist once built, throwing `ERR_MODULE_NOT_FOUND`.
 *
 * Deliberately NOT a multi-candidate existence probe — this module always
 * compiles `src/discovery.ts` → `dist/discovery.js` (see tsconfig
 * `rootDir`/`outDir`), so `thisDir` unambiguously tells us which of the two
 * real deployment shapes we're in; there is exactly one correct answer per
 * shape, not a list of guesses to try:
 *   - running from `dist/` (built/published): the CLI entry is the sibling
 *     `dist/cli/index.js` — if it's missing, that's a real packaging bug.
 *   - running from `src/` (dev, via `tsx`): the CLI entry is the dev shim
 *     `scripts/alook-shim.mjs`, which execs the TS source through `tsx` so
 *     relative `.js` import specifiers resolve to their `.ts` siblings.
 *     (Deliberately never falls back to a possibly-stale prebuilt `dist/` —
 *     that would silently serve old CLI behavior after source edits.)
 *
 * Returns null if the one expected entry doesn't exist (caller should log a
 * warning) — never silently substitutes a different candidate.
 */
export function resolveAlookCliPath(moduleDir?: string): string | null {
  const thisDir = moduleDir ?? path.dirname(fileURLToPath(import.meta.url));

  const target =
    path.basename(thisDir) === "dist"
      ? path.resolve(thisDir, "cli", "index.js")
      : path.resolve(thisDir, "..", "scripts", "alook-shim.mjs");

  return fs.existsSync(target) ? target : null;
}

export function deriveCliFallbackCandidates(cliPath: string): string[] {
  if (!cliPath) return [];
  const normalized = cliPath.split(path.sep).join("/");
  const marker = "/node_modules/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return [];

  const globalRoot = cliPath.slice(0, idx + marker.length - 1);
  const tail = path.join("dist", "cli", "index.js");
  return [
    path.join(globalRoot, "@alook", "daemon", tail),
  ].filter((candidate) => candidate !== cliPath);
}

export function resolveAlookCliPathWithFallback(primary?: string | null): string | null {
  const resolved = primary ?? resolveAlookCliPath();
  if (resolved && fs.existsSync(resolved)) return resolved;

  if (resolved) {
    const fallbacks = deriveCliFallbackCandidates(resolved);
    for (const fallback of fallbacks) {
      if (fs.existsSync(fallback)) return fallback;
    }
  }

  return resolved;
}

export interface RuntimeInfo {
  id: RuntimeId;
  status: "healthy" | "unhealthy";
  version?: string;
  /** Short reason code when unhealthy — e.g. "version_probe_failed", "ENOENT". */
  lastError?: string;
  /** ISO-8601 timestamp of the last transition to unhealthy. */
  lastErrorAt?: string;
  reasoning?: RuntimeReasoningCatalog;
}

export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  const ids = listRuntimeIds();
  const results: RuntimeInfo[] = [];
  const nowIso = new Date().toISOString();

  for (const id of ids) {
    try {
      const driver = getDriver(id);
      const probe = await driver.probe();
      if (probe.status === "healthy") {
        results.push({
          id,
          status: "healthy",
          version: probe.version,
          reasoning: probe.reasoning,
        });
      } else {
        results.push({
          id,
          status: "unhealthy",
          lastError: probe.error.code ?? "probe_failed",
          lastErrorAt: nowIso,
        });
      }
    } catch (err) {
      results.push({
        id,
        status: "unhealthy",
        lastError: (err as { code?: string } | undefined)?.code ?? "probe_threw",
        lastErrorAt: nowIso,
      });
    }
  }

  return results;
}

export async function getAvailableRuntimes(): Promise<RuntimeId[]> {
  const all = await detectRuntimes();
  return all.filter((r) => r.status === "healthy").map((r) => r.id);
}

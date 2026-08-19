/**
 * Runtime & CLI discovery — auto-detect available runtimes and the agent CLI path.
 *
 * `detectRuntimes()` probes every registered driver and reports which are available.
 * `resolveAlookCliPath()` locates the agent CLI entry the daemon injects into spawned agents.
 */
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { getDriver, listRuntimeIds, type RuntimeId } from "./drivers/index.js";
import type { ProbeResult } from "./types.js";

/* ------------------------------------------------------------------ */
/* Agent CLI path resolution                                           */
/* ------------------------------------------------------------------ */

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

/**
 * Derive fallback candidates when the primary CLI path is missing
 * (e.g. package tree mutated while the daemon is running).
 *
 * Looks for other known package locations in the same node_modules tree.
 */
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

/**
 * Resolve agent CLI path with fallback self-healing.
 * If the primary path doesn't exist, try fallback candidates.
 */
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

/* ------------------------------------------------------------------ */
/* Runtime detection                                                    */
/* ------------------------------------------------------------------ */

export interface RuntimeInfo {
  id: RuntimeId;
  status: "healthy" | "unhealthy";
  version?: string;
  /** Short reason code when unhealthy — e.g. "version_probe_failed", "ENOENT". */
  lastError?: string;
  /** ISO-8601 timestamp of the last transition to unhealthy. */
  lastErrorAt?: string;
}

/**
 * Probe all registered drivers and return which runtimes are available.
 * capabilities to the server. Runtime health after startup is mutated live
 * by `AgentRouter.markRuntimeUnhealthy` / `markRuntimeHealthy` — see
 * plans/community-machine-presence-fix.md.
 */
export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  const ids = listRuntimeIds();
  const results: RuntimeInfo[] = [];
  const nowIso = new Date().toISOString();

  for (const id of ids) {
    try {
      const driver = getDriver(id);
      const probe: ProbeResult = await driver.probe();
      const healthy = probe.status === "healthy";
      results.push({
        id,
        status: healthy ? "healthy" : "unhealthy",
        version: probe.version,
        lastError: healthy ? undefined : probe.lastError ?? "probe_failed",
        lastErrorAt: healthy ? undefined : nowIso,
      });
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

/**
 * Return just the runtime IDs that are currently available on this machine.
 */
export async function getAvailableRuntimes(): Promise<RuntimeId[]> {
  const all = await detectRuntimes();
  return all.filter((r) => r.status === "healthy").map((r) => r.id);
}

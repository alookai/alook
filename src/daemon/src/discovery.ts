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
 * Search order (first existing wins):
 *   1. Bundled: `<daemon-pkg>/dist/cli/index.js`
 *   2. Workspace sibling: `<monorepo>/src/daemon/dist/cli/index.js` (pnpm workspace)
 *   3. Source (dev): `<monorepo>/src/daemon/src/cli/index.ts` (for tsx usage)
 *
 * Returns null if no candidate exists (caller should log a warning).
 */
export function resolveAlookCliPath(moduleDir?: string): string | null {
  const thisDir = moduleDir ?? path.dirname(fileURLToPath(import.meta.url));

  const candidates = [
    // 1. Bundled dist CLI (production: daemon built + CLI entry in same dist)
    path.resolve(thisDir, "cli", "index.js"),
    // 2. Dist from package root (built but running from src via tsx)
    path.resolve(thisDir, "..", "dist", "cli", "index.js"),
    // 3. Source entry (dev: running unbuilt via tsx)
    path.resolve(thisDir, "cli", "index.ts"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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
 * Mirrors raft's `detectRuntimes()` — called ONCE at daemon startup to report
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

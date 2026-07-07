/**
 * CLI/model probing helpers — detect whether a runtime's binary is installed
 * and read its version. Used by each driver's `probe()`.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ProbeResult } from "../types.js";

export interface ProbeDeps {
  homeDir?: string;
  which?: (cmd: string) => string | null;
}

/** Resolve a command to an absolute path on PATH (cross-platform). */
export function resolveCommandOnPath(command: string, deps: ProbeDeps = {}): string | null {
  if (deps.which) return deps.which(command);
  try {
    if (process.platform === "win32") {
      // `where` is a native cmd.exe builtin (PATHEXT-aware, resolves .cmd/.bat
      // shims just like `Get-Command`) that returns in milliseconds. Spawning
      // `powershell -Command` here instead cost 1-3s of interpreter cold-start
      // PER call — with ~9 runtimes probed sequentially at daemon startup /
      // in `detectRuntimes()` tests, that added up to 30s+ wall time.
      const out = execFileSync("where", [command], { encoding: "utf8", timeout: 5000 });
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      return first?.trim() || null;
    }
    const out = execFileSync("which", [command], { encoding: "utf8", timeout: 5000 });
    return out.trim() || null;
  } catch {
    return null;
  }
}

export function firstExistingPath(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

export type VersionProbeResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

/**
 * Actually spawn `<command> --version` and read stdout. Returns `ok: true`
 * only when the child exits 0 AND emits a non-empty first line. A spawn
 * error (ENOENT — vendored binary missing) or a non-zero exit produces
 * `ok: false` with the error code, which callers surface as `status:
 * "unhealthy"` on the driver's `probe()` result.
 *
 * This is deliberately stricter than "does the command resolve on PATH":
 * npm packages sometimes ship a JS wrapper whose `which` succeeds but whose
 * vendored native binary is broken. Requiring `--version` to actually run
 * catches that class of failure at startup instead of at first spawn.
 */
export function probeCommandVersion(
  command: string,
  args: string[] = [],
  deps: ProbeDeps = {}
): VersionProbeResult {
  void deps;
  try {
    const out = execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 5000 });
    const line = out.split("\n")[0]?.trim();
    if (!line) return { ok: false, error: "empty_version_output" };
    return { ok: true, version: line };
  } catch (err) {
    const code =
      (err as NodeJS.ErrnoException | undefined)?.code ??
      (err as { code?: string } | undefined)?.code ??
      "version_probe_failed";
    return { ok: false, error: String(code) };
  }
}

/**
 * @deprecated Use `probeCommandVersion` instead — it returns explicit
 * success/failure so callers can distinguish "binary not runnable" from
 * "binary runs but has no version output" and report `status: "unhealthy"`.
 * Retained as a thin shim for a couple of legacy call sites during rollout.
 */
export function readCommandVersion(command: string, args: string[] = [], deps: ProbeDeps = {}): string | null {
  const r = probeCommandVersion(command, args, deps);
  return r.ok ? r.version : null;
}

export function resolveHomePath(relativePath: string, deps: ProbeDeps = {}): string {
  return path.join(deps.homeDir || process.env.HOME || ".", relativePath);
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Run through a shell — needed on Windows for `.cmd`/`.bat` shims. */
  shell: boolean;
}

/**
 * Resolve a runtime command into a spawn spec, cross-platform.
 *
 * On Windows, npm-installed CLIs are usually `.cmd` shims that Node can only
 * spawn through a shell; we resolve the real path (PowerShell `Get-Command`,
 * which returns the `.cmd`) and set `shell: true` when it looks like a shim.
 * On POSIX, we resolve via `which` and never need a shell.
 */
export function resolveSpawnSpec(
  command: string,
  args: string[],
  deps: ProbeDeps = {},
  platform: NodeJS.Platform = process.platform,
): SpawnSpec {
  const resolved = resolveCommandOnPath(command, deps) ?? command;
  const shell = platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
  return { command: resolved, args, shell };
}

/** Detect the Claude Code CLI, including macOS app-bundle fallbacks. */
export function resolveClaudeCommand(deps: ProbeDeps = {}): string | null {
  const onPath = resolveCommandOnPath("claude", deps);
  if (onPath) return onPath;
  if (process.platform === "darwin") {
    return firstExistingPath([
      resolveHomePath("Applications/Claude Code URL Handler.app/Contents/MacOS/claude", deps),
      "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude",
    ]);
  }
  return null;
}

export function probeClaude(deps: ProbeDeps = {}): ProbeResult {
  const command = resolveClaudeCommand(deps);
  if (!command) return { status: "unhealthy", lastError: "not_on_path" };
  const r = probeCommandVersion(command, [], deps);
  if (!r.ok) return { status: "unhealthy", lastError: r.error };
  return { status: "healthy", version: r.version };
}

/**
 * Shared probe for CLI-shaped runtimes: resolve on PATH, then spawn `--version`.
 * Every non-Pi driver's `probe()` is a call to this. Kept as a small helper
 * rather than living inline so a future change to probe semantics is one edit,
 * not eight.
 */
export function probeCliRuntime(binary: string, deps: ProbeDeps = {}): ProbeResult {
  const command = resolveCommandOnPath(binary, deps);
  if (!command) return { status: "unhealthy", lastError: "not_on_path" };
  const r = probeCommandVersion(command, [], deps);
  if (!r.ok) return { status: "unhealthy", lastError: r.error };
  return { status: "healthy", version: r.version };
}

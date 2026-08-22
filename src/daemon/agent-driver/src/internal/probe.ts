/**
 * CLI/model probing helpers — detect whether a runtime's binary is installed
 * and read its version. Used by each driver's `probe()`.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ProbeResult } from "./adapter.js";

/**
 * Wall-clock cap for every `--version`/`where`/`which` probe. Kept short: a
 * healthy CLI answers in tens of milliseconds, and each unresponsive driver
 * blocks daemon startup this long — with ~9 runtimes probed sequentially,
 * every second here is a second of user-visible wait.
 */
const PROBE_TIMEOUT_MS = 5000;

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
      const out = execFileSync("where", [command], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
      const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
      return first?.trim() || null;
    }
    const out = execFileSync("which", [command], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function firstExistingPath(candidates: string[]): string | null {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

type VersionProbeResult =
  | { ok: true; version: string }
  | { ok: false; error: string };

/**
 * A `--version` line must look like a version to be accepted: it has to contain
 * a digit-dotted token (e.g. `1.2.3`, `v0.4`, `2024.1`). This is the
 * load-bearing defense against a CLI whose `--version` doesn't print a version
 * but instead an interactive prompt or error. A shim can resolve on PATH, exit
 * 0, and print an installation prompt with no version token; it is rejected
 * here rather than surfacing as a bogus "version" on the Runtimes
 * page. The non-interactive spawn options below can't catch it (the shim exits
 * 0 even with stdin closed), so this regex is what draws the line.
 */
function looksLikeVersion(line: string): boolean {
  return /\d+\.\d+/.test(line);
}

/** True when `command` needs a shell to exec on this platform — Windows
 * can't run a `.cmd`/`.bat` shim (which is what most npm global installs
 * resolve to) directly via `CreateProcess`. Shared by `resolveSpawnSpec`
 * (actual agent spawn) and `probeCommandVersion` (health-check spawn) so the
 * two never disagree about whether a given resolved path is runnable. */
function needsWindowsShimShell(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

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
 *
 * Runs through a shell on Windows when `command` is a `.cmd`/`.bat` shim —
 * same detection `resolveSpawnSpec` uses for the real agent spawn. Without
 * this, a runtime whose actual `spawn()` succeeds (because it already
 * routes through `resolveSpawnSpec`) would still probe as `unhealthy` here,
 * hiding an available runtime from the UI.
 */
export function probeCommandVersion(
  command: string,
  args: string[] = [],
  deps: ProbeDeps = {},
  platform: NodeJS.Platform = process.platform,
): VersionProbeResult {
  void deps;
  try {
    const shell = needsWindowsShimShell(command, platform);
    // Run non-interactively: feed empty stdin (`input: ""`) so a CLI that would
    // otherwise block on a prompt can't hang, and set `CI` in the child env
    // (options object only — never mutate `process.env`, per the statelessness
    // rule) so version-aware CLIs skip interactive paths. stdout stays piped
    // (execFileSync returns it) — that's what we parse. A misbehaving shim that
    // ignores all of this and prints a prompt anyway is caught by the
    // `looksLikeVersion` validation below.
    const out = execFileSync(command, [...args, "--version"], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      shell,
      input: "",
      env: { ...process.env, CI: "1" },
    });
    const line = out.split("\n")[0]?.trim();
    if (!line) return { ok: false, error: "empty_version_output" };
    if (!looksLikeVersion(line)) return { ok: false, error: "invalid_version_output" };
    return { ok: true, version: line };
  } catch (err) {
    const code =
      (err as NodeJS.ErrnoException | undefined)?.code ??
      (err as { code?: string } | undefined)?.code ??
      "version_probe_failed";
    return { ok: false, error: String(code) };
  }
}

function resolveHomePath(relativePath: string, deps: ProbeDeps = {}): string {
  return path.join(deps.homeDir || process.env.HOME || ".", relativePath);
}

interface SpawnSpec {
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
 *
 * When `override` is a non-empty string, it takes precedence over the default
 * `command` — that's how `runtimeConfig.command` is honoured uniformly across
 * every driver. If the override looks like an absolute path (or contains a
 * separator) we don't re-resolve via PATH — the caller pointed us at a
 * specific binary and we respect that; otherwise it's still a bare name that
 * needs PATH resolution.
 */
export function resolveSpawnSpec(
  command: string,
  args: string[],
  override?: string,
  deps: ProbeDeps = {},
  platform: NodeJS.Platform = process.platform,
): SpawnSpec {
  const trimmed = override?.trim();
  const target = trimmed && trimmed.length > 0 ? trimmed : command;
  const looksLikePath = trimmed !== undefined && trimmed.length > 0 && /[\\/]/.test(trimmed);
  const resolved = looksLikePath ? target : (resolveCommandOnPath(target, deps) ?? target);
  return { command: resolved, args, shell: needsWindowsShimShell(resolved, platform) };
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
export function probeCliRuntime(binary: string, deps: ProbeDeps = {}, override?: string): ProbeResult {
  const explicit = override?.trim();
  const command = explicit || resolveCommandOnPath(binary, deps);
  if (!command) return { status: "unhealthy", lastError: "not_on_path" };
  const r = probeCommandVersion(command, [], deps);
  if (!r.ok) return { status: "unhealthy", lastError: r.error };
  return { status: "healthy", version: r.version };
}

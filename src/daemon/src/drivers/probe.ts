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
      const out = execFileSync("powershell", ["-Command", `(Get-Command ${command}).Source`], {
        encoding: "utf8",
        timeout: 5000,
      });
      return out.trim() || null;
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

export function readCommandVersion(command: string, args: string[] = [], deps: ProbeDeps = {}): string | null {
  void deps;
  try {
    const out = execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 5000 });
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
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
  if (!command) return { available: false };
  const version = readCommandVersion(command, [], deps);
  return version ? { available: true, version } : { available: true };
}

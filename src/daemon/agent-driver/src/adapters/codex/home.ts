/**
 * Codex home / state-directory resolution.
 *
 * Codex stores its config, auth, and session rollouts under a "home" directory.
 * Resolution order:
 *   1. `CODEX_HOME` env var (resolved relative to cwd if not absolute), else
 *   2. `<homeDir>/.codex`.
 *
 * The state and session roots may live either directly under that root or under
 * a nested `.codex/` — callers probe both candidates.
 */
import * as os from "os";
import * as path from "path";

function readConfiguredCodexHome(env: NodeJS.ProcessEnv): string | null {
  const raw = env.CODEX_HOME;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
}

export function resolveCodexHomeRootFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { cwd?: string; defaultHomeDir?: string } = {},
): string {
  const raw = readConfiguredCodexHome(env);
  if (raw) return path.resolve(opts.cwd ?? process.cwd(), raw);
  return path.join(opts.defaultHomeDir ?? os.homedir(), ".codex");
}

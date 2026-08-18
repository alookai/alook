/**
 * Hermes Agent launch spec.
 *
 * Builds the `hermes chat ...` argument vector from a LaunchContext. Hermes
 * supports a first-class `--provider` flag (unlike Claude/Codex whose provider
 * is carried via env), so we surface the resolved provider + model directly.
 *
 * Reference invocation produced for a turn:
 *   hermes chat -q "<prompt>" -Q --pass-session-id \
 *     --provider <provider> --model <model> \
 *     [--resume <sessionId>] [--max-turns N] [--yolo|-c]
 *
 * - `-Q`            quiet mode: suppress banner/spinner; print only the final
 *                   response + a `session_id:` footer (what the normalizer reads).
 * - `--pass-session-id`  include the session id in the system prompt / footer so
 *                   resume_or_fresh can recover it across turns.
 * - `--resume`      resume a previous Hermes session by id (turn continuity).
 * - `--max-turns`   cap tool-calling iterations (defaults to daemon default).
 * - `--yolo`        bypass approval prompts so the agent can run unattended.
 *                   Mirrors OpenCode's `--dangerously-skip-permissions`; see the
 *                   PR notes for the autonomy/safety tradeoff.
 */
import type { LaunchContext } from "../types.js";
import type { ResolvedLaunchFields } from "../runtimeConfig.js";
import * as fs from "fs";

export interface HermesLaunchSpec {
  command: string;
  args: string[];
}

/** Default model when the RuntimeConfig carries no explicit model. */
export const HERMES_DEFAULT_MODEL = "auto";

/**
 * Resolve the hermes binary. Prefer the host-supplied `agentCliPath` (so a
 * deployment can pin a specific hermes), else fall back to `hermes` on PATH.
 */
export function resolveHermesLaunchCommand(agentCliPath?: string): string {
  if (agentCliPath && fs.existsSync(agentCliPath)) return agentCliPath;
  return "hermes";
}

/**
 * Build the launch args. `spawnEnv` is mutated in place to add hermes-specific
 * env (e.g. a quiet/non-interactive hint) — callers may ignore the returned env.
 */
export function buildHermesArgs(
  command: string,
  ctx: LaunchContext,
  f: ResolvedLaunchFields,
  spawnEnv: NodeJS.ProcessEnv,
): HermesLaunchSpec {
  // Force non-interactive operation regardless of TTY (daemons never have one).
  spawnEnv.HERMES_QUIET = "1";
  spawnEnv.HERMES_INTERACTIVE = "0";

  const args = ["chat", "-q", ctx.prompt, "-Q", "--pass-session-id"];

  // Provider: prefer an explicit RuntimeConfig provider; fall back to env so a
  // host can set ALOOK_HERMES_PROVIDER without editing every agent config.
  const provider =
    (ctx.config.runtimeConfig as { provider?: { kind: string; providerId?: string } } | undefined)
      ?.provider?.providerId ??
    (process.env.ALOOK_HERMES_PROVIDER || undefined);
  if (provider) args.push("--provider", provider);

  // Model: prefer resolved model id, else the config default, else HERMES_DEFAULT.
  const model = f.model ?? HERMES_DEFAULT_MODEL;
  if (model && model !== "auto") args.push("--model", model);

  if (ctx.config.sessionId) args.push("--resume", ctx.config.sessionId);

  // Cap tool iterations so an unattended agent can't loop forever.
  const maxTurns = process.env.ALOOK_HERMES_MAX_TURNS
    ? Number(process.env.ALOOK_HERMES_MAX_TURNS)
    : undefined;
  if (Number.isFinite(maxTurns)) args.push("--max-turns", String(maxTurns));

  // Autonomy: run unattended. Toggled off via ALOOK_HERMES_NO_YOLO for hosts
  // that want every shell op approved by a human gateway.
  if (process.env.ALOOK_HERMES_NO_YOLO !== "1") {
    args.push("--yolo");
  }

  // The prompt is positional (`-q <prompt>`). On Windows, spawn-with-shell does
  // NOT re-quote args containing spaces (cmd.exe `%*` splits them), so a prompt
  // like "Fix the bug" would arrive as two tokens — the same gap the
  // src/cli OpenCode backend closes with quoteWinArgs. Quote it here for the
  // daemon's spawnAgentProcess path too. POSIX shells quote automatically.
  if (process.platform === "win32" && ctx.prompt.includes(" ")) {
    args[args.indexOf(ctx.prompt)] = `"${ctx.prompt}"`;
  }

  return { command, args };
}

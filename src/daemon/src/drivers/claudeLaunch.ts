/**
 * Claude Code launch configuration — args, command resolution, and spawn spec.
 *
 * Claude is run in full stream-json mode (`--input-format stream-json
 * --output-format stream-json --include-partial-messages`). That is precisely
 * what makes same-turn steering possible: stdin is a long-lived NDJSON channel
 * onto which new user messages can be appended at safe boundaries.
 */
import type { LaunchConfig } from "../types.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { resolveClaudeCommand } from "./probe.js";

/** Default Claude model when the launch config doesn't specify one. */
export const DEFAULT_CLAUDE_MODEL = "sonnet";

/** Tools the host disables by default — runtime-native scheduling/plan tools that
 *  would bypass the host's reminder/task model. Overridable via
 *  `launchRuntimeFields.disallowedTools`. */
export const CLAUDE_DISALLOWED_TOOLS = "EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete";

export function buildClaudeArgs(config: LaunchConfig): string[] {
  const f = resolveLaunchFieldsOrDefault(config.runtimeConfig);
  const args = [
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--model",
    f.model || DEFAULT_CLAUDE_MODEL,
    "--disallowed-tools",
    f.disallowedTools || CLAUDE_DISALLOWED_TOOLS,
  ];
  if (f.reasoningEffort) args.push("--effort", f.reasoningEffort);
  if (f.fastMode) args.push("--settings", '{"fastMode":true}');
  if (config.sessionId) args.push("--resume", config.sessionId);
  return args;
}

export function resolveClaudeLaunchCommand(config: LaunchConfig): string {
  const override = resolveLaunchFieldsOrDefault(config.runtimeConfig).command?.trim();
  return override || resolveClaudeCommand() || "claude";
}

export interface ClaudeSpawnSpec {
  command: string;
  shell: boolean;
}

export function buildClaudeSpawnSpec(
  claudeCommand: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeSpawnSpec {
  const command = claudeCommand ?? "claude";
  const shell = platform === "win32" && (!command || /\.(cmd|bat)$/i.test(command));
  return { command, shell };
}


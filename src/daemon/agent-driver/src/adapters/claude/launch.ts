/**
 * Claude Code launch configuration — args, command resolution, and spawn spec.
 *
 * Claude is run in full stream-json mode (`--input-format stream-json
 * --output-format stream-json --include-partial-messages`). That is precisely
 * what makes same-turn steering possible: stdin is a long-lived NDJSON channel
 * onto which new user messages can be appended at safe boundaries.
 */
import type { AdapterLaunchConfig } from "../../internal/adapter.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";

/** Tools the host disables by default — runtime-native scheduling/plan tools that
 *  would bypass the host's reminder/task model. Overridable via
 *  `launchRuntimeFields.disallowedTools`. */
const CLAUDE_DISALLOWED_TOOLS = "EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete";

export function buildClaudeArgs(config: AdapterLaunchConfig): string[] {
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
    "--disallowed-tools",
    f.disallowedTools || CLAUDE_DISALLOWED_TOOLS,
  ];
  if (f.model) args.push("--model", f.model);
  if (f.reasoningEffort) args.push("--effort", f.reasoningEffort);
  if (f.fastMode) args.push("--settings", '{"fastMode":true}');
  if (config.sessionId) args.push("--resume", config.sessionId);
  return args;
}

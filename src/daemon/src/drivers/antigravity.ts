/**
 * Antigravity driver — per-turn, PLAIN-TEXT output, no steering.
 *
 * The odd one out: `agy --print --print-timeout <t> --dangerously-skip-permissions`
 * emits plain text, not JSON. The normalizer treats every non-empty line as a
 * `text` event unless it matches an error pattern. Models are suggestion-only
 * (not passed at launch). The prompt is written to stdin then closed.
 */
import { randomUUID } from "crypto";
import { spawnAgentDriverProcess } from "@alook/agent-driver";
import type { ChildProcess } from "child_process";
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";

const ERROR_LINE_PATTERNS: RegExp[] = [/^error[:\s]/i, /\bfatal\b/i, /\bpanic\b/i, /unable to/i];

function scheduleStdinWriteAndEnd(proc: ChildProcess, payload: string): void {
  queueMicrotask(() => {
    proc.stdin?.write(payload);
    proc.stdin?.end();
  });
}

/**
 * Wall-clock cap for a single Antigravity print run — chosen high because the
 * `agy` binary uses per-turn spawn and its own long-form reasoning routinely
 * runs many minutes on heavy inputs; 30m is the ceiling we're comfortable
 * letting a single turn hold before we assume it's wedged.
 */
const ANTIGRAVITY_PRINT_TIMEOUT = "30m";

export function buildAntigravityArgs(ctx: LaunchContext): string[] {
  const args = ["--print", "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT, "--dangerously-skip-permissions"];
  // `agy` has no by-id resume — the only resume flag is `--continue`, which
  // follows the most recent session in cwd. We compensate by stashing
  // `ctx.config.sessionId` in `this.sessionId` so the daemon still records the
  // logical id, but the CLI itself will re-attach to whatever ran last.
  // Reflected in `capabilities.sessionResumeMode = "most-recent"`.
  if (ctx.config.sessionId) args.push("--continue");
  return args;
}

export class AntigravityDriver implements Driver {
  readonly id = "antigravity";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "suggestion_only",
    toLaunchSpec: (_modelId: string) => ({ args: [] }),
  } as const;


  readonly capabilities = {
    reasoningEffort: false,
    fastMode: false,
    disallowedTools: false,
    command: true,
    sessionResumeMode: "most-recent",
  } as const;

  private sessionId: string | null = null;
  private sentInit = false;

  probe() {
    return probeCliRuntime("agy");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? randomUUID();
    this.sentInit = false;
    const { spawnEnv } = await prepareCliTransport(ctx, {
      // Antigravity is sensitive to inherited SSH context — clear it.
      SSH_CLIENT: "",
      SSH_CONNECTION: "",
      SSH_TTY: "",
    });
    // Cross-platform spawn: on Windows the agy entry is often a `.cmd`
    // shim, which `child_process.spawn` can't exec without a shell.
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = resolveSpawnSpec("agy", buildAntigravityArgs(ctx), override);
    const proc = spawnAgentDriverProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });
    scheduleStdinWriteAndEnd(proc, ctx.prompt);
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const out: ParsedEvent[] = [];
    if (!this.sentInit) {
      this.sentInit = true;
      out.push({ kind: "session_init", sessionId: this.sessionId! });
    }
    if (ERROR_LINE_PATTERNS.some((re) => re.test(trimmed))) out.push({ kind: "error", message: trimmed });
    else out.push({ kind: "text", text: line });
    return out;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config);
  }
}

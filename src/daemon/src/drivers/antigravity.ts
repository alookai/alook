/**
 * Antigravity driver — per-turn, PLAIN-TEXT output, no steering.
 *
 * The odd one out: `agy --print --print-timeout <t> --dangerously-skip-permissions`
 * emits plain text, not JSON. The normalizer treats every non-empty line as a
 * `text` event unless it matches an error pattern. Models are suggestion-only
 * (not passed at launch). The prompt is written to stdin then closed.
 */
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { resolveCommandOnPath, probeCliRuntime } from "./probe.js";

const ERROR_LINE_PATTERNS: RegExp[] = [/^error[:\s]/i, /\bfatal\b/i, /\bpanic\b/i, /unable to/i];

/** Wall-clock cap for a single Antigravity print run. */
const ANTIGRAVITY_PRINT_TIMEOUT = "30m";

export function buildAntigravityArgs(ctx: LaunchContext): string[] {
  const args = ["--print", "--print-timeout", ANTIGRAVITY_PRINT_TIMEOUT, "--dangerously-skip-permissions"];
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

  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;
  private sentInit = false;

  probe() {
    return probeCliRuntime("agy");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? randomUUID();
    this.sentInit = false;
    const { spawnEnv } = await prepareCliTransport(ctx, {
      NO_COLOR: "1",
      // Antigravity is sensitive to inherited SSH context — clear it.
      SSH_CLIENT: "",
      SSH_CONNECTION: "",
      SSH_TTY: "",
    });
    const command = resolveCommandOnPath("agy") ?? "agy";
    const proc = spawn(command, buildAntigravityArgs(ctx), {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
    proc.stdin?.end(ctx.prompt);
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
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
      postStartupNotes: [
        "**Antigravity runtime note:** The host launches you as a per-turn process. Complete the current wake using `alook` commands, then stop; the host will restart you when new messages arrive.",
      ],
      includeStdinNotificationSection: false,
      messageNotificationStyle: "poll",
    });
  }
}

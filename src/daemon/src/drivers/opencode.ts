/**
 * OpenCode driver — per-turn, JSON output, deferred-spawn + terminate-on-end.
 *
 * Distinctive lifecycle: it DEFERS spawning until a concrete message arrives
 * (bookkeeping-only wakes don't launch a process) and explicitly TERMINATES the
 * process when the turn ends (rather than relying on natural exit). The
 * standing prompt is injected via `OPENCODE_CONFIG_CONTENT` (a `host` agent
 * definition), and the user message is the trailing `-- <prompt>` positional.
 */
import { spawn } from "child_process";
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { resolveCommandOnPath, probeCliRuntime } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";

export class OpenCodeDriver implements Driver {
  readonly id = "opencode";
  readonly lifecycle = {
    kind: "per_turn",
    start: "defer_until_concrete_message",
    exit: "terminate_on_turn_end",
    inFlightWake: "coalesce_into_pending",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;

  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;
  readonly terminateProcessOnTurnEnd = true;
  readonly deferSpawnUntilMessage = true;

  private sessionId: string | null = null;

  /** System task wakes (first-message bookkeeping) should not spawn a process. */
  shouldDeferWakeMessage(message: { type?: string }): boolean {
    return message?.type === "system";
  }

  probe() {
    return probeCliRuntime("opencode");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? null;
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const { spawnEnv } = await prepareCliTransport(ctx, {
      NO_COLOR: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: { host: { prompt: ctx.standingPrompt } } }),
    });

    const args = ["run", "--format", "json", "--dangerously-skip-permissions", "--pure", "--dir", ctx.workingDirectory];
    if (f.model) args.push("--model", f.model);
    args.push("--agent", "host");
    if (ctx.config.sessionId) args.push("--session", ctx.config.sessionId);
    const promptArg = ctx.prompt === ctx.standingPrompt ? "No new messages are pending. Stop now." : ctx.prompt;
    args.push("--", promptArg);

    const command = resolveCommandOnPath("opencode") ?? "opencode";
    const proc = spawn(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
    proc.stdin?.end();
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const out: ParsedEvent[] = [];
    if (event?.sessionID && this.sessionId !== event.sessionID) {
      this.sessionId = event.sessionID;
      out.push({ kind: "session_init", sessionId: this.sessionId! });
    }
    switch (event?.type) {
      case "step_start":
        out.push({ kind: "thinking", text: "" });
        break;
      case "text":
        if (typeof event.part?.text === "string" && event.part.text.length > 0)
          out.push({ kind: "text", text: event.part.text });
        break;
      case "tool_use":
        out.push({ kind: "tool_call", name: event.part?.tool ?? "unknown_tool", input: event.part?.state?.input });
        break;
      case "step_finish":
        if (event.reason !== "tool-calls") out.push({ kind: "turn_end", sessionId: this.sessionId ?? undefined });
        break;
      case "error":
        out.push({
          kind: "error",
          message: event.error?.data?.message ?? event.error?.message ?? "OpenCode error",
        });
        out.push({ kind: "turn_end", sessionId: this.sessionId ?? undefined });
        break;
    }
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
        "**OpenCode runtime note:** The host launches you as a per-turn process. Complete the current wake using `alook` commands, then stop; the host will restart you when new messages arrive.",
      ],
      includeStdinNotificationSection: false,
      messageNotificationStyle: "poll",
    });
  }
}

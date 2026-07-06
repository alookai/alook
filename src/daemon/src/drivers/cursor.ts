/**
 * Cursor driver — per-turn, stream-json, no steering.
 *
 * `cursor-agent --print --output-format stream-json --yolo --approve-mcps
 * --trust <prompt>` is launched per wake. Emits Anthropic-style stream-json
 * (system/assistant/result envelopes) and exits.
 */
import { spawn } from "child_process";
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { resolveCommandOnPath, probeCliRuntime } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";

export class CursorDriver implements Driver {
  readonly id = "cursor";
  readonly lifecycle = {
    kind: "per_turn",
    start: "immediate",
    exit: "natural",
    inFlightWake: "spawn_new",
  } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;

  readonly supportsStdinNotification = false;
  readonly busyDeliveryMode = "none" as const;

  private sessionId: string | null = null;

  probe() {
    return probeCliRuntime("cursor-agent");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? null;
    const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const args = ["--print", "--output-format", "stream-json", "--yolo", "--approve-mcps", "--trust"];
    if (f.model) args.push("--model", f.model);
    if (ctx.config.sessionId) args.push("--resume", ctx.config.sessionId);
    args.push(ctx.prompt);

    const command = resolveCommandOnPath("cursor-agent") ?? "cursor-agent";
    const proc = spawn(command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (event?.type === "system") {
      if (event.subtype === "init") {
        this.sessionId = event.session_id ?? this.sessionId;
        return this.sessionId ? [{ kind: "session_init", sessionId: this.sessionId }] : [];
      }
      if (event.subtype === "status" && event.status === "compacting") return [{ kind: "compaction_started" }];
      if (event.subtype === "compact_boundary") return [{ kind: "compaction_finished" }];
      return [];
    }
    if (event?.type === "assistant") {
      const content = event.message?.content ?? [];
      const out: ParsedEvent[] = [];
      for (const block of content) {
        if (block?.type === "thinking") out.push({ kind: "thinking", text: block.thinking ?? "" });
        else if (block?.type === "text") out.push({ kind: "text", text: block.text ?? "" });
        else if (block?.type === "tool_use")
          out.push({ kind: "tool_call", name: block.name ?? "unknown_tool", input: block.input });
      }
      return out;
    }
    if (event?.type === "result") {
      const out: ParsedEvent[] = [];
      if (event.subtype !== "success" || event.is_error) {
        const detail = (event.errors ?? []).map((e: any) => e?.message).filter(Boolean).join("; ");
        out.push({ kind: "error", message: detail || String(event.result ?? "Cursor error") });
      }
      out.push({ kind: "turn_end", sessionId: event.session_id ?? this.sessionId ?? undefined });
      return out;
    }
    return [];
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
        "**Cursor runtime note:** The host launches you as a per-turn process. Complete the current wake using `alook` commands, then stop; the host will restart you when new messages arrive.",
      ],
      includeStdinNotificationSection: false,
      messageNotificationStyle: "poll",
    });
  }
}

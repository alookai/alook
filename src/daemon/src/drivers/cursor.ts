/**
 * Cursor driver — per-turn, stream-json, no steering.
 *
 * `cursor-agent --print --output-format stream-json --force <prompt>` is
 * launched per wake. Emits Anthropic-style stream-json (system/assistant/result
 * envelopes) and exits.
 *
 * Flag note: the older `--yolo --approve-mcps --trust` trio was removed when the
 * cursor-agent CLI changed — passing them now fails arg-parse ("unknown option
 * '--yolo'"), so the process exits before the handshake (pre_handshake_exit).
 * The auto-approve execution posture is now `--force` ("allow commands unless
 * explicitly denied") on top of `--print` (which already grants full tool
 * access, write+bash). MCP approval moved out of the CLI into config
 * (`.cursor/mcp.json` + `cursor-agent mcp login`), so it has no launch flag.
 */
import type { Driver, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { spawnAgentProcess } from "../runtime/killTree.js";
import { tryParseJsonLine } from "./utils.js";

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


  readonly capabilities = {
    reasoningEffort: false,
    fastMode: false,
    disallowedTools: false,
    command: true,
    sessionResumeMode: "by-id",
  } as const;

  private sessionId: string | null = null;

  probe() {
    return probeCliRuntime("cursor-agent");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? null;
    const { spawnEnv } = await prepareCliTransport(ctx);
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const args = ["--print", "--output-format", "stream-json", "--force"];
    if (f.model) args.push("--model", f.model);
    if (ctx.config.sessionId) args.push("--resume", ctx.config.sessionId);
    args.push(ctx.prompt);

    // Cross-platform spawn: on Windows the cursor-agent entry is often a
    // `.cmd` shim, which `child_process.spawn` can't exec without a shell.
    const spec = resolveSpawnSpec("cursor-agent", args, f.command);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
      // cursor-agent blocks waiting on a piped stdin even with the prompt in a
      // positional arg — it emits nothing and the daemon times out. It never
      // reads stdin (per-turn, encodeStdinMessage returns null), so ignore it.
      stdin: "ignore",
    });
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    const event = tryParseJsonLine(line) as any;
    if (!event) return [];
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
    return buildCliTransportSystemPrompt(config);
  }
}

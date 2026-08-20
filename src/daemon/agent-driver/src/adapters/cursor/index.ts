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
import type {
  BackendAdapter, AdapterLaunchContext, AdapterEvent, RuntimeLane, RuntimeLaneOpenOptions, SpawnedProcess,
} from "../../internal/adapter.js";
import { createProcessLane } from "../../controller/process-host.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { probeCliRuntime, resolveSpawnSpec } from "../../internal/probe.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { tryParseJsonLine } from "../../internal/utils.js";

export class CursorDriver implements BackendAdapter {
  readonly id = "cursor";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "turn",
    transport: { kind: "one_shot_cli", protocol: "cursor.print.stream-json.v1" },
    wakeStart: "immediate",
    terminalOwnership: "lane_generation",
  } as const;

  private sessionId: string | null = null;

  probe(command?: string) {
    return probeCliRuntime("cursor-agent", {}, command);
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return createProcessLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess> {
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
      // reads stdin (per-turn, encodeMessage returns null), so ignore it.
      stdin: "ignore",
    });
    return { process: proc };
  }

  normalizeLine(line: string): AdapterEvent[] {
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
      const out: AdapterEvent[] = [];
      for (const block of content) {
        if (block?.type === "thinking") out.push({ kind: "thinking", text: block.thinking ?? "" });
        else if (block?.type === "text") out.push({ kind: "text", text: block.text ?? "" });
        else if (block?.type === "tool_use")
          out.push({ kind: "tool_call", name: block.name ?? "unknown_tool", input: block.input });
      }
      return out;
    }
    if (event?.type === "result") {
      const out: AdapterEvent[] = [];
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

  encodeMessage(): string | null {
    return null;
  }

}

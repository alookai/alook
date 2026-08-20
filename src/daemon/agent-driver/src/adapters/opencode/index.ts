/**
 * OpenCode driver — per-turn, JSON output, deferred-spawn + terminate-on-end.
 *
 * Distinctive lifecycle: it DEFERS spawning until a concrete message arrives
 * (bookkeeping-only wakes don't launch a process) and explicitly TERMINATES the
 * process when the turn ends (rather than relying on natural exit). The
 * standing prompt reaches OpenCode via the core-materialized `AGENTS.md`
 * (OpenCode auto-reads it from cwd); the user message
 * is the trailing `-- <prompt>` positional.
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

export class OpenCodeDriver implements BackendAdapter {
  readonly id = "opencode";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "turn",
    transport: { kind: "one_shot_cli", protocol: "opencode.run.json.v1" },
    wakeStart: "deferred",
    terminalOwnership: "lane_generation",
  } as const;

  private sessionId: string | null = null;

  /** System task wakes (first-message bookkeeping) should not spawn a process. */
  shouldDeferWakeMessage(message: { type?: string }): boolean {
    return message?.type === "system";
  }

  probe(command?: string) {
    return probeCliRuntime("opencode", {}, command);
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return createProcessLane(this, ctx, {
      onRawStdoutLine: options?.onRawStdoutLine,
      stopAfterTurn: true,
    });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess> {
    this.sessionId = ctx.config.sessionId ?? null;
    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    // Core has already materialized AGENTS.md; OpenCode auto-reads it from cwd.
    const { spawnEnv } = await prepareCliTransport(ctx);

    const args = ["run", "--format", "json", "--dangerously-skip-permissions", "--pure", "--dir", ctx.workingDirectory];
    if (f.model) args.push("--model", f.model);
    if (ctx.config.sessionId) args.push("--session", ctx.config.sessionId);
    const promptArg = ctx.prompt === ctx.standingPrompt ? "No new messages are pending. Stop now." : ctx.prompt;
    args.push("--", promptArg);

    // Cross-platform spawn: on Windows the opencode entry is often a `.cmd`
    // shim, which `child_process.spawn` can't exec without a shell.
    const spec = resolveSpawnSpec("opencode", args, f.command);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });
    proc.stdin?.end();
    return { process: proc };
  }

  normalizeLine(line: string): AdapterEvent[] {
    const event = tryParseJsonLine(line) as any;
    if (!event) return [];
    const out: AdapterEvent[] = [];
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
        // `reason` lives under `part` (e.g. `part: { reason: "stop" | "tool-calls" | ... }`),
        // not at the top level — reading `event.reason` directly is always
        // `undefined`, which made every step (including intermediate
        // tool-call steps) look like the final one.
        if (event.part?.reason !== "tool-calls") out.push({ kind: "turn_end", sessionId: this.sessionId ?? undefined });
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

  encodeMessage(): string | null {
    return null;
  }

}

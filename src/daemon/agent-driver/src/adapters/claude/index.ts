/**
 * Claude Code driver — persistent stream-json process with gated steering.
 *
 * Claude's stdin protocol accepts a stable UUID on every user frame and its
 * terminal `result` reports the root `user_message_uuid`. That provider-owned
 * receipt, rather than payload content or a process restart, binds a terminal
 * to the logical turn that initiated it. Safe-boundary steering frames use
 * fresh UUIDs while Claude keeps the root UUID on the eventual result.
 */
import type {
  BackendAdapter, EncodeMessageOptions, AdapterLaunchContext, AdapterEvent, RuntimeLane,
  RuntimeLaneOpenOptions, SpawnedProcess, ProbeResult,
} from "../../internal/adapter.js";
import { createProcessLane } from "../../controller/process-host.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { buildClaudeProviderIsolationEnv } from "./providerIsolation.js";
import { buildClaudeArgs } from "./launch.js";
import { ClaudeEventNormalizer } from "./normalizer.js";
import { probeClaude, probeCommandVersion, resolveSpawnSpec, resolveClaudeCommand } from "../../internal/probe.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";
import { ClaudeTurnProtocol } from "./turnProtocol.js";

const CLAUDE_MODEL_CATALOG = {
  updateMode: "unsupported" as const,
  models: ["opus", "sonnet", "haiku"].map((id) => ({
    id,
    supportedReasoningEfforts: [],
  })),
};

export class ClaudeDriver implements BackendAdapter {
  readonly id = "claude";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_stream", protocol: "claude.stream-json.v1" },
    wakeStart: "immediate",
    terminalOwnership: "vendor_message",
  } as const;

  private readonly turnProtocol = new ClaudeTurnProtocol();
  private readonly eventNormalizer = new ClaudeEventNormalizer(this.turnProtocol);

  beginTurn(): string {
    return this.turnProtocol.beginTurn();
  }

  probe(command?: string): ProbeResult {
    const explicit = command?.trim();
    const base: ProbeResult = explicit
      ? (() => {
          const result = probeCommandVersion(explicit);
          return result.ok
            ? { status: "healthy", version: result.version }
            : { status: "unhealthy", lastError: result.error };
        })()
      : probeClaude();
    return base.status === "healthy"
      ? { ...base, reasoning: CLAUDE_MODEL_CATALOG }
      : base;
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return createProcessLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess> {
    // The core materializes AGENTS.md (+ CLAUDE.md symlink) before opening the
    // lane; Claude Code auto-reads CLAUDE.md from cwd, so no CLI flag is needed.
    const { spawnEnv } = await prepareCliTransport(ctx, buildClaudeProviderIsolationEnv(ctx));
    const args = buildClaudeArgs(ctx.config);

    // Let Claude detect it is NOT nested in another Claude Code session.
    delete spawnEnv.CLAUDECODE;

    // Claude has an extra bespoke discovery step (macOS `.app` bundle
    // fallback via `resolveClaudeCommand`) that no other driver needs, but
    // the spawn spec itself is the same as everyone else's. `runtimeConfig.command`
    // wins over the discovered path when set (uniform across drivers).
    //
    // The discovery probe stays lazy: `resolveClaudeCommand` shells out to
    // `which`/`where` (up to PROBE_TIMEOUT_MS), so when the user pinned an
    // explicit `command` we must not pay for — or block on — a lookup whose
    // result `resolveSpawnSpec` would immediately discard.
    //
    // Both branches feed the chosen path through `resolveSpawnSpec`'s override
    // slot, whose "already looks like a path → don't re-resolve" rule keeps us
    // from PATH-probing a path `resolveClaudeCommand` just resolved.
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command?.trim();
    const claudeCommand = override || resolveClaudeCommand() || "claude";
    const spec = resolveSpawnSpec("claude", args, claudeCommand);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });

    // Deliver the initial prompt as the first stream-json line.
    const stdinMsg = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: ctx.prompt }] },
      uuid: this.turnProtocol.rootInputUuid(),
      ...(ctx.config.sessionId ? { session_id: ctx.config.sessionId } : {}),
    });
    proc.stdin?.write(stdinMsg + "\n");

    return { process: proc };
  }

  normalizeLine(line: string): AdapterEvent[] {
    return this.eventNormalizer.normalizeLine(line);
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId;
  }

  /** Both idle and busy messages use the same stream-json user-message shape. */
  encodeMessage(text: string, sessionId: string | null, opts?: EncodeMessageOptions): string {
    const uuid = opts?.mode === "idle"
      ? this.turnProtocol.rootInputUuid()
      : this.turnProtocol.steeringInputUuid();
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      uuid,
      ...(opts?.mode === "busy" ? { priority: "now" } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

}

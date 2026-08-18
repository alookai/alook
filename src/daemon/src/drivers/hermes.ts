/**
 * Hermes Agent driver — per_turn, plain-text (quiet mode), resume_or_fresh.
 *
 * Hermes Agent (https://github.com/NousResearch/Hermes-Agent) is spawned as a
 * bare child process per turn, exactly like OpenCode. It does NOT speak a
 * streamed JSON protocol the way Codex/Claude do — its `-Q` (quiet) mode prints
 * the final assistant response plus a session-id footer, which is what this
 * driver normalizes. Hermes auto-reads AGENTS.md from cwd for its standing
 * prompt, so `prepareCliTransport` (shared by every CLI runtime) is reused
 * unchanged.
 *
 * Lifecycle mirrors OpenCode:
 *  - one `hermes chat -q "<prompt>" -Q` process per turn,
 *  - it exits on its own when the turn completes, but we also force-terminate
 *    on turn_end to reclaim the process group promptly,
 *  - bookkeeping-only wakes (system task events) do NOT spawn a process.
 *
 * Provider / model come from the agent's RuntimeConfig. Hermes also has a
 * first-class `--provider` flag, so we pass the resolved provider + model
 * straight through (unlike Claude/Codex whose provider is encoded in env).
 */
import type {
  Driver,
  LaunchConfig,
  LaunchContext,
  ParsedEvent,
  SpawnResult,
} from "../types.js";
import {
  prepareCliTransport,
  buildCliTransportSystemPrompt,
} from "./cliTransport.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { spawnAgentProcess } from "../runtime/killTree.js";
import {
  buildHermesArgs,
  resolveHermesLaunchCommand,
  type HermesLaunchSpec,
} from "./hermesLaunch.js";
import { HermesEventNormalizer } from "./hermesEventNormalizer.js";

export class HermesDriver implements Driver {
  readonly id = "hermes";
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
  private readonly eventNormalizer = new HermesEventNormalizer();

  probe() {
    return probeCliRuntime("hermes");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    this.sessionId = ctx.config.sessionId ?? null;

    // prepareCliTransport writes AGENTS.md (+ CLAUDE.md symlink) into the
    // workdir — Hermes auto-reads AGENTS.md from cwd, no CLI flag needed.
    const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });

    const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const hermesCommand = resolveHermesLaunchCommand(ctx.agentCliPath);
    const spec: HermesLaunchSpec = buildHermesArgs(hermesCommand, ctx, f, spawnEnv);

    // Cross-platform spawn: on Windows the hermes entry is a `.cmd` shim which
    // child_process can't exec without a shell — resolveSpawnSpec handles that
    // identically to OpenCode.
    const resolved = resolveSpawnSpec(spec.command, spec.args);
    const proc = spawnAgentProcess(resolved.command, resolved.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: resolved.shell,
    });
    proc.stdin?.end();
    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.eventNormalizer.normalizeLine(line, this.sessionId);
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId ?? this.sessionId;
  }

  /** Per-turn runtime: no mid-session stdin steering. */
  encodeStdinMessage(): string | null {
    return null;
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config, { lifecycleKind: this.lifecycle.kind });
  }

  /** Bookkeeping-only wakes (system task events) must not spawn a process. */
  shouldDeferWakeMessage(message: { type?: string }): boolean {
    return message?.type === "system";
  }
}

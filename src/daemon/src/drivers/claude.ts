/**
 * Claude Code driver — persistent, stream-json, gated steering.
 *
 * Lifecycle: one long-lived process per session. stdin is a stream-json NDJSON
 * channel; the initial prompt and every subsequent message are written as
 * `{type:"user", message:{role:"user", content:[{type:"text",text}]}}` lines.
 * Because mid-stream injection can collide with signed thinking blocks, busy
 * delivery is `gated` — held until a safe boundary (see runtime/apmStateMachine).
 */
import type { Driver, EncodeOpts, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt, DEFAULT_CLI_CONFIG } from "./cliTransport.js";
import { buildClaudeProviderIsolationEnv } from "./claudeProviderIsolation.js";
import { buildClaudeArgs } from "./claudeLaunch.js";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer.js";
import { probeClaude, resolveSpawnSpec, resolveClaudeCommand } from "./probe.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { spawnAgentProcess } from "../runtime/killTree.js";

export class ClaudeDriver implements Driver {
  readonly id = "claude";
  readonly lifecycle = { kind: "persistent", stdin: "gated", inFlightWake: "queue" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ args: ["--model", modelId] }),
  } as const;

  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "gated" as const;
  readonly supportsNativeStandingPrompt = true;

  readonly capabilities = {
    reasoningEffort: true,
    fastMode: true,
    disallowedTools: true,
    command: true,
    sessionResumeMode: "by-id",
  } as const;

  private readonly eventNormalizer = new ClaudeEventNormalizer();

  probe() {
    return probeClaude();
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    const cliConfig = ctx.agentCliPath
      ? { ...DEFAULT_CLI_CONFIG, hostCliPath: ctx.agentCliPath }
      : undefined;
    // prepareCliTransport writes AGENTS.md (+ CLAUDE.md symlink) into the
    // workdir as part of the shared transport setup — Claude Code auto-reads
    // CLAUDE.md from cwd, no CLI flag needed.
    const { spawnEnv } = await prepareCliTransport(ctx, buildClaudeProviderIsolationEnv(ctx), cliConfig);
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
      ...(ctx.config.sessionId ? { session_id: ctx.config.sessionId } : {}),
    });
    proc.stdin?.write(stdinMsg + "\n");

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.eventNormalizer.normalizeLine(line);
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId;
  }

  /** Both idle and busy messages use the same stream-json user-message shape. */
  encodeStdinMessage(text: string, sessionId: string | null, _opts?: EncodeOpts): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config);
  }
}

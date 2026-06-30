/**
 * Claude Code driver — persistent, stream-json, gated steering.
 *
 * Lifecycle: one long-lived process per session. stdin is a stream-json NDJSON
 * channel; the initial prompt and every subsequent message are written as
 * `{type:"user", message:{role:"user", content:[{type:"text",text}]}}` lines.
 * Because mid-stream injection can collide with signed thinking blocks, busy
 * delivery is `gated` — held until a safe boundary (see runtime/apmStateMachine
 * and runtime/turnState).
 */
import { spawn } from "child_process";
import type { Driver, EncodeOpts, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt, DEFAULT_CLI_CONFIG } from "./cliTransport.js";
import { buildClaudeProviderIsolationEnv } from "./claudeProviderIsolation.js";
import {
  buildClaudeArgs,
  resolveClaudeLaunchCommand,
  buildClaudeSpawnSpec,
} from "./claudeLaunch.js";
import { writeAgentFile } from "./agentFile.js";
import { ClaudeEventNormalizer } from "./claudeEventNormalizer.js";
import { probeClaude } from "./probe.js";

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

  private readonly eventNormalizer = new ClaudeEventNormalizer();

  probe() {
    return probeClaude();
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    const cliConfig = ctx.agentCliPath
      ? { ...DEFAULT_CLI_CONFIG, hostCliPath: ctx.agentCliPath }
      : undefined;
    const { spawnEnv } = await prepareCliTransport(ctx, buildClaudeProviderIsolationEnv(ctx), cliConfig);
    // Write system prompt as AGENTS.md in workdir — Claude Code auto-reads
    // CLAUDE.md (symlinked to AGENTS.md) from cwd, no CLI flag needed.
    writeAgentFile(ctx.workingDirectory, ctx.standingPrompt);
    const args = buildClaudeArgs(ctx.config);

    // Let Claude detect it is NOT nested in another Claude Code session.
    delete spawnEnv.CLAUDECODE;

    const claudeCommand = resolveClaudeLaunchCommand(ctx.config);
    const spawnSpec = buildClaudeSpawnSpec(claudeCommand);
    const proc = spawn(spawnSpec.command, args, {
      cwd: ctx.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
      shell: spawnSpec.shell,
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
    return buildCliTransportSystemPrompt(config, {
      extraCriticalRules: [],
      postStartupNotes: [],
      includeStdinNotificationSection: true,
      messageNotificationStyle: "direct",
    });
  }
}

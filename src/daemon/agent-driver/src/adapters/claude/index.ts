/**
 * Claude Code driver — persistent, stream-json, gated steering.
 *
 * Lifecycle: one long-lived process per session. stdin is a stream-json NDJSON
 * channel; the initial prompt and every subsequent message are written as
 * `{type:"user", message:{role:"user", content:[{type:"text",text}]}}` lines.
 * Because mid-stream injection can collide with signed thinking blocks, busy
 * delivery is `gated` — held until a safe boundary (see runtime/apmStateMachine).
 */
import type { BackendAdapter, EncodeMessageOptions, AdapterLaunchContext, AdapterEvent, SpawnedProcess } from "../../internal/adapter.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { buildClaudeProviderIsolationEnv } from "./providerIsolation.js";
import { buildClaudeArgs } from "./launch.js";
import { ClaudeEventNormalizer } from "./normalizer.js";
import { probeClaude, resolveSpawnSpec, resolveClaudeCommand } from "../../internal/probe.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { spawnAgentProcess } from "../../internal/killTree.js";

export class ClaudeDriver implements BackendAdapter {
  readonly id = "claude";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = { kind: "persistent_process", input: "safe_boundary" } as const;

  private readonly eventNormalizer = new ClaudeEventNormalizer();

  probe() {
    return probeClaude();
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
  encodeMessage(text: string, sessionId: string | null, _opts?: EncodeMessageOptions): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

}

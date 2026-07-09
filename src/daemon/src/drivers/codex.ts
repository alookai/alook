/**
 * Codex driver — persistent, JSON-RPC app-server, GATED steering.
 *
 * Codex runs as `app-server --listen stdio://` and speaks JSON-RPC 2.0. Like
 * Claude, a `turn/steer` sent while a tool call / compaction / review is in
 * flight can race the app-server's own turn-state handling, so busy delivery
 * is `gated` — held until a safe boundary by the manager-level mechanism in
 * `manager/managerPolicy.ts` (see plans/wire-gated-busy-steering-daemon.md). A
 * busy message becomes a `turn/steer` RPC against the active turn, while an
 * idle message becomes a fresh `turn/start` — the encoding itself is
 * unaffected by gating, only WHEN the manager calls it.
 *
 * Handshake (queued on spawn): `initialize` → then `thread/start` (or
 * `thread/resume` with the prior threadId). The thread id is the session id.
 */
import type { Driver, EncodeOpts, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { CodexEventNormalizer } from "./codexEventNormalizer.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveCodexHomeRootFromEnv } from "./codexHome.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { spawnAgentProcess } from "../runtime/killTree.js";

/** True if a resume error means the prior thread rollout is gone. */
export function isCodexMissingRolloutError(message: string): boolean {
  return (
    /\bno\s+rollout\s+found\b/i.test(message) ||
    /\bmissing\s+rollout\b/i.test(message) ||
    /\brollout\b.*\b(not found|missing)\b/i.test(message) ||
    /\bthread\b.*\b(not found|missing)\b/i.test(message) ||
    /\bmissing\s+thread\b/i.test(message)
  );
}

/**
 * Classify a Codex resume failure. A missing rollout is recoverable: fall back
 * to a fresh thread (the host should prepend a recovery notice to the prompt).
 */
export function classifyCodexResumeError(
  message: string,
): { kind: "missing_rollout"; recoveryAction: "fallback_fresh_thread" } | { kind: "other" } {
  return isCodexMissingRolloutError(message)
    ? { kind: "missing_rollout", recoveryAction: "fallback_fresh_thread" }
    : { kind: "other" };
}

export class CodexDriver implements Driver {
  readonly id = "codex";
  readonly lifecycle = { kind: "persistent", stdin: "gated", inFlightWake: "queue" } as const;
  readonly session = { recovery: "resume_or_fresh" } as const;
  readonly model = {
    detectedModelsVerifiedAs: "launchable",
    toLaunchSpec: (modelId: string) => ({ params: { model: modelId } }),
  } as const;

  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "gated" as const;
  readonly supportsNativeStandingPrompt = true;

  private readonly eventNormalizer = new CodexEventNormalizer();
  private requestId = 0;
  /** Resolved Codex home root (CODEX_HOME or ~/.codex); set on spawn. */
  private codexHomeRoot: string | null = null;
  private nextRequestId(): number {
    return ++this.requestId;
  }

  /** Resolved Codex home root (CODEX_HOME or ~/.codex). Null until spawned. */
  get codexHome(): string | null {
    return this.codexHomeRoot;
  }

  probe() {
    // probeCliRuntime spawns `--version` — a missing vendored binary (npm
    // package resolves but the aarch64 blob is absent) fails there even
    // though resolveCommandOnPath returned a JS wrapper. See
    // plans/community-machine-presence-fix.md.
    return probeCliRuntime("codex");
  }

  async spawn(ctx: LaunchContext): Promise<SpawnResult> {
    const { spawnEnv } = await prepareCliTransport(ctx, { NO_COLOR: "1" });
    // Resolve the Codex home so resume can find its session rollout (and so a
    // host could surface "missing rollout" recovery — see classifyCodexResumeError).
    this.codexHomeRoot = resolveCodexHomeRootFromEnv(spawnEnv, { cwd: ctx.workingDirectory });
    // Cross-platform spawn: on Windows the codex entry is often a `.cmd` shim.
    const spec = resolveSpawnSpec("codex", ["app-server", "--listen", "stdio://"]);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });

    // Async handshake: initialize, then thread/start|resume with the prompt.
    queueMicrotask(() => {
      proc.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextRequestId(),
          method: "initialize",
          params: {
            clientInfo: { name: "agent-backend", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          },
        }) + "\n",
      );

      const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
      const resuming = Boolean(ctx.config.sessionId);
      // The standing prompt reaches Codex via the AGENTS.md that
      // prepareCliTransport writes into the workdir (unified packing) —
      // Codex auto-reads it from cwd, no developerInstructions param needed.
      const params: Record<string, unknown> = {
        cwd: ctx.workingDirectory,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandbox_mode: "danger-full-access",
        experimentalRawEvents: true,
      };
      if (resuming) params.threadId = ctx.config.sessionId;
      if (f.model) params.model = f.model;
      if (f.reasoningEffort) params.config = { model_reasoning_effort: f.reasoningEffort };
      if (f.fastMode) params.serviceTier = "fast";

      proc.stdin?.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextRequestId(),
          method: resuming ? "thread/resume" : "thread/start",
          params,
        }) + "\n",
      );
    });

    return { process: proc };
  }

  parseLine(line: string): ParsedEvent[] {
    return this.eventNormalizer.normalizeLine(line);
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId;
  }

  /** busy → `turn/steer` against the active turn; idle → fresh `turn/start`. */
  encodeStdinMessage(text: string, sessionId: string | null, opts?: EncodeOpts): string | null {
    const threadId = sessionId ?? this.eventNormalizer.currentSessionId;
    if (!threadId) return null;
    const input = [{ type: "text", text }];
    if (opts?.mode === "idle") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextRequestId(),
        method: "turn/start",
        params: { threadId, input },
      });
    }
    return JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextRequestId(),
      method: "turn/steer",
      params: { threadId, input },
    });
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config, { lifecycleKind: this.lifecycle.kind });
  }
}

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
import { serializeAgentDriverJsonRpcRequest, spawnAgentDriverProcess } from "@alook/agent-driver";
import type { Driver, EncodeOpts, LaunchConfig, LaunchContext, ParsedEvent, SpawnResult } from "../types.js";
import { prepareCliTransport, buildCliTransportSystemPrompt } from "./cliTransport.js";
import { CodexEventNormalizer } from "./codexEventNormalizer.js";
import { probeCliRuntime, resolveSpawnSpec } from "./probe.js";
import { resolveCodexHomeRootFromEnv } from "./codexHome.js";
import { resolveLaunchFieldsOrDefault } from "../runtimeConfig.js";
import { getDaemonClientInfo } from "../version.js";

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

  readonly supportsNativeStandingPrompt = true;

  readonly capabilities = {
    reasoningEffort: true,
    fastMode: true,
    disallowedTools: false,
    command: true,
    sessionResumeMode: "by-id",
  } as const;

  private readonly eventNormalizer = new CodexEventNormalizer();
  private requestId = 0;
  /** Resolved Codex home root (CODEX_HOME or ~/.codex); set on spawn. */
  private codexHomeRoot: string | null = null;
  /**
   * The spawned process, retained so the initial-prompt `turn/start` can be
   * written once the thread id is adopted (see `parseLine`). Null until spawn.
   */
  private proc: SpawnResult["process"] | null = null;
  /**
   * The initial user message drained into `ctx.prompt` at spawn, held until the
   * first `session_init` (thread adopted) lets us submit it as a `turn/start`.
   * Codex can't deliver it in the spawn handshake like Claude does: `turn/start`
   * needs a threadId, which only arrives in the `thread/start`|`thread/resume`
   * RESPONSE. Cleared after the one-time submit (submit-once latch). Null when
   * there is no prompt (a bare wake) — we don't start an empty turn.
   */
  private pendingInitialPrompt: string | null = null;
  /**
   * When spawn issued a `thread/resume`, the `thread/start` params to fall back
   * to if that resume fails with "no rollout found" (the prior thread's rollout
   * is gone). Null once we're not resuming, or once the fallback has fired. This
   * powers the missing-rollout recovery in `parseLine`: re-issue a FRESH
   * `thread/start` (no threadId) on the same live process, keeping
   * `pendingInitialPrompt` so the fresh thread's `session_init` still delivers it.
   */
  private pendingResumeFallbackParams: Record<string, unknown> | null = null;
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
    const { spawnEnv } = await prepareCliTransport(ctx);
    // Resolve the Codex home so resume can find its session rollout (and so a
    // host could surface "missing rollout" recovery — see classifyCodexResumeError).
    this.codexHomeRoot = resolveCodexHomeRootFromEnv(spawnEnv, { cwd: ctx.workingDirectory });
    // Cross-platform spawn: on Windows the codex entry is often a `.cmd` shim.
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = resolveSpawnSpec("codex", ["app-server", "--listen", "stdio://"], override);
    const proc = spawnAgentDriverProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });
    this.proc = proc;
    // Hold the initial user message until the thread id is adopted; `parseLine`
    // submits it as a `turn/start` on the first `session_init`. Empty/whitespace
    // (a bare wake with no message) → no pending prompt, so no empty turn.
    const initialPrompt = ctx.prompt?.trim() ? ctx.prompt : null;
    this.pendingInitialPrompt = initialPrompt;

    // Async handshake: initialize, then thread/start|resume. This ONLY sets up
    // the thread — the user prompt is delivered later (see `parseLine`), because
    // `turn/start` needs the threadId that arrives in this call's response. (The
    // standing/system prompt is separate: it reaches Codex via the AGENTS.md
    // that prepareCliTransport writes into the workdir, auto-read from cwd.)
    queueMicrotask(() => {
      proc.stdin?.write(
        serializeAgentDriverJsonRpcRequest(
          "initialize",
          { clientInfo: getDaemonClientInfo(), capabilities: { experimentalApi: true } },
          this.nextRequestId(),
        ) + "\n",
      );

      const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
      const resuming = Boolean(ctx.config.sessionId);
      // Fresh-thread params (no threadId) — used directly for a fresh spawn, and
      // stashed as the resume fallback so a "no rollout found" resume can retry
      // as a fresh thread (see parseLine).
      const freshParams: Record<string, unknown> = {
        cwd: ctx.workingDirectory,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        sandbox_mode: "danger-full-access",
        experimentalRawEvents: true,
      };
      if (f.model) freshParams.model = f.model;
      if (f.reasoningEffort) freshParams.config = { model_reasoning_effort: f.reasoningEffort };
      if (f.fastMode) freshParams.serviceTier = "fast";

      if (resuming) {
        this.pendingResumeFallbackParams = freshParams;
        proc.stdin?.write(
          serializeAgentDriverJsonRpcRequest("thread/resume", { ...freshParams, threadId: ctx.config.sessionId }, this.nextRequestId()) + "\n",
        );
      } else {
        proc.stdin?.write(serializeAgentDriverJsonRpcRequest("thread/start", freshParams, this.nextRequestId()) + "\n");
      }
    });

    return { process: proc };
  }

  /**
   * Parse a stdout line AND, as a one-time side-effect, deliver the initial
   * prompt. This is NOT a pure parser: on the FIRST `session_init` (the thread
   * id is now known) it writes the held `pendingInitialPrompt` as a `turn/start`
   * to stdin, then clears it (submit-once latch). This is where the initial user
   * message actually reaches Codex — the spawn handshake only starts the thread.
   *
   * The latch also makes the double `session_init` harmless: `thread/start`
   * emits one from its result and one from the `thread/started` notification, so
   * without the latch we'd submit the prompt twice. Resume takes the same path
   * (thread/resume's result also yields `session_init`), so no separate branch.
   *
   * SECOND side-effect — missing-rollout recovery: if a `thread/resume` fails
   * with "no rollout found" (the prior thread's rollout is gone), Codex emits an
   * `error` event and NO `session_init`. We re-issue a FRESH `thread/start` on
   * the same live process and swallow the error so the manager doesn't fault the
   * turn. `pendingInitialPrompt` is deliberately kept, so the fresh thread's
   * `session_init` delivers it via the latch above. Without this, a stale
   * sessionId wedges the bot: resume errors out, no turn ever runs.
   */
  parseLine(line: string): ParsedEvent[] {
    const events = this.eventNormalizer.normalizeLine(line);

    // Missing-rollout resume recovery — before any session_init is adopted.
    if (this.pendingResumeFallbackParams && this.proc?.stdin && !this.proc.stdin.destroyed) {
      const rolloutErr = events.find(
        (e) => e.kind === "error" && isCodexMissingRolloutError(e.message),
      );
      if (rolloutErr) {
        const fallback = this.pendingResumeFallbackParams;
        this.pendingResumeFallbackParams = null;
        // Fresh thread/start (no threadId). Keep pendingInitialPrompt so the new
        // thread's session_init delivers it. Swallow the resume error so it's
        // not surfaced as a runtime_error fault.
        this.proc.stdin.write(serializeAgentDriverJsonRpcRequest("thread/start", fallback, this.nextRequestId()) + "\n");
        return events.filter((e) => e !== rolloutErr);
      }
    }

    if (this.pendingInitialPrompt !== null && events.some((e) => e.kind === "session_init")) {
      const threadId = this.eventNormalizer.currentSessionId;
      // Defensive: the process is normally alive when its own stdout is being
      // parsed, but guard the write so a mid-teardown line can't throw.
      if (threadId && this.proc?.stdin && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(this.buildTurnStart(threadId, this.pendingInitialPrompt) + "\n");
        this.pendingInitialPrompt = null;
      }
    }

    // A successful thread adoption means resume didn't fail — drop the fallback.
    if (events.some((e) => e.kind === "session_init")) {
      this.pendingResumeFallbackParams = null;
    }

    return events;
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId;
  }

  /** A `turn/start` RPC — the sole encoder for starting a fresh Codex turn. */
  private buildTurnStart(threadId: string, text: string): string {
    return serializeAgentDriverJsonRpcRequest("turn/start", { threadId, input: [{ type: "text", text }] }, this.nextRequestId());
  }

  /** busy → `turn/steer` against the active turn; idle → fresh `turn/start`. */
  encodeStdinMessage(text: string, sessionId: string | null, opts?: EncodeOpts): string | null {
    const threadId = sessionId ?? this.eventNormalizer.currentSessionId;
    if (!threadId) return null;
    if (opts?.mode === "idle") return this.buildTurnStart(threadId, text);
    // Steer the in-flight turn. Codex requires `expectedTurnId` = the active
    // turn's id (from turn/started's params.turn.id); without it it rejects the
    // steer with "missing field expectedTurnId". If we somehow have no live turn
    // id (raced past turn/completed), fall back to a fresh turn/start rather than
    // send an invalid steer.
    const turnId = this.eventNormalizer.currentTurnId;
    if (!turnId) return this.buildTurnStart(threadId, text);
    return serializeAgentDriverJsonRpcRequest(
      "turn/steer",
      { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] },
      this.nextRequestId(),
    );
  }

  buildSystemPrompt(config: LaunchConfig): string {
    return buildCliTransportSystemPrompt(config);
  }
}

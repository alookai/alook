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
import type {
  BackendAdapter, EncodeMessageOptions, AdapterLaunchContext, AdapterEvent, RuntimeLane,
  RuntimeLaneOpenOptions, SpawnedProcess,
} from "../../internal/adapter.js";
import type {
  AgentDriverError,
  RuntimeSettingsUpdate,
  RuntimeSettingsUpdateResult,
  RuntimeReasoningCatalog,
} from "../../contract.js";
import { createProcessLane } from "../../controller/process-host.js";
import { prepareCliTransport } from "../../internal/cliTransport.js";
import { CodexEventNormalizer } from "./normalizer.js";
import { probeCliRuntime, resolveSpawnSpec } from "../../internal/probe.js";
import { resolveCodexHomeRootFromEnv } from "./home.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { killProcessTree, spawnAgentProcess } from "../../internal/killTree.js";
import { jsonRpcRequest, tryParseJsonLine } from "../../internal/utils.js";
import { scrubDriverErrorMessage } from "../../internal/errors.js";
import {
  normalizeRuntimeModelId,
  RUNTIME_MODEL_CATALOG_MAX,
} from "../../internal/modelCatalog.js";

const SETTINGS_UPDATE_TIMEOUT_MS = 5_000;
const MODEL_LIST_TIMEOUT_MS = 5_000;
const MODEL_LIST_OUTPUT_MAX_BYTES = 1024 * 1024;
const MODEL_LIST_MAX = RUNTIME_MODEL_CATALOG_MAX;
const MODEL_EFFORT_MAX = 16;

/** True when Codex cannot resume because the prior thread rollout is gone. */
function isCodexMissingRolloutError(message: string): boolean {
  return (
    /\bno\s+rollout\s+found\b/i.test(message) ||
    /\bmissing\s+rollout\b/i.test(message) ||
    /\brollout\b.*\b(not found|missing)\b/i.test(message) ||
    /\b(not found|missing)\b.*\brollout\b/i.test(message)
  );
}

export class CodexDriver implements BackendAdapter {
  readonly id = "codex";
  readonly instructionDelivery = { kind: "workspace_file", canonical: "AGENTS.md", aliases: ["CLAUDE.md"] } as const;
  readonly execution = {
    lifetime: "session",
    transport: { kind: "stdio_rpc", protocol: "codex.app-server.v1" },
    wakeStart: "immediate",
    terminalOwnership: "transport_request",
    turnSilence: {
      nativeIdleTimeoutMs: 300_000,
      daemonGraceMs: 60_000,
      recoveryGraceMs: 60_000,
      maxRecoveryExtensions: 1,
    },
  } as const;

  private readonly eventNormalizer = new CodexEventNormalizer();
  private readonly pendingAccountReadRequestIds = new Set<number>();
  private requestId = 0;
  /** Resolved Codex home root (CODEX_HOME or ~/.codex); set on spawn. */
  private codexHomeRoot: string | null = null;
  /**
   * The spawned process, retained so the initial-prompt `turn/start` can be
   * written once the thread id is adopted (see `normalizeLine`). Null until spawn.
   */
  private proc: SpawnedProcess["process"] | null = null;
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
   * powers the missing-rollout recovery in `normalizeLine`: re-issue a FRESH
   * `thread/start` (no threadId) on the same live process, keeping
   * `pendingInitialPrompt` so the fresh thread's `session_init` still delivers it.
   */
  private pendingResumeFallbackParams: Record<string, unknown> | null = null;
  private readonly pendingSettingsUpdates = new Map<number, {
    resolve(result: RuntimeSettingsUpdateResult): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextRequestId(): number {
    return ++this.requestId;
  }

  private requestAccountQuotaSnapshot(): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    const accountReadRequestId = this.nextRequestId();
    this.pendingAccountReadRequestIds.add(accountReadRequestId);
    this.eventNormalizer.registerAccountReadRequest(accountReadRequestId);
    this.proc.stdin.write(jsonRpcRequest(
      "account/read",
      { refreshToken: false },
      accountReadRequestId,
    ) + "\n");
  }

  private requestQuotaSnapshot(): void {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return;
    const quotaReadRequestId = this.nextRequestId();
    this.eventNormalizer.registerQuotaReadRequest(quotaReadRequestId);
    this.proc.stdin.write(jsonRpcRequest("account/rateLimits/read", {}, quotaReadRequestId) + "\n");
  }

  /** Resolved Codex home root (CODEX_HOME or ~/.codex). Null until spawned. */
  get codexHome(): string | null {
    return this.codexHomeRoot;
  }

  async probe(command?: string) {
    // probeCliRuntime spawns `--version` — a missing vendored binary (npm
    // package resolves but the aarch64 blob is absent) fails there even
    // though resolveCommandOnPath returned a JS wrapper. See
    // plans/community-machine-presence-fix.md.
    const result = await probeCliRuntime("codex", {}, command);
    if (result.status !== "healthy") return result;
    return {
      ...result,
      reasoning: await this.probeReasoningCatalog(command),
    };
  }

  private async probeReasoningCatalog(command?: string): Promise<RuntimeReasoningCatalog | undefined> {
    const spec = resolveSpawnSpec("codex", ["app-server", "--listen", "stdio://"], command);
    let proc: SpawnedProcess["process"];
    try {
      proc = spawnAgentProcess(spec.command, spec.args, {
        cwd: process.cwd(),
        env: { ...process.env, CI: "1" },
        shell: spec.shell,
      });
    } catch {
      return undefined;
    }
    return new Promise((resolve) => {
      let settled = false;
      let buffer = "";
      let outputBytes = 0;
      let nextId = 0;
      let initializeId = 0;
      let listId = 0;
      const models: RuntimeReasoningCatalog["models"][number][] = [];
      const seenModels = new Set<string>();
      let overflow = false;
      let defaultModelId: string | undefined;
      const finish = (catalog?: RuntimeReasoningCatalog) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const done = proc.pid
          ? killProcessTree(proc.pid, { graceMs: 250 }).catch(() => {})
          : Promise.resolve().then(() => { proc.kill("SIGTERM"); });
        void done.finally(() => resolve(catalog));
      };
      const requestModelPage = (cursor?: string) => {
        listId = ++nextId;
        proc.stdin?.write(jsonRpcRequest(
          "model/list",
          { limit: Math.min(MODEL_LIST_MAX - models.length, MODEL_LIST_MAX), includeHidden: false, ...(cursor ? { cursor } : {}) },
          listId,
        ) + "\n");
      };
      const consumeModel = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const model = value as Record<string, unknown>;
        const id = normalizeRuntimeModelId(model.id);
        if (!id || seenModels.has(id)) return;
        if (models.length >= MODEL_LIST_MAX) {
          overflow = true;
          return;
        }
        const rawOptions = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts
          : [];
        const seenEfforts = new Set<string>();
        const supportedReasoningEfforts = rawOptions.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const option = raw as Record<string, unknown>;
          const value = typeof option.reasoningEffort === "string"
            ? option.reasoningEffort.trim()
            : "";
          if (!value || value.length > 32 || !/^[A-Za-z0-9._-]+$/.test(value) || seenEfforts.has(value)) return [];
          seenEfforts.add(value);
          const description = typeof option.description === "string"
            ? option.description.slice(0, 256)
            : undefined;
          return [{ value, ...(description ? { description } : {}) }];
        }).slice(0, MODEL_EFFORT_MAX);
        const candidateDefault = typeof model.defaultReasoningEffort === "string"
          ? model.defaultReasoningEffort
          : undefined;
        seenModels.add(id);
        if (model.isDefault === true) defaultModelId = id;
        models.push({
          id,
          supportedReasoningEfforts,
          ...(candidateDefault && supportedReasoningEfforts.some((item) => item.value === candidateDefault)
            ? { defaultReasoningEffort: candidateDefault }
            : {}),
        });
      };
      const onLine = (line: string) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (message.id === initializeId) {
          if (message.error) return finish();
          requestModelPage();
          return;
        }
        if (message.id !== listId) return;
        if (message.error || !message.result || typeof message.result !== "object") return finish();
        const result = message.result as Record<string, unknown>;
        for (const model of Array.isArray(result.data) ? result.data : []) consumeModel(model);
        if (overflow) return finish();
        const cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (cursor && models.length >= MODEL_LIST_MAX) return finish();
        if (cursor) return requestModelPage(cursor);
        if (models.length === 0) return finish();
        finish({
          updateMode: "live_next_turn",
          ...(defaultModelId ? { defaultModelId } : {}),
          models,
        });
      };
      const timer = setTimeout(() => finish(), MODEL_LIST_TIMEOUT_MS);
      timer.unref?.();
      proc.stdout?.on("data", (chunk) => {
        const text = chunk.toString();
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > MODEL_LIST_OUTPUT_MAX_BYTES) return finish();
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) onLine(line);
      });
      proc.on("error", () => finish());
      proc.on("exit", () => finish());
      initializeId = ++nextId;
      proc.stdin?.write(jsonRpcRequest(
        "initialize",
        { clientInfo: { name: "alook-agent-driver-probe", version: "0.1.24" }, capabilities: { experimentalApi: true } },
        initializeId,
      ) + "\n");
    });
  }

  async openLane(ctx: AdapterLaunchContext, options?: RuntimeLaneOpenOptions): Promise<RuntimeLane> {
    return createProcessLane(this, ctx, { onRawStdoutLine: options?.onRawStdoutLine });
  }

  async spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess> {
    const { spawnEnv } = await prepareCliTransport(ctx);
    // Resolve the Codex home so resume can find its session rollout (and so a
    // host could surface "missing rollout" recovery — see classifyCodexResumeError).
    this.codexHomeRoot = resolveCodexHomeRootFromEnv(spawnEnv, { cwd: ctx.workingDirectory });
    // Cross-platform spawn: on Windows the codex entry is often a `.cmd` shim.
    const override = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command;
    const spec = resolveSpawnSpec("codex", ["app-server", "--listen", "stdio://"], override);
    const proc = spawnAgentProcess(spec.command, spec.args, {
      cwd: ctx.workingDirectory,
      env: spawnEnv,
      shell: spec.shell,
    });
    this.proc = proc;
    proc.once("exit", () => {
      this.failPendingSettingsUpdates(
        "settings_process_exited",
        "Codex exited before acknowledging the settings update",
      );
    });
    // Hold the initial user message until the thread id is adopted; `normalizeLine`
    // submits it as a `turn/start` on the first `session_init`. Empty/whitespace
    // (a bare wake with no message) → no pending prompt, so no empty turn.
    const initialPrompt = ctx.prompt?.trim() ? ctx.prompt : null;
    this.pendingInitialPrompt = initialPrompt;

    // Async handshake: initialize, then thread/start|resume. This ONLY sets up
    // the thread — the user prompt is delivered later (see `normalizeLine`), because
    // `turn/start` needs the threadId that arrives in this call's response. (The
    // standing/system prompt is separate: it reaches Codex via the
    // core-materialized AGENTS.md, auto-read from cwd.)
    queueMicrotask(() => {
      proc.stdin?.write(
        jsonRpcRequest(
          "initialize",
          { clientInfo: { name: "alook-agent-driver", version: "0.1.14" }, capabilities: { experimentalApi: true } },
          this.nextRequestId(),
        ) + "\n",
      );

      const f = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
      const resuming = Boolean(ctx.config.sessionId);
      // Fresh-thread params (no threadId) — used directly for a fresh spawn, and
      // stashed as the resume fallback so a "no rollout found" resume can retry
      // as a fresh thread (see normalizeLine).
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
          jsonRpcRequest("thread/resume", { ...freshParams, threadId: ctx.config.sessionId }, this.nextRequestId()) + "\n",
        );
      } else {
        proc.stdin?.write(jsonRpcRequest("thread/start", freshParams, this.nextRequestId()) + "\n");
      }
      this.requestAccountQuotaSnapshot();
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
  normalizeLine(line: string): AdapterEvent[] {
    const settingsResponse = this.consumeSettingsUpdateResponse(line);
    if (settingsResponse) return [];
    const parsed = tryParseJsonLine(line) as { id?: unknown; method?: unknown } | null;
    const events = this.eventNormalizer.normalizeLine(line);
    if (
      typeof parsed?.id === "number"
      && this.pendingAccountReadRequestIds.delete(parsed.id)
    ) {
      // Establish (and, if needed, rotate) the account-scoped source epoch
      // before asking for limits. Issuing both RPCs concurrently can associate
      // a fast quota response with the previous account after an account swap.
      this.requestQuotaSnapshot();
    }
    if (parsed?.method === "account/updated") this.requestAccountQuotaSnapshot();

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
        this.proc.stdin.write(jsonRpcRequest("thread/start", fallback, this.nextRequestId()) + "\n");
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

  updateSettings(input: RuntimeSettingsUpdate): Promise<RuntimeSettingsUpdateResult> {
    const threadId = this.eventNormalizer.currentSessionId;
    const stdin = this.proc?.stdin;
    if (!threadId || !stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
      return Promise.resolve({
        status: "failed",
        error: this.settingsError(
          "process",
          "settings_thread_unavailable",
          "Codex thread is not available for a settings update",
          true,
        ),
      });
    }
    const id = this.nextRequestId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pendingSettingsUpdates.delete(id)) return;
        resolve({
          status: "failed",
          error: this.settingsError(
            "timeout",
            "settings_update_timeout",
            "Codex did not acknowledge the settings update before the deadline",
            true,
          ),
        });
      }, SETTINGS_UPDATE_TIMEOUT_MS);
      timer.unref?.();
      this.pendingSettingsUpdates.set(id, { resolve, timer });
      try {
        stdin.write(jsonRpcRequest(
          "thread/settings/update",
          { threadId, effort: input.reasoningEffort },
          id,
        ) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pendingSettingsUpdates.delete(id);
        resolve({
          status: "failed",
          error: this.settingsError(
            "process",
            "settings_update_write_failed",
            String(error),
            true,
          ),
        });
      }
    });
  }

  private consumeSettingsUpdateResponse(line: string): boolean {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return false;
    }
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "number") return false;
    const pending = this.pendingSettingsUpdates.get(record.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingSettingsUpdates.delete(record.id);
    const error = record.error;
    if (!error || typeof error !== "object") {
      pending.resolve({ status: "applied" });
      return true;
    }
    const rpcError = error as Record<string, unknown>;
    const message = typeof rpcError.message === "string"
      ? rpcError.message
      : "Codex rejected the settings update";
    if (rpcError.code === -32601 || /method\s+not\s+found/i.test(message)) {
      pending.resolve({
        status: "unsupported",
        error: this.settingsError(
          "protocol",
          "settings_update_unsupported",
          "Codex does not support live reasoning settings updates",
          false,
        ),
      });
    } else {
      pending.resolve({
        status: "failed",
        error: this.settingsError("protocol", "settings_update_rejected", message, true),
      });
    }
    return true;
  }

  private settingsError(
    category: AgentDriverError["category"],
    code: string,
    message: string,
    retryable: boolean,
  ): AgentDriverError {
    return { category, code, message: scrubDriverErrorMessage(message), retryable };
  }

  private failPendingSettingsUpdates(code: string, message: string): void {
    for (const [id, pending] of this.pendingSettingsUpdates) {
      clearTimeout(pending.timer);
      this.pendingSettingsUpdates.delete(id);
      pending.resolve({
        status: "failed",
        error: this.settingsError("process", code, message, true),
      });
    }
  }

  get currentSessionId(): string | null {
    return this.eventNormalizer.currentSessionId;
  }

  /** A `turn/start` RPC — the sole encoder for starting a fresh Codex turn. */
  private buildTurnStart(threadId: string, text: string): string {
    return jsonRpcRequest("turn/start", { threadId, input: [{ type: "text", text }] }, this.nextRequestId());
  }

  /** busy → `turn/steer` against the active turn; idle → fresh `turn/start`. */
  encodeMessage(text: string, sessionId: string | null, opts?: EncodeMessageOptions): string | null {
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
    return jsonRpcRequest(
      "turn/steer",
      { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] },
      this.nextRequestId(),
    );
  }

}

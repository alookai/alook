import type {
  BackendAdapter, EncodeMessageOptions, AdapterLaunchContext, AdapterEvent, LaneInterruptInput, RuntimeLane,
  RuntimeLaneOpenOptions, SpawnedProcess, SpawnedProcessHandle,
} from "../../internal/adapter.js";
import type {
  AgentDriverError,
  RuntimeSettingsUpdate,
  RuntimeSettingsUpdateResult,
  RuntimeReasoningCatalog,
  InputReference,
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
import { resolveCodexCommand } from "./command.js";
import { discoverCodexRecentContext } from "./recent-context.js";

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
  readonly modelCatalogOrigin = "native_report" as const;
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
  discoverRecentContext(request: Parameters<typeof discoverCodexRecentContext>[0]) {
    return discoverCodexRecentContext(request);
  }
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
  private requestedSessionId?: string;
  private pendingInitialInputs: readonly InputReference[] = [];
  private readonly pendingInputs = new Map<number, { inputs: readonly InputReference[]; steer: boolean; settled?: boolean }>();
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

  async probe(command?: string, includeModels = true) {
    // probeCliRuntime spawns `--version` — a missing vendored binary (npm
    // package resolves but the aarch64 blob is absent) fails there even
    // though resolveCommandOnPath returned a JS wrapper; probing the resolved
    // command keeps runtime health tied to what can actually execute.
    const selected = resolveCodexCommand(command);
    const result = await probeCliRuntime("codex", {}, selected);
    if (result.status !== "healthy") return result;
    if (!includeModels) return result;
    return {
      ...result,
      reasoning: await this.probeReasoningCatalog(selected),
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
        for (const model of Array.isArray(result.data) ? result.data : []) {
          consumeModel(model);
          if (models.length >= MODEL_LIST_MAX) break;
        }
        const cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
        if (cursor && models.length < MODEL_LIST_MAX) return requestModelPage(cursor);
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
    const override = resolveCodexCommand(resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).command);
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
    this.pendingInitialInputs = ctx.inputs ?? [];
    this.requestedSessionId = ctx.config.sessionId;

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
        proc.stdin?.write(
          jsonRpcRequest("thread/resume", { ...freshParams, threadId: ctx.config.sessionId, excludeTurns: true }, this.nextRequestId()) + "\n",
        );
      } else {
        proc.stdin?.write(jsonRpcRequest("thread/start", freshParams, this.nextRequestId()) + "\n");
      }
      this.requestAccountQuotaSnapshot();
    });

    return { process: proc };
  }

  normalizeLine(line: string): AdapterEvent[] {
    if (this.consumeSettingsUpdateResponse(line)) return [];
    const parsed = tryParseJsonLine(line) as { id?: number; method?: string; error?: { message?: string }; result?: unknown } | null;
    const pending = typeof parsed?.id === "number" ? this.pendingInputs.get(parsed.id) : undefined;
    if (pending && parsed) {
      if (pending.settled) return [];
      this.pendingInputs.set(parsed.id!, { inputs: [], steer: pending.steer, settled: true });
      if (pending.steer && parsed.error) return [{ kind: "input_returned", inputs: pending.inputs, evidence: "explicitly_rejected", reason: parsed.error.message ?? "Codex rejected steering", retryable: true }];
      if (!parsed.error && pending.steer) return [{ kind: "input_observed", inputs: pending.inputs, evidence: "native_ack" }];
    }
    const events = this.eventNormalizer.normalizeLine(line);
    if (typeof parsed?.id === "number" && this.pendingAccountReadRequestIds.delete(parsed.id)) this.requestQuotaSnapshot();
    if (parsed?.method === "account/updated") this.requestAccountQuotaSnapshot();
    if (this.requestedSessionId) {
      const failure = events.find((event) => event.kind === "error" && isCodexMissingRolloutError(event.message));
      if (failure?.kind === "error") {
        this.pendingInitialPrompt = null;
        return [{ ...failure, code: "reset_required", scope: "session" }];
      }
    }
    for (const event of events) {
      if (event.kind !== "session_init") continue;
      if (this.requestedSessionId && event.sessionId !== this.requestedSessionId) {
        this.pendingInitialPrompt = null;
        return [{ kind: "error", code: "reset_required", scope: "session", message: "Codex did not restore the requested thread" }];
      }
      event.acquisition = { status: this.requestedSessionId ? "resumed" : "created", evidence: "native_api" };
    }
    if (this.pendingInitialPrompt !== null && events.some((event) => event.kind === "session_init")) {
      const threadId = this.eventNormalizer.currentSessionId;
      if (threadId && this.proc?.stdin && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(this.buildTurnStart(threadId, this.pendingInitialPrompt, this.pendingInitialInputs) + "\n");
        this.pendingInitialPrompt = null;
      }
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
      pending.resolve({ status: "acknowledged", effective: "next_turn" });
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

  async interrupt(_input: LaneInterruptInput, process: SpawnedProcessHandle): Promise<boolean> {
    const threadId = this.eventNormalizer.currentSessionId;
    const turnId = this.eventNormalizer.currentTurnId;
    const stdin = process.stdin;
    if (
      !threadId
      || !turnId
      || !stdin
      || stdin.destroyed
      || stdin.writableEnded
      || stdin.writable === false
    ) return false;
    stdin.write(jsonRpcRequest(
      "turn/interrupt",
      { threadId, turnId },
      this.nextRequestId(),
    ) + "\n");
    return true;
  }

  /** A `turn/start` RPC — the sole encoder for starting a fresh Codex turn. */
  private buildTurnStart(threadId: string, text: string, inputs: readonly InputReference[] = []): string {
    const id = this.nextRequestId();
    this.pendingInputs.set(id, { inputs, steer: false });
    return jsonRpcRequest("turn/start", { threadId, input: [{ type: "text", text }] }, id);
  }

  /** busy → `turn/steer` against the active turn; idle → fresh `turn/start`. */
  encodeMessage(text: string, sessionId: string | null, opts?: EncodeMessageOptions): string | null {
    const threadId = sessionId ?? this.eventNormalizer.currentSessionId;
    if (!threadId) return null;
    if (opts?.mode === "idle") return this.buildTurnStart(threadId, text, opts?.inputs);
    const turnId = this.eventNormalizer.currentTurnId;
    if (!turnId) return null;
    const id = this.nextRequestId();
    this.pendingInputs.set(id, { inputs: opts?.inputs ?? [], steer: true });
    return jsonRpcRequest(
      "turn/steer",
      { threadId, expectedTurnId: turnId, input: [{ type: "text", text }] },
      id,
    );
  }

}

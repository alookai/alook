import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AdapterEvent,
  AdapterLaunchContext,
  LaneAdmission,
  LaneInterruptInput,
  LaneSendInput,
  LaneStartInput,
  LaneStopInput,
  RuntimeLane,
  RuntimeLaneEventMap,
  SpawnedProcess,
  SpawnedProcessHandle,
} from "../../internal/adapter.js";
import type {
  AgentDriverError,
  ReasoningEffort,
  RuntimeReasoningCatalog,
  RuntimeSettingsUpdate,
  RuntimeSettingsUpdateResult,
} from "../../contract.js";
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { killProcessTree, SESSION_STOP_GRACE_MS } from "../../internal/killTree.js";
import { SettledUsageProjector } from "../../internal/token-usage.js";
import { asRecord } from "../../internal/utils.js";
import { parseGrokModelCatalog } from "./catalog-probe.js";
import { normalizeGrokBilling, projectGrokUsage } from "./telemetry.js";

const ACP_PROTOCOL_VERSION = 1;
const AUTH_METHOD_ID = "cached_token";
const INTERACTIVE_AUTH_METHOD_IDS = new Set(["grok.com"]);
const HANDSHAKE_TIMEOUT_MS = 15_000;
const SESSION_CLOSE_TIMEOUT_MS = 1_000;
const PROMPT_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

type JsonRpcId = number | string;
type JsonRecord = Record<string, unknown>;

interface PendingCall {
  readonly kind: "call";
  readonly method: string;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout>;
}

interface PromptRequest {
  readonly requestId: number;
  readonly receipt: string;
  readonly providerPromptId: string;
  fallbackUsage?: unknown;
}

interface PendingPrompt {
  readonly kind: "prompt";
  readonly method: "session/prompt";
  readonly prompt: PromptRequest;
}

type PendingRequest = PendingCall | PendingPrompt;

interface RpcRequest {
  readonly id: number;
  readonly promise: Promise<unknown>;
}

export interface GrokAcpProcessFactory {
  spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess>;
}

interface GrokAcpLaneOptions {
  readonly onRawStdoutLine?: (line: string) => void;
  readonly handshakeTimeoutMs?: number;
}

class GrokAcpResetRequiredError extends Error {}
class GrokAcpIncompatibleError extends Error {}
class GrokAcpAuthenticationError extends Error {}

class GrokAcpRpcError extends Error {
  constructor(readonly method: string, readonly code: number | undefined, message: string) {
    super(message);
  }
}

function safeLabel(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_.\/-]{1,96}$/i.test(value) ? value : "unknown";
}

function rpcErrorMessage(error: unknown): string {
  const payload = asRecord(error);
  return typeof payload?.message === "string" && payload.message.trim()
    ? payload.message
    : "Grok ACP request failed";
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bsession\b.*\b(not found|missing|unknown|invalid)\b/i.test(message)
    || /\b(not found|missing|unknown|invalid)\b.*\bsession\b/i.test(message);
}

function settingsError(
  category: AgentDriverError["category"],
  code: string,
  message: string,
  retryable = false,
): AgentDriverError {
  return { category, code, message, retryable };
}

export class GrokAcpLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openToolCalls = new Map<string, string>();
  private readonly usageProjector = new SettledUsageProjector();
  private readonly quotaSourceEpoch = randomBytes(16).toString("base64url");
  private process: SpawnedProcessHandle | null = null;
  private stdoutBuffer = "";
  private requestSequence = 0;
  private started = false;
  private ready = false;
  private sessionId: string | null = null;
  private currentPromptRequestId: number | null = null;
  private terminalOwner: string | null = null;
  private catalog: RuntimeReasoningCatalog | undefined;
  private currentModelId: string | undefined;
  private currentReasoningEffort: ReasoningEffort | undefined;
  private requestedStopReason?: string;
  private spawnPromise?: Promise<SpawnedProcess>;
  private stopPromise?: Promise<void>;
  private suppressExit = false;
  private processTerminal = false;
  private processActivated = false;
  private processStartError: Error | null = null;
  private billingInFlight = false;

  constructor(
    private readonly factory: GrokAcpProcessFactory,
    private readonly ctx: AdapterLaunchContext,
    private readonly options: GrokAcpLaneOptions = {},
  ) {}

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  on<K extends keyof RuntimeLaneEventMap>(
    event: K,
    listener: (value: RuntimeLaneEventMap[K]) => void,
  ): void {
    this.events.on(event, listener);
  }

  async start(input: LaneStartInput): Promise<LaneAdmission> {
    if (this.started) return { ok: false, reason: "runtime_error", error: "Grok ACP session already started" };
    this.started = true;
    const launchCtx: AdapterLaunchContext = {
      ...this.ctx,
      prompt: input.text,
      config: { ...this.ctx.config, sessionId: input.sessionId ?? this.ctx.config.sessionId },
    };
    try {
      this.spawnPromise = this.factory.spawn(launchCtx).then((spawned) => {
        this.process = spawned.process;
        this.attachProcess(spawned.process);
        return spawned;
      });
      await this.spawnPromise;
      if (this.requestedStopReason) {
        await this.stop({ reason: this.requestedStopReason, forceAfterMs: 0 });
        throw new Error("Grok ACP start was cancelled");
      }
      await this.handshake(launchCtx);
      if (this.requestedStopReason) {
        await this.stop({ reason: this.requestedStopReason, forceAfterMs: 0 });
        throw new Error("Grok ACP start was cancelled");
      }
      if (this.processStartError) throw this.processStartError;
      if (this.processTerminal || this.isClosed()) throw new Error("Grok ACP process exited during startup");
      const sessionId = this.sessionId;
      if (!sessionId) throw new Error("Grok ACP handshake completed without a session id");
      this.processActivated = true;
      this.ready = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId } satisfies AdapterEvent);
      return this.admitPrompt(input.text, input.terminalOwner);
    } catch (error) {
      this.suppressExit = true;
      await this.stop({ reason: "failed_start", forceAfterMs: 0 }).catch(() => {});
      if (error instanceof GrokAcpResetRequiredError) {
        return { ok: false, reason: "reset_required", error: error.message };
      }
      if (error instanceof GrokAcpIncompatibleError) {
        return { ok: false, reason: "incompatible_configuration", error: error.message };
      }
      if (error instanceof GrokAcpAuthenticationError) {
        return { ok: false, reason: "authentication", error: error.message };
      }
      throw error;
    }
  }

  send(input: LaneSendInput): Promise<LaneAdmission> {
    if (!this.ready || !this.process || this.isClosed()) {
      return Promise.resolve({ ok: false, reason: "closed" });
    }
    if (input.mode === "busy" || this.currentPromptRequestId !== null) {
      return Promise.resolve({
        ok: false,
        reason: "runtime_busy",
        error: "Grok ACP accepts messages only at a safe prompt boundary",
      });
    }
    return Promise.resolve(this.admitPrompt(input.text, input.terminalOwner));
  }

  interrupt(_input: LaneInterruptInput): Promise<boolean> {
    if (!this.ready || !this.sessionId || this.currentPromptRequestId === null || this.isClosed()) {
      return Promise.resolve(false);
    }
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    return Promise.resolve(true);
  }

  async updateSettings(input: RuntimeSettingsUpdate): Promise<RuntimeSettingsUpdateResult> {
    if (!this.ready || !this.sessionId || this.isClosed()) {
      return { status: "failed", error: settingsError("process", "settings_session_unavailable", "Grok session is not available", true) };
    }
    if (this.currentPromptRequestId !== null) {
      return { status: "failed", error: settingsError("configuration", "settings_runtime_busy", "Grok settings change requires an idle session", true) };
    }
    const modelId = this.currentModelId ?? this.catalog?.defaultModelId;
    if (!modelId) {
      return { status: "failed", error: settingsError("configuration", "settings_model_unavailable", "Grok did not publish the active model") };
    }
    if (input.reasoningEffort !== null && !this.supportsReasoning(modelId, input.reasoningEffort)) {
      return { status: "failed", error: settingsError("configuration", "unsupported_reasoning_effort", "Configured Grok reasoning effort is unavailable") };
    }
    try {
      await this.setModel(modelId, input.reasoningEffort ?? undefined);
      this.currentReasoningEffort = input.reasoningEffort ?? undefined;
      return { status: "applied" };
    } catch {
      return { status: "failed", error: settingsError("protocol", "settings_update_failed", "Grok rejected the settings update", true) };
    }
  }

  stop(input: LaneStopInput = {}): Promise<void> {
    this.requestedStopReason ??= input.reason ?? "requested_stop";
    this.ready = false;
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.finishOpenTools();
    this.stopPromise ??= this.stopPhysicalOnce(input);
    return this.stopPromise;
  }

  private async stopPhysicalOnce(input: LaneStopInput): Promise<void> {
    await this.spawnPromise?.catch(() => undefined);
    const proc = this.process;
    if (!proc) return;
    if (this.sessionId && !this.isClosed() && (input.forceAfterMs ?? SESSION_STOP_GRACE_MS) > 0) {
      await this.call("session/close", { sessionId: this.sessionId }, Math.min(
        input.forceAfterMs ?? SESSION_CLOSE_TIMEOUT_MS,
        SESSION_CLOSE_TIMEOUT_MS,
      )).catch(() => undefined);
    }
    this.rejectAllPending(new Error("Grok ACP lane stopped"));
    if (proc.pid) {
      await killProcessTree(proc.pid, { graceMs: input.forceAfterMs ?? SESSION_STOP_GRACE_MS });
    } else if (!this.isClosed()) {
      proc.kill(input.signal ?? "SIGTERM");
    }
  }

  private async handshake(ctx: AdapterLaunchContext): Promise<void> {
    const initialize = asRecord(await this.call("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "alook-agent-driver", version: "0.1.31" },
    }));
    if (initialize?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new GrokAcpIncompatibleError("Installed Grok ACP does not support protocol version 1");
    }
    const capabilities = asRecord(initialize.agentCapabilities);
    if (capabilities?.loadSession !== true) {
      throw new GrokAcpIncompatibleError("Installed Grok ACP does not support persistent session loading");
    }
    const authMethods = Array.isArray(initialize.authMethods) ? initialize.authMethods : [];
    const authMethodIds = authMethods.flatMap((method) => {
      const id = asRecord(method)?.id;
      return typeof id === "string" ? [id] : [];
    });
    if (!authMethodIds.includes(AUTH_METHOD_ID)) {
      if (authMethodIds.some((id) => INTERACTIVE_AUTH_METHOD_IDS.has(id))) {
        throw new GrokAcpAuthenticationError("Grok authentication failed; run `grok login` and retry");
      }
      throw new GrokAcpIncompatibleError("Installed Grok ACP does not expose cached-token authentication");
    }
    this.adoptCatalogFromInitialize(initialize);
    try {
      await this.call("authenticate", { methodId: AUTH_METHOD_ID });
    } catch {
      throw new GrokAcpAuthenticationError("Grok authentication failed; run `grok login` and retry");
    }
    void this.refreshBilling();

    const requestedSessionId = ctx.config.sessionId;
    let session: JsonRecord | null;
    if (requestedSessionId) {
      try {
        session = asRecord(await this.call("session/load", {
          sessionId: requestedSessionId,
          cwd: ctx.workingDirectory,
          mcpServers: [],
        }));
      } catch (error) {
        if (isMissingSessionError(error)) {
          throw new GrokAcpResetRequiredError("Grok session could not be loaded; reset this agent to start a new session");
        }
        throw error;
      }
    } else {
      session = asRecord(await this.call("session/new", {
        cwd: ctx.workingDirectory,
        mcpServers: [],
        _meta: { yoloMode: true },
      }));
    }
    if (!session) throw new Error("Grok ACP did not return a valid session response");
    const returnedSessionId = session.sessionId;
    if (requestedSessionId) {
      if (returnedSessionId !== undefined && (typeof returnedSessionId !== "string" || !returnedSessionId.trim())) {
        throw new Error("Grok ACP returned an invalid session id");
      }
      if (typeof returnedSessionId === "string" && returnedSessionId !== requestedSessionId) {
        throw new GrokAcpResetRequiredError("Grok ACP loaded a different session; reset this agent before continuing");
      }
      this.sessionId = requestedSessionId;
    } else {
      if (typeof returnedSessionId !== "string" || !returnedSessionId.trim()) {
        throw new Error("Grok ACP did not return a valid session id");
      }
      this.sessionId = returnedSessionId;
    }
    this.catalog = parseGrokModelCatalog(session.models) ?? this.catalog;
    await this.configureModel(ctx);
  }

  private adoptCatalogFromInitialize(initialize: JsonRecord): void {
    const meta = asRecord(initialize._meta) ?? asRecord(initialize.meta);
    this.catalog = parseGrokModelCatalog(meta?.modelState) ?? this.catalog;
    this.currentModelId = this.catalog?.defaultModelId ?? this.currentModelId;
  }

  private async configureModel(ctx: AdapterLaunchContext): Promise<void> {
    const configured = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    const requestedModel = configured.model;
    const modelId = requestedModel ?? this.catalog?.defaultModelId;
    if (requestedModel && !this.catalog?.models.some((model) => model.id === requestedModel)) {
      throw new GrokAcpIncompatibleError(`Configured Grok model is unavailable: ${requestedModel}`);
    }
    if (configured.reasoningEffort && (!modelId || !this.supportsReasoning(modelId, configured.reasoningEffort))) {
      throw new GrokAcpIncompatibleError(`Configured Grok reasoning effort is unavailable: ${configured.reasoningEffort}`);
    }
    this.currentModelId = modelId;
    this.currentReasoningEffort = configured.reasoningEffort;
    if (requestedModel || configured.reasoningEffort) {
      if (!modelId) throw new GrokAcpIncompatibleError("Grok did not publish a model catalog");
      await this.setModel(modelId, configured.reasoningEffort);
    }
  }

  private supportsReasoning(modelId: string, effort: ReasoningEffort): boolean {
    const model = this.catalog?.models.find((candidate) => candidate.id === modelId);
    return Boolean(model?.supportedReasoningEfforts.some((candidate) => candidate.value === effort));
  }

  private async setModel(modelId: string, reasoningEffort?: ReasoningEffort): Promise<void> {
    if (!this.sessionId) throw new Error("Grok ACP session is not ready");
    await this.call("session/set_model", {
      sessionId: this.sessionId,
      modelId,
      ...(reasoningEffort ? { _meta: { reasoningEffort } } : {}),
    });
  }

  private admitPrompt(text: string, requestedOwner?: string): LaneAdmission {
    if (!this.sessionId) return { ok: false, reason: "not_ready", error: "Grok ACP session is not ready" };
    const requestId = ++this.requestSequence;
    const receipt = requestedOwner?.trim() || `grok:acp:${requestId}`;
    const prompt: PromptRequest = { requestId, receipt, providerPromptId: `alook-${requestId}` };
    this.currentPromptRequestId = requestId;
    this.terminalOwner = receipt;
    this.openToolCalls.clear();
    this.pending.set(requestId, { kind: "prompt", method: "session/prompt", prompt });
    try {
      this.write({
        jsonrpc: "2.0",
        id: requestId,
        method: "session/prompt",
        params: {
          sessionId: this.sessionId,
          prompt: [{ type: "text", text }],
          _meta: { promptId: prompt.providerPromptId },
        },
      });
    } catch (error) {
      this.pending.delete(requestId);
      this.currentPromptRequestId = null;
      this.terminalOwner = null;
      throw error;
    }
    return { ok: true, acceptedAs: "prompt", receipt };
  }

  private completePrompt(prompt: PromptRequest, value: unknown): void {
    if (this.currentPromptRequestId !== prompt.requestId) return;
    const result = asRecord(value);
    if (!result || typeof result.stopReason !== "string" || !PROMPT_STOP_REASONS.has(result.stopReason)) {
      this.failPrompt(prompt, new Error("Grok ACP prompt response did not contain a supported stopReason"), "grok.invalid_stop_reason");
      return;
    }
    const terminalOwner = this.terminalOwner ?? prompt.receipt;
    const meta = asRecord(result._meta) ?? asRecord(result.meta);
    const responseUsage = projectGrokUsage(
      this.usageProjector,
      this.sessionId ?? "unknown",
      prompt.providerPromptId,
      meta?.usage,
    );
    const usage = responseUsage ?? projectGrokUsage(
      this.usageProjector,
      this.sessionId ?? "unknown",
      prompt.providerPromptId,
      prompt.fallbackUsage,
    );
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.finishOpenTools();
    if (usage) this.events.emit("runtime_event", usage);
    this.events.emit("runtime_event", {
      kind: "turn_end",
      sessionId: this.sessionId ?? undefined,
      turnOwner: terminalOwner,
    } satisfies AdapterEvent);
    void this.refreshBilling();
  }

  private failPrompt(prompt: PromptRequest, error: unknown, code = "grok.prompt_failed"): void {
    if (this.currentPromptRequestId !== prompt.requestId) return;
    const terminalOwner = this.terminalOwner ?? prompt.receipt;
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.finishOpenTools();
    this.events.emit("runtime_event", {
      kind: "error",
      code,
      message: error instanceof Error ? error.message : String(error),
    } satisfies AdapterEvent);
    this.events.emit("runtime_event", {
      kind: "turn_end",
      sessionId: this.sessionId ?? undefined,
      turnOwner: terminalOwner,
    } satisfies AdapterEvent);
    void this.refreshBilling();
  }

  private call(method: string, params: JsonRecord, timeoutMs?: number): Promise<unknown> {
    return this.request(method, params, timeoutMs ?? this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS).promise;
  }

  private request(method: string, params: JsonRecord, timeoutMs?: number): RpcRequest {
    const id = ++this.requestSequence;
    let resolve!: (result: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((accept, decline) => {
      resolve = accept;
      reject = decline;
    });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      const pending = this.pending.get(id);
      if (!pending || pending.kind !== "call") return;
      this.pending.delete(id);
      pending.reject(new Error(`Grok ACP ${method} timed out`));
    }, timeoutMs);
    timer?.unref?.();
    this.pending.set(id, { kind: "call", method, resolve, reject, ...(timer ? { timer } : {}) });
    try {
      this.write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (pending?.kind === "call" && pending.timer) clearTimeout(pending.timer);
      throw error instanceof Error ? error : new Error(String(error));
    }
    return { id, promise };
  }

  private write(message: JsonRecord): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.writable === false) {
      throw new Error("Grok ACP stdin is not writable");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private attachProcess(proc: SpawnedProcessHandle): void {
    proc.stdout?.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.options.onRawStdoutLine?.(line);
        } catch {}
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.protocolFailure("Grok ACP emitted malformed JSON");
          continue;
        }
        try {
          this.handleMessage(message);
        } catch {
          this.protocolFailure("Grok ACP could not answer a client-side protocol request");
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.events.emit("stderr", text);
    });
    proc.on("error", (error) => {
      if (this.process !== proc || this.processTerminal) return;
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.rejectAllPending(normalized);
      if (!this.processActivated || this.requestedStopReason) {
        if (!this.processActivated) this.processStartError ??= normalized;
        this.events.emit("error", normalized);
        return;
      }
      this.processTerminal = true;
      this.ready = false;
      this.currentPromptRequestId = null;
      this.terminalOwner = null;
      this.finishOpenTools();
      this.stopPromise ??= this.stopPhysicalOnce({ reason: "runtime_error", forceAfterMs: 0 });
      void this.stopPromise.catch(() => {});
      this.events.emit("error", normalized);
      if (!this.suppressExit) this.events.emit("exit", { code: null, signal: null, reason: "runtime_exit" });
    });
    proc.on("exit", (code, signal) => {
      if (this.processTerminal || this.process !== proc) return;
      this.processTerminal = true;
      this.ready = false;
      this.currentPromptRequestId = null;
      this.terminalOwner = null;
      this.finishOpenTools();
      this.rejectAllPending(new Error("Grok ACP process exited"));
      if (this.suppressExit || !this.processActivated) return;
      this.events.emit("exit", {
        code,
        signal,
        reason: this.requestedStopReason ? "requested" : "runtime_exit",
      });
    });
  }

  private handleMessage(value: unknown): void {
    const message = asRecord(value);
    if (!message || message.jsonrpc !== "2.0") {
      this.protocolFailure("Grok ACP emitted an invalid JSON-RPC message");
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) this.handleRequest(message.id as JsonRpcId, message.method, message.params);
      else this.handleNotification(message.method, message.params);
      return;
    }
    if (typeof message.id === "number" || typeof message.id === "string") {
      this.handleResponse(message.id, message);
      return;
    }
    this.protocolFailure("Grok ACP emitted an unrecognized JSON-RPC message");
  }

  private handleResponse(id: JsonRpcId, message: JsonRecord): void {
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (typeof id !== "number" || !pending) {
      this.diagnostic("warning", "Grok ACP emitted a duplicate or unknown response id");
      return;
    }
    if (pending.kind === "prompt") {
      this.pending.delete(id);
      if (message.error !== undefined) {
        const payload = asRecord(message.error);
        const code = typeof payload?.code === "number" && Number.isSafeInteger(payload.code) ? payload.code : undefined;
        this.failPrompt(
          pending.prompt,
          new GrokAcpRpcError(pending.method, code, rpcErrorMessage(message.error)),
          code === undefined ? "grok.rpc_error" : `grok.rpc.${code}`,
        );
      } else if (!("result" in message)) {
        this.failPrompt(pending.prompt, new Error("Grok ACP response omitted result"), "grok.invalid_response");
      } else {
        this.completePrompt(pending.prompt, message.result);
      }
      return;
    }
    if (message.error !== undefined) {
      const payload = asRecord(message.error);
      this.settleRequest(id, false, new GrokAcpRpcError(
        pending.method,
        typeof payload?.code === "number" && Number.isSafeInteger(payload.code) ? payload.code : undefined,
        rpcErrorMessage(message.error),
      ));
      return;
    }
    if (!("result" in message)) {
      this.settleRequest(id, false, new Error("Grok ACP response omitted result"));
      return;
    }
    this.settleRequest(id, true, message.result);
  }

  private settleRequest(id: number, ok: boolean, value: unknown): void {
    const pending = this.pending.get(id);
    if (!pending || pending.kind !== "call") return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (ok) pending.resolve(value);
    else pending.reject(value instanceof Error ? value : new Error(String(value)));
  }

  private handleRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method !== "session/request_permission") {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported Grok ACP client request" } });
      this.diagnostic("warning", `Unsupported Grok ACP client request: ${safeLabel(method)}`);
      return;
    }
    const payload = asRecord(params);
    const options = Array.isArray(payload?.options) ? payload.options.map(asRecord).filter(Boolean) as JsonRecord[] : [];
    const allowOnce = options.find((option) => option.kind === "allow_once" && typeof option.optionId === "string" && option.optionId.trim());
    if (!this.ready || this.currentPromptRequestId === null || payload?.sessionId !== this.sessionId || !allowOnce) {
      this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      this.diagnostic("error", "Grok ACP permission request was not allowed for the active prompt");
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      result: { outcome: { outcome: "selected", optionId: allowOnce.optionId } },
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "_x.ai/models/update" || method === "x.ai/models/update") {
      this.catalog = parseGrokModelCatalog(params) ?? this.catalog;
      this.currentModelId ??= this.catalog?.defaultModelId;
      return;
    }
    if (method === "session/update") {
      this.handleSessionUpdate(params);
      return;
    }
    if (method === "_x.ai/session/update" || method === "x.ai/session/update") {
      this.handlePrivateSessionUpdate(params);
      return;
    }
    this.diagnostic("warning", `Unsupported Grok ACP notification: ${safeLabel(method)}`);
  }

  private handleSessionUpdate(params: unknown): void {
    const payload = asRecord(params);
    const update = asRecord(payload?.update) ?? {};
    const replay = asRecord(payload?._meta)?.isReplay === true || asRecord(update?._meta)?.isReplay === true;
    if (replay || !this.ready) return;
    if (!payload || payload.sessionId !== this.sessionId) {
      this.diagnostic("warning", "Grok ACP emitted an update for a different session");
      return;
    }
    if (this.currentPromptRequestId === null) {
      this.diagnostic("warning", "Grok ACP emitted a session update without an active prompt");
      return;
    }
    const updateType = update?.sessionUpdate;
    switch (updateType) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const content = asRecord(update.content);
        if (content?.type === "text" && typeof content.text === "string") {
          this.events.emit("runtime_event", {
            kind: updateType === "agent_message_chunk" ? "assistant_message_delta" : "assistant_reasoning_delta",
            text: content.text,
          } satisfies AdapterEvent);
        }
        return;
      }
      case "user_message_chunk":
        return;
      case "tool_call": {
        if (typeof update.toolCallId !== "string" || typeof update.title !== "string") {
          this.diagnostic("warning", "Grok ACP emitted a malformed tool_call update");
          return;
        }
        this.openToolCalls.set(update.toolCallId, update.title);
        this.events.emit("runtime_event", {
          kind: "tool_call",
          callId: update.toolCallId,
          name: update.title,
          input: update.rawInput,
        } satisfies AdapterEvent);
        return;
      }
      case "tool_call_update": {
        if (
          typeof update.toolCallId === "string"
          && (update.status === "completed" || update.status === "failed")
        ) {
          const name = this.openToolCalls.get(update.toolCallId);
          if (name) {
            this.openToolCalls.delete(update.toolCallId);
            this.events.emit("runtime_event", {
              kind: "tool_output",
              callId: update.toolCallId,
              name: typeof update.title === "string" ? update.title : name,
            } satisfies AdapterEvent);
          }
        }
        return;
      }
      case "plan":
        this.events.emit("runtime_event", { kind: "internal_progress", source: "grok.acp", itemType: "plan" } satisfies AdapterEvent);
        return;
      case "current_model_update": {
        const modelId = typeof update.modelId === "string" ? update.modelId : update.model_id;
        if (typeof modelId === "string") this.currentModelId = modelId;
        return;
      }
      default:
        this.diagnostic("warning", `Unsupported Grok ACP session update: ${safeLabel(updateType)}`);
    }
  }

  private handlePrivateSessionUpdate(params: unknown): void {
    const payload = asRecord(params);
    const update = asRecord(payload?.update) ?? payload;
    const replay = asRecord(payload?._meta)?.isReplay === true || asRecord(update?._meta)?.isReplay === true;
    if (replay || !this.ready || !payload || payload.sessionId !== this.sessionId) return;
    const pending = this.currentPrompt();
    if (!pending || update?.sessionUpdate !== "turn_completed") return;
    const updateMeta = asRecord(update._meta);
    const payloadMeta = asRecord(payload._meta);
    const promptId = update.promptId ?? update.prompt_id
      ?? updateMeta?.promptId ?? updateMeta?.prompt_id
      ?? payload.promptId ?? payload.prompt_id
      ?? payloadMeta?.promptId ?? payloadMeta?.prompt_id;
    if (promptId !== pending.providerPromptId) return;
    pending.fallbackUsage ??= update.usage ?? updateMeta?.usage ?? payload.usage ?? payloadMeta?.usage;
  }

  private currentPrompt(): PromptRequest | null {
    if (this.currentPromptRequestId === null) return null;
    const pending = this.pending.get(this.currentPromptRequestId);
    return pending?.kind === "prompt" ? pending.prompt : null;
  }

  private async refreshBilling(): Promise<void> {
    if (this.billingInFlight || this.requestedStopReason || this.isClosed()) return;
    this.billingInFlight = true;
    try {
      const result = await this.call("_x.ai/billing", {});
      if (this.requestedStopReason) return;
      const payload = asRecord(result);
      this.events.emit("runtime_event", {
        kind: "telemetry",
        name: "rate_limits",
        source: "grok_billing",
        quota: normalizeGrokBilling(payload?.billing ?? result, this.quotaSourceEpoch),
      } satisfies AdapterEvent);
    } catch (error) {
      if (this.requestedStopReason) return;
      const code = error instanceof GrokAcpRpcError && error.code === -32601
        ? "unavailable"
        : error instanceof GrokAcpRpcError && (error.code === 401 || error.code === -32001)
          ? "unauthorized"
          : "provider_error";
      this.events.emit("runtime_event", {
        kind: "telemetry",
        name: "rate_limits",
        source: "grok_billing",
        quota: {
          status: "error",
          sourceEpoch: this.quotaSourceEpoch,
          code,
          retryable: code !== "unauthorized" && code !== "unavailable",
        },
      } satisfies AdapterEvent);
    } finally {
      this.billingInFlight = false;
    }
  }

  private finishOpenTools(): void {
    for (const [callId, name] of this.openToolCalls) {
      this.events.emit("runtime_event", { kind: "tool_output", callId, name } satisfies AdapterEvent);
    }
    this.openToolCalls.clear();
  }

  private diagnostic(severity: "error" | "warning", message: string): void {
    this.events.emit("runtime_event", { kind: "runtime_diagnostic", severity, source: "grok.acp", message } satisfies AdapterEvent);
  }

  private protocolFailure(message: string): void {
    const error = new Error(message);
    this.rejectAllPending(error);
    this.events.emit("error", error);
    void this.stop({ reason: "protocol_error", forceAfterMs: 0 }).catch(() => {});
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of [...this.pending]) {
      this.pending.delete(id);
      if (pending.kind === "call") {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
      }
    }
  }

  private isClosed(): boolean {
    return this.process ? this.process.exitCode !== null || this.process.signalCode !== null : false;
  }
}

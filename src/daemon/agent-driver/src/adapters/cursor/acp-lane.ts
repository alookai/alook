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
import { resolveLaunchFieldsOrDefault } from "../../internal/config.js";
import { killProcessTree, SESSION_STOP_GRACE_MS } from "../../internal/killTree.js";
import { flattenCursorAcpSelectOptions } from "./catalog-probe.js";

const ACP_PROTOCOL_VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const AUTH_METHOD_ID = "cursor_login";
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

interface PromptRequest {
  readonly requestId: number;
  readonly receipt: string;
}

export interface CursorAcpProcessFactory {
  spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess>;
}

interface CursorAcpLaneOptions {
  readonly onRawStdoutLine?: (line: string) => void;
  readonly handshakeTimeoutMs?: number;
}

class CursorAcpResetRequiredError extends Error {}
class CursorAcpIncompatibleError extends Error {}

class CursorAcpRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function safeLabel(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_-]{1,64}$/i.test(value) ? value : "unknown";
}

function rpcErrorMessage(error: unknown): string {
  const payload = record(error);
  const message = typeof payload?.message === "string" && payload.message.trim()
    ? payload.message
    : "Cursor ACP request failed";
  const data = record(payload?.data);
  const detail = typeof data?.message === "string" && data.message.trim() ? data.message : undefined;
  return detail ? `${message}: ${detail}` : message;
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bsession\b.*\b(not found|missing|unknown|invalid)\b/i.test(message)
    || /\b(not found|missing|unknown|invalid)\b.*\bsession\b/i.test(message);
}

export class CursorAcpLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openToolCalls = new Set<string>();
  private process: SpawnedProcessHandle | null = null;
  private stdoutBuffer = "";
  private requestSequence = 0;
  private started = false;
  private ready = false;
  private sessionId: string | null = null;
  private currentPromptRequestId: number | null = null;
  private terminalOwner: string | null = null;
  private requestedStopReason?: string;
  private spawnPromise?: Promise<SpawnedProcess>;
  private stopPromise?: Promise<void>;
  private suppressExit = false;
  private processTerminal = false;
  private processActivated = false;
  private processStartError: Error | null = null;

  constructor(
    private readonly factory: CursorAcpProcessFactory,
    private readonly ctx: AdapterLaunchContext,
    private readonly options: CursorAcpLaneOptions = {},
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
    if (this.started) {
      return { ok: false, reason: "runtime_error", error: "Cursor ACP session already started" };
    }
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
        throw new Error("Cursor ACP start was cancelled");
      }
      await this.handshake(launchCtx);
      if (this.requestedStopReason) {
        await this.stop({ reason: this.requestedStopReason, forceAfterMs: 0 });
        throw new Error("Cursor ACP start was cancelled");
      }
      if (this.processStartError) throw this.processStartError;
      if (this.processTerminal || this.isClosed()) {
        throw new Error("Cursor ACP process exited during startup");
      }
      const sessionId = this.sessionId;
      if (!sessionId) throw new Error("Cursor ACP handshake completed without a session id");
      this.processActivated = true;
      this.ready = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId } satisfies AdapterEvent);
      return this.admitPrompt(input.text);
    } catch (error) {
      // LogicalAgentSession owns failed-start settlement. Do not let the child
      // exit caused by this cleanup race that admission into a false crash.
      this.suppressExit = true;
      await this.stop({ reason: "failed_start", forceAfterMs: 0 }).catch(() => {});
      if (error instanceof CursorAcpResetRequiredError) {
        return { ok: false, reason: "reset_required", error: error.message };
      }
      if (error instanceof CursorAcpIncompatibleError) {
        return { ok: false, reason: "incompatible_configuration", error: error.message };
      }
      throw error;
    }
  }

  async send(input: LaneSendInput): Promise<LaneAdmission> {
    if (!this.ready || !this.process || this.isClosed()) return { ok: false, reason: "closed" };
    if (input.mode === "busy") {
      if (this.currentPromptRequestId === null) {
        return { ok: false, reason: "runtime_busy", error: "Cursor ACP has no active prompt to steer" };
      }
      return this.admitPrompt(input.text, "steer");
    }
    if (this.currentPromptRequestId !== null) {
      return { ok: false, reason: "runtime_busy", error: "Cursor ACP prompt is still active" };
    }
    return this.admitPrompt(input.text);
  }

  async interrupt(_input: LaneInterruptInput): Promise<boolean> {
    if (!this.ready || !this.sessionId || this.currentPromptRequestId === null || this.isClosed()) return false;
    this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    return true;
  }

  stop(input: LaneStopInput = {}): Promise<void> {
    this.requestedStopReason ??= input.reason ?? "requested_stop";
    this.ready = false;
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.openToolCalls.clear();
    this.rejectAllPending(new Error("Cursor ACP lane stopped"));
    this.stopPromise ??= this.stopPhysicalOnce(input);
    return this.stopPromise;
  }

  private async stopPhysicalOnce(input: LaneStopInput): Promise<void> {
    await this.spawnPromise?.catch(() => undefined);
    const proc = this.process;
    if (!proc) return;
    if (proc.pid) {
      await killProcessTree(proc.pid, { graceMs: input.forceAfterMs ?? SESSION_STOP_GRACE_MS });
    } else if (!this.isClosed()) {
      proc.kill(input.signal ?? "SIGTERM");
    }
  }

  private async handshake(ctx: AdapterLaunchContext): Promise<void> {
    const initialize = record(await this.call("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "alook-agent-driver", version: "0.1.14" },
    }));
    if (initialize?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new CursorAcpIncompatibleError("Installed Cursor ACP does not support protocol version 1");
    }
    const capabilities = record(initialize.agentCapabilities);
    if (capabilities?.loadSession !== true) {
      throw new CursorAcpIncompatibleError("Installed Cursor ACP does not support persistent session loading");
    }
    const authMethods = Array.isArray(initialize.authMethods) ? initialize.authMethods : [];
    if (!authMethods.some((method) => record(method)?.id === AUTH_METHOD_ID)) {
      throw new CursorAcpIncompatibleError("Installed Cursor ACP does not expose Cursor login authentication");
    }
    await this.call("authenticate", { methodId: AUTH_METHOD_ID });

    let session: JsonRecord | null;
    if (ctx.config.sessionId) {
      try {
        session = record(await this.call("session/load", {
          sessionId: ctx.config.sessionId,
          cwd: ctx.workingDirectory,
          mcpServers: [],
        }));
      } catch (error) {
        if (isMissingSessionError(error)) {
          throw new CursorAcpResetRequiredError(
            "Cursor session cannot be loaded through ACP; reset this agent to start a new ACP session",
          );
        }
        throw error;
      }
    } else {
      session = record(await this.call("session/new", { cwd: ctx.workingDirectory, mcpServers: [] }));
    }
    if (!session) throw new Error("Cursor ACP did not return a valid session response");
    const returnedSessionId = session.sessionId;
    if (returnedSessionId !== undefined
      && (typeof returnedSessionId !== "string" || !returnedSessionId.trim())) {
      throw new Error("Cursor ACP did not return a valid session id");
    }
    if (ctx.config.sessionId) {
      if (returnedSessionId !== undefined && returnedSessionId !== ctx.config.sessionId) {
        throw new CursorAcpResetRequiredError(
          "Cursor ACP loaded a different session; reset this agent before continuing",
        );
      }
      this.sessionId = ctx.config.sessionId;
    } else {
      if (typeof returnedSessionId !== "string") {
        throw new Error("Cursor ACP did not return a valid session id");
      }
      this.sessionId = returnedSessionId;
    }
    await this.configureModel(session, ctx);
  }

  private async configureModel(session: JsonRecord, ctx: AdapterLaunchContext): Promise<void> {
    const requestedModel = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig).model;
    if (!requestedModel) return;
    const configOptions = Array.isArray(session.configOptions) ? session.configOptions : [];
    const modelConfig = configOptions.map(record).find((option) => option?.id === "model") ?? null;
    if (!modelConfig) {
      throw new CursorAcpIncompatibleError("Installed Cursor ACP does not support model configuration");
    }
    const options = flattenCursorAcpSelectOptions(modelConfig.options);
    const match = options.find((option) => option.value === requestedModel);
    if (!match) {
      throw new CursorAcpIncompatibleError(`Configured Cursor model is unavailable through ACP: ${requestedModel}`);
    }
    let response: JsonRecord | null;
    try {
      response = record(await this.call("session/set_config_option", {
        sessionId: this.sessionId,
        configId: "model",
        value: match.value,
      }));
    } catch {
      throw new CursorAcpIncompatibleError("Installed Cursor ACP rejected model configuration");
    }
    const confirmedOptions = Array.isArray(response?.configOptions) ? response.configOptions : [];
    const confirmedModel = confirmedOptions.map(record).find((option) => option?.id === "model") ?? null;
    if (confirmedModel?.currentValue !== match.value) {
      throw new CursorAcpIncompatibleError("Cursor ACP did not confirm the exact configured model");
    }
  }

  private admitPrompt(text: string, delivery: "prompt" | "steer" = "prompt"): LaneAdmission {
    if (!this.sessionId) return { ok: false, reason: "not_ready", error: "Cursor ACP session is not ready" };
    const requestId = ++this.requestSequence;
    const prompt: PromptRequest = {
      requestId,
      receipt: `cursor:acp:${requestId}`,
    };
    const previousPromptRequestId = this.currentPromptRequestId;
    const previousTerminalOwner = this.terminalOwner;
    const previousOpenToolCalls = new Set(this.openToolCalls);
    if (delivery === "prompt") this.terminalOwner = prompt.receipt;
    this.currentPromptRequestId = requestId;
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
        },
      });
    } catch (error) {
      this.pending.delete(requestId);
      if (this.currentPromptRequestId === requestId) {
        this.currentPromptRequestId = previousPromptRequestId;
        this.terminalOwner = previousTerminalOwner;
        this.openToolCalls.clear();
        for (const toolCallId of previousOpenToolCalls) this.openToolCalls.add(toolCallId);
      }
      throw error;
    }
    return { ok: true, acceptedAs: delivery, receipt: prompt.receipt };
  }

  private completePrompt(prompt: PromptRequest, value: unknown): void {
    if (this.currentPromptRequestId !== prompt.requestId) return;
    const result = record(value);
    if (!result || typeof result.stopReason !== "string" || !PROMPT_STOP_REASONS.has(result.stopReason)) {
      this.failPrompt(
        prompt,
        new Error("Cursor ACP prompt response did not contain a supported stopReason"),
        "cursor.invalid_stop_reason",
      );
      return;
    }
    const terminalOwner = this.terminalOwner ?? prompt.receipt;
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.openToolCalls.clear();
    this.events.emit("runtime_event", {
      kind: "turn_end",
      sessionId: this.sessionId ?? undefined,
      turnOwner: terminalOwner,
    } satisfies AdapterEvent);
  }

  private failPrompt(prompt: PromptRequest, error: unknown, code = "cursor.prompt_failed"): void {
    if (this.currentPromptRequestId !== prompt.requestId) return;
    const terminalOwner = this.terminalOwner ?? prompt.receipt;
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.openToolCalls.clear();
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
  }

  private call(method: string, params: JsonRecord): Promise<unknown> {
    return this.request(method, params, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS).promise;
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
      pending.reject(new Error(`Cursor ACP ${method} timed out`));
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
      throw new Error("Cursor ACP stdin is not writable");
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
        } catch {
          // Observability must not affect protocol handling.
        }
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.protocolFailure("Cursor ACP emitted malformed JSON");
          continue;
        }
        try {
          this.handleMessage(message);
        } catch {
          this.protocolFailure("Cursor ACP could not answer a client-side protocol request");
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
      this.openToolCalls.clear();
      this.stopPromise ??= this.stopPhysicalOnce({ reason: "runtime_error", forceAfterMs: 0 });
      void this.stopPromise.catch(() => {});
      this.events.emit("error", normalized);
      if (this.suppressExit) return;
      this.events.emit("exit", {
        code: null,
        signal: null,
        reason: "runtime_exit",
      });
    });
    proc.on("exit", (code, signal) => {
      if (this.processTerminal || this.process !== proc) return;
      this.processTerminal = true;
      this.ready = false;
      this.currentPromptRequestId = null;
      this.terminalOwner = null;
      this.openToolCalls.clear();
      this.rejectAllPending(new Error("Cursor ACP process exited"));
      if (this.suppressExit || !this.processActivated) return;
      this.events.emit("exit", {
        code,
        signal,
        reason: this.requestedStopReason ? "requested" : "runtime_exit",
      });
    });
  }

  private handleMessage(value: unknown): void {
    const message = record(value);
    if (!message || message.jsonrpc !== "2.0") {
      this.protocolFailure("Cursor ACP emitted an invalid JSON-RPC message");
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method !== "string") {
      this.handleResponse(message.id, message);
      return;
    }
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        this.handleRequest(message.id as JsonRpcId, message.method, message.params);
      } else {
        this.handleNotification(message.method, message.params);
      }
      return;
    }
    this.protocolFailure("Cursor ACP emitted an unrecognized JSON-RPC message");
  }

  private handleResponse(id: JsonRpcId, message: JsonRecord): void {
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (typeof id !== "number" || !pending) {
      this.diagnostic("warning", "Cursor ACP emitted a duplicate or unknown response id");
      return;
    }
    if (pending.kind === "prompt") {
      this.pending.delete(id);
      if (message.error !== undefined) {
        const payload = record(message.error);
        const rpcCode = typeof payload?.code === "number" && Number.isSafeInteger(payload.code)
          ? payload.code
          : undefined;
        this.failPrompt(
          pending.prompt,
          new CursorAcpRpcError(pending.method, rpcCode, rpcErrorMessage(message.error)),
          rpcCode === undefined ? "cursor.rpc_error" : `cursor.rpc.${rpcCode}`,
        );
      } else if (!("result" in message)) {
        this.failPrompt(
          pending.prompt,
          new Error("Cursor ACP response omitted result"),
          "cursor.invalid_response",
        );
      } else {
        this.completePrompt(pending.prompt, message.result);
      }
      return;
    }
    if (message.error !== undefined) {
      const payload = record(message.error);
      this.settleRequest(id, false, new CursorAcpRpcError(
        pending.method,
        typeof payload?.code === "number" ? payload.code : undefined,
        rpcErrorMessage(message.error),
      ));
      return;
    }
    if (!("result" in message)) {
      this.settleRequest(id, false, new Error("Cursor ACP response omitted result"));
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
      this.write({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unsupported Cursor ACP client request" },
      });
      this.diagnostic("warning", `Unsupported Cursor ACP client request: ${safeLabel(method)}`);
      return;
    }
    const payload = record(params);
    const sameSession = payload?.sessionId === this.sessionId;
    const options = Array.isArray(payload?.options) ? payload.options.map(record).filter(Boolean) as JsonRecord[] : [];
    const allowOnce = options.find((option) => (
      option.kind === "allow_once"
      && typeof option.optionId === "string"
      && option.optionId.trim().length > 0
    ));
    if (!this.ready || this.currentPromptRequestId === null || !sameSession || !allowOnce) {
      this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      this.diagnostic("error", "Cursor ACP permission request was not allowed for the active prompt");
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      result: { outcome: { outcome: "selected", optionId: allowOnce.optionId } },
    });
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === "session/update") {
      this.handleSessionUpdate(params);
      return;
    }
    this.diagnostic("warning", `Unsupported Cursor ACP notification: ${safeLabel(method)}`);
  }

  private handleSessionUpdate(params: unknown): void {
    const payload = record(params);
    if (!payload || payload.sessionId !== this.sessionId) {
      this.diagnostic("warning", "Cursor ACP emitted an update for a different session");
      return;
    }
    if (!this.ready || this.currentPromptRequestId === null) {
      this.diagnostic("warning", "Cursor ACP emitted a session update without an active prompt");
      return;
    }
    const update = record(payload.update) ?? {};
    const updateType = update?.sessionUpdate;
    switch (updateType) {
      case "agent_message_chunk": {
        const content = record(update.content);
        if (content?.type === "text" && typeof content.text === "string") {
          this.events.emit("runtime_event", { kind: "assistant_message_delta", text: content.text } satisfies AdapterEvent);
        }
        return;
      }
      case "agent_thought_chunk": {
        const content = record(update.content);
        if (content?.type === "text" && typeof content.text === "string") {
          this.events.emit("runtime_event", { kind: "assistant_reasoning_delta", text: content.text } satisfies AdapterEvent);
        }
        return;
      }
      case "user_message_chunk":
        return;
      case "tool_call": {
        if (typeof update.toolCallId !== "string" || typeof update.title !== "string") {
          this.diagnostic("warning", "Cursor ACP emitted a malformed tool_call update");
          return;
        }
        this.openToolCalls.add(update.toolCallId);
        this.events.emit("runtime_event", {
          kind: "tool_call",
          name: update.title,
          input: update.rawInput,
        } satisfies AdapterEvent);
        return;
      }
      case "tool_call_update": {
        if (
          typeof update.toolCallId === "string"
          && (update.status === "completed" || update.status === "failed")
          && this.openToolCalls.delete(update.toolCallId)
        ) {
          this.events.emit("runtime_event", {
            kind: "tool_output",
            name: typeof update.title === "string" ? update.title : "Cursor tool",
          } satisfies AdapterEvent);
        }
        return;
      }
      case "plan":
        this.events.emit("runtime_event", {
          kind: "internal_progress",
          source: "cursor.acp",
          itemType: "plan",
        } satisfies AdapterEvent);
        return;
      default:
        this.diagnostic("warning", `Unsupported Cursor ACP session update: ${safeLabel(updateType)}`);
    }
  }

  private diagnostic(severity: "error" | "warning", message: string): void {
    this.events.emit("runtime_event", {
      kind: "runtime_diagnostic",
      severity,
      source: "cursor.acp",
      message,
    } satisfies AdapterEvent);
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

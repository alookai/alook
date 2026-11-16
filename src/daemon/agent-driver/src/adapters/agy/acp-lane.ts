import { Utf8LineFramer, Utf8TextDecoder } from "../../internal/utf8-lines.js";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import { SettledUsageProjector } from "../../internal/token-usage.js";
import type { InputReference, RuntimeSettingsUpdate, RuntimeSettingsUpdateResult } from "../../contract.js";

import { agyStateHome, NativeExecutionReader } from "./execution.js";

const ACP_PROTOCOL_VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 15_000;

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
  readonly inputs: readonly InputReference[];
  readonly text: string;
  readonly steered: boolean;
}

interface AgyAcpProcessFactory {
  spawn(ctx: AdapterLaunchContext): Promise<SpawnedProcess & { stateHome?: string }>;
}

interface AgyAcpLaneOptions {
  readonly onRawStdoutLine?: (line: string) => void;
  readonly handshakeTimeoutMs?: number;
  readonly executionReader?: Pick<NativeExecutionReader, "checkpoint" | "terminal">;
}

class AgyAcpResetRequiredError extends Error {}
class AgyAcpIncompatibleError extends Error {}

class AgyAcpRpcError extends Error {
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
    : "Agy ACP request failed";
  const data = record(payload?.data);
  const detail = typeof data?.message === "string" && data.message.trim() ? data.message : undefined;
  return detail ? `${message}: ${detail}` : message;
}

function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bsession\b.*\b(not found|missing|unknown|invalid)\b/i.test(message)
    || /\b(not found|missing|unknown|invalid)\b.*\bsession\b/i.test(message);
}

export class AgyAcpLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly toolCalls = new Map<string, string | null>();
  private process: SpawnedProcessHandle | null = null;
  private requestSequence = 0;
  private started = false;
  private ready = false;
  private sessionId: string | null = null;
  private currentPromptRequestId: number | null = null;
  private terminalOwner: string | null = null;
  private readonly promptOutcomes = new Map<number, { stopReason: string; error?: Error; usage?: JsonRecord }>();
  private readonly observedPrompts = new Set<number>();
  private readonly usage = new SettledUsageProjector();
  private readonly usageSource = `agy:acp:${randomUUID()}`;
  private loopStartedAt = "";
  private usageProfile: { inputIncludesCache: boolean; outputIncludesReasoning: boolean } | undefined;
  private executionReader?: Pick<NativeExecutionReader, "checkpoint" | "terminal">;
  private executionRead?: Promise<unknown>;
  private executionCheckpoint?: Awaited<ReturnType<NativeExecutionReader["checkpoint"]>>;
  private stateHome = "";
  private finishing = false;
  private admitting = false;
  private readonly configOptions = new Map<string, JsonRecord>();
  private readonly observedOptions = new Map<string, unknown>();
  private configWaiter?: { id: string; value: string; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private requestedStopReason?: string;
  private spawnPromise?: Promise<SpawnedProcess & { stateHome?: string }>;
  private stopPromise?: Promise<void>;
  private suppressExit = false;
  private processTerminal = false;
  private processActivated = false;
  private processStartError: Error | null = null;

  constructor(
    private readonly factory: AgyAcpProcessFactory,
    private readonly ctx: AdapterLaunchContext,
    private readonly options: AgyAcpLaneOptions = {},
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
      return { ok: false, reason: "runtime_error", error: "Agy ACP session already started" };
    }
    this.started = true;
    const launchCtx: AdapterLaunchContext = {
      ...this.ctx,
      prompt: input.text,
      config: { ...this.ctx.config, sessionId: input.sessionId ?? this.ctx.config.sessionId },
    };
    try {
      this.spawnPromise = this.factory.spawn(launchCtx).then((spawned) => {
        this.stateHome = spawned.stateHome ?? agyStateHome(process.env, launchCtx.workingDirectory);
        this.process = spawned.process;
        this.attachProcess(spawned.process);
        return spawned;
      });
      await this.spawnPromise;
      if (this.requestedStopReason) {
        await this.stop({ reason: this.requestedStopReason, forceAfterMs: 0 });
        throw new Error("Agy ACP start was cancelled");
      }
      await this.handshake(launchCtx);
      if (this.requestedStopReason) {
        await this.stop({ reason: this.requestedStopReason, forceAfterMs: 0 });
        throw new Error("Agy ACP start was cancelled");
      }
      if (this.processStartError) throw this.processStartError;
      if (this.processTerminal || this.isClosed()) {
        throw new Error("Agy ACP process exited during startup");
      }
      const sessionId = this.sessionId;
      if (!sessionId) throw new Error("Agy ACP handshake completed without a session id");
      this.executionReader = this.options.executionReader ?? new NativeExecutionReader(this.stateHome, sessionId);
      this.processActivated = true;
      this.ready = true;
      this.events.emit("runtime_event", { kind: "session_init", sessionId, acquisition: { status: input.sessionId ? "resumed" : "created", evidence: "native_api" } } satisfies AdapterEvent);
      const admission = await this.admitRoot(input.text, input.inputs);
      if (!admission.ok) throw new AgyAcpIncompatibleError(admission.error ?? "Native execution state unavailable");
      return admission;
    } catch (error) {
      this.suppressExit = true;
      await this.stop({ reason: "failed_start", forceAfterMs: 0 }).catch(() => {});
      if (error instanceof AgyAcpResetRequiredError) {
        return { ok: false, reason: "reset_required", error: error.message };
      }
      if (error instanceof AgyAcpIncompatibleError) {
        return { ok: false, reason: "incompatible_configuration", error: error.message };
      }
      if (error instanceof Error && /authentication (required|failed)|not authenticated|sign[ -]?in required/i.test(error.message)) {
        return { ok: false, reason: "authentication", error: "Antigravity CLI authentication is unavailable. Run the configured Antigravity CLI in a terminal, complete sign-in, then retry." };
      }
      throw error;
    }
  }

  async send(input: LaneSendInput): Promise<LaneAdmission> {
    if (!this.ready || !this.process || this.isClosed()) return { ok: false, reason: "closed" };
    if (this.finishing || this.admitting) return { ok: false, reason: "runtime_busy", error: "Agy ACP root boundary is being verified" };
    if (input.mode === "busy") {
      if (this.currentPromptRequestId === null) {
        return { ok: false, reason: "runtime_busy", error: "Agy ACP has no active prompt to steer" };
      }
      return this.admitPrompt(input.text, "steer", input.inputs);
    }
    if (this.currentPromptRequestId !== null) {
      return { ok: false, reason: "runtime_busy", error: "Agy ACP prompt is still active" };
    }
    return await this.admitRoot(input.text, input.inputs);
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
    this.toolCalls.clear();
    this.rejectAllPending(new Error("Agy ACP lane stopped"));
    this.promptOutcomes.clear();
    this.observedPrompts.clear();
    this.usage.reset();
    const waiter = this.configWaiter;
    if (waiter) { clearTimeout(waiter.timer); this.configWaiter = undefined; waiter.reject(new Error("Antigravity CLI lane stopped")); }
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
    await this.executionRead?.catch(() => undefined);
  }

  private async handshake(ctx: AdapterLaunchContext): Promise<void> {
    const initialize = record(await this.call("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "alook-agent-driver", version: "1" },
    }));
    if (initialize?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AgyAcpIncompatibleError("Installed Agy ACP does not support protocol version 1");
    }
    const capabilities = record(initialize.agentCapabilities);
    if (capabilities?.loadSession !== true) {
      throw new AgyAcpIncompatibleError("Installed Agy ACP does not support persistent session loading");
    }
    if (record(initialize.agentInfo)?.name !== "Antigravity ACP Server") {
      throw new AgyAcpIncompatibleError("Expected the native Antigravity CLI ACP server");
    }
    const version = record(initialize.agentInfo)?.version;
    this.usageProfile = version === "1.4.12" ? { inputIncludesCache: true, outputIncludesReasoning: false }
      : version === "1.5.9" ? { inputIncludesCache: false, outputIncludesReasoning: true } : undefined;
    if (!record(record(initialize.agentCapabilities)?.sessionCapabilities)?.resume) {
      throw new AgyAcpIncompatibleError("Antigravity CLI ACP does not support native session resume");
    }
    const native = record(record(capabilities?._meta)?.antigravity);
    if (ctx.standingPrompt && record(native?.systemPrompt)?.append !== true) {
      throw new AgyAcpIncompatibleError("Antigravity CLI ACP does not support native standing instructions");
    }
    const meta = ctx.standingPrompt ? { _meta: { antigravity: { systemPrompt: { append: ctx.standingPrompt } } } } : {};

    let session: JsonRecord | null;
    if (ctx.config.sessionId) {
      await this.confirmResumeCwd(ctx.config.sessionId, ctx.workingDirectory, initialize);
      try {
        session = record(await this.call("session/resume", {
          sessionId: ctx.config.sessionId,
          cwd: ctx.workingDirectory,
          mcpServers: [],
          ...meta,
        }));
      } catch (error) {
        if (isMissingSessionError(error)) {
          throw new AgyAcpResetRequiredError(
            "Agy session cannot be loaded through ACP; reset this agent to start a new ACP session",
          );
        }
        throw error;
      }
    } else {
      session = record(await this.call("session/new", { cwd: ctx.workingDirectory, mcpServers: [], ...meta }));
    }
    if (!session) throw new Error("Agy ACP did not return a valid session response");
    const returnedSessionId = session.sessionId;
    if (returnedSessionId !== undefined
      && (typeof returnedSessionId !== "string" || !returnedSessionId.trim())) {
      throw new Error("Agy ACP did not return a valid session id");
    }
    if (ctx.config.sessionId) {
      if (returnedSessionId !== undefined && returnedSessionId !== ctx.config.sessionId) {
        throw new AgyAcpResetRequiredError(
          "Agy ACP loaded a different session; reset this agent before continuing",
        );
      }
      this.sessionId = ctx.config.sessionId;
    } else {
      if (typeof returnedSessionId !== "string") {
        throw new Error("Agy ACP did not return a valid session id");
      }
      this.sessionId = returnedSessionId;
    }
    await this.configureModel(session, ctx);
  }

  private async confirmResumeCwd(sessionId: string, cwd: string, initialized: JsonRecord): Promise<void> {
    const capabilities = record(record(initialized.agentCapabilities)?.sessionCapabilities);
    if (!record(capabilities?.list)) throw new AgyAcpResetRequiredError("Antigravity CLI cannot confirm the saved session directory");
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 32; page++) {
      const response = record(await this.call("session/list", { ...(cursor ? { cursor } : {}) }));
      const sessions = response?.sessions;
      if (!Array.isArray(sessions)) break;
      const saved = sessions.map(record).find((value) => value?.sessionId === sessionId);
      if (saved) {
        if (typeof saved.cwd !== "string" || !saved.cwd.trim()) break;
        let actual: string = saved.cwd;
        if (actual.startsWith("file:")) {
          try { actual = fileURLToPath(actual); } catch { break; }
        }
        if (process.platform === "win32" && /^\/[a-z]:[\/]/i.test(actual)) actual = actual.slice(1);
        if (resolve(actual) !== resolve(cwd)) {
          let sameDirectory = false;
          try { const paths = await Promise.all([realpath(actual), realpath(cwd)]); sameDirectory = paths[0] === paths[1]; } catch {}
          if (!sameDirectory) throw new AgyAcpResetRequiredError("Antigravity CLI saved session directory differs; reset explicitly before starting elsewhere");
        }
        return;
      }
      if (typeof response?.nextCursor !== "string" || !response.nextCursor || seen.has(response.nextCursor)) break;
      cursor = response.nextCursor;
      seen.add(cursor);
    }
    throw new AgyAcpResetRequiredError("Antigravity CLI could not verify the saved session directory; reset explicitly");
  }

  private rememberConfig(value: unknown, observed = false): void {
    const options = record(value)?.configOptions;
    if (!Array.isArray(options)) return;
    for (const item of options) {
      const option = record(item);
      if (typeof option?.id !== "string") continue;
      this.configOptions.set(option.id, option);
      if (observed) this.observedOptions.set(option.id, option.currentValue);
    }
    const waiter = this.configWaiter;
    if (waiter && this.observedOptions.get(waiter.id) === waiter.value) {
      clearTimeout(waiter.timer);
      this.configWaiter = undefined;
      waiter.resolve();
    }
  }

  private selectValues(id: string): string[] {
    const values: string[] = [];
    const walk = (items: unknown) => {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const option = record(item);
        if (typeof option?.value === "string") values.push(option.value);
        walk(option?.options);
      }
    };
    walk(this.configOptions.get(id)?.options);
    return values;
  }

  private async setOption(id: string, value: string): Promise<void> {
    if (!this.selectValues(id).includes(value)) throw new AgyAcpIncompatibleError(`Antigravity CLI did not offer configured ${id}: ${value}`);
    this.observedOptions.delete(id);
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.configWaiter = undefined;
        reject(new AgyAcpIncompatibleError(`Antigravity CLI did not confirm ${id}: ${value}`));
      }, this.options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      this.configWaiter = { id, value, resolve, reject, timer };
    });
    void observed.catch(() => {});
    try {
      const response = await this.call("session/set_config_option", { sessionId: this.sessionId, configId: id, value });
      this.rememberConfig(response);
      if (this.configOptions.get(id)?.currentValue !== value) throw new AgyAcpIncompatibleError(`Antigravity CLI returned a different ${id}`);
      await observed;
    } catch (error) {
      const waiter = this.configWaiter;
      if (waiter) { clearTimeout(waiter.timer); this.configWaiter = undefined; waiter.reject(error instanceof Error ? error : new Error(String(error))); }
      throw error;
    }
  }

  private async configureModel(session: JsonRecord, ctx: AdapterLaunchContext): Promise<void> {
    this.rememberConfig(session);
    const requested = resolveLaunchFieldsOrDefault(ctx.config.runtimeConfig);
    let model = requested.model;
    let effort = requested.reasoningEffort;
    if (model && !this.selectValues("model").includes(model)) {
      const legacy = record(session.models);
      const available = Array.isArray(legacy?.availableModels) ? legacy.availableModels : [];
      if (!available.some((item) => record(item)?.modelId === model)) throw new AgyAcpIncompatibleError("Configured Antigravity CLI model is unavailable");
      const family = this.selectValues("model").filter((value) => model!.startsWith(value + "-")).sort((a, b) => b.length - a.length)[0];
      if (!family) throw new AgyAcpIncompatibleError("Configured Antigravity CLI model has no native family");
      effort ??= model.slice(family.length + 1);
      model = family;
    }
    if (model) await this.setOption("model", model);
    if (effort) await this.setOption("thought_level", effort);
    this.events.emit("runtime_event", { kind: "configuration_observed", observation: {
      evidence: "observed", effective: "current",
      ...(typeof this.configOptions.get("model")?.currentValue === "string" ? { model: this.configOptions.get("model")!.currentValue as string } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    } } satisfies AdapterEvent);
  }

  async updateSettings(input: RuntimeSettingsUpdate): Promise<RuntimeSettingsUpdateResult> {
    if (!this.ready || this.isClosed()) return { status: "failed", error: { category: "process", code: "settings_session_unavailable", message: "Antigravity CLI session is unavailable", retryable: true } };
    if (this.currentPromptRequestId !== null) return { status: "failed", error: { category: "configuration", code: "settings_runtime_busy", message: "Antigravity CLI settings require an idle session", retryable: true } };
    if (!input.reasoningEffort) return { status: "unsupported" };
    try {
      await this.setOption("thought_level", input.reasoningEffort);
      return { status: "acknowledged", effective: "next_turn" };
    } catch (error) {
      return { status: "failed", error: { category: "configuration", code: "settings_update_failed", message: String(error), retryable: true } };
    }
  }

  private async admitRoot(text: string, inputs: readonly InputReference[] = []): Promise<LaneAdmission> {
    this.admitting = true;
    try {
      const read = this.executionReader!.checkpoint();
      this.executionRead = read;
      const checkpoint = await read;
      if (!this.ready || this.requestedStopReason || this.isClosed()) return { ok: false, reason: "closed" };
      this.executionCheckpoint = checkpoint;
      return this.admitPrompt(text, "prompt", inputs);
    } catch {
      return { ok: false, reason: "runtime_error", error: "Antigravity CLI native execution state cannot be verified. A readable native conversation database and the packaged SQLite runtime are required." };
    } finally { this.executionRead = undefined; this.admitting = false; }
  }

  private admitPrompt(text: string, delivery: "prompt" | "steer" = "prompt", inputs: readonly InputReference[] = []): LaneAdmission {
    if (!this.sessionId) return { ok: false, reason: "not_ready", error: "Agy ACP session is not ready" };
    const requestId = ++this.requestSequence;
    const prompt: PromptRequest = {
      requestId,
      receipt: `agy:acp:${requestId}`,
      inputs, text, steered: delivery === "steer",
    };
    const previousPromptRequestId = this.currentPromptRequestId;
    const previousTerminalOwner = this.terminalOwner;
    const previousToolCalls = new Map(this.toolCalls);
    if (delivery === "prompt") this.terminalOwner = prompt.receipt;
    this.currentPromptRequestId = requestId;
    if (delivery === "prompt") {
      this.toolCalls.clear();
      this.promptOutcomes.clear();
      this.observedPrompts.clear();
      this.loopStartedAt = new Date().toISOString();
    }
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
        this.toolCalls.clear();
        for (const [toolCallId, name] of previousToolCalls) this.toolCalls.set(toolCallId, name);
      }
      throw error;
    }
    return { ok: true, acceptedAs: delivery, receipt: prompt.receipt };
  }

  private completePrompt(prompt: PromptRequest, value: unknown): void {
    if (!this.terminalOwner) return;
    const result = record(value);
    if (typeof result?.stopReason !== "string" || !PROMPT_STOP_REASONS.has(result.stopReason)) {
      this.failPrompt(prompt, new Error("Antigravity CLI prompt response has no supported stopReason"), "agy.invalid_response");
      return;
    }
    this.promptOutcomes.set(prompt.requestId, { stopReason: result.stopReason, ...(record(result.usage) ? { usage: record(result.usage)! } : {}) });
    this.finishLoop();
  }

  private failPrompt(prompt: PromptRequest, error: unknown, code = "agy.prompt_failed"): void {
    if (!this.terminalOwner) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (prompt.steered && error instanceof AgyAcpRpcError && error.code === -32602) {
      this.events.emit("runtime_event", { kind: "input_returned", inputs: prompt.inputs, evidence: "explicitly_rejected", reason: code } satisfies AdapterEvent);
    } else {
      this.promptOutcomes.set(prompt.requestId, { stopReason: "failed", error: normalized });
    }
    this.finishLoop();
  }

  private finishLoop(): void {
    if (this.finishing || !this.terminalOwner || [...this.pending.values()].some((value) => value.kind === "prompt")) return;
    this.finishing = true;
    const owner = this.terminalOwner;
    void this.verifyLoop(owner);
  }

  private async verifyLoop(owner: string): Promise<void> {
    let nativeOutcome: "success" | "interrupted" | "failed" = "failed";
    let verificationError: Error | undefined;
    try {
      if (!this.executionReader || !this.executionCheckpoint) throw new Error("Native execution checkpoint missing");
      const read = this.executionReader.terminal(this.executionCheckpoint);
      this.executionRead = read;
      nativeOutcome = await read;
    } catch { verificationError = new Error("Antigravity CLI native execution terminal could not be verified"); }
    finally { this.executionRead = undefined; }
    if (this.terminalOwner !== owner || this.requestedStopReason || this.processTerminal) return;
    this.finishing = false;
    const outcomes = [...this.promptOutcomes].sort(([a], [b]) => b - a);
    let latest = outcomes.find(([, outcome]) => outcome.error)?.[1] ?? outcomes[0]?.[1];
    if (verificationError || nativeOutcome === "failed") latest = { stopReason: "failed", error: verificationError ?? new Error("Antigravity CLI native executor failed") };
    else if (!latest?.error && nativeOutcome === "interrupted") latest = { ...latest, stopReason: "cancelled" };
    const terminalOwner = this.terminalOwner;
    const usage = outcomes.find(([, outcome]) => outcome.usage)?.[1].usage;
    const projected = usage && this.sessionId && this.usageProfile ? this.usage.project({
      runtime: "antigravity-cli", backendSessionId: this.sessionId, providerRecordId: terminalOwner,
      source: "agy.acp", input: usage.inputTokens, output: usage.outputTokens,
      reasoning: usage.thoughtTokens, cacheRead: usage.cachedReadTokens, cacheWrite: usage.cachedWriteTokens,
      ...this.usageProfile,
    }) : null;
    if (projected?.kind === "telemetry" && projected.name === "token_usage") {
      this.events.emit("runtime_event", { ...projected, identity: {
        source: `${this.usageSource}:${this.sessionId}`, index: Number(terminalOwner.split(":").at(-1)), occurredAt: this.loopStartedAt,
      } } satisfies AdapterEvent);
    }
    this.events.emit("runtime_event", { kind: "telemetry", name: "token_usage_status", source: "agy.acp", status: projected ? "available" : "unavailable" } satisfies AdapterEvent);
    this.usage.reset();
    this.currentPromptRequestId = null;
    this.terminalOwner = null;
    this.toolCalls.clear();
    this.promptOutcomes.clear();
    this.observedPrompts.clear();
    if (!latest) {
      this.events.emit("runtime_event", { kind: "error", code: "agy.missing_outcome", message: "Antigravity CLI loop ended without a native outcome" } satisfies AdapterEvent);
    } else if (latest.error) {
      this.events.emit("runtime_event", { kind: "error", code: "agy.prompt_failed", message: latest.error.message } satisfies AdapterEvent);
    }
    this.events.emit("runtime_event", {
      kind: "turn_end", sessionId: this.sessionId ?? undefined, turnOwner: terminalOwner,
      outcome: latest?.stopReason === "cancelled" ? "interrupted" : latest?.stopReason === "end_turn" ? "success" : "failed",
      stopReason: latest?.stopReason,
      ...(latest?.stopReason === "cancelled" ? { pendingContent: "discard" as const } : {}),
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
      pending.reject(new Error(`Agy ACP ${method} timed out`));
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
      throw new Error("Agy ACP stdin is not writable");
    }
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private attachProcess(proc: SpawnedProcessHandle): void {
    const stdout = new Utf8LineFramer();
    const stderr = new Utf8TextDecoder();
    proc.stdout?.on("data", (chunk) => {
      const lines = stdout.write(chunk);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.options.onRawStdoutLine?.(line);
        } catch {
        }
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.protocolFailure("Agy ACP emitted malformed JSON");
          continue;
        }
        try {
          this.handleMessage(message);
        } catch {
          this.protocolFailure("Agy ACP could not answer a client-side protocol request");
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      const text = stderr.write(chunk).trim();
      if (text) this.events.emit("stderr", text);
    });
    proc.stderr?.on("end", () => {
      const text = stderr.end().trim();
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
      this.toolCalls.clear();
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
      this.toolCalls.clear();
      this.rejectAllPending(new Error("Agy ACP process exited"));
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
      this.protocolFailure("Agy ACP emitted an invalid JSON-RPC message");
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
    this.protocolFailure("Agy ACP emitted an unrecognized JSON-RPC message");
  }

  private handleResponse(id: JsonRpcId, message: JsonRecord): void {
    const pending = typeof id === "number" ? this.pending.get(id) : undefined;
    if (typeof id !== "number" || !pending) {
      this.diagnostic("warning", "Agy ACP emitted a duplicate or unknown response id");
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
          new AgyAcpRpcError(pending.method, rpcCode, rpcErrorMessage(message.error)),
          rpcCode === undefined ? "agy.rpc_error" : `agy.rpc.${rpcCode}`,
        );
      } else if (!("result" in message)) {
        this.failPrompt(
          pending.prompt,
          new Error("Agy ACP response omitted result"),
          "agy.invalid_response",
        );
      } else {
        this.completePrompt(pending.prompt, message.result);
      }
      return;
    }
    if (message.error !== undefined) {
      const payload = record(message.error);
      this.settleRequest(id, false, new AgyAcpRpcError(
        pending.method,
        typeof payload?.code === "number" ? payload.code : undefined,
        rpcErrorMessage(message.error),
      ));
      return;
    }
    if (!("result" in message)) {
      this.settleRequest(id, false, new Error("Agy ACP response omitted result"));
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
        error: { code: -32601, message: "Unsupported Agy ACP client request" },
      });
      this.diagnostic("warning", `Unsupported Agy ACP client request: ${safeLabel(method)}`);
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
      this.diagnostic("error", "Agy ACP permission request was not allowed for the active prompt");
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
    this.diagnostic("warning", `Unsupported Agy ACP notification: ${safeLabel(method)}`);
  }

  private handleSessionUpdate(params: unknown): void {
    const payload = record(params);
    if (!payload || payload.sessionId !== this.sessionId) {
      this.diagnostic("warning", "Agy ACP emitted an update for a different session");
      return;
    }
    const configuration = record(payload.update);
    if (configuration?.sessionUpdate === "config_option_update") {
      this.rememberConfig(configuration, true);
      return;
    }
    if (!this.ready || this.currentPromptRequestId === null) {
      this.diagnostic("warning", "Agy ACP emitted a session update without an active prompt");
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
      case "user_message_chunk": {
        const content = record(update.content);
        if (content?.type !== "text" || typeof content.text !== "string") return;
        const matching = [...this.pending.values()].find((value) => value.kind === "prompt" && value.prompt.text === content.text && !this.observedPrompts.has(value.prompt.requestId));
        if (matching?.kind === "prompt") {
          this.observedPrompts.add(matching.prompt.requestId);
          this.events.emit("runtime_event", { kind: "input_observed", inputs: matching.prompt.inputs, evidence: "user_message" } satisfies AdapterEvent);
        }
        return;
      }
      case "session_info_update":
      case "available_commands_update":
      case "usage_update":
        return;
      case "tool_call": {
        if (typeof update.toolCallId !== "string" || typeof update.title !== "string") {
          this.diagnostic("warning", "Agy ACP emitted a malformed tool_call update");
          return;
        }
        if (!this.toolCalls.has(update.toolCallId)) {
          const name = typeof update.name === "string" ? update.name : update.title;
          this.toolCalls.set(update.toolCallId, name);
          this.events.emit("runtime_event", {
            kind: "tool_call", callId: update.toolCallId, name, input: update.rawInput,
          } satisfies AdapterEvent);
        }
        if ((update.status === "completed" || update.status === "failed") && this.toolCalls.get(update.toolCallId) !== null) {
          const name = this.toolCalls.get(update.toolCallId) ?? update.title;
          this.toolCalls.set(update.toolCallId, null);
          this.events.emit("runtime_event", {
            kind: "tool_output", callId: update.toolCallId, name,
            outcome: update.status === "failed" ? "failed" : "success", output: update.rawOutput,
          } satisfies AdapterEvent);
        }
        return;
      }
      case "tool_call_update": {
        if (
          typeof update.toolCallId === "string"
          && (update.status === "completed" || update.status === "failed")
        ) {
          const name = this.toolCalls.get(update.toolCallId);
          if (name === undefined || name === null) return;
          this.toolCalls.set(update.toolCallId, null);
          this.events.emit("runtime_event", {
            kind: "tool_output",
            callId: update.toolCallId,
            outcome: update.status === "failed" ? "failed" : "success", output: update.rawOutput,
            name,
          } satisfies AdapterEvent);
        }
        return;
      }
      case "plan":
        this.events.emit("runtime_event", {
          kind: "internal_progress",
          source: "agy.acp",
          itemType: "plan",
        } satisfies AdapterEvent);
        return;
      default:
        this.diagnostic("warning", `Unsupported Agy ACP session update: ${safeLabel(updateType)}`);
    }
  }

  private diagnostic(severity: "error" | "warning", message: string): void {
    this.events.emit("runtime_event", {
      kind: "runtime_diagnostic",
      severity,
      source: "agy.acp",
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

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
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

const SUPPORTED_VERSION = "1.17.20";
const HOST = "127.0.0.1";
const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 100;
const ACTIVE_POLL_MS = 50;
const PORT_ATTEMPTS = 3;
const HISTORY_PAGE_LIMIT = 100;

type JsonRecord = Record<string, unknown>;

interface ServiceIdentity {
  readonly generation: number;
  readonly process: SpawnedProcessHandle;
  readonly pid: number;
}

interface TurnOutcome {
  readonly seq: number;
  readonly ok: boolean;
  readonly message?: string;
}

interface ActiveRoot {
  readonly receipt: string;
  readonly baselineSeq: number;
  readonly frontier: Map<string, number>;
  readonly durableAdmissions: Map<string, number>;
  readonly observedAdmissions: Set<string>;
  readonly outcomes: TurnOutcome[];
  generation: number;
  pendingAdmissions: number;
  interrupted: boolean;
  interruptPending: boolean;
}

interface StreamGate {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface OpenCodeServiceLaneOptions {
  readonly onRawStdoutLine?: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly allocatePort?: () => Promise<number>;
  readonly startTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly reconnectDelayMs?: number;
  readonly activePollMs?: number;
  readonly portAttempts?: number;
  readonly password?: string;
}

export interface OpenCodeServiceProcessFactory {
  spawnService(ctx: AdapterLaunchContext, port: number, password: string): Promise<SpawnedProcess>;
}

class OpenCodeIncompatibleError extends Error {}
class OpenCodeResetRequiredError extends Error {}
class OpenCodePortBindError extends Error {}
class OpenCodeProtocolError extends Error {}
class OpenCodeStoppedError extends Error {}

class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    super(`OpenCode ${operation} failed with HTTP ${status}`);
  }
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function safeLabel(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(value) ? value : "unknown";
}

function makeGate(): StreamGate {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: HOST, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("OpenCode port allocation returned no TCP address")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function parseModelRef(model: string | undefined): JsonRecord | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash < 1 || slash === model.length - 1) {
    throw new OpenCodeIncompatibleError("Configured OpenCode model must use provider/model form for the v2 API");
  }
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) };
}

function messageFromError(value: unknown): string {
  const payload = record(value);
  const message = typeof payload?.message === "string" && payload.message.trim()
    ? payload.message
    : undefined;
  return message ? "OpenCode turn failed" : "OpenCode reported an inconsistent turn outcome";
}

export class OpenCodeServiceLane implements RuntimeLane {
  private readonly events = new EventEmitter();
  private readonly fetchFn: typeof fetch;
  private readonly password: string;
  private readonly requestControllers = new Set<AbortController>();
  private process: SpawnedProcessHandle | null = null;
  private identity: ServiceIdentity | null = null;
  private baseUrl = "";
  private sessionId: string | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private serviceGeneration = 0;
  private started = false;
  private ready = false;
  private stopping = false;
  private requestedStopReason?: string;
  private suppressExit = false;
  private serviceActivated = false;
  private processStartError: Error | null = null;
  private spawnPromise: Promise<SpawnedProcess> | null = null;
  private stopPromise?: Promise<void>;
  private readonly processStopPromises = new WeakMap<object, Promise<void>>();
  private terminalProcessGeneration: number | null = null;
  private durableAbort?: AbortController;
  private liveAbort?: AbortController;
  private durableTask?: Promise<void>;
  private liveTask?: Promise<void>;
  private durableBootstrapAdmissionUsed = false;
  private durableGate = makeGate();
  private liveGate = makeGate();
  private durableGap = true;
  private lastDurableSeq = 0;
  private readonly durableSeqById = new Map<string, number>();
  private readonly durableIdBySeq = new Map<number, string>();
  private readonly toolNames = new Map<string, string>();
  private readonly handledPermissions = new Set<string>();
  private readonly permissionFlights = new Map<string, Promise<void>>();
  private activeRoot: ActiveRoot | null = null;
  private admissionTail: Promise<void> = Promise.resolve();
  private historyTail: Promise<void> = Promise.resolve();
  private evaluationTimer?: ReturnType<typeof setTimeout>;
  private evaluating = false;
  private reevaluate = false;
  private reevaluateDelayMs: number | undefined;
  private identityFailed = false;

  constructor(
    private readonly factory: OpenCodeServiceProcessFactory,
    private readonly ctx: AdapterLaunchContext,
    private readonly options: OpenCodeServiceLaneOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.password = options.password ?? randomBytes(32).toString("base64url");
  }

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
    if (this.started) return { ok: false, reason: "already_started", error: "OpenCode service lane already started" };
    this.started = true;
    try {
      await this.startService();
      const startupIdentity = this.identity;
      if (!startupIdentity) throw new Error("OpenCode service started without an identity");
      this.assertStartupIdentity(startupIdentity);
      await this.openSession(input.sessionId ?? this.ctx.config.sessionId);
      this.assertStartupIdentity(startupIdentity);
      await this.primeHistory();
      this.assertStartupIdentity(startupIdentity);
      this.startStreams();
      await this.waitForLiveStream();
      this.assertStartupIdentity(startupIdentity);
      if (!this.sessionId) throw new Error("OpenCode v2 session was not initialized");
      this.ready = true;
      this.events.emit("runtime_event", {
        kind: "session_init",
        sessionId: this.sessionId,
      } satisfies AdapterEvent);
      const admission = await this.beginRoot(input);
      this.assertStartupIdentity(startupIdentity);
      this.serviceActivated = true;
      return admission;
    } catch (error) {
      this.suppressExit = true;
      await this.stop({ reason: "failed_start", forceAfterMs: 0 }).catch(() => {});
      if (error instanceof OpenCodeResetRequiredError) {
        return { ok: false, reason: "reset_required", error: error.message };
      }
      if (error instanceof OpenCodeIncompatibleError) {
        return { ok: false, reason: "incompatible_configuration", error: error.message };
      }
      throw error;
    }
  }

  async send(input: LaneSendInput): Promise<LaneAdmission> {
    if (!this.ready || this.stopping || !this.sessionId || !this.identityMatches()) {
      return { ok: false, reason: "closed" };
    }
    if (input.mode === "idle") {
      if (this.activeRoot) return { ok: false, reason: "runtime_busy", error: "OpenCode root turn is still active" };
      return this.beginRoot(input);
    }
    if (!this.activeRoot) return { ok: false, reason: "not_ready", error: "OpenCode has no active root turn" };
    return this.queueAdmission(input.text, "steer", this.newMessageId());
  }

  async interrupt(input: LaneInterruptInput): Promise<boolean> {
    const root = this.activeRoot;
    if (!this.ready || !root || !this.sessionId || this.stopping || !this.identityMatches()) return false;
    root.generation += 1;
    root.interrupted = true;
    root.interruptPending = true;
    try {
      await this.requestNoContent(
        `/api/session/${encodeURIComponent(this.sessionId)}/interrupt`,
        "POST",
        undefined,
        "session interrupt",
      );
      root.interruptPending = false;
      setTimeout(() => this.scheduleEvaluation(), 0).unref?.();
      return true;
    } catch (error) {
      root.interruptPending = false;
      this.events.emit("runtime_event", {
        kind: "runtime_diagnostic",
        severity: "error",
        source: "opencode.v2",
        message: `OpenCode interrupt failed (${safeLabel(input.requestId)})`,
      } satisfies AdapterEvent);
      void this.stop({ reason: "interrupt_timeout", forceAfterMs: 0 });
      throw error;
    }
  }

  stop(input: LaneStopInput = {}): Promise<void> {
    this.requestedStopReason ??= input.reason ?? "requested_stop";
    this.ready = false;
    this.stopping = true;
    this.activeRoot = null;
    if (this.evaluationTimer) clearTimeout(this.evaluationTimer);
    this.durableAbort?.abort();
    this.liveAbort?.abort();
    for (const controller of this.requestControllers) controller.abort();
    const stopped = new Error("OpenCode service lane stopped");
    this.durableGate.reject(stopped);
    this.liveGate.reject(stopped);
    this.stopPromise ??= this.stopPhysicalOnce(input);
    return this.stopPromise;
  }

  private async stopPhysicalOnce(input: LaneStopInput): Promise<void> {
    let proc = this.process;
    const pendingSpawn = this.spawnPromise;
    if (!proc && pendingSpawn) {
      try {
        proc = (await pendingSpawn).process;
      } catch {
        return;
      }
    }
    if (!proc) return;
    await this.stopProcessOnce(proc, input);
  }

  private async startService(): Promise<void> {
    const attempts = this.options.portAttempts ?? PORT_ATTEMPTS;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const port = await (this.options.allocatePort ?? allocateLoopbackPort)();
      this.assertRunning();
      const generation = ++this.serviceGeneration;
      this.baseUrl = `http://${HOST}:${port}`;
      this.stderrBuffer = "";
      this.serviceActivated = false;
      this.processStartError = null;
      this.terminalProcessGeneration = null;
      try {
        const spawnPromise = this.factory.spawnService(this.ctx, port, this.password);
        this.spawnPromise = spawnPromise;
        const spawned = await spawnPromise;
        const pid = spawned.process.pid;
        if (!Number.isInteger(pid) || Number(pid) < 1) {
          throw new Error("OpenCode service did not expose a process id");
        }
        this.process = spawned.process;
        this.identity = { generation, process: spawned.process, pid: Number(pid) };
        this.attachProcess(spawned.process, generation);
        this.assertRunning();
        await this.waitForCompatibility(generation);
        this.assertRunning();
        return;
      } catch (error) {
        lastError = error;
        if (this.stopping) throw error;
        const retryable = error instanceof OpenCodePortBindError
          || (error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message));
        await this.killCandidate();
        if (!retryable || attempt === attempts) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("OpenCode service failed to start");
  }

  private async killCandidate(): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.identity = null;
    if (!proc) return;
    await this.stopProcessOnce(proc, { signal: "SIGKILL", forceAfterMs: 0 });
  }

  private stopProcessOnce(proc: SpawnedProcessHandle, input: LaneStopInput): Promise<void> {
    const existing = this.processStopPromises.get(proc);
    if (existing) return existing;
    const stopping = (async () => {
      if (proc.pid) {
        await killProcessTree(proc.pid, { graceMs: input.forceAfterMs ?? SESSION_STOP_GRACE_MS });
      } else if (!this.isProcessClosed(proc)) {
        proc.kill(input.signal ?? "SIGTERM");
      }
    })();
    this.processStopPromises.set(proc, stopping);
    return stopping;
  }

  private attachProcess(proc: SpawnedProcessHandle, generation: number): void {
    proc.stdout?.on("data", (chunk) => {
      if (this.identity?.generation !== generation) return;
      const text = chunk.toString();
      this.stdoutBuffer += text;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.options.onRawStdoutLine?.(line);
        } catch {
          // Observability must not affect the service protocol.
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      if (this.identity?.generation !== generation) return;
      const text = chunk.toString();
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-4096);
      this.events.emit("stderr", text);
    });
    proc.on("error", (error) => {
      if (this.identity?.generation !== generation || this.suppressExit) return;
      if (!this.serviceActivated) {
        this.processStartError = error instanceof Error ? error : new Error("OpenCode service process failed to start");
        this.abortRuntime(this.processStartError);
        return;
      }
      this.handleActiveProcessError(proc, generation, error);
    });
    proc.on("exit", (code, signal) => this.handleProcessExit(proc, generation, code, signal));
  }

  private handleProcessExit(
    proc: SpawnedProcessHandle,
    generation: number,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.identity?.generation !== generation || this.identity.process !== proc) return;
    if (this.terminalProcessGeneration === generation) return;
    this.terminalProcessGeneration = generation;
    const error = new Error("OpenCode service exited");
    this.abortRuntime(error);
    if (this.suppressExit || !this.serviceActivated) return;
    this.events.emit("exit", {
      code,
      signal,
      reason: this.requestedStopReason ? "requested" : "runtime_exit",
    } satisfies RuntimeLaneEventMap["exit"]);
  }

  private handleActiveProcessError(proc: SpawnedProcessHandle, generation: number, value: unknown): void {
    if (
      this.identity?.generation !== generation
      || this.identity.process !== proc
      || this.terminalProcessGeneration === generation
    ) return;
    this.terminalProcessGeneration = generation;
    const error = value instanceof Error ? value : new Error("OpenCode service process failed");
    this.abortRuntime(error);
    void this.stop({ reason: "runtime_error", forceAfterMs: 0 });
    this.events.emit("error", error);
    this.events.emit("exit", {
      code: null,
      signal: null,
      reason: "runtime_exit",
    } satisfies RuntimeLaneEventMap["exit"]);
  }

  private abortRuntime(error: Error): void {
    this.ready = false;
    this.durableAbort?.abort();
    this.liveAbort?.abort();
    for (const controller of this.requestControllers) controller.abort();
    this.durableGate.reject(error);
    this.liveGate.reject(error);
  }

  private assertRunning(): void {
    if (this.stopping) throw new OpenCodeStoppedError("OpenCode service lane stopped during startup");
  }

  private assertStartupIdentity(identity: ServiceIdentity): void {
    this.assertRunning();
    if (!this.isIdentity(identity)) {
      throw new Error("OpenCode service identity changed during startup");
    }
  }

  private async waitForCompatibility(generation: number): Promise<void> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (this.processStartError) throw this.processStartError;
      if (!this.identity || this.identity.generation !== generation || this.isProcessClosed(this.identity.process)) {
        if (/EADDRINUSE|address already in use/i.test(this.stderrBuffer)) throw new OpenCodePortBindError("OpenCode service port bind raced");
        throw new Error("OpenCode service exited before readiness");
      }
      try {
        const healthTimeoutMs = Math.max(1, Math.min(
          1_000,
          deadline - Date.now(),
          this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        ));
        const { response, body } = await this.fetchJsonWithTimeout(
          "/global/health",
          { method: "GET" },
          "health",
          healthTimeoutMs,
        );
        if (response.ok) {
          const health = record(body);
          if (health?.healthy !== true || health.version !== SUPPORTED_VERSION) {
            throw new OpenCodeIncompatibleError(`Installed OpenCode service must be version ${SUPPORTED_VERSION}`);
          }
          await this.verifyOpenApi();
          return;
        }
        if (response.status === 401) throw new OpenCodeIncompatibleError("OpenCode service rejected session-scoped authentication");
      } catch (error) {
        if (error instanceof OpenCodeIncompatibleError) throw error;
      }
      await delay(25);
    }
    throw new Error("OpenCode service readiness timed out");
  }

  private async verifyOpenApi(): Promise<void> {
    const { response, body } = await this.fetchJsonWithTimeout("/doc", { method: "GET" }, "OpenAPI");
    if (!response.ok) throw new OpenCodeIncompatibleError("Installed OpenCode service does not expose its OpenAPI document");
    const document = record(body);
    const paths = record(document?.paths);
    const required = [
      "/api/session",
      "/api/session/active",
      "/api/session/{sessionID}/prompt",
      "/api/session/{sessionID}/event",
      "/api/session/{sessionID}/history",
      "/api/session/{sessionID}/interrupt",
      "/api/session/{sessionID}/model",
      "/api/session/{sessionID}/permission",
      "/api/session/{sessionID}/permission/{requestID}/reply",
      "/api/event",
    ];
    if (!paths || required.some((path) => !record(paths[path]))) {
      throw new OpenCodeIncompatibleError("Installed OpenCode service is missing required v2 session capabilities");
    }
  }

  private async openSession(resumeId: string | undefined): Promise<void> {
    const model = parseModelRef(resolveLaunchFieldsOrDefault(this.ctx.config.runtimeConfig).model);
    if (resumeId) {
      const { response, body } = await this.fetchJsonWithTimeout(
        `/api/session/${encodeURIComponent(resumeId)}`,
        { method: "GET" },
        "session resume",
      );
      if (response.status === 404) {
        throw new OpenCodeResetRequiredError("OpenCode session cannot be loaded through the v2 service; reset this agent to start a new session");
      }
      if (!response.ok) throw new OpenCodeHttpError(response.status, "session resume");
      const session = record(record(body)?.data);
      if (session?.id !== resumeId) {
        throw new OpenCodeResetRequiredError("OpenCode v2 returned a different resumed session; reset this agent before continuing");
      }
      this.sessionId = resumeId;
      if (model) {
        await this.requestNoContent(
          `/api/session/${encodeURIComponent(resumeId)}/model`,
          "POST",
          { model },
          "model selection",
        );
      }
      return;
    }
    const body: JsonRecord = {
      location: { directory: this.ctx.workingDirectory },
      ...(model ? { model } : {}),
    };
    const { response, body: responseBody } = await this.fetchJsonWithTimeout("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, "session create");
    if (!response.ok) throw new OpenCodeHttpError(response.status, "session create");
    const payload = record(responseBody);
    const session = record(payload?.data);
    if (typeof session?.id !== "string" || !/^ses/.test(session.id)) {
      throw new Error("OpenCode v2 did not return a valid session id");
    }
    this.sessionId = session.id;
  }

  private async primeHistory(): Promise<void> {
    await this.catchUpHistory(false);
  }

  private startStreams(): void {
    const identity = this.identity;
    if (!identity || !this.sessionId) throw new Error("OpenCode service streams started before session initialization");
    this.durableTask = this.runDurableStream(identity).catch((error) => this.streamFailure("durable", error));
    this.liveTask = this.runLiveStream(identity).catch((error) => this.streamFailure("live", error));
  }

  private async runDurableStream(identity: ServiceIdentity): Promise<void> {
    while (!this.stopping && this.isIdentity(identity)) {
      this.durableGap = true;
      const gate = this.durableGate;
      const controller = new AbortController();
      this.durableAbort = controller;
      try {
        const path = `/api/session/${encodeURIComponent(this.sessionId!)}/event?after=${this.lastDurableSeq}`;
        const response = await this.openStream(path, controller, "durable event stream");
        await this.catchUpHistory(true);
        if (!this.isIdentity(identity)) return;
        this.durableGap = false;
        gate.resolve();
        this.scheduleEvaluation();
        await this.consumeSse(response, async (value) => { await this.handleDurableEvent(value, true); });
        if (!this.stopping) this.diagnostic("warning", "OpenCode durable event stream disconnected; replaying from its cursor");
      } catch (error) {
        if (this.stopping || !this.isIdentity(identity) || controller.signal.aborted) return;
        if (error instanceof OpenCodeProtocolError || (error instanceof OpenCodeHttpError && error.status < 500)) {
          this.protocolFailure("OpenCode durable event stream violated the v2 protocol", error);
          return;
        }
        this.diagnostic("warning", "OpenCode durable event stream reconnecting after transport failure");
      }
      this.durableGap = true;
      if (this.durableGate === gate) {
        this.durableGate = makeGate();
        // A pre-open failure leaves the old gate unresolved. Wake its waiters
        // so they can observe the generation change and bind to the retry.
        gate.resolve();
      }
      this.events.emit("runtime_event", {
        kind: "runtime_metric",
        name: "sse_reconnect",
        increment: 1,
      } satisfies AdapterEvent);
      await delay(this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS);
    }
  }

  private async runLiveStream(identity: ServiceIdentity): Promise<void> {
    while (!this.stopping && this.isIdentity(identity)) {
      const gate = this.liveGate;
      const controller = new AbortController();
      this.liveAbort = controller;
      try {
        const response = await this.openStream("/api/event", controller, "live event stream");
        await this.recoverPendingPermissions();
        if (!this.isIdentity(identity)) return;
        gate.resolve();
        await this.consumeSse(response, (value) => this.handleLiveEvent(value));
        if (!this.stopping) this.diagnostic("warning", "OpenCode live event stream disconnected; reconnecting");
      } catch (error) {
        if (this.stopping || !this.isIdentity(identity) || controller.signal.aborted) return;
        if (error instanceof OpenCodeProtocolError || (error instanceof OpenCodeHttpError && error.status < 500)) {
          this.protocolFailure("OpenCode live event stream violated the v2 protocol", error);
          return;
        }
        this.diagnostic("warning", "OpenCode live event stream reconnecting after transport failure");
      }
      if (this.liveGate === gate) {
        this.liveGate = makeGate();
        gate.resolve();
      }
      this.events.emit("runtime_event", {
        kind: "runtime_metric",
        name: "sse_reconnect",
        increment: 1,
      } satisfies AdapterEvent);
      await delay(this.options.reconnectDelayMs ?? RECONNECT_DELAY_MS);
    }
  }

  private streamFailure(kind: "durable" | "live", error: unknown): void {
    if (this.stopping) return;
    this.protocolFailure(`OpenCode ${kind} stream stopped unexpectedly`, error);
  }

  private async openStream(path: string, lifecycle: AbortController, operation: string): Promise<Response> {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: this.headers({ accept: "text/event-stream" }),
        signal: AbortSignal.any([lifecycle.signal, deadline.signal]),
      });
      if (!response.ok || !response.body) throw new OpenCodeHttpError(response.status, operation);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async consumeSse(response: Response, consume: (value: unknown) => Promise<void>): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!this.stopping) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new OpenCodeProtocolError("OpenCode SSE emitted malformed JSON");
        }
        await consume(parsed);
      }
    }
  }

  private catchUpHistory(project: boolean): Promise<void> {
    const run = this.historyTail.then(async () => {
      if (!this.sessionId || this.stopping) return;
      let hasMore = true;
      let historyCursor = this.lastDurableSeq;
      while (hasMore && !this.stopping) {
        const { response, body: responseBody } = await this.fetchJsonWithTimeout(
          `/api/session/${encodeURIComponent(this.sessionId)}/history?after=${historyCursor}&limit=${HISTORY_PAGE_LIMIT}`,
          { method: "GET" },
          "session history",
        );
        if (!response.ok) throw new OpenCodeHttpError(response.status, "session history");
        const body = record(responseBody);
        if (!Array.isArray(body?.data) || typeof body.hasMore !== "boolean") {
          throw new OpenCodeProtocolError("OpenCode session history returned an invalid page");
        }
        const before = historyCursor;
        for (const event of body.data) {
          historyCursor = Math.max(historyCursor, await this.handleDurableEvent(event, project));
        }
        hasMore = body.hasMore;
        if (hasMore && historyCursor === before) {
          throw new OpenCodeProtocolError("OpenCode session history cursor did not advance");
        }
      }
    });
    this.historyTail = run.catch(() => {});
    return run;
  }

  private async handleDurableEvent(value: unknown, project: boolean): Promise<number> {
    const event = record(value);
    const durable = record(event?.durable);
    const data = record(event?.data);
    if (
      !event
      || typeof event.id !== "string"
      || typeof event.type !== "string"
      || !durable
      || durable.aggregateID !== this.sessionId
      || !Number.isInteger(durable.seq)
      || Number(durable.seq) < 0
      || data?.sessionID !== this.sessionId
    ) {
      throw new OpenCodeProtocolError("OpenCode session stream emitted an invalid durable event");
    }
    const seq = Number(durable.seq);
    const priorSeq = this.durableSeqById.get(event.id);
    if (priorSeq !== undefined) {
      if (priorSeq !== seq) {
        throw new OpenCodeProtocolError("OpenCode replayed a durable event id at a different sequence");
      }
      return seq;
    }
    const priorId = this.durableIdBySeq.get(seq);
    if (priorId !== undefined) {
      throw new OpenCodeProtocolError("OpenCode emitted different durable event ids at the same sequence");
    }
    if (seq < this.lastDurableSeq) {
      throw new OpenCodeProtocolError("OpenCode emitted an unseen durable event below the replay cursor");
    }
    this.durableSeqById.set(event.id, seq);
    this.durableIdBySeq.set(seq, event.id);
    const root = this.activeRoot;
    this.lastDurableSeq = Math.max(this.lastDurableSeq, seq);
    if (event.type === "session.next.prompt.admitted") {
      const messageId = data.messageID;
      if (root && typeof messageId === "string") {
        root.durableAdmissions.set(messageId, seq);
        const expected = root.frontier.get(messageId);
        if (expected !== undefined) {
          if (expected !== seq) throw new OpenCodeProtocolError("OpenCode durable prompt admission sequence did not match its receipt");
          root.observedAdmissions.add(messageId);
        }
      }
    }
    if (!project || !root || seq <= root.baselineSeq) {
      this.scheduleEvaluation();
      return seq;
    }
    switch (event.type) {
      case "session.next.step.started":
        this.events.emit("runtime_event", {
          kind: "internal_progress",
          source: "opencode.service",
          itemType: "step_started",
        } satisfies AdapterEvent);
        break;
      case "session.next.text.ended":
        if (typeof data.text === "string" && data.text.length > 0) {
          this.events.emit("runtime_event", { kind: "assistant_message_completed", text: data.text } satisfies AdapterEvent);
        }
        break;
      case "session.next.reasoning.ended":
        if (typeof data.text === "string" && data.text.length > 0) {
          this.events.emit("runtime_event", { kind: "assistant_reasoning_completed", text: data.text } satisfies AdapterEvent);
        }
        break;
      case "session.next.tool.called":
        if (typeof data.callID === "string") {
          const name = typeof data.tool === "string" ? data.tool : "OpenCode tool";
          this.toolNames.set(data.callID, name);
          this.events.emit("runtime_event", { kind: "tool_call", name, input: data.input } satisfies AdapterEvent);
        }
        break;
      case "session.next.tool.success":
      case "session.next.tool.failed":
        if (typeof data.callID === "string") {
          const name = this.toolNames.get(data.callID) ?? "OpenCode tool";
          this.toolNames.delete(data.callID);
          this.events.emit("runtime_event", { kind: "tool_output", name } satisfies AdapterEvent);
        }
        break;
      case "session.next.compaction.started":
        this.events.emit("runtime_event", { kind: "compaction_started" } satisfies AdapterEvent);
        break;
      case "session.next.compaction.ended":
        this.events.emit("runtime_event", { kind: "compaction_finished" } satisfies AdapterEvent);
        break;
      case "session.next.step.ended": {
        if (typeof data.finish !== "string") {
          throw new OpenCodeProtocolError("OpenCode step outcome omitted its finish reason");
        }
        if (data.finish !== "tool-calls") {
          const successful = data.finish === "stop" || data.finish === "length" || data.finish === "content-filter";
          root.outcomes.push({
            seq,
            ok: successful,
            ...(!successful ? { message: "OpenCode reported an unsupported final step outcome" } : {}),
          });
        }
        const tokens = record(data.tokens);
        if (tokens) {
          this.events.emit("runtime_event", {
            kind: "telemetry",
            name: "token_usage",
            source: "opencode.v2",
            attrs: tokens,
          } satisfies AdapterEvent);
        }
        break;
      }
      case "session.next.step.failed":
        root.outcomes.push({ seq, ok: false, message: messageFromError(data.error) });
        break;
      default:
        break;
    }
    this.scheduleEvaluation();
    return seq;
  }

  private async handleLiveEvent(value: unknown): Promise<void> {
    const event = record(value);
    const data = record(event?.data);
    if (event?.type !== "permission.v2.asked" || data?.sessionID !== this.sessionId) return;
    if (typeof data.id !== "string" || !/^per/.test(data.id)) {
      throw new OpenCodeProtocolError("OpenCode emitted a malformed permission request");
    }
    await this.replyPermission(data.id);
  }

  private async recoverPendingPermissions(): Promise<void> {
    if (!this.sessionId) return;
    const { response, body: responseBody } = await this.fetchJsonWithTimeout(
      `/api/session/${encodeURIComponent(this.sessionId)}/permission`,
      { method: "GET" },
      "permission list",
    );
    if (!response.ok) throw new OpenCodeHttpError(response.status, "permission list");
    const body = record(responseBody);
    if (!Array.isArray(body?.data)) throw new OpenCodeProtocolError("OpenCode permission list returned invalid data");
    for (const item of body.data) {
      const permission = record(item);
      if (permission?.sessionID === this.sessionId && typeof permission.id === "string") {
        await this.replyPermission(permission.id);
      }
    }
  }

  private async replyPermission(requestId: string): Promise<void> {
    if (this.handledPermissions.has(requestId)) return;
    const existing = this.permissionFlights.get(requestId);
    if (existing) return existing;
    const flight = this.requestNoContent(
        `/api/session/${encodeURIComponent(this.sessionId!)}/permission/${encodeURIComponent(requestId)}/reply`,
        "POST",
        { reply: "once" },
        "permission reply",
      )
      .catch((error) => {
        if (!(error instanceof OpenCodeHttpError) || error.status !== 404) throw error;
      })
      .then(() => { this.handledPermissions.add(requestId); })
      .finally(() => { this.permissionFlights.delete(requestId); });
    this.permissionFlights.set(requestId, flight);
    return flight;
  }

  private async beginRoot(input: LaneStartInput): Promise<LaneAdmission> {
    const receipt = input.terminalOwner?.startsWith("msg_") ? input.terminalOwner : this.newMessageId();
    this.activeRoot = {
      receipt,
      baselineSeq: this.lastDurableSeq,
      frontier: new Map(),
      durableAdmissions: new Map(),
      observedAdmissions: new Set(),
      outcomes: [],
      generation: 0,
      pendingAdmissions: 0,
      interrupted: false,
      interruptPending: false,
    };
    try {
      return await this.queueAdmission(input.text, "queue", receipt);
    } catch (error) {
      this.activeRoot = null;
      throw error;
    }
  }

  private queueAdmission(text: string, delivery: "queue" | "steer", messageId: string): Promise<LaneAdmission> {
    const root = this.activeRoot;
    if (!root) return Promise.resolve({ ok: false, reason: "not_ready" });
    root.generation += 1;
    root.pendingAdmissions += 1;
    const run = this.admissionTail.then(async (): Promise<LaneAdmission> => {
      if (!this.ready || this.stopping || this.activeRoot !== root || !this.sessionId || !this.identityMatches()) {
        return { ok: false, reason: "closed" };
      }
      await this.waitForLiveStream();
      // OpenCode 1.17.20 does not flush the durable SSE response headers until
      // the first durable event. The first prompt admission creates that event,
      // so waiting for the durable fetch here deadlocks startup. History closes
      // the pre-admission gap; after this POST releases the stream, the normal
      // durable cursor/frontier barrier remains the sole terminal authority.
      if (this.durableGap && this.durableBootstrapAdmissionUsed) await this.waitForStreams();
      this.durableBootstrapAdmissionUsed = true;
      if (this.durableGap) await this.catchUpHistory(true);
      const { response, body: responseBody } = await this.fetchJsonWithTimeout(
        `/api/session/${encodeURIComponent(this.sessionId)}/prompt`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: messageId, prompt: { text }, delivery, resume: true }),
        },
        "prompt admission",
      );
      if (!response.ok) throw new OpenCodeHttpError(response.status, "prompt admission");
      const body = record(responseBody);
      const admitted = record(body?.data);
      if (
        admitted?.id !== messageId
        || admitted.sessionID !== this.sessionId
        || admitted.delivery !== delivery
        || !Number.isInteger(admitted.admittedSeq)
        || Number(admitted.admittedSeq) < 0
      ) {
        throw new OpenCodeProtocolError("OpenCode prompt admission returned an invalid receipt");
      }
      root.frontier.set(messageId, Number(admitted.admittedSeq));
      const durableSeq = root.durableAdmissions.get(messageId);
      if (durableSeq !== undefined) {
        if (durableSeq !== Number(admitted.admittedSeq)) {
          throw new OpenCodeProtocolError("OpenCode durable prompt admission sequence did not match its receipt");
        }
        root.observedAdmissions.add(messageId);
      } else {
        void this.catchUpHistory(true).catch((error) => {
          if (!this.stopping && this.activeRoot === root) {
            if (
              error instanceof OpenCodeProtocolError
              || (error instanceof OpenCodeHttpError && error.status < 500)
            ) {
              this.protocolFailure("OpenCode session history violated the v2 protocol", error);
              return;
            }
            this.diagnostic("warning", "OpenCode durable admission catch-up failed; waiting for SSE replay");
          }
        });
      }
      return { ok: true, acceptedAs: delivery === "steer" ? "steer" : "prompt", receipt: messageId };
    }).catch((error) => {
      if (!this.stopping && this.activeRoot === root) {
        this.protocolFailure("OpenCode prompt admission did not produce a valid durable receipt", error);
      }
      throw error;
    }).finally(() => {
      root.pendingAdmissions -= 1;
      this.scheduleEvaluation();
    });
    this.admissionTail = run.then(() => {}, () => {});
    return run;
  }

  private scheduleEvaluation(delayMs = 0): void {
    if (!this.activeRoot || this.stopping) return;
    if (this.evaluating) {
      this.reevaluate = true;
      this.reevaluateDelayMs = this.reevaluateDelayMs === undefined
        ? delayMs
        : Math.min(this.reevaluateDelayMs, delayMs);
      return;
    }
    if (this.evaluationTimer) return;
    this.evaluationTimer = setTimeout(() => {
      this.evaluationTimer = undefined;
      void this.evaluateTerminal();
    }, delayMs);
    this.evaluationTimer.unref?.();
  }

  private async evaluateTerminal(): Promise<void> {
    const root = this.activeRoot;
    const identity = this.identity;
    if (!root || !identity || this.stopping || this.evaluating) return;
    if (
      root.pendingAdmissions > 0
      || root.interruptPending
      || this.durableGap
      || root.frontier.size === 0
      || root.observedAdmissions.size !== root.frontier.size
    ) return;
    const maxAdmission = Math.max(...root.frontier.values());
    if (this.lastDurableSeq < maxAdmission) return;
    this.evaluating = true;
    const generation = root.generation;
    try {
      const { response, body: responseBody } = await this.fetchJsonWithTimeout(
        "/api/session/active",
        { method: "GET" },
        "active session query",
      );
      if (!response.ok) throw new OpenCodeHttpError(response.status, "active session query");
      const body = record(responseBody);
      const active = record(body?.data);
      if (!active) throw new OpenCodeProtocolError("OpenCode active session query returned invalid data");
      if (!this.barrierStillCurrent(root, identity, generation)) return;
      if (active[this.sessionId!] !== undefined) {
        this.scheduleEvaluation(this.options.activePollMs ?? ACTIVE_POLL_MS);
        return;
      }
      await this.catchUpHistory(true);
      if (!this.barrierStillCurrent(root, identity, generation) || this.durableGap) return;
      if (
        root.observedAdmissions.size !== root.frontier.size
        || this.lastDurableSeq < maxAdmission
      ) return;
      const outcome = root.outcomes
        .filter((item) => item.seq > maxAdmission)
        .sort((left, right) => left.seq - right.seq)
        .at(-1);
      if (!root.interrupted && !outcome) {
        this.settleRoot(root, false, "OpenCode drain settled without a durable turn outcome");
        return;
      }
      if (outcome && !outcome.ok) {
        this.settleRoot(root, false, outcome.message ?? "OpenCode turn failed");
        return;
      }
      this.settleRoot(root, true);
    } catch (error) {
      if (
        error instanceof OpenCodeProtocolError
        || (error instanceof OpenCodeHttpError && error.status < 500)
      ) {
        this.protocolFailure("OpenCode active barrier violated the v2 protocol", error);
        return;
      }
      if (!this.stopping && this.activeRoot === root && this.isIdentity(identity)) {
        this.diagnostic("warning", "OpenCode active barrier query failed; retrying without settling the turn");
        this.scheduleEvaluation(this.options.activePollMs ?? ACTIVE_POLL_MS);
      }
    } finally {
      this.evaluating = false;
      if (this.reevaluate) {
        this.reevaluate = false;
        const delayMs = this.reevaluateDelayMs ?? 0;
        this.reevaluateDelayMs = undefined;
        this.scheduleEvaluation(delayMs);
      }
    }
  }

  private barrierStillCurrent(root: ActiveRoot, identity: ServiceIdentity, generation: number): boolean {
    return this.activeRoot === root
      && root.generation === generation
      && root.pendingAdmissions === 0
      && !root.interruptPending
      && this.isIdentity(identity)
      && this.identityMatches();
  }

  private settleRoot(root: ActiveRoot, success: boolean, message?: string): void {
    if (this.activeRoot !== root) return;
    this.activeRoot = null;
    this.toolNames.clear();
    if (!success) {
      this.events.emit("runtime_event", {
        kind: "error",
        message: message ?? "OpenCode turn failed",
      } satisfies AdapterEvent);
    }
    this.events.emit("runtime_event", {
      kind: "turn_end",
      sessionId: this.sessionId ?? undefined,
      turnOwner: root.receipt,
    } satisfies AdapterEvent);
  }

  private async requestNoContent(
    path: string,
    method: "POST",
    body: JsonRecord | undefined,
    operation: string,
  ): Promise<void> {
    const response = await this.fetchWithTimeout(path, {
      method,
      ...(body ? {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      } : {}),
    }, operation);
    if (!response.ok) throw new OpenCodeHttpError(response.status, operation);
  }

  private async fetchWithTimeout(
    path: string,
    init: RequestInit,
    operation: string,
    timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    if (this.stopping) throw new Error("OpenCode service lane is stopping");
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
        signal: controller.signal,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(`OpenCode ${operation} request failed`);
    } finally {
      clearTimeout(timer);
      this.requestControllers.delete(controller);
    }
  }

  private async fetchJsonWithTimeout(
    path: string,
    init: RequestInit,
    operation: string,
    timeoutMs = this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
  ): Promise<{ response: Response; body: unknown }> {
    if (this.stopping) throw new OpenCodeStoppedError("OpenCode service lane is stopping");
    const controller = new AbortController();
    this.requestControllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchFn(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.headers),
        signal: controller.signal,
      });
      if (!response.ok) return { response, body: undefined };
      try {
        return { response, body: await response.json() };
      } catch (error) {
        if (timedOut) {
          throw new Error(`OpenCode ${operation} response timed out`);
        }
        if (controller.signal.aborted) throw error;
        throw new OpenCodeProtocolError(`OpenCode ${operation} returned invalid JSON`);
      }
    } catch (error) {
      throw error instanceof Error ? error : new Error(`OpenCode ${operation} request failed`);
    } finally {
      clearTimeout(timer);
      this.requestControllers.delete(controller);
    }
  }

  private headers(input?: HeadersInit): Headers {
    const headers = new Headers(input);
    headers.set("authorization", `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`);
    return headers;
  }

  private newMessageId(): string {
    return `msg_${randomBytes(16).toString("hex")}`;
  }

  private diagnostic(severity: "warning" | "error", message: string): void {
    this.events.emit("runtime_event", {
      kind: "runtime_diagnostic",
      severity,
      source: "opencode.v2",
      message,
    } satisfies AdapterEvent);
  }

  private protocolFailure(message: string, _cause?: unknown): void {
    if (this.stopping) return;
    void this.stop({ reason: "protocol_error", forceAfterMs: 0 });
    this.events.emit("error", new Error(message));
  }

  private identityMatches(): boolean {
    const identity = this.identity;
    const matches = !!identity
      && identity.process === this.process
      && identity.process.pid === identity.pid
      && !this.isProcessClosed(identity.process);
    if (
      !matches
      && identity
      && identity.process === this.process
      && identity.process.pid !== identity.pid
      && this.ready
      && !this.stopping
    ) {
      this.failPidIdentity();
    }
    return matches;
  }

  private isIdentity(identity: ServiceIdentity): boolean {
    return this.identity === identity && this.identityMatches();
  }

  private isProcessClosed(proc: SpawnedProcessHandle): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
  }

  private async waitForLiveStream(): Promise<void> {
    while (!this.stopping) {
      const live = this.liveGate;
      await live.promise;
      if (live === this.liveGate) return;
    }
    throw new Error("OpenCode service lane stopped before stream recovery");
  }

  private async waitForStreams(): Promise<void> {
    while (!this.stopping) {
      const durable = this.durableGate;
      const live = this.liveGate;
      await Promise.all([durable.promise, live.promise]);
      if (!this.durableGap && durable === this.durableGate && live === this.liveGate) return;
    }
    throw new Error("OpenCode service lane stopped before stream recovery");
  }

  private failPidIdentity(): void {
    if (this.identityFailed) return;
    this.identityFailed = true;
    this.ready = false;
    this.events.emit("exit", {
      code: null,
      signal: null,
      reason: "runtime_exit",
    } satisfies RuntimeLaneEventMap["exit"]);
    void this.stop({ reason: "service_identity_changed", forceAfterMs: 0 });
  }
}

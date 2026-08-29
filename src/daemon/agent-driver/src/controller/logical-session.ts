import type {
  AgentDriverError,
  AgentEvent,
  AgentMessage,
  AgentSession,
  AgentSessionResult,
  AgentSessionSnapshot,
  BackendId,
  CapabilitiesOf,
  ConfigOf,
  CoreAgentEventPayload,
  DeliveryReceipt,
  ExtensionResult,
  HostCleanupResult,
  InterruptResult,
  JsonValue,
  PreparedExecutionResource,
  StopInput,
  StopReceipt,
  RuntimeSettingsUpdate,
  RuntimeSettingsUpdateResult,
} from "../contract.js";
import type { AgentDriverHost } from "../contract.js";
import type {
  BackendAdapter,
  AdapterLaunchContext,
  AdapterEvent,
  LaneAdmission,
  RuntimeLane,
} from "../internal/adapter.js";
import {
  DEFAULT_DAEMON_GRACE_MS,
  DEFAULT_MAX_RECOVERY_EXTENSIONS,
  DEFAULT_NATIVE_IDLE_TIMEOUT_MS,
  DEFAULT_RECOVERY_GRACE_MS,
} from "../internal/adapter.js";
import { BufferedEventQueue } from "./event-queue.js";
import { writeAgentFile } from "../internal/agentFile.js";
import { scrubDriverErrorMessage } from "../internal/errors.js";
import { mkdirSync } from "node:fs";

type SessionState = AgentSessionSnapshot["state"];

interface QueuedCommand {
  message: AgentMessage;
  reason: "unsafe_boundary" | "runtime_busy" | "waiting_for_message";
  queuedAt: number;
}

interface CommandRecord {
  method: "start" | "send";
  canonical: string;
  promise: Promise<DeliveryReceipt>;
}

interface SafeBoundaryDelivery {
  item: QueuedCommand;
  activeTurn: { turnId: string; commandIds: string[] };
  finalized: boolean;
}

interface SteeringDelivery {
  message: AgentMessage;
  activeTurn: ActiveTurn;
  finalized: boolean;
  failure?: AgentDriverError;
  cancel(error: AgentDriverError): void;
  cancellation: Promise<never>;
}

interface TurnAdmission {
  messages: AgentMessage[];
  turnId: string;
  delivery: "prompt" | "steer";
  finalized: boolean;
  accepted: boolean;
  pendingEvents: Array<{
    event: AdapterEvent;
    physicalOwner: RuntimeLane;
    generation: number;
  }>;
}

interface ActiveTurn {
  turnId: string;
  commandIds: string[];
  terminalOwner?: string;
  pendingMessage: SemanticAssembler;
  pendingReasoning: SemanticAssembler;
  lastWorkHeartbeatAt: number | null;
}

interface SemanticAssembler {
  chunks: string[];
  bytes: number;
  truncated: boolean;
}

const SEMANTIC_ASSEMBLER_MAX_BYTES = 1_048_576;
const WORK_HEARTBEAT_MIN_INTERVAL_MS = 1_000;

function emptySemanticAssembler(): SemanticAssembler {
  return { chunks: [], bytes: 0, truncated: false };
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    let end = mid;
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    if (Buffer.byteLength(text.slice(0, end), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end -= 1;
  return text.slice(0, end);
}

function appendSemanticFragment(buffer: SemanticAssembler, text: string): void {
  if (text.length === 0 || buffer.truncated) return;
  const remaining = SEMANTIC_ASSEMBLER_MAX_BYTES - buffer.bytes;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= remaining) {
    buffer.chunks.push(text);
    buffer.bytes += bytes;
    return;
  }
  const prefix = utf8Prefix(text, remaining);
  if (prefix.length > 0) {
    buffer.chunks.push(prefix);
    buffer.bytes += Buffer.byteLength(prefix, "utf8");
  }
  buffer.truncated = true;
}

function finishSemanticAssembler(buffer: SemanticAssembler): { text: string; truncated: boolean } {
  return { text: buffer.chunks.join(""), truncated: buffer.truncated };
}

function boundedSemanticCompletion(text: string): { text: string; truncated: boolean } {
  const buffer = emptySemanticAssembler();
  appendSemanticFragment(buffer, text);
  return finishSemanticAssembler(buffer);
}

interface ClosedLaneTombstone {
  sessionInstanceId: string;
  localTurnId: string;
  commandIds: string[];
  terminalOwner?: string;
  physicalOwner: RuntimeLane;
  generation: number;
  state: "closed" | "reopened_after_terminal";
}

function driverError(
  category: AgentDriverError["category"],
  code: string,
  message: string,
  retryable = false,
): AgentDriverError {
  return { category, code, message: scrubDriverErrorMessage(message), retryable };
}

class StructuredLaneAdmissionError extends Error {
  constructor(readonly code: "reset_required" | "incompatible_configuration", message: string) {
    super(message);
  }
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return String(value);
  }
}

export class LogicalAgentSession<Specs, Id extends BackendId<Specs>>
implements AgentSession<Specs, Id> {
  readonly capabilities: CapabilitiesOf<Specs, Id>;
  readonly sessionInstanceId: string;
  readonly events;
  readonly closed: Promise<AgentSessionResult>;

  private state: SessionState = "new";
  private backendSessionId?: string;
  private lane: RuntimeLane | null = null;
  private activeTurn?: ActiveTurn;
  private readonly queued: QueuedCommand[] = [];
  private readonly commands = new Map<string, CommandRecord>();
  private readonly commandAdmittedAt = new Map<string, number>();
  private startedAdmitted = false;
  private eventSequence = 0;
  private resolveClosed!: (result: AgentSessionResult) => void;
  private terminalResult?: AgentSessionResult;
  private finishing = false;
  private finishPromise?: Promise<void>;
  private turnError?: AgentDriverError;
  private interruptedTurnId?: string;
  private processTurnEnded = false;
  private stopRequestId?: string;
  private outstandingToolUses = 0;
  private compacting = false;
  private reviewing = false;
  private readonly steeringDeliveries = new Set<SteeringDelivery>();
  private laneAdmissionTail: Promise<void> = Promise.resolve();
  private laneAdmissionPending = 0;
  private toolBoundaryFlushDisabled = false;
  private safeBoundaryFlush?: Promise<void>;
  private safeBoundaryDelivery?: SafeBoundaryDelivery;
  private settingsUpdateTail: Promise<void> = Promise.resolve();
  private settingsUpdatePending = false;
  private turnAdmission?: TurnAdmission;
  private instructionsMaterialized = false;
  private lifecycleGeneration = 0;
  private closedLaneTombstone?: ClosedLaneTombstone;
  private physicalOpenCount = 0;
  private turnCount = 0;
  private commandAdmissionCount = 0;
  private commandAdmissionLatencyTotalMs = 0;
  private queueDwellCount = 0;
  private queueDwellTotalMs = 0;
  private sseReconnectCount = 0;
  private resumeOutcome: AgentSessionSnapshot["diagnostics"]["metrics"]["resumeOutcome"];

  private readonly eventQueue: BufferedEventQueue<AgentEvent<Specs, Id>>;
  private readonly behavior;
  private readonly turnSilence: AgentSessionSnapshot["diagnostics"]["turnSilence"];

  constructor(
    readonly backend: Id,
    private readonly config: ConfigOf<Specs, Id>,
    private readonly launch: {
      workingDirectory: string;
      instructions: string;
      resumeSessionId?: string;
      launchId: string;
    },
    private readonly adapter: BackendAdapter<Id, ConfigOf<Specs, Id>>,
    capabilities: CapabilitiesOf<Specs, Id>,
    private readonly host: AgentDriverHost,
    private readonly prepared: PreparedExecutionResource,
    private readonly hostReleaseTimeoutMs: number,
  ) {
    this.capabilities = capabilities;
    this.behavior = this.capabilities as import("../contract.js").BackendCapabilities;
    const declaredSilence = adapter.execution.turnSilence;
    const nativeIdleTimeoutMs = declaredSilence?.nativeIdleTimeoutMs ?? DEFAULT_NATIVE_IDLE_TIMEOUT_MS;
    const daemonGraceMs = declaredSilence?.daemonGraceMs ?? DEFAULT_DAEMON_GRACE_MS;
    const recoveryGraceMs = declaredSilence?.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS;
    const maxRecoveryExtensions = declaredSilence?.maxRecoveryExtensions ?? DEFAULT_MAX_RECOVERY_EXTENSIONS;
    this.turnSilence = {
      nativeIdleTimeoutMs,
      daemonGraceMs,
      recoveryGraceMs,
      maxRecoveryExtensions,
      normalBudgetMs: nativeIdleTimeoutMs + daemonGraceMs,
    };
    this.resumeOutcome = launch.resumeSessionId ? "pending" : "not_requested";
    this.sessionInstanceId = host.createId();
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    this.eventQueue = new BufferedEventQueue(
      () => { void this.stopForConsumer(); },
      () => { void this.failBufferOverflow(); },
    );
    this.events = this.eventQueue.stream;
  }

  start(message: AgentMessage): Promise<DeliveryReceipt> {
    return this.admit("start", message);
  }

  send(message: AgentMessage): Promise<DeliveryReceipt> {
    return this.admit("send", message);
  }

  updateSettings(input: RuntimeSettingsUpdate): Promise<RuntimeSettingsUpdateResult> {
    if (this.state === "closed" || this.state === "stopping" || this.finishing) {
      return Promise.resolve({
        status: "failed",
        error: driverError("process", "settings_session_closed", "Runtime session is closed", true),
      });
    }
    this.settingsUpdatePending = true;
    const operation = this.settingsUpdateTail.then(async (): Promise<RuntimeSettingsUpdateResult> => {
      if (!this.lane?.updateSettings) return { status: "unsupported" };
      try {
        return await this.lane.updateSettings(input);
      } catch (error) {
        return {
          status: "failed",
          error: driverError("process", "settings_update_failed", String(error), true),
        };
      }
    });
    this.settingsUpdateTail = operation.then((result) => {
      if (result.status === "applied") {
        this.settingsUpdatePending = false;
        return;
      }
      return new Promise<void>(() => {});
    });
    return operation;
  }

  async interrupt(input: { readonly requestId: string; readonly reason: string }): Promise<InterruptResult> {
    if (this.state === "closed" || this.state === "stopping" || this.finishing) return { status: "closed" };
    if (!this.activeTurn || !this.lane) return { status: "not_running" };
    const turnId = this.activeTurn.turnId;
    this.interruptedTurnId = turnId;
    try {
      const accepted = await this.lane.interrupt(input);
      if (!accepted) {
        if (this.interruptedTurnId === turnId) this.interruptedTurnId = undefined;
        return { status: "not_running" };
      }
      return { status: "accepted", requestId: input.requestId, turnId };
    } catch (error) {
      if (this.interruptedTurnId === turnId) this.interruptedTurnId = undefined;
      return {
        status: "failed",
        error: driverError("process", "interrupt_failed", String(error), true),
      };
    }
  }

  async stop(input: StopInput): Promise<StopReceipt> {
    return this.stopWithRelease(input, "requested_stop");
  }

  private async stopWithRelease(
    input: StopInput,
    releaseReason: "requested_stop" | "consumer_closed",
  ): Promise<StopReceipt> {
    if (this.terminalResult) return { status: "closed", result: this.terminalResult };
    if (this.state === "stopping" || this.finishing) {
      return { status: "already_stopping", requestId: this.enterStopping() };
    }
    const stopRequestId = this.enterStopping();
    this.failTurnAdmission("cancelled", "session_stopping", "Session is stopping");
    this.failSafeBoundaryDelivery("cancelled", "session_stopping", "Session is stopping");
    this.failSteeringDeliveries("cancelled", "session_stopping", "Session is stopping");
    this.failQueued("cancelled", "session_stopping", "Session is stopping");
    let forced = false;
    let stopFailure: AgentDriverError | undefined;
    if (this.lane) {
      const settlement = await this.settleLaneStop(input.reason, input.forceAfterMs);
      forced = settlement.forced;
      stopFailure = settlement.failure;
    }
    if (stopFailure) {
      const error = stopFailure;
      await this.finish(
        (cleanup) => ({
          outcome: "forced",
          requested: true,
          backendSessionId: this.backendSessionId,
          error,
          cleanup,
        }),
        releaseReason,
      );
      return { status: "failed", error };
    } else if (forced) {
      await this.finish(
        (cleanup) => ({
          outcome: "forced",
          requested: true,
          backendSessionId: this.backendSessionId,
          error: driverError("timeout", "force_stop_deadline", "Runtime did not stop before the force deadline"),
          cleanup,
        }),
        releaseReason,
      );
    } else {
      await this.finish(
        (cleanup) => ({
          outcome: "stopped",
          requested: true,
          backendSessionId: this.backendSessionId,
          cleanup,
        }),
        releaseReason,
      );
    }
    return { status: "accepted", requestId: stopRequestId };
  }

  snapshot(): AgentSessionSnapshot {
    return {
      sessionInstanceId: this.sessionInstanceId,
      state: this.state,
      backendSessionId: this.backendSessionId,
      activeTurn: this.activeTurn
        ? { turnId: this.activeTurn.turnId, commandIds: this.activeTurn.commandIds }
        : undefined,
      queuedCommands: this.queued.map(({ message }) => ({
        commandId: message.id,
        kind: message.kind,
      })),
      lastEventSequence: this.eventSequence,
      diagnostics: {
        deliveryPhase: this.deliveryPhase(),
        turnSilence: this.turnSilence,
        metrics: {
          physicalOpenCount: this.metricValue(this.physicalOpenCount),
          turnCount: this.metricValue(this.turnCount),
          commandAdmissionCount: this.metricValue(this.commandAdmissionCount),
          commandAdmissionLatencyTotalMs: this.metricValue(this.commandAdmissionLatencyTotalMs),
          queueDwellCount: this.metricValue(this.queueDwellCount),
          queueDwellTotalMs: this.metricValue(this.queueDwellTotalMs),
          sseReconnectCount: this.metricValue(this.sseReconnectCount),
          resumeOutcome: this.resumeOutcome,
          terminalOwnerKind: this.adapter.execution.terminalOwnership,
        },
      },
    };
  }

  async invokeExtension(): Promise<ExtensionResult<never>> {
    return {
      ok: false,
      error: driverError("configuration", "unsupported_extension", "Backend has no public extensions"),
    };
  }

  private admit(method: "start" | "send", message: AgentMessage): Promise<DeliveryReceipt> {
    const canonical = JSON.stringify(message);
    const existing = this.commands.get(message.id);
    if (existing) {
      if (existing.method === method && existing.canonical === canonical) return existing.promise;
      return Promise.resolve({ status: "rejected", reason: "duplicate_conflict" });
    }
    this.commandAdmittedAt.set(message.id, this.metricNow());
    const promise = this.admitFresh(method, message).then((receipt) => {
      if (receipt.status === "rejected") this.commandAdmittedAt.delete(message.id);
      return receipt;
    });
    this.commands.set(message.id, { method, canonical, promise });
    return promise;
  }

  private async admitFresh(
    method: "start" | "send",
    message: AgentMessage,
  ): Promise<DeliveryReceipt> {
    if (!message.id || !message.text) return { status: "rejected", reason: "invalid_input" };
    if (this.state === "closed" || this.state === "stopping" || this.finishing) {
      return { status: "rejected", reason: "closed" };
    }
    if (method === "start") {
      if (this.startedAdmitted) return { status: "rejected", reason: "already_started" };
      this.startedAdmitted = true;
      if (
        this.adapter.execution.lifetime === "turn"
        && this.adapter.execution.wakeStart === "deferred"
        && message.kind === "system"
      ) {
        return this.queue(message, "waiting_for_message", "awaiting_first_message");
      }
      return this.startTurn([message], "prompt");
    }
    if (!this.startedAdmitted) return { status: "rejected", reason: "not_started" };
    if (this.state === "awaiting_first_message") {
      if (message.kind === "system") return this.queue(message, "waiting_for_message");
      const prefix = this.queued.splice(0).map((item) => {
        this.recordQueueDwell(item);
        return item.message;
      });
      return this.startTurn([...prefix, message], "prompt");
    }
    if (this.state === "working" || this.state === "starting") {
      if (this.behavior.midTurnDelivery === "steer" && this.activeTurn && this.lane) {
        return this.deliverSteer(message, this.activeTurn);
      }
      const reason = this.behavior.midTurnDelivery === "safe_boundary_queue"
        ? "unsafe_boundary"
        : "runtime_busy";
      const receipt = this.queue(message, reason);
      if (this.behavior.midTurnDelivery === "safe_boundary_queue") {
        void this.flushSafeBoundaryQueue();
      }
      return receipt;
    }
    if (
      this.state === "idle"
      && (
        this.queued.length > 0
        || this.safeBoundaryFlush !== undefined
        || this.safeBoundaryDelivery !== undefined
        || this.settingsUpdatePending
      )
    ) {
      return this.queue(message, "runtime_busy");
    }
    return this.startTurn([message], "prompt");
  }

  private queue(
    message: AgentMessage,
    reason: QueuedCommand["reason"],
    nextState?: SessionState,
  ): DeliveryReceipt {
    this.queued.push({ message, reason, queuedAt: this.metricNow() });
    if (nextState) this.state = nextState;
    this.emit({ type: "command_queued", commandId: message.id, reason });
    return { status: "queued", reason, commandId: message.id };
  }

  private async startTurn(
    messages: AgentMessage[],
    delivery: "prompt" | "steer",
  ): Promise<DeliveryReceipt> {
    const turnId = this.host.createId();
    const commandIds = messages.map((message) => message.id);
    const terminalOwner = this.adapter.beginTurn?.();
    this.activeTurn = {
      turnId,
      commandIds: [...commandIds],
      ...(terminalOwner ? { terminalOwner } : {}),
      pendingMessage: emptySemanticAssembler(),
      pendingReasoning: emptySemanticAssembler(),
      lastWorkHeartbeatAt: null,
    };
    this.turnError = undefined;
    this.interruptedTurnId = undefined;
    this.processTurnEnded = false;
    this.state = "starting";
    const generation = this.lifecycleGeneration;
    const text = messages.map((message) => message.text).join("\n\n");
    const admission: TurnAdmission = {
      messages,
      turnId,
      delivery,
      finalized: false,
      accepted: false,
      pendingEvents: [],
    };
    this.turnAdmission = admission;
    const current = messages.at(-1)!;
    const acceptedReceipt: DeliveryReceipt = {
      status: "accepted",
      delivery,
      commandId: current.id,
      turnId,
    };
    const admit = async (reuseExistingLane: boolean): Promise<DeliveryReceipt> => {
      try {
        let laneAdmission: LaneAdmission;
        if (reuseExistingLane) {
          laneAdmission = await this.sendLane(text, "idle");
        } else {
          const opened = await this.openLane(text, generation);
          if (!opened) {
            // A racing stop owns terminal settlement. Preserve the historical
            // contract that session_closed is observable before start resolves.
            if (this.finishPromise) await this.finishPromise;
            return { status: "rejected", reason: "closed" };
          }
          laneAdmission = opened;
        }
        if (!this.isStartCurrent(generation, turnId)) {
          return { status: "rejected", reason: "closed" };
        }
        this.acceptTurnAdmission(admission, laneAdmission);
        void this.flushSafeBoundaryQueue();
        return acceptedReceipt;
      } catch (error) {
        if (!this.isStartCurrent(generation, turnId) || admission.finalized) {
          return admission.accepted ? acceptedReceipt : { status: "rejected", reason: "closed" };
        }
        const failure = error instanceof StructuredLaneAdmissionError
          ? driverError("configuration", error.code, error.message, false)
          : driverError("process", "failed_to_start", String(error), true);
        if (this.launch.resumeSessionId && this.resumeOutcome === "pending") {
          this.resumeOutcome = error instanceof StructuredLaneAdmissionError && error.code === "reset_required"
            ? "reset_required"
            : "failed";
        }
        this.failTurnAdmissionWithError(failure);
        this.activeTurn = undefined;
        const failedLane = this.lane;
        if (failedLane) {
          this.lane = null;
          await this.stopLaneInstanceBounded(failedLane, "failed_start", this.hostReleaseTimeoutMs);
        }
        this.emit({ type: "session_failed", error: failure });
        await this.finish(
          (cleanup) => ({ outcome: "failed_to_start", requested: false, error: failure, cleanup }),
          "failed_start",
        );
        return { status: "rejected", reason: "runtime_unavailable", error: failure };
      }
    };
    const reuseExistingLane = this.adapter.execution.lifetime === "session" && this.lane !== null;
    return this.enqueueLaneAdmission(() => admit(reuseExistingLane));
  }

  private internalContext(prompt: string): AdapterLaunchContext<Id, ConfigOf<Specs, Id>> {
    return {
      backend: this.backend,
      agentId: this.launch.launchId,
      launchId: this.launch.launchId,
      workingDirectory: this.launch.workingDirectory,
      standingPrompt: this.launch.instructions,
      prompt,
      prepared: this.prepared,
      config: {
        sessionId: this.backendSessionId ?? this.launch.resumeSessionId,
        runtimeConfig: this.config,
      },
    };
  }

  private async openLane(
    prompt: string,
    generation: number,
  ): Promise<LaneAdmission | null> {
    if (!this.instructionsMaterialized) {
      // The public controller owns the workspace precondition shared by every
      // adapter. Fresh daemon agents do not have an agent-specific directory
      // yet, and both workspace-file materialization and child-process cwd
      // require it to exist before the physical lane opens.
      mkdirSync(this.launch.workingDirectory, { recursive: true });
      const strategy = this.adapter.instructionDelivery;
      if (strategy.kind === "workspace_file" && this.launch.instructions) {
        writeAgentFile(this.launch.workingDirectory, this.launch.instructions, strategy);
      }
      this.instructionsMaterialized = true;
    }
    const ctx = this.internalContext(prompt);
    const lane = await this.adapter.openLane(ctx, {
      onRawStdoutLine: (text) => this.host.onRawOutput({
        backend: this.backend,
        launchId: this.launch.launchId,
        stream: "stdout",
        text,
      }),
    });
    this.physicalOpenCount += 1;
    this.lane = lane;
    this.attachLane(lane, generation);
    if (!this.isOpenCurrent(generation)) {
      await this.stopLaneInstanceBounded(lane, "stale_open", this.hostReleaseTimeoutMs);
      if (this.lane === lane) this.lane = null;
      return null;
    }
    const admission = await lane.start({
      text: prompt,
      sessionId: ctx.config.sessionId,
      terminalOwner: this.activeTurn?.terminalOwner,
    });
    if (!admission.ok) {
      if (admission.reason === "reset_required" || admission.reason === "incompatible_configuration") {
        throw new StructuredLaneAdmissionError(admission.reason, admission.error ?? admission.reason);
      }
      throw new Error(admission.error ?? admission.reason);
    }
    if (!this.isOpenCurrent(generation)) {
      await this.stopLaneInstanceBounded(lane, "stale_open", this.hostReleaseTimeoutMs);
      if (this.lane === lane) this.lane = null;
      return null;
    }
    return admission;
  }

  private attachLane(lane: RuntimeLane, generation: number): void {
    const current = () => this.lane === lane && this.lifecycleGeneration === generation;
    lane.on("runtime_event", (event: unknown) => {
      if (!current()) return;
      const admission = this.turnAdmission;
      if (admission && !admission.finalized && admission.turnId === this.activeTurn?.turnId) {
        admission.pendingEvents.push({ event: event as AdapterEvent, physicalOwner: lane, generation });
        return;
      }
      this.onAdapterEvent(event as AdapterEvent, lane, generation);
    });
    lane.on("stderr", (value: unknown) => {
      if (!current()) return;
      const text = String(value);
      this.host.onRawOutput({
        backend: this.backend,
        launchId: this.launch.launchId,
        stream: "stderr",
        text,
      });
      this.emit({
        type: "diagnostic",
        severity: "warning",
        source: this.backend,
        message: scrubDriverErrorMessage(text, "Runtime emitted a warning"),
      });
    });
    lane.on("error", (error: unknown) => {
      if (current()) this.onLaneError(error, lane, generation);
    });
    lane.on("exit", (info: unknown) => {
      if (current()) void this.onLaneExit(lane, info);
    });
  }

  private onAdapterEvent(
    event: AdapterEvent,
    physicalOwner: RuntimeLane,
    generation: number,
  ): void {
    if (this.state === "closed" || this.state === "stopping" || this.finishing) return;
    if (this.isClosedPerTurnLaneTail(physicalOwner, generation)) return;
    const turnId = this.activeTurn?.turnId ?? this.reopenClosedLaneForWork(event, physicalOwner, generation);
    switch (event.kind) {
      case "session_init":
        if (this.launch.resumeSessionId && this.resumeOutcome === "pending") {
          this.resumeOutcome = event.sessionId === this.launch.resumeSessionId ? "resumed" : "failed";
        }
        if (this.backendSessionId !== event.sessionId) {
          this.backendSessionId = event.sessionId;
          this.emit({ type: "session_started", backendSessionId: event.sessionId });
        }
        return;
      case "turn_owner":
        if (!this.activeTurn || !event.receipt.trim()) return;
        if (this.activeTurn.terminalOwner && this.activeTurn.terminalOwner !== event.receipt) {
          this.turnError = driverError(
            "process",
            "terminal_owner_mismatch",
            "Runtime acknowledged a terminal owner that did not match command admission",
          );
          this.emit({
            type: "diagnostic",
            turnId: this.activeTurn.turnId,
            severity: "error",
            source: this.backend,
            message: "Runtime terminal ownership did not match command admission",
          });
          return;
        }
        this.activeTurn.terminalOwner = event.receipt;
        const nativeTurnId = event.nativeTurnId?.trim();
        if (nativeTurnId && nativeTurnId.length <= 512 && /^[A-Za-z0-9._:-]+$/.test(nativeTurnId)) {
          this.emit({
            type: "backend_turn_started",
            turnId: this.activeTurn.turnId,
            backendTurnId: nativeTurnId,
          });
        }
        return;
      case "assistant_reasoning_delta":
      case "assistant_message_delta":
        if (turnId && this.activeTurn?.turnId === turnId && event.text.length > 0) {
          appendSemanticFragment(
            event.kind === "assistant_message_delta"
              ? this.activeTurn.pendingMessage
              : this.activeTurn.pendingReasoning,
            event.text,
          );
          const now = this.host.now();
          if (
            this.activeTurn.lastWorkHeartbeatAt === null
            || now - this.activeTurn.lastWorkHeartbeatAt >= WORK_HEARTBEAT_MIN_INTERVAL_MS
          ) {
            this.activeTurn.lastWorkHeartbeatAt = now;
            this.emit({ type: "work_heartbeat", turnId });
          }
        }
        return;
      case "assistant_reasoning_completed":
      case "assistant_message_completed":
        if (turnId && this.activeTurn?.turnId === turnId) {
          const field = event.kind === "assistant_message_completed" ? "pendingMessage" : "pendingReasoning";
          this.activeTurn[field] = emptySemanticAssembler();
          if (event.text.length > 0) {
            const completed = boundedSemanticCompletion(event.text);
            this.emit({ type: event.kind, turnId, ...completed });
          }
        }
        return;
      case "tool_call":
        this.outstandingToolUses += 1;
        if (turnId) this.emit({ type: "tool_started", turnId, name: event.name, input: jsonValue(event.input) });
        return;
      case "tool_output":
        this.outstandingToolUses = Math.max(0, this.outstandingToolUses - 1);
        if (turnId) this.emit({ type: "tool_finished", turnId, name: event.name });
        if (this.outstandingToolUses === 0 && !this.toolBoundaryFlushDisabled) void this.flushSafeBoundaryQueue();
        return;
      case "compaction_started":
      case "compaction_finished":
      case "review_started":
      case "review_finished":
        if (event.kind === "compaction_started") this.compacting = true;
        if (event.kind === "compaction_finished") this.compacting = false;
        if (event.kind === "review_started") this.reviewing = true;
        if (event.kind === "review_finished") this.reviewing = false;
        if (turnId) this.emit({ type: event.kind, turnId });
        if (event.kind.endsWith("finished")) void this.flushSafeBoundaryQueue();
        return;
      case "internal_progress":
        this.emit({ type: "internal_progress", turnId, source: event.source, itemType: event.itemType, payloadBytes: event.payloadBytes });
        return;
      case "runtime_diagnostic":
        this.emit({
          type: "diagnostic",
          turnId,
          severity: event.severity === "error" || event.severity === "warning" || event.severity === "debug"
            ? event.severity
            : "info",
          source: event.source,
          message: scrubDriverErrorMessage(event.message, "Runtime diagnostic"),
        });
        return;
      case "runtime_recovery":
        this.emit({
          type: "recovery",
          turnId,
          stage: event.stage,
          source: event.source,
        });
        return;
      case "runtime_metric":
        if (event.name === "sse_reconnect" && event.increment === 1) {
          this.sseReconnectCount += 1;
          this.emit({ type: "recovery", turnId, stage: "retrying", source: "transport_reconnect" });
        }
        return;
      case "telemetry": {
        if (event.name === "token_usage") {
          this.emit({ type: "token_usage", turnId, source: event.source, usage: event.usage });
        } else {
          this.emit({ type: "rate_limits", turnId, source: event.source, quota: event.quota });
        }
        return;
      }
      case "error":
        this.toolBoundaryFlushDisabled = true;
        this.turnError = driverError("process", "runtime_error", event.message, true);
        this.emit({
          type: "diagnostic",
          turnId,
          severity: "error",
          source: this.backend,
          message: scrubDriverErrorMessage(event.message),
        });
        return;
      case "turn_end":
        if (turnId && this.activeTurn?.turnId === turnId) {
          const reasoning = finishSemanticAssembler(this.activeTurn.pendingReasoning);
          const message = finishSemanticAssembler(this.activeTurn.pendingMessage);
          this.activeTurn.pendingReasoning = emptySemanticAssembler();
          this.activeTurn.pendingMessage = emptySemanticAssembler();
          if (reasoning.text.length > 0) {
            this.emit({ type: "assistant_reasoning_completed", turnId, ...reasoning });
          }
          if (message.text.length > 0) {
            this.emit({ type: "assistant_message_completed", turnId, ...message });
          }
        }
        this.completeTurn(event.sessionId, physicalOwner, generation, event.turnOwner);
        return;
    }
  }

  private isClosedPerTurnLaneTail(
    physicalOwner: RuntimeLane,
    generation: number,
  ): boolean {
    if (this.adapter.execution.lifetime !== "turn" || this.activeTurn) return false;
    const tombstone = this.closedLaneTombstone;
    return tombstone?.state === "closed"
      && tombstone.sessionInstanceId === this.sessionInstanceId
      && tombstone.physicalOwner === physicalOwner
      && tombstone.generation === generation;
  }

  private reopenClosedLaneForWork(
    event: AdapterEvent,
    physicalOwner: RuntimeLane,
    generation: number,
  ): string | undefined {
    // Defense in depth for direct/internal callers. Normal event delivery drops
    // every event from a closed per-turn transport before any shared-state side
    // effect in onAdapterEvent's switch can run.
    if (this.adapter.execution.lifetime === "turn") return undefined;
    const isRootWork = event.kind === "tool_call"
      || event.kind === "tool_output"
      || event.kind === "compaction_started"
      || event.kind === "compaction_finished"
      || event.kind === "review_started"
      || event.kind === "review_finished"
      || event.kind === "internal_progress";
    if (!isRootWork) return undefined;
    const tombstone = this.closedLaneTombstone;
    if (
      !tombstone
      || tombstone.sessionInstanceId !== this.sessionInstanceId
      || tombstone.physicalOwner !== physicalOwner
      || tombstone.generation !== generation
    ) return undefined;
    tombstone.state = "reopened_after_terminal";
    this.activeTurn = {
      turnId: tombstone.localTurnId,
      commandIds: tombstone.commandIds,
      ...(tombstone.terminalOwner ? { terminalOwner: tombstone.terminalOwner } : {}),
      pendingMessage: emptySemanticAssembler(),
      pendingReasoning: emptySemanticAssembler(),
      lastWorkHeartbeatAt: null,
    };
    this.state = "working";
    return tombstone.localTurnId;
  }

  private completeTurn(
    sessionId?: string,
    physicalOwner = this.lane,
    generation = this.lifecycleGeneration,
    terminalOwner?: string,
  ): void {
    const active = this.activeTurn;
    if (!active) {
      return;
    }
    if (!active.terminalOwner || terminalOwner !== active.terminalOwner) return;
    this.failTurnAdmission(
      "cancelled",
      "turn_completed_before_command_acceptance",
      "Turn completed before command acceptance",
    );
    this.failSafeBoundaryDelivery(
      "cancelled",
      "turn_completed_before_command_acceptance",
      "Turn completed before command acceptance",
    );
    this.failSteeringDeliveries(
      "cancelled",
      "turn_completed_before_command_acceptance",
      "Turn completed before command acceptance",
      active,
    );
    if (sessionId && this.backendSessionId !== sessionId) {
      this.backendSessionId = sessionId;
      this.emit({ type: "session_started", backendSessionId: sessionId });
    }
    this.emit({
      type: "turn_completed",
      turnId: active.turnId,
      commandIds: active.commandIds,
      result: this.interruptedTurnId === active.turnId
        ? { outcome: "interrupted", backendSessionId: this.backendSessionId }
        : this.turnError
          ? { outcome: "failed", backendSessionId: this.backendSessionId, error: this.turnError }
          : { outcome: "success", backendSessionId: this.backendSessionId ?? "" },
    });
    if (physicalOwner) {
      this.closedLaneTombstone = {
        sessionInstanceId: this.sessionInstanceId,
        localTurnId: active.turnId,
        commandIds: active.commandIds,
        terminalOwner: active.terminalOwner,
        physicalOwner,
        generation,
        state: "closed",
      };
    }
    this.activeTurn = undefined;
    this.turnError = undefined;
    this.interruptedTurnId = undefined;
    this.outstandingToolUses = 0;
    this.compacting = false;
    this.reviewing = false;
    this.toolBoundaryFlushDisabled = false;
    this.state = "idle";
    if (this.adapter.execution.lifetime === "turn") {
      this.processTurnEnded = true;
    } else {
      void Promise.resolve()
        .then(() => this.safeBoundaryFlush)
        .then(() => this.settingsUpdateTail)
        .then(() => this.startNextQueued());
    }
  }

  private flushSafeBoundaryQueue(): Promise<void> {
    if (this.safeBoundaryFlush) return this.safeBoundaryFlush;
    if (!this.canFlushSafeBoundaryQueue()) return Promise.resolve();
    this.safeBoundaryFlush = this.drainSafeBoundaryQueue().finally(() => {
      this.safeBoundaryFlush = undefined;
      if (this.canFlushSafeBoundaryQueue()) void this.flushSafeBoundaryQueue();
    });
    return this.safeBoundaryFlush;
  }

  private canFlushSafeBoundaryQueue(): boolean {
    return this.state === "working"
      && this.behavior.midTurnDelivery === "safe_boundary_queue"
      && this.outstandingToolUses === 0
      && !this.compacting
      && !this.reviewing
      && this.activeTurn !== undefined
      && this.lane !== null
      && this.queued.length > 0;
  }

  private async drainSafeBoundaryQueue(): Promise<void> {
    while (this.canFlushSafeBoundaryQueue()) {
      const item = this.queued.shift()!;
      this.recordQueueDwell(item);
      const activeTurn = this.activeTurn!;
      const delivery: SafeBoundaryDelivery = { item, activeTurn, finalized: false };
      this.safeBoundaryDelivery = delivery;
      try {
        await this.sendLane(item.message.text, "busy");
      } catch (error) {
        if (!delivery.finalized) {
          delivery.finalized = true;
          this.emit({
            type: "command_failed",
            commandId: item.message.id,
            turnId: activeTurn.turnId,
            error: driverError("process", "delivery_failed", String(error), true),
          });
        }
        continue;
      } finally {
        if (this.safeBoundaryDelivery === delivery) this.safeBoundaryDelivery = undefined;
      }
      if (delivery.finalized) continue;
      delivery.finalized = true;
      activeTurn.commandIds.push(item.message.id);
      this.emit({
        type: "command_accepted",
        commandId: item.message.id,
        turnId: activeTurn.turnId,
        delivery: "steer",
      });
    }
  }

  private failSafeBoundaryDelivery(
    category: AgentDriverError["category"],
    code: string,
    message: string,
  ): void {
    const delivery = this.safeBoundaryDelivery;
    if (!delivery || delivery.finalized) return;
    delivery.finalized = true;
    this.emit({
      type: "command_failed",
      commandId: delivery.item.message.id,
      turnId: delivery.activeTurn.turnId,
      error: driverError(category, code, message),
    });
  }

  private failTurnAdmission(
    category: AgentDriverError["category"],
    code: string,
    message: string,
  ): void {
    this.failTurnAdmissionWithError(driverError(category, code, message));
  }

  private failTurnAdmissionWithError(error: AgentDriverError): void {
    const admission = this.turnAdmission;
    if (!admission || admission.finalized) return;
    admission.finalized = true;
    admission.pendingEvents.length = 0;
    if (this.turnAdmission === admission) this.turnAdmission = undefined;
    for (const message of admission.messages) {
      this.emit({ type: "command_failed", commandId: message.id, turnId: admission.turnId, error });
    }
  }

  private acceptTurnAdmission(admission: TurnAdmission, laneAdmission: LaneAdmission): void {
    if (!laneAdmission.ok) throw new Error(laneAdmission.error ?? laneAdmission.reason);
    const receipt = laneAdmission.receipt.trim();
    if (!receipt) throw new Error("runtime admitted a command without a terminal receipt");
    const active = this.activeTurn;
    if (!active || active.turnId !== admission.turnId) {
      throw new Error("runtime admitted a command for a stale turn");
    }
    if (active.terminalOwner && active.terminalOwner !== receipt) {
      throw new Error("runtime admission receipt did not match the prepared terminal owner");
    }
    active.terminalOwner = receipt;
    admission.finalized = true;
    admission.accepted = true;
    if (this.turnAdmission === admission) this.turnAdmission = undefined;
    this.state = "working";
    this.turnCount += 1;
    for (const message of admission.messages) {
      this.emit({
        type: "command_accepted",
        commandId: message.id,
        turnId: admission.turnId,
        delivery: admission.delivery,
      });
    }
    this.emit({
      type: "turn_started",
      turnId: admission.turnId,
      commandIds: admission.messages.map((message) => message.id),
    });
    for (const pending of admission.pendingEvents.splice(0)) {
      this.onAdapterEvent(pending.event, pending.physicalOwner, pending.generation);
    }
  }

  private async startNextQueued(): Promise<void> {
    if (this.state !== "idle" || this.queued.length === 0) return;
    const item = this.queued.shift()!;
    this.recordQueueDwell(item);
    await this.startTurn([item.message], "prompt");
  }

  private onLaneError(
    error: unknown,
    physicalOwner: RuntimeLane,
    generation: number,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.onAdapterEvent({ kind: "error", message }, physicalOwner, generation);
  }

  private async onLaneExit(lane: RuntimeLane, info: unknown): Promise<void> {
    if (this.lane !== lane || this.state === "closed") return;
    const stoppingBeforeExit = this.state === "stopping" || this.finishing;
    const expectedTurnExit = this.adapter.execution.lifetime === "turn" && this.processTurnEnded;
    if (!stoppingBeforeExit && !expectedTurnExit) this.enterStopping();
    await this.stopLaneInstanceBounded(lane, "runtime_exit", this.hostReleaseTimeoutMs);
    if (this.lane === lane) this.lane = null;
    if (this.terminalResult || stoppingBeforeExit) return;
    if (expectedTurnExit) {
      this.processTurnEnded = false;
      await this.startNextQueued();
      return;
    }
    const facts = info as { code?: number | null; signal?: string | null } | undefined;
    const error = driverError("process", "runtime_exit", "Runtime exited unexpectedly", true);
    this.emit({ type: "session_failed", error });
    await this.finish(
      (cleanup) => ({
        outcome: "crashed",
        requested: false,
        backendSessionId: this.backendSessionId,
        exitCode: facts?.code ?? null,
        signal: facts?.signal ?? null,
        error,
        cleanup,
      }),
      "crash",
    );
  }

  private emit(payload: CoreAgentEventPayload): void {
    const at = this.metricNow();
    if (payload.type === "command_accepted" || payload.type === "command_failed") {
      const admittedAt = this.commandAdmittedAt.get(payload.commandId);
      if (admittedAt !== undefined) {
        this.commandAdmittedAt.delete(payload.commandId);
        this.commandAdmissionCount += 1;
        this.commandAdmissionLatencyTotalMs += Math.max(0, at - admittedAt);
      }
    }
    const event = {
      ...payload,
      sequence: ++this.eventSequence,
      sessionInstanceId: this.sessionInstanceId,
      at,
    } as AgentEvent<Specs, Id>;
    this.eventQueue.push(event, payload.type === "session_closed");
  }

  private failQueued(category: AgentDriverError["category"], code: string, message: string): void {
    const error = driverError(category, code, message);
    for (const item of this.queued.splice(0)) {
      this.recordQueueDwell(item);
      this.emit({ type: "command_failed", commandId: item.message.id, error });
    }
  }

  private deliveryPhase(): AgentSessionSnapshot["diagnostics"]["deliveryPhase"] {
    if (this.state === "stopping" || this.state === "closed") return "idle";
    if (this.turnAdmission) return "admission_wait";
    if (this.steeringDeliveries.size > 0 || this.safeBoundaryDelivery) return "steering";
    if (this.behavior.midTurnDelivery === "next_turn_queue" && this.queued.length > 0) return "next_turn_queued";
    if (this.compacting) return "compacting";
    if (this.reviewing) return "reviewing";
    if (this.outstandingToolUses > 0) return "tool_wait";
    if (this.activeTurn) return "working";
    return "idle";
  }

  private metricNow(): number {
    const now = this.host.now();
    return Number.isFinite(now) && now >= 0 ? now : 0;
  }

  private metricValue(value: number): number {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private recordQueueDwell(item: QueuedCommand): void {
    this.queueDwellCount += 1;
    this.queueDwellTotalMs += Math.max(0, this.metricNow() - item.queuedAt);
  }

  private enqueueLaneAdmission<T>(operation: () => Promise<T>): Promise<T> {
    // Reserve the lane-wide FIFO slot synchronously. Preserve the historical
    // immediate first admission while every later root/steer waits on its tail.
    const startsImmediately = this.laneAdmissionPending === 0;
    this.laneAdmissionPending += 1;
    let reserved: Promise<T>;
    if (startsImmediately) {
      try {
        reserved = operation();
      } catch (error) {
        reserved = Promise.reject(error);
      }
    } else {
      reserved = this.laneAdmissionTail.then(operation);
    }
    const tail = reserved.then(() => {}, () => {});
    this.laneAdmissionTail = tail;
    void tail.then(() => {
      this.laneAdmissionPending = Math.max(0, this.laneAdmissionPending - 1);
    });
    return reserved;
  }

  private async deliverSteer(message: AgentMessage, activeTurn: ActiveTurn): Promise<DeliveryReceipt> {
    let rejectCancellation!: (error: AgentDriverError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const delivery: SteeringDelivery = {
      message,
      activeTurn,
      finalized: false,
      cancellation,
      cancel(error) {
        rejectCancellation(error);
      },
    };
    this.steeringDeliveries.add(delivery);
    const physical = this.enqueueLaneAdmission(async (): Promise<DeliveryReceipt> => {
      try {
        if (delivery.finalized || this.activeTurn !== activeTurn) {
          throw delivery.failure ?? driverError(
            "cancelled",
            "turn_closed_before_command_acceptance",
            "Turn closed before command acceptance",
          );
        }
        await this.sendLane(message.text, "busy");
        if (delivery.finalized || this.activeTurn !== activeTurn) {
          throw delivery.failure ?? driverError(
            "cancelled",
            "turn_closed_before_command_acceptance",
            "Turn closed before command acceptance",
          );
        }
        delivery.finalized = true;
        activeTurn.commandIds.push(message.id);
        this.emit({ type: "command_accepted", commandId: message.id, turnId: activeTurn.turnId, delivery: "steer" });
        return { status: "accepted", delivery: "steer", commandId: message.id, turnId: activeTurn.turnId };
      } catch (error) {
        const failure = delivery.failure ?? (typeof error === "object" && error !== null && "category" in error
          ? error as AgentDriverError
          : driverError("process", "delivery_failed", String(error), true));
        if (!delivery.finalized) {
          delivery.finalized = true;
          this.emit({ type: "command_failed", commandId: message.id, turnId: activeTurn.turnId, error: failure });
        }
        return { status: "rejected", reason: "runtime_unavailable", error: failure };
      }
    });
    try {
      return await Promise.race([physical, cancellation]);
    } catch (error) {
      const failure = delivery.failure ?? (typeof error === "object" && error !== null && "category" in error
        ? error as AgentDriverError
        : driverError("process", "delivery_failed", String(error), true));
      if (!delivery.finalized) {
        delivery.finalized = true;
        this.emit({ type: "command_failed", commandId: message.id, turnId: activeTurn.turnId, error: failure });
      }
      return { status: "rejected", reason: "runtime_unavailable", error: failure };
    } finally {
      this.steeringDeliveries.delete(delivery);
    }
  }

  private failSteeringDeliveries(
    category: AgentDriverError["category"],
    code: string,
    message: string,
    activeTurn?: ActiveTurn,
  ): void {
    const error = driverError(category, code, message);
    for (const delivery of this.steeringDeliveries) {
      if (activeTurn && delivery.activeTurn !== activeTurn) continue;
      if (delivery.finalized) continue;
      delivery.finalized = true;
      delivery.failure = error;
      this.emit({
        type: "command_failed",
        commandId: delivery.message.id,
        turnId: delivery.activeTurn.turnId,
        error,
      });
      delivery.cancel(error);
    }
  }

  private async cleanupResource(
    reason: Parameters<PreparedExecutionResource["release"]>[0]["reason"],
  ): Promise<HostCleanupResult> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = driverError("timeout", "host_release_timeout", "Host resource release timed out");
    try {
      const timeout = new Promise<HostCleanupResult>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve({ status: "timed_out", error: timeoutError });
        }, this.hostReleaseTimeoutMs);
        timer.unref?.();
      });
      const release = Promise.resolve()
        .then(() => this.prepared.release({
          reason,
          signal: abort.signal,
          deadlineAt: this.host.now() + this.hostReleaseTimeoutMs,
        }))
        .then((): HostCleanupResult => ({ status: "released" }))
        .catch((error): HostCleanupResult => ({
          status: "failed",
          error: driverError("internal", "host_release_failed", String(error)),
        }));
      const result = await Promise.race([release, timeout]);
      release.catch(() => {});
      if (result.status === "failed" || result.status === "timed_out") {
        this.emit({
          type: "diagnostic",
          severity: "error",
          source: "host",
          message: result.error.message,
        });
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async finish(
    buildResult: (cleanup: HostCleanupResult) => AgentSessionResult,
    releaseReason: Parameters<PreparedExecutionResource["release"]>[0]["reason"],
  ): Promise<void> {
    if (this.terminalResult) return;
    if (!this.finishPromise) {
      this.finishing = true;
      this.enterStopping();
      this.finishPromise = (async () => {
        this.failTurnAdmission(
          "cancelled",
          "session_closed",
          "Session closed before command acceptance",
        );
        this.failSafeBoundaryDelivery(
          "cancelled",
          "session_closed",
          "Session closed before command acceptance",
        );
        this.failSteeringDeliveries(
          "cancelled",
          "session_closed",
          "Session closed before command acceptance",
        );
        this.failQueued("cancelled", "session_closed", "Session closed before command acceptance");
        if (this.activeTurn) {
          const active = this.activeTurn;
          const interrupted = releaseReason === "requested_stop"
            || releaseReason === "consumer_closed"
            || this.interruptedTurnId === active.turnId;
          const error = this.turnError ?? driverError(
            interrupted ? "cancelled" : "process",
            interrupted ? "turn_interrupted" : "session_closed",
            interrupted ? "Turn interrupted by session stop" : "Session closed before turn completion",
            !interrupted,
          );
          this.emit({
            type: "turn_completed",
            turnId: active.turnId,
            commandIds: active.commandIds,
            result: interrupted
              ? { outcome: "interrupted", backendSessionId: this.backendSessionId ?? "" }
              : { outcome: "failed", backendSessionId: this.backendSessionId, error },
          });
          this.activeTurn = undefined;
          this.interruptedTurnId = undefined;
        }
        const cleanup = await this.cleanupResource(releaseReason);
        const result = buildResult(cleanup);
        this.terminalResult = result;
        this.state = "closed";
        this.emit({ type: "session_closed", result });
        this.eventQueue.close();
        this.resolveClosed(result);
        this.finishing = false;
      })();
    }
    await this.finishPromise;
  }

  private async failBufferOverflow(): Promise<void> {
    if (this.terminalResult || this.finishing) return;
    const error = driverError("buffer_overflow", "event_buffer_overflow", "Event buffer exceeded 4 MiB");
    this.enterStopping();
    if (this.lane) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stopped = this.stopLane("event_buffer_overflow", 0).catch(() => {});
        const deadline = new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.hostReleaseTimeoutMs);
          timer.unref?.();
        });
        await Promise.race([stopped, deadline]);
        stopped.catch(() => {});
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.emit({ type: "session_failed", error });
    await this.finish(
      (cleanup) => ({ outcome: "crashed", requested: false, exitCode: null, signal: null, error, cleanup }),
      "crash",
    );
  }

  private async stopForConsumer(): Promise<void> {
    if (this.state === "closed" || this.state === "stopping") return;
    await this.stopWithRelease({ reason: "shutdown", forceAfterMs: 5_000 }, "consumer_closed");
  }

  private sendLane(text: string, mode: "busy" | "idle"): Promise<LaneAdmission> {
    if (!this.lane) return Promise.reject(new Error("runtime lane is not open"));
    return this.lane.send({
      text,
      mode,
      sessionId: this.backendSessionId ?? this.launch.resumeSessionId,
      terminalOwner: mode === "idle" ? this.activeTurn?.terminalOwner : undefined,
    })
      .then((result) => {
        if (!result.ok) throw new Error(String("reason" in result ? result.reason : "runtime rejected delivery"));
        return result;
      });
  }

  private stopLane(reason: string, forceAfterMs: number): Promise<unknown> {
    if (!this.lane) return Promise.resolve();
    return this.lane.stop({ reason, forceAfterMs });
  }

  /**
   * Own physical stop settlement across two bounded windows.
   *
   * `forceAfterMs` decides whether the public result is forced, but it is not
   * permission to release host resources while the lane's already-started hard
   * teardown is still settling. After that outer deadline, wait one separate
   * host-owned cleanup window so a tree-kill success/rejection remains visible.
   * A truly hung SDK lane is still bounded by the second window.
   */
  private async settleLaneStop(
    reason: string,
    forceAfterMs: number,
  ): Promise<{ forced: boolean; failure?: AgentDriverError }> {
    type StopSettlement = { kind: "stopped" } | { kind: "failed"; error: unknown };
    const stopped: Promise<StopSettlement> = Promise.resolve()
      .then(() => this.stopLane(reason, forceAfterMs))
      .then(
        () => ({ kind: "stopped" }),
        (error: unknown) => ({ kind: "failed", error }),
      );
    let outerTimer: ReturnType<typeof setTimeout> | undefined;
    const outerDeadline = new Promise<{ kind: "outer_deadline" }>((resolve) => {
      outerTimer = setTimeout(() => resolve({ kind: "outer_deadline" }), forceAfterMs);
      outerTimer.unref?.();
    });
    const first = await Promise.race([stopped, outerDeadline]);
    if (outerTimer) clearTimeout(outerTimer);
    if (first.kind === "stopped") return { forced: false };
    if (first.kind === "failed") {
      return { forced: false, failure: driverError("process", "stop_failed", String(first.error), true) };
    }

    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanupDeadline = new Promise<{ kind: "cleanup_deadline" }>((resolve) => {
      cleanupTimer = setTimeout(() => resolve({ kind: "cleanup_deadline" }), this.hostReleaseTimeoutMs);
      cleanupTimer.unref?.();
    });
    const final = await Promise.race([stopped, cleanupDeadline]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    if (final.kind === "failed") {
      return { forced: true, failure: driverError("process", "stop_failed", String(final.error), true) };
    }
    return { forced: true };
  }

  private enterStopping(): string {
    if (this.state !== "stopping") {
      this.state = "stopping";
      this.lifecycleGeneration += 1;
      this.closedLaneTombstone = undefined;
    }
    this.stopRequestId ??= this.host.createId();
    return this.stopRequestId;
  }

  private isOpenCurrent(generation: number): boolean {
    return generation === this.lifecycleGeneration
      && this.state === "starting"
      && !this.finishing
      && !this.terminalResult;
  }

  private isStartCurrent(generation: number, turnId: string): boolean {
    return this.isOpenCurrent(generation) && this.activeTurn?.turnId === turnId;
  }

  private async stopLaneInstanceBounded(
    lane: RuntimeLane,
    reason: string,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = lane.stop({ reason, forceAfterMs: 0 })
      .catch(() => {});
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([stopped, deadline]);
      stopped.catch(() => {});
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

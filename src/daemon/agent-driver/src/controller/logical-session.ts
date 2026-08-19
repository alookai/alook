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
  JsonObject,
  JsonValue,
  PreparedExecutionResource,
  StopInput,
  StopReceipt,
} from "../contract.js";
import type { AgentDriverHost } from "../contract.js";
import type { BackendAdapter, AdapterLaunchContext, AdapterEvent } from "../internal/adapter.js";
import { createProcessLane, type ProcessLane } from "./process-host.js";
import { SdkLane } from "./sdk-host.js";
import { BufferedEventQueue } from "./event-queue.js";
import { writeAgentFile } from "../internal/agentFile.js";
import { scrubDriverErrorMessage } from "../internal/errors.js";

type SessionState = AgentSessionSnapshot["state"];

interface QueuedCommand {
  message: AgentMessage;
  reason: "unsafe_boundary" | "runtime_busy" | "waiting_for_message";
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

interface TurnAdmission {
  messages: AgentMessage[];
  turnId: string;
  delivery: "prompt" | "steer";
  finalized: boolean;
  accepted: boolean;
}

interface ActiveTurn {
  turnId: string;
  commandIds: string[];
  terminalOwner?: string;
}

interface ClosedLaneTombstone<Id extends string, Config> {
  sessionInstanceId: string;
  localTurnId: string;
  commandIds: string[];
  terminalOwner?: string;
  physicalOwner: ProcessLane<Id, Config> | SdkLane;
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
  private lane: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane | null = null;
  private activeTurn?: ActiveTurn;
  private readonly queued: QueuedCommand[] = [];
  private readonly commands = new Map<string, CommandRecord>();
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
  private toolBoundaryFlushDisabled = false;
  private safeBoundaryFlush?: Promise<void>;
  private safeBoundaryDelivery?: SafeBoundaryDelivery;
  private turnAdmission?: TurnAdmission;
  private instructionsMaterialized = false;
  private lifecycleGeneration = 0;
  private closedLaneTombstone?: ClosedLaneTombstone<Id, ConfigOf<Specs, Id>>;

  private readonly eventQueue: BufferedEventQueue<AgentEvent<Specs, Id>>;
  private readonly behavior;

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

  async interrupt(input: { readonly requestId: string; readonly reason: string }): Promise<InterruptResult> {
    if (this.state === "closed" || this.state === "stopping" || this.finishing) return { status: "closed" };
    if (!this.activeTurn || !this.lane) return { status: "not_running" };
    const turnId = this.activeTurn.turnId;
    this.interruptedTurnId = turnId;
    try {
      const accepted = this.lane instanceof SdkLane
        ? await this.lane.interrupt()
        : this.lane.interrupt();
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
    this.failQueued("cancelled", "session_stopping", "Session is stopping");
    let forced = false;
    let stopFailure: AgentDriverError | undefined;
    if (this.lane) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<"forced">((resolve) => {
          timer = setTimeout(() => resolve("forced"), input.forceAfterMs);
          timer.unref?.();
        });
          const stopped = this.stopLane(input.reason, input.forceAfterMs)
          .then(() => "stopped" as const);
        stopped.catch(() => {});
        forced = (await Promise.race([stopped, timeout])) === "forced";
      } catch (error) {
        stopFailure = driverError("process", "stop_failed", String(error), true);
      } finally {
        if (timer) clearTimeout(timer);
      }
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
    const promise = this.admitFresh(method, message);
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
        this.adapter.execution.kind === "per_turn_process"
        && this.adapter.execution.start === "deferred"
        && message.kind === "system"
      ) {
        return this.queue(message, "waiting_for_message", "awaiting_first_message");
      }
      return this.startTurn([message], "prompt");
    }
    if (!this.startedAdmitted) return { status: "rejected", reason: "not_started" };
    if (this.state === "awaiting_first_message") {
      if (message.kind === "system") return this.queue(message, "waiting_for_message");
      const prefix = this.queued.splice(0).map((item) => item.message);
      return this.startTurn([...prefix, message], "prompt");
    }
    if (this.state === "working" || this.state === "starting") {
      if (this.behavior.midTurnDelivery === "steer" && this.activeTurn && this.lane) {
        await this.sendLane(message.text, "busy");
        this.activeTurn.commandIds.push(message.id);
        this.emit({
          type: "command_accepted",
          commandId: message.id,
          turnId: this.activeTurn.turnId,
          delivery: "steer",
        });
        return {
          status: "accepted",
          delivery: "steer",
          commandId: message.id,
          turnId: this.activeTurn.turnId,
        };
      }
      const reason = this.behavior.midTurnDelivery === "safe_boundary_queue"
        ? "unsafe_boundary"
        : "runtime_busy";
      return this.queue(message, reason);
    }
    return this.startTurn([message], "prompt");
  }

  private queue(
    message: AgentMessage,
    reason: QueuedCommand["reason"],
    nextState?: SessionState,
  ): DeliveryReceipt {
    this.queued.push({ message, reason });
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
    this.activeTurn = { turnId, commandIds: [...commandIds], ...(terminalOwner ? { terminalOwner } : {}) };
    this.turnError = undefined;
    this.interruptedTurnId = undefined;
    this.processTurnEnded = false;
    this.state = "starting";
    const generation = this.lifecycleGeneration;
    const text = messages.map((message) => message.text).join("\n\n");
    const admission: TurnAdmission = { messages, turnId, delivery, finalized: false, accepted: false };
    this.turnAdmission = admission;
    try {
      const emitAdmission = () => {
        if (admission.finalized) return;
        admission.finalized = true;
        admission.accepted = true;
        if (this.turnAdmission === admission) this.turnAdmission = undefined;
        for (const message of messages) {
          this.emit({ type: "command_accepted", commandId: message.id, turnId, delivery });
        }
        this.emit({ type: "turn_started", turnId, commandIds });
      };
      let openedSdk = false;
      if (this.adapter.execution.kind === "in_process_sdk" && this.lane) {
        emitAdmission();
        await this.sendLane(text, "idle");
      } else if (this.adapter.execution.kind === "persistent_process" && this.lane) {
        await this.sendLane(text, "idle");
      } else {
        const opened = await this.openLane(text, generation);
        if (!opened) {
          // A racing stop owns terminal settlement. Preserve the historical
          // contract that session_closed is observable before start resolves.
          if (this.finishPromise) await this.finishPromise;
          return { status: "rejected", reason: "closed" };
        }
        openedSdk = this.adapter.execution.kind === "in_process_sdk";
      }
      if (!this.isStartCurrent(generation, turnId)) {
        return { status: "rejected", reason: "closed" };
      }
      emitAdmission();
      if (openedSdk) {
        await this.sendLane(text, "idle");
      }
      const current = messages.at(-1)!;
      if (!this.isStartCurrent(generation, turnId)) {
        return { status: "accepted", delivery, commandId: current.id, turnId };
      }
      this.state = "working";
      return { status: "accepted", delivery, commandId: current.id, turnId };
    } catch (error) {
      if (!this.isStartCurrent(generation, turnId) || admission.finalized) {
        return { status: "rejected", reason: "closed" };
      }
      const failure = driverError("process", "failed_to_start", String(error), true);
      this.failTurnAdmissionWithError(failure);
      this.activeTurn = undefined;
      this.emit({ type: "session_failed", error: failure });
      await this.finish(
        (cleanup) => ({ outcome: "failed_to_start", requested: false, error: failure, cleanup }),
        "failed_start",
      );
      return { status: "rejected", reason: "runtime_unavailable", error: failure };
    }
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

  private async openLane(prompt: string, generation: number): Promise<boolean> {
    if (!this.instructionsMaterialized) {
      const strategy = this.adapter.instructionDelivery;
      if (strategy.kind === "workspace_file" && this.launch.instructions) {
        writeAgentFile(this.launch.workingDirectory, this.launch.instructions, strategy);
      }
      this.instructionsMaterialized = true;
    }
    const ctx = this.internalContext(prompt);
    if (this.adapter.execution.kind === "in_process_sdk" && this.adapter.openSdkSession) {
      const lane = await this.adapter.openSdkSession(ctx) as SdkLane;
      if (!this.isOpenCurrent(generation)) {
        await this.stopLaneInstanceBounded(lane, "stale_open", this.hostReleaseTimeoutMs);
        return false;
      }
      this.lane = lane;
      this.attachLane(lane, generation);
      return true;
    }
    const lane = createProcessLane(this.adapter, ctx, {
      onRawStdoutLine: (text) => this.host.onRawOutput({
        backend: this.backend,
        launchId: this.launch.launchId,
        stream: "stdout",
        text,
      }),
    });
    this.lane = lane;
    this.attachLane(lane, generation);
    await lane.start({ text: prompt, sessionId: ctx.config.sessionId });
    if (!this.isOpenCurrent(generation)) {
      await this.stopLaneInstanceBounded(lane, "stale_open", this.hostReleaseTimeoutMs);
      if (this.lane === lane) this.lane = null;
      return false;
    }
    return true;
  }

  private attachLane(lane: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane, generation: number): void {
    const current = () => this.lane === lane && this.lifecycleGeneration === generation;
    lane.on("runtime_event", (event: unknown) => {
      if (current()) this.onAdapterEvent(event as AdapterEvent, lane, generation);
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
    physicalOwner: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane,
    generation: number,
  ): void {
    if (this.state === "closed" || this.state === "stopping" || this.finishing) return;
    if (this.isClosedPerTurnLaneTail(physicalOwner, generation)) return;
    const turnId = this.activeTurn?.turnId ?? this.reopenClosedLaneForWork(event, physicalOwner, generation);
    switch (event.kind) {
      case "session_init":
        if (this.backendSessionId !== event.sessionId) {
          this.backendSessionId = event.sessionId;
          this.emit({ type: "session_started", backendSessionId: event.sessionId });
        }
        return;
      case "turn_owner":
        if (this.activeTurn) this.activeTurn.terminalOwner = event.receipt;
        return;
      case "thinking":
        if (turnId) this.emit({ type: "thinking_delta", turnId, text: event.text });
        return;
      case "text":
        if (turnId) this.emit({ type: "text_delta", turnId, text: event.text });
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
      case "telemetry": {
        const details = jsonValue(event.attrs) as JsonObject;
        if (event.name === "token_usage") {
          this.emit({ type: "token_usage", turnId, source: event.source, usage: {}, details });
        } else {
          this.emit({ type: "rate_limits", turnId, source: event.source, details });
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
        this.completeTurn(event.sessionId, physicalOwner, generation, event.turnOwner);
        return;
    }
  }

  private isClosedPerTurnLaneTail(
    physicalOwner: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane,
    generation: number,
  ): boolean {
    if (this.adapter.execution.kind !== "per_turn_process" || this.activeTurn) return false;
    const tombstone = this.closedLaneTombstone;
    return tombstone?.state === "closed"
      && tombstone.sessionInstanceId === this.sessionInstanceId
      && tombstone.physicalOwner === physicalOwner
      && tombstone.generation === generation;
  }

  private reopenClosedLaneForWork(
    event: AdapterEvent,
    physicalOwner: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane,
    generation: number,
  ): string | undefined {
    // Defense in depth for direct/internal callers. Normal event delivery drops
    // every event from a closed per-turn transport before any shared-state side
    // effect in onAdapterEvent's switch can run.
    if (this.adapter.execution.kind === "per_turn_process") return undefined;
    const isRootWork = event.kind === "thinking"
      || event.kind === "text"
      || event.kind === "tool_call"
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
    if (active.terminalOwner && terminalOwner !== active.terminalOwner) return;
    if (!active.terminalOwner && terminalOwner) {
      const previous = this.closedLaneTombstone;
      if (
        previous?.terminalOwner === terminalOwner
        && previous.localTurnId !== active.turnId
        && previous.physicalOwner === physicalOwner
        && previous.generation === generation
      ) return;
      active.terminalOwner = terminalOwner;
    }
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
    if (this.adapter.execution.kind === "per_turn_process") {
      this.processTurnEnded = true;
      if (this.adapter.execution.afterTurn === "terminate" && this.lane) {
        void this.stopLane("turn_complete", 2_000);
      }
    } else {
      void Promise.resolve()
        .then(() => this.safeBoundaryFlush)
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
    if (this.turnAdmission === admission) this.turnAdmission = undefined;
    for (const message of admission.messages) {
      this.emit({ type: "command_failed", commandId: message.id, turnId: admission.turnId, error });
    }
  }

  private async startNextQueued(): Promise<void> {
    if (this.state !== "idle" || this.queued.length === 0) return;
    const item = this.queued.shift()!;
    await this.startTurn([item.message], "prompt");
  }

  private onLaneError(
    error: unknown,
    physicalOwner: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane,
    generation: number,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.onAdapterEvent({ kind: "error", message }, physicalOwner, generation);
  }

  private async onLaneExit(lane: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane, info: unknown): Promise<void> {
    if (this.lane !== lane || this.state === "closed") return;
    this.lane = null;
    if (this.state === "stopping") return;
    if (this.adapter.execution.kind === "per_turn_process" && this.processTurnEnded) {
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
    const event = {
      ...payload,
      sequence: ++this.eventSequence,
      sessionInstanceId: this.sessionInstanceId,
      at: this.host.now(),
    } as AgentEvent<Specs, Id>;
    this.eventQueue.push(event, payload.type === "session_closed");
  }

  private failQueued(category: AgentDriverError["category"], code: string, message: string): void {
    const error = driverError(category, code, message);
    for (const item of this.queued.splice(0)) {
      this.emit({ type: "command_failed", commandId: item.message.id, error });
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

  private sendLane(text: string, mode: "busy" | "idle"): Promise<unknown> {
    if (!this.lane) return Promise.reject(new Error("runtime lane is not open"));
    return (this.lane instanceof SdkLane
      ? this.lane.send(text, mode, mode === "idle" ? this.activeTurn?.terminalOwner : undefined)
      : Promise.resolve(this.lane.send({ text, mode })))
      .then((result) => {
        if (!result.ok) throw new Error(String("reason" in result ? result.reason : "runtime rejected delivery"));
        return result;
      });
  }

  private stopLane(reason: string, forceAfterMs: number): Promise<unknown> {
    if (!this.lane) return Promise.resolve();
    return this.lane instanceof SdkLane
      ? this.lane.stop()
      : this.lane.stop({ reason, forceAfterMs });
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
    lane: ProcessLane<Id, ConfigOf<Specs, Id>> | SdkLane,
    reason: string,
    timeoutMs: number,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = (lane instanceof SdkLane
      ? lane.stop()
      : lane.stop({ reason, forceAfterMs: 0 }))
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

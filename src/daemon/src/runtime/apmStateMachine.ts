/**
 * APM (Agent Process Manager) gated-steering state machine.
 *
 * Where `RuntimeTurnState` answers "is it safe *right now*?", this reducer set
 * is the coarse-grained policy layer that decides WHEN to flush queued inbox
 * notices into a `gated` runtime, and emits the concrete delivery effects
 * (`notify_stdin` / `deliver_stdin`).
 *
 * It is a pure reducer: `(state, input) -> { nextState?, effects?, ... }`. The
 * orchestrator owns the mutable copy and applies the effects.
 *
 * Phases: idle → tool_wait → tool_boundary → assistant_continuation →
 *         compacting → error → idle. Notices flush only at safe phases.
 *
 * Clause `SMR-002` tags every stdin-delivery effect (a stable marker used in
 * telemetry to identify the steering-message rule).
 */

export const MAX_APM_GATED_STEERING_EVENTS = 12;

export type ApmPhase =
  | "idle"
  | "tool_wait"
  | "tool_boundary"
  | "assistant_continuation"
  | "compacting"
  | "reviewing"
  | "error";

export interface ApmGatedSteeringState {
  isIdle: boolean;
  expectedTerminationReason: string | null;
  phase: ApmPhase;
  outstandingToolUses: number;
  compacting: boolean;
  /** True while the runtime is in review mode (Codex) — flushes are held. */
  reviewing?: boolean;
  toolBoundaryFlushDisabled: boolean;
  lastFlushReason: string | null;
  recentEvents: string[];
}

export type StdinDeliveryEffect = {
  kind: "notify_stdin" | "deliver_stdin";
  reason: string;
  stdinMode: "busy" | "idle";
  clauseId: "SMR-002";
};

export function createInitialApmGatedSteeringState(): ApmGatedSteeringState {
  return {
    isIdle: false,
    expectedTerminationReason: null,
    phase: "idle",
    outstandingToolUses: 0,
    compacting: false,
    toolBoundaryFlushDisabled: false,
    lastFlushReason: null,
    recentEvents: [],
  };
}

/* ------------------------------------------------------------------ */
/* Phase transitions                                                   */
/* ------------------------------------------------------------------ */

export function reduceApmIdleState(
  state: ApmGatedSteeringState,
  input: { isIdle: boolean },
): { nextState: ApmGatedSteeringState } {
  return { nextState: { ...state, isIdle: input.isIdle } };
}

/**
 * Tool-call open/close. A `tool_call` increments the outstanding count and
 * enters `tool_wait`. Anything else (a tool result) decrements and lands on a
 * `tool_boundary`; when the LAST outstanding tool closes, we signal a batch
 * flush opportunity.
 */
export function reduceApmGatedToolUse(
  state: ApmGatedSteeringState,
  input: { kind: string },
): {
  nextState: ApmGatedSteeringState;
  hadOutstandingToolUse: boolean;
  shouldFlushToolBatch: boolean;
} {
  if (input.kind === "tool_call") {
    return {
      nextState: {
        ...state,
        isIdle: false,
        phase: "tool_wait",
        outstandingToolUses: state.outstandingToolUses + 1,
      },
      hadOutstandingToolUse: state.outstandingToolUses > 0,
      shouldFlushToolBatch: false,
    };
  }
  const hadOutstandingToolUse = state.outstandingToolUses > 0;
  const outstandingToolUses = Math.max(0, state.outstandingToolUses - 1);
  return {
    nextState: {
      ...state,
      isIdle: false,
      phase: "tool_boundary",
      outstandingToolUses,
    },
    hadOutstandingToolUse,
    shouldFlushToolBatch: hadOutstandingToolUse && outstandingToolUses === 0,
  };
}

export function reduceApmGatedCompaction(
  state: ApmGatedSteeringState,
  input: { kind: "compaction_started" | "compaction_interrupted" | string },
): { nextState: ApmGatedSteeringState } {
  if (input.kind === "compaction_started") {
    return { nextState: { ...state, isIdle: false, phase: "compacting", compacting: true } };
  }
  if (input.kind === "compaction_interrupted") {
    return { nextState: { ...state, isIdle: false, compacting: false } };
  }
  // compaction_finished
  return {
    nextState: { ...state, isIdle: false, phase: "assistant_continuation", compacting: false },
  };
}

export function reduceApmGatedAssistantContinuation(state: ApmGatedSteeringState): {
  nextState: ApmGatedSteeringState;
} {
  return { nextState: { ...state, isIdle: false, phase: "assistant_continuation" } };
}

/**
 * Codex review mode. `review_started` enters the `reviewing` phase (flushes are
 * held — see `reduceApmGatedFlushReadiness`); `review_finished` leaves it and
 * lands on `assistant_continuation`, a safe boundary to flush at.
 */
export function reduceApmGatedReview(
  state: ApmGatedSteeringState,
  input: { kind: "review_started" | "review_finished" | string },
): { nextState: ApmGatedSteeringState } {
  if (input.kind === "review_started") {
    return { nextState: { ...state, isIdle: false, phase: "reviewing", reviewing: true } };
  }
  return {
    nextState: { ...state, isIdle: false, phase: "assistant_continuation", reviewing: false },
  };
}

/* ------------------------------------------------------------------ */
/* Delivery decisions (emit effects)                                   */
/* ------------------------------------------------------------------ */

/**
 * After a compaction completes, if there is a session, the runtime supports
 * stdin, the inbox is non-empty AND a notification is pending — deliver a busy
 * notice. (Compaction is a natural safe boundary.)
 */
export function reduceApmGatedCompactionBoundaryFlush(
  _state: ApmGatedSteeringState,
  input: {
    hasSession: boolean;
    supportsStdinNotification: boolean;
    inboxLength: number;
    pendingNotificationCount: number;
  },
): { effects: StdinDeliveryEffect[] } {
  if (!input.hasSession || !input.supportsStdinNotification || input.inboxLength === 0) {
    return { effects: [] };
  }
  if (input.pendingNotificationCount === 0) return { effects: [] };
  return {
    effects: [{ kind: "notify_stdin", reason: "compaction_finished", stdinMode: "busy", clauseId: "SMR-002" }],
  };
}

/** Symmetric to compaction: review exit is also a safe flush boundary. */
export function reduceApmGatedReviewBoundaryFlush(
  _state: ApmGatedSteeringState,
  input: {
    hasSession: boolean;
    supportsStdinNotification: boolean;
    inboxLength: number;
    pendingNotificationCount: number;
  },
): { effects: StdinDeliveryEffect[] } {
  if (!input.hasSession || !input.supportsStdinNotification || input.inboxLength === 0) {
    return { effects: [] };
  }
  if (input.pendingNotificationCount === 0) return { effects: [] };
  return {
    effects: [{ kind: "notify_stdin", reason: "review_finished", stdinMode: "busy", clauseId: "SMR-002" }],
  };
}

/**
 * Turn ended. If there are queued messages and the runtime can take them, go
 * NOT-idle and deliver them as an `idle`-mode prompt (the cleanest boundary —
 * a fresh turn). Otherwise mark idle.
 */
export function reduceApmGatedTurnEnd(
  state: ApmGatedSteeringState,
  input: {
    inboxLength?: number;
    supportsStdinNotification?: boolean;
    hasSession?: boolean;
    terminateProcessOnTurnEnd?: boolean;
  } = {},
): { nextState: ApmGatedSteeringState; effects: StdinDeliveryEffect[] } {
  const shouldDeliverQueuedMessages = Boolean(
    input.inboxLength && input.inboxLength > 0 && input.supportsStdinNotification && input.hasSession,
  );
  return {
    nextState: {
      ...state,
      isIdle: !shouldDeliverQueuedMessages,
      expectedTerminationReason:
        input.terminateProcessOnTurnEnd === true ? "turn_end" : state.expectedTerminationReason,
      phase: "idle",
      outstandingToolUses: 0,
      compacting: false,
    },
    effects: shouldDeliverQueuedMessages
      ? [{ kind: "deliver_stdin", reason: "turn_end", stdinMode: "idle", clauseId: "SMR-002" }]
      : [],
  };
}

export function reduceApmGatedError(
  state: ApmGatedSteeringState,
  input: { terminalWakeable?: boolean; disableToolBoundaryFlush?: boolean } = {},
): { nextState: ApmGatedSteeringState; shouldDisableToolBoundaryFlush: boolean } {
  const shouldDisableToolBoundaryFlush = input.disableToolBoundaryFlush === true;
  return {
    nextState: {
      ...state,
      isIdle: input.terminalWakeable === true,
      phase: "error",
      compacting: false,
      toolBoundaryFlushDisabled: state.toolBoundaryFlushDisabled || shouldDisableToolBoundaryFlush,
    },
    shouldDisableToolBoundaryFlush,
  };
}

/**
 * The central "can I flush a tool-boundary notice now?" gate. Returns
 * `shouldNotify` plus a structured `blockedReason` for telemetry, and the
 * busy-mode `notify_stdin` effect when clear.
 */
export function reduceApmGatedFlushReadiness(
  state: ApmGatedSteeringState,
  input: { isGated: boolean; hasSession: boolean; inboxLength: number; reason: string },
): { shouldNotify: boolean; blockedReason: string | null; effects: StdinDeliveryEffect[] } {
  if (!input.isGated) return { shouldNotify: false, blockedReason: "non_gated", effects: [] };
  if (!input.hasSession) return { shouldNotify: false, blockedReason: "missing_session", effects: [] };
  if (input.inboxLength === 0) return { shouldNotify: false, blockedReason: "empty_inbox", effects: [] };
  if (state.toolBoundaryFlushDisabled) {
    return { shouldNotify: false, blockedReason: "tool_boundary_flush_disabled", effects: [] };
  }
  if (state.compacting) return { shouldNotify: false, blockedReason: "compacting", effects: [] };
  if (state.reviewing) return { shouldNotify: false, blockedReason: "reviewing", effects: [] };
  if (state.outstandingToolUses > 0) {
    return { shouldNotify: false, blockedReason: "outstanding_tool_uses", effects: [] };
  }
  return {
    shouldNotify: true,
    blockedReason: null,
    effects: [{ kind: "notify_stdin", reason: input.reason, stdinMode: "busy", clauseId: "SMR-002" }],
  };
}

export function reduceApmGatedFlush(
  state: ApmGatedSteeringState,
  input: { reason: string },
): { nextState: ApmGatedSteeringState } {
  return { nextState: { ...state, lastFlushReason: input.reason } };
}

export function reduceApmGatedRecentEvent(
  state: ApmGatedSteeringState,
  input: { event: string },
): { nextState: ApmGatedSteeringState } {
  const summary = `${input.event}:${state.phase}:tools=${state.outstandingToolUses}:compact=${state.compacting}`;
  return {
    nextState: {
      ...state,
      recentEvents: [...state.recentEvents, summary].slice(-MAX_APM_GATED_STEERING_EVENTS),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Recovery / termination                                              */
/* ------------------------------------------------------------------ */

/** Decide whether to terminate-and-restart a stalled process for recovery. */
export function reduceApmStalledRecoveryTermination(
  state: ApmGatedSteeringState,
  input: {
    inboxLength: number;
    supportsStdinNotification: boolean;
    busyDeliveryMode: string;
    hasSession: boolean;
    hasDirectStdinRecoveryEvidence: boolean;
    staleForMs: number;
    staleThresholdMs: number;
    runtimeProgressIsStale: boolean;
  },
): {
  nextState: ApmGatedSteeringState;
  shouldTerminate: boolean;
  alreadyRecovering: boolean;
  blockedReason: string | null;
} {
  if (input.inboxLength === 0) {
    return { nextState: state, shouldTerminate: false, alreadyRecovering: false, blockedReason: "empty_inbox" };
  }
  if (state.expectedTerminationReason === "stalled_recovery") {
    return { nextState: state, shouldTerminate: false, alreadyRecovering: true, blockedReason: null };
  }
  const directStdinRuntime = input.supportsStdinNotification && input.busyDeliveryMode === "direct";
  const canRestartDirectStdinProcess =
    directStdinRuntime &&
    input.hasSession &&
    (state.outstandingToolUses === 0 || input.hasDirectStdinRecoveryEvidence);
  const canRestartStalledProcess = !input.supportsStdinNotification || canRestartDirectStdinProcess;
  if (!canRestartStalledProcess) {
    return {
      nextState: state,
      shouldTerminate: false,
      alreadyRecovering: false,
      blockedReason: "runtime_not_restartable",
    };
  }
  if (input.staleForMs < input.staleThresholdMs && !input.runtimeProgressIsStale) {
    return {
      nextState: state,
      shouldTerminate: false,
      alreadyRecovering: false,
      blockedReason: "runtime_progress_recent",
    };
  }
  return {
    nextState: { ...state, expectedTerminationReason: "stalled_recovery" },
    shouldTerminate: true,
    alreadyRecovering: false,
    blockedReason: null,
  };
}

export function reduceApmStartupTimeoutTermination(
  state: ApmGatedSteeringState,
  input: { hasRuntimeProgressEvent: boolean },
): { nextState: ApmGatedSteeringState; shouldTerminate: boolean; blockedReason: string | null } {
  if (input.hasRuntimeProgressEvent) {
    return { nextState: state, shouldTerminate: false, blockedReason: "runtime_progress_started" };
  }
  return {
    nextState: { ...state, isIdle: false, expectedTerminationReason: "startup_timeout" },
    shouldTerminate: true,
    blockedReason: null,
  };
}


export type AgentStatus = "idle" | "starting" | "running" | "stopping";

export interface AgentMsg {
  id?: string;
  seq?: number;
  text: string;
}

export interface TurnIdentity {
  sessionInstanceId: string;
  turnId: string;
}

export interface RootTerminal {
  identity: TurnIdentity;
  at: number;
}

export type NativeActivityKind =
  | "turn_started"
  | "backend_turn_started"
  | "thinking"
  | "text"
  | "tool_call"
  | "tool_output"
  | "internal_progress"
  | "recovery"
  | "turn_end";

export type RuntimePhase = "idle" | "admission" | "inference" | "tool" | "recovery" | "terminal";

export interface TurnSilencePolicy {
  nativeIdleTimeoutMs: number;
  daemonGraceMs: number;
  recoveryGraceMs: number;
  maxRecoveryExtensions: number;
  normalBudgetMs: number;
}

export interface PendingAdmission {
  sessionInstanceId: string;
  commandId: string;
  exactAgentMsg: AgentMsg;
  admittedAt: number;
  driverAcknowledged: boolean;
  mode: "busy" | "idle";
  requeueOnFailure: boolean;
}

export type RootLease =
  | { state: "detached" }
  | { state: "none"; lastTerminal: RootTerminal | null }
  | {
      state: "active";
      identity: TurnIdentity;
      lastWorkAt: number;
      nativeDeadlineAt: number;
      recoveryExtensionsUsed: number;
      outstandingToolUses?: number;
    }
  | {
      state: "suspect_active";
      identity: TurnIdentity;
      lastWorkAt: number;
      nativeDeadlineAt: number;
      recoveryExtensionsUsed: number;
      outstandingToolUses?: number;
      reason: "work_after_terminal";
    };

export type ExecutionEpoch =
  | { sessionInstanceId: null; lease: { state: "detached" } }
  | { sessionInstanceId: string; lease: Exclude<RootLease, { state: "detached" }> };

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  inbox: AgentMsg[];
  sessionId: string | null;
  /** Backend session that has already consumed its one same-session stall recovery. */
  stalledSessionId: string | null;
  execution: ExecutionEpoch;
  pendingAdmissions: PendingAdmission[];
  turnId: string | null;
  turnActive: boolean;
  lastProgressAt: number;
  lastNativeActivityAt: number;
  lastNativeActivityKind: NativeActivityKind | null;
  runtimePhase: RuntimePhase;
  backendTurnId: string | null;
  turnSilence: TurnSilencePolicy;
  lastDeliverAt: number | null;
  idleSince: number | null;
  stoppingSince: number | null;
  resetting: boolean;
  resettingSince: number | null;
}

export function isActivelyWorking(agent: AgentState): boolean {
  return agent.status === "running"
    && (leaseIsWorking(agent.execution.lease) || agent.pendingAdmissions.length > 0 || agent.inbox.length > 0);
}

export interface ManagerState {
  agents: Record<string, AgentState>;
  staleThresholdMs: number;
  idleTimeoutMs: number;
  idleResetTimeoutMs: number;
  resetStuckThresholdMs: number;
  stoppingStuckThresholdMs: number;
}

export type ManagerEvent =
  | { type: "register"; agentId: string }
  | { type: "wake"; agentId: string; message: AgentMsg; nowMs: number }
  | { type: "spawned"; agentId: string; nowMs: number }
  | { type: "backend_session"; agentId: string; sessionId: string; stalledBefore?: boolean }
  | {
      type: "attach_session";
      agentId: string;
      sessionInstanceId: string;
      nowMs: number;
      turnSilence?: TurnSilencePolicy;
    }
  | {
      type: "admission_started";
      agentId: string;
      sessionInstanceId: string;
      commandId: string;
      exactAgentMsg: AgentMsg;
      mode: "busy" | "idle";
      requeueOnFailure: boolean;
      nowMs: number;
    }
  | {
      type: "admission_settled";
      agentId: string;
      sessionInstanceId: string;
      commandId: string;
      outcome: "accepted" | "failed";
    }
  | {
      type: "admission_acknowledged";
      agentId: string;
      sessionInstanceId: string;
      commandId: string;
    }
  | {
      type: "turn_started";
      agentId: string;
      sessionInstanceId: string;
      turnId: string;
      commandIds: readonly string[];
      nowMs: number;
    }
  | { type: "turn_work"; agentId: string; sessionInstanceId: string; turnId: string; nowMs: number }
  | { type: "turn_tool_started"; agentId: string; sessionInstanceId: string; turnId: string; nowMs: number }
  | { type: "turn_tool_finished"; agentId: string; sessionInstanceId: string; turnId: string; nowMs: number }
  | {
      type: "turn_completed";
      agentId: string;
      sessionInstanceId: string;
      nowMs: number;
      endReason?: "errored";
      turnId: string;
      terminationCause?: "runtime_error" | "killed_stalled";
      errorDetail?: string;
    }
  | { type: "session_closed"; agentId: string; sessionInstanceId: string }
  | {
      type: "exit";
      agentId: string;
      exitCode?: number | null;
      exitSignal?: string | null;
      abnormal?: boolean;
      spawnFailureReason?: string | null;
      terminationSemantics?: string | null;
    }
  | { type: "tick"; nowMs: number }
  | { type: "reset_session"; agentId: string }
  | { type: "idle_reset_committed"; agentId: string; nowMs: number }
  | { type: "begin_reset"; agentId: string; nowMs: number }
  | { type: "rewake_after_reset"; agentId: string; message: AgentMsg }
  | { type: "runtime_config_applied"; agentId: string }
  | {
      type: "runtime_signal";
      agentId: string;
      sessionInstanceId: string;
      turnId: string;
      kind: NativeActivityKind;
      phase: RuntimePhase;
      nowMs: number;
      backendTurnId?: string;
      recoveryStage?: "retrying" | "recovered";
    }
  | {
      type: "stall_control_failed";
      agentId: string;
      sessionId: string;
      transition: "attempt" | "fence" | "clear";
    }
  | {
      type: "delivery_rejected";
      agentId: string;
      message: AgentMsg;
      mode: "busy" | "idle";
    };

export type ManagerEffect =
  | { type: "spawn"; agentId: string; messages: AgentMsg[]; resumeSessionId: string | null }
  | { type: "send"; agentId: string; message: AgentMsg; mode: "busy" | "idle" }
  | { type: "stop"; agentId: string; reason: string }
  | { type: "terminate_stalled"; agentId: string; recordSessionId?: string; forgetSessionId?: string }
  | { type: "clear_stall_recovery"; agentId: string; sessionId: string }
  | { type: "expire_admission"; agentId: string; sessionInstanceId: string; commandIds: string[] }
  | { type: "requeue_delivery"; agentId: string; message: AgentMsg; mode: "busy" | "idle" }
  | { type: "reset_idle_session"; agentId: string; sessionId: string }
  | { type: "force_exit"; agentId: string; reason: string };

export const DEFAULT_STALE_THRESHOLD_MS = 120_000;
export const DEFAULT_TURN_SILENCE_POLICY: TurnSilencePolicy = {
  nativeIdleTimeoutMs: 300_000,
  daemonGraceMs: 60_000,
  recoveryGraceMs: 60_000,
  maxRecoveryExtensions: 1,
  normalBudgetMs: 360_000,
};
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_IDLE_RESET_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
export const DEFAULT_RESET_STUCK_THRESHOLD_MS = 120_000;
export const DEFAULT_STOPPING_STUCK_THRESHOLD_MS = 30_000;

export interface ReduceResult {
  state: ManagerState;
  effects: ManagerEffect[];
}

export function createInitialManagerState(
  staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  resetStuckThresholdMs = DEFAULT_RESET_STUCK_THRESHOLD_MS,
  stoppingStuckThresholdMs = DEFAULT_STOPPING_STUCK_THRESHOLD_MS,
  idleResetTimeoutMs = DEFAULT_IDLE_RESET_TIMEOUT_MS,
): ManagerState {
  return {
    agents: {},
    staleThresholdMs,
    idleTimeoutMs,
    idleResetTimeoutMs,
    resetStuckThresholdMs,
    stoppingStuckThresholdMs,
  };
}

export function reduceManager(state: ManagerState, event: ManagerEvent): ReduceResult {
  switch (event.type) {
    case "register":
      return withAgent(state, event.agentId, (a) => a ?? freshAgent(event.agentId), []);

    case "wake":
      return onWake(state, event.agentId, event.message);

    case "spawned":
      return mutate(state, event.agentId, (a) => {
        enterStable(a, "running");
        syncExecutionProjection(a);
      });

    case "backend_session":
      return mutate(state, event.agentId, (a) => {
        if (event.stalledBefore) {
          a.stalledSessionId = event.sessionId;
        } else if (a.stalledSessionId !== null && a.stalledSessionId !== event.sessionId) {
          a.stalledSessionId = null;
        }
        a.sessionId = event.sessionId;
      });

    case "attach_session": {
      const existing = state.agents[event.agentId];
      if (!existing) return { state, effects: [] };
      const agent = clone(existing);
      const effects = recoveryEffects(agent, agent.pendingAdmissions);
      agent.pendingAdmissions = [];
      {
        const a = agent;
        a.execution = { sessionInstanceId: event.sessionInstanceId, lease: { state: "none", lastTerminal: null } };
        a.turnSilence = event.turnSilence ?? {
          ...DEFAULT_TURN_SILENCE_POLICY,
          nativeIdleTimeoutMs: state.staleThresholdMs,
          daemonGraceMs: 0,
          normalBudgetMs: state.staleThresholdMs,
        };
        a.lastProgressAt = event.nowMs;
        a.lastNativeActivityAt = event.nowMs;
        a.lastNativeActivityKind = null;
        a.runtimePhase = "admission";
        a.backendTurnId = null;
        a.idleSince = null;
        syncExecutionProjection(a);
      }
      return commit(state, agent, effects);
    }

    case "admission_started": {
      const existing = state.agents[event.agentId];
      if (!existing || existing.execution.sessionInstanceId !== event.sessionInstanceId) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        if (!matchesSession(a, event.sessionInstanceId)) return;
        if (a.pendingAdmissions.some((entry) => entry.commandId === event.commandId)) return;
        a.pendingAdmissions = [...a.pendingAdmissions, {
          sessionInstanceId: event.sessionInstanceId,
          commandId: event.commandId,
          exactAgentMsg: event.exactAgentMsg,
          admittedAt: event.nowMs,
          driverAcknowledged: false,
          mode: event.mode,
          requeueOnFailure: event.requeueOnFailure,
        }];
        a.idleSince = null;
        syncExecutionProjection(a);
      });
    }

    case "admission_settled": {
      const existing = state.agents[event.agentId];
      if (!existing || existing.execution.sessionInstanceId !== event.sessionInstanceId) return { state, effects: [] };
      const record = existing.pendingAdmissions.find((entry) =>
        entry.sessionInstanceId === event.sessionInstanceId && entry.commandId === event.commandId);
      if (!record) return { state, effects: [] };
      const agent = clone(existing);
      agent.pendingAdmissions = agent.pendingAdmissions.filter((entry) =>
        entry.sessionInstanceId !== event.sessionInstanceId || entry.commandId !== event.commandId);
      syncExecutionProjection(agent);
      return commit(
        state,
        agent,
        event.outcome === "failed" ? recoveryEffects(agent, [record]) : [],
      );
    }

    case "admission_acknowledged": {
      const existing = state.agents[event.agentId];
      if (!existing || existing.execution.sessionInstanceId !== event.sessionInstanceId) return { state, effects: [] };
      if (!existing.pendingAdmissions.some((entry) =>
        entry.sessionInstanceId === event.sessionInstanceId && entry.commandId === event.commandId)) {
        return { state, effects: [] };
      }
      return mutate(state, event.agentId, (a) => {
        a.pendingAdmissions = a.pendingAdmissions.map((entry) =>
          entry.sessionInstanceId === event.sessionInstanceId && entry.commandId === event.commandId
            ? { ...entry, driverAcknowledged: true }
            : entry);
      });
    }

    case "reset_session":
      if (!state.agents[event.agentId]) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        a.sessionId = null;
        a.stalledSessionId = null;
        a.idleSince = null;
      });

    case "idle_reset_committed": {
      const existing = state.agents[event.agentId];
      if (!existing) return { state, effects: [] };
      const agent = clone(existing);
      agent.sessionId = null;
      agent.stalledSessionId = null;
      agent.idleSince = null;
      if (agent.status !== "running") return commit(state, agent, []);
      agent.status = "stopping";
      agent.stoppingSince = event.nowMs;
      return commit(state, agent, [
        { type: "stop", agentId: event.agentId, reason: "idle_session_reset" },
      ]);
    }

    case "begin_reset":
      if (!state.agents[event.agentId]) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        a.resetting = true;
        a.resettingSince = event.nowMs;
        const lease = a.execution.lease;
        if ((lease.state === "active" || lease.state === "suspect_active") && lease.outstandingToolUses !== undefined) {
          const unblockedLease = { ...lease };
          delete unblockedLease.outstandingToolUses;
          a.execution.lease = unblockedLease;
        }
      });

    case "rewake_after_reset":
      if (!state.agents[event.agentId]) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        a.inbox = [...a.inbox, event.message];
        a.idleSince = null;
      });

    case "runtime_config_applied": {
      const existing = state.agents[event.agentId];
      if (!existing) return { state, effects: [] };
      const agent = clone(existing);
      if (
        agent.status !== "running"
        || leaseIsWorking(agent.execution.lease)
        || agent.pendingAdmissions.length > 0
        || agent.inbox.length === 0
      ) return { state, effects: [] };
      const messages = drainInbox(agent);
      return commit(state, agent, messages.map((message) => ({
        type: "send" as const,
        agentId: event.agentId,
        message,
        mode: "idle" as const,
      })));
    }

    case "turn_started": {
      const existing = state.agents[event.agentId];
      if (!existing || existing.execution.sessionInstanceId !== event.sessionInstanceId) return { state, effects: [] };
      const current = existing.execution.lease;
      const nextIdentity = identityOf(event);
      if (
        (current.state === "active" || current.state === "suspect_active")
        && !sameIdentity(current.identity, nextIdentity)
      ) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        if (!matchesSession(a, event.sessionInstanceId)) return;
        const lease = a.execution.lease;
        const identity = identityOf(event);
        if ((lease.state === "active" || lease.state === "suspect_active") && !sameIdentity(lease.identity, identity)) return;
        const startedCommands = new Set(event.commandIds);
        a.pendingAdmissions = a.pendingAdmissions.filter((entry) => !startedCommands.has(entry.commandId));
        a.execution.lease = {
          state: "active",
          identity,
          lastWorkAt: event.nowMs,
          nativeDeadlineAt: event.nowMs + a.turnSilence.normalBudgetMs,
          recoveryExtensionsUsed: 0,
        };
        a.lastProgressAt = event.nowMs;
        a.lastNativeActivityAt = event.nowMs;
        a.lastNativeActivityKind = "turn_started";
        a.runtimePhase = "inference";
        a.backendTurnId = null;
        a.idleSince = null;
        syncExecutionProjection(a);
      });
    }

    case "turn_work": {
      const existing = state.agents[event.agentId];
      if (!existing || existing.execution.sessionInstanceId !== event.sessionInstanceId) return { state, effects: [] };
      const current = existing.execution.lease;
      const nextIdentity = identityOf(event);
      const matchesActive = (current.state === "active" || current.state === "suspect_active")
        && sameIdentity(current.identity, nextIdentity);
      const matchesTerminal = current.state === "none"
        && current.lastTerminal !== null
        && sameIdentity(current.lastTerminal.identity, nextIdentity);
      if (!matchesActive && !matchesTerminal) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        if (!matchesSession(a, event.sessionInstanceId)) return;
        const lease = a.execution.lease;
        const identity = identityOf(event);
        if ((lease.state === "active" || lease.state === "suspect_active") && sameIdentity(lease.identity, identity)) {
          a.execution.lease = {
            ...lease,
            lastWorkAt: event.nowMs,
            nativeDeadlineAt: event.nowMs + a.turnSilence.normalBudgetMs,
            recoveryExtensionsUsed: 0,
          };
        } else {
          const terminal = lease.state === "none" ? lease.lastTerminal : null;
          if (!terminal || !sameIdentity(terminal.identity, identity)) return;
          a.execution.lease = {
            state: "suspect_active",
            identity,
            lastWorkAt: event.nowMs,
            nativeDeadlineAt: event.nowMs + a.turnSilence.normalBudgetMs,
            recoveryExtensionsUsed: 0,
            reason: "work_after_terminal",
          };
        }
        a.lastProgressAt = event.nowMs;
        a.idleSince = null;
        syncExecutionProjection(a);
      });
    }

    case "turn_tool_started":
      return onTurnToolLifecycle(state, event, "started");

    case "turn_tool_finished":
      return onTurnToolLifecycle(state, event, "finished");

    case "turn_completed":
      return onTurnCompleted(
        state,
        event.agentId,
        event.sessionInstanceId,
        event.nowMs,
        event.turnId,
        event.endReason,
      );

    case "session_closed":
      if (state.agents[event.agentId]?.execution.sessionInstanceId !== event.sessionInstanceId) {
        return { state, effects: [] };
      }
      {
        const agent = clone(state.agents[event.agentId]!);
        const closing = agent.pendingAdmissions.filter((entry) => entry.sessionInstanceId === event.sessionInstanceId);
        agent.pendingAdmissions = agent.pendingAdmissions.filter((entry) => entry.sessionInstanceId !== event.sessionInstanceId);
        agent.execution = { sessionInstanceId: null, lease: { state: "detached" } };
        syncExecutionProjection(agent);
        return commit(state, agent, recoveryEffects(agent, closing));
      }

    case "exit":
      return onExit(state, event.agentId);

    case "tick":
      return onTick(state, event.nowMs);

    case "runtime_signal": {
      const existing = state.agents[event.agentId];
      if (!existing || existing.execution.sessionInstanceId !== event.sessionInstanceId) return { state, effects: [] };
      const lease = existing.execution.lease;
      const identity = { sessionInstanceId: event.sessionInstanceId, turnId: event.turnId };
      if ((lease.state !== "active" && lease.state !== "suspect_active") || !sameIdentity(lease.identity, identity)) {
        return { state, effects: [] };
      }
      return mutate(state, event.agentId, (a) => {
        const active = a.execution.lease;
        if ((active.state !== "active" && active.state !== "suspect_active") || !sameIdentity(active.identity, identity)) return;
        if (event.kind === "recovery" && event.recoveryStage !== "recovered") {
          if (active.recoveryExtensionsUsed < a.turnSilence.maxRecoveryExtensions) {
            a.execution.lease = {
              ...active,
              nativeDeadlineAt: Math.max(
                active.nativeDeadlineAt,
                event.nowMs + a.turnSilence.recoveryGraceMs,
              ),
              recoveryExtensionsUsed: active.recoveryExtensionsUsed + 1,
            };
          }
        } else {
          a.execution.lease = {
            ...active,
            nativeDeadlineAt: event.nowMs + a.turnSilence.normalBudgetMs,
          };
        }
        a.lastNativeActivityAt = event.nowMs;
        a.lastNativeActivityKind = event.kind;
        a.runtimePhase = event.phase;
        if (event.backendTurnId) a.backendTurnId = event.backendTurnId;
      });
    }

    case "stall_control_failed":
      return mutate(state, event.agentId, (a) => {
        if (event.transition === "clear") {
          if (a.sessionId === event.sessionId) a.stalledSessionId = event.sessionId;
          return;
        }
        if (a.status !== "stopping") return;
        const lease = a.execution.lease;
        if (lease.state !== "active" && lease.state !== "suspect_active") return;
        a.status = "running";
        a.stoppingSince = null;
        a.sessionId = event.sessionId;
        a.stalledSessionId = event.transition === "fence" ? event.sessionId : null;
      });

    case "delivery_rejected":
      return mutate(state, event.agentId, (a) => {
        if (!a.inbox.some((message) => message.id === event.message.id)) {
          a.inbox = [event.message, ...a.inbox];
        }
        syncExecutionProjection(a);
        a.idleSince = null;
      });
  }
}

function onWake(state: ManagerState, agentId: string, message: AgentMsg): ReduceResult {
  const existing = state.agents[agentId];
  const agent = existing ? clone(existing) : null;
  if (!agent) {
    return { state, effects: [] };
  }

  if (agent.resetting && agent.status !== "idle") {
    agent.inbox = [...agent.inbox, message];
    agent.idleSince = null;
    return commit(state, agent, []);
  }

  agent.inbox = [...agent.inbox, message];
  agent.idleSince = null;

  if (agent.status === "idle") {
    agent.status = "starting";
    const messages = drainInbox(agent);
    return commit(state, agent, [
      { type: "spawn", agentId, messages, resumeSessionId: agent.sessionId },
    ]);
  }

  if (agent.status === "running") {
    const messages = drainInbox(agent);
    const mode = leaseIsWorking(agent.execution.lease) || agent.pendingAdmissions.length > 0 ? "busy" : "idle";
    return commit(state, agent, messages.map((queued) => ({ type: "send", agentId, message: queued, mode })));
  }

  return commit(state, agent, []);
}

function onTurnCompleted(
  state: ManagerState,
  agentId: string,
  sessionInstanceId: string,
  nowMs: number,
  turnId: string,
  endReason: "errored" | undefined,
): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  if (!matchesSession(agent, sessionInstanceId)) return { state, effects: [] };
  const lease = agent.execution.lease;
  if (lease.state !== "active" && lease.state !== "suspect_active") return { state, effects: [] };
  const identity = { sessionInstanceId, turnId };
  if (!sameIdentity(lease.identity, identity)) return { state, effects: [] };
  const lastTerminal = { identity, at: nowMs };
  agent.execution.lease = { state: "none", lastTerminal };
  agent.lastProgressAt = nowMs;
  agent.lastNativeActivityAt = nowMs;
  agent.lastNativeActivityKind = "turn_end";
  agent.runtimePhase = "terminal";
  const clearedStallSessionId = endReason === undefined ? agent.stalledSessionId : null;
  if (clearedStallSessionId !== null) agent.stalledSessionId = null;
  syncExecutionProjection(agent);
  const clearEffects: ManagerEffect[] = clearedStallSessionId === null
    ? []
    : [{ type: "clear_stall_recovery", agentId, sessionId: clearedStallSessionId }];
  if (agent.inbox.length > 0 && !agent.resetting) {
    const messages = drainInbox(agent);
    return commit(state, agent, [
      ...clearEffects,
      ...messages.map((queued) => ({ type: "send" as const, agentId, message: queued, mode: "idle" as const })),
    ]);
  }

  agent.idleSince = nowMs;
  return commit(state, agent, clearEffects);
}

function onTurnToolLifecycle(
  state: ManagerState,
  event: Extract<ManagerEvent, { type: "turn_tool_started" | "turn_tool_finished" }>,
  lifecycle: "started" | "finished",
): ReduceResult {
  const existing = state.agents[event.agentId];
  if (
    !existing
    || existing.resetting
    || existing.execution.sessionInstanceId !== event.sessionInstanceId
  ) return { state, effects: [] };
  const current = existing.execution.lease;
  const identity = identityOf(event);
  const matchesActive = (current.state === "active" || current.state === "suspect_active")
    && sameIdentity(current.identity, identity);
  const matchesTerminal = lifecycle === "started"
    && current.state === "none"
    && current.lastTerminal !== null
    && sameIdentity(current.lastTerminal.identity, identity);
  if (!matchesActive && !matchesTerminal) return { state, effects: [] };
  if (lifecycle === "finished" && matchesActive && (current.outstandingToolUses ?? 0) === 0) {
    return { state, effects: [] };
  }
  return mutate(state, event.agentId, (agent) => {
    if (!matchesSession(agent, event.sessionInstanceId)) return;
    const lease = agent.execution.lease;
    if ((lease.state === "active" || lease.state === "suspect_active") && sameIdentity(lease.identity, identity)) {
      const outstandingToolUses = (lease.outstandingToolUses ?? 0) + (lifecycle === "started" ? 1 : -1);
      if (outstandingToolUses > 0) {
        agent.execution.lease = {
          ...lease,
          lastWorkAt: event.nowMs,
          nativeDeadlineAt: event.nowMs + agent.turnSilence.normalBudgetMs,
          recoveryExtensionsUsed: 0,
          outstandingToolUses,
        };
      } else {
        const unblockedLease = { ...lease };
        delete unblockedLease.outstandingToolUses;
        agent.execution.lease = {
          ...unblockedLease,
          lastWorkAt: event.nowMs,
          nativeDeadlineAt: event.nowMs + agent.turnSilence.normalBudgetMs,
          recoveryExtensionsUsed: 0,
        };
      }
    } else {
      const terminal = lease.state === "none" ? lease.lastTerminal : null;
      if (lifecycle !== "started" || !terminal || !sameIdentity(terminal.identity, identity)) return;
      agent.execution.lease = {
        state: "suspect_active",
        identity,
        lastWorkAt: event.nowMs,
        nativeDeadlineAt: event.nowMs + agent.turnSilence.normalBudgetMs,
        recoveryExtensionsUsed: 0,
        outstandingToolUses: 1,
        reason: "work_after_terminal",
      };
    }
    agent.lastProgressAt = event.nowMs;
    agent.lastNativeActivityAt = event.nowMs;
    agent.lastNativeActivityKind = lifecycle === "started" ? "tool_call" : "tool_output";
    agent.runtimePhase = lifecycle === "started" ? "tool" : "inference";
    agent.idleSince = null;
    syncExecutionProjection(agent);
  });
}

function onExit(state: ManagerState, agentId: string): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  const effects = recoveryEffects(agent, agent.pendingAdmissions);
  agent.pendingAdmissions = [];
  agent.execution = { sessionInstanceId: null, lease: { state: "detached" } };
  agent.runtimePhase = "idle";
  agent.backendTurnId = null;
  agent.stoppingSince = null;
  syncExecutionProjection(agent);

  if (agent.inbox.length > 0) {
    agent.status = "starting";
    const messages = drainInbox(agent);
    return commit(state, agent, [
      ...effects,
      { type: "spawn", agentId, messages, resumeSessionId: agent.sessionId },
    ]);
  }
  enterStable(agent, "idle");
  return commit(state, agent, effects);
}

function onTick(state: ManagerState, nowMs: number): ReduceResult {
  const effects: ManagerEffect[] = [];
  const agents = { ...state.agents };
  for (const id of Object.keys(agents)) {
    const a = agents[id];

    const lease = a.execution.lease;
    const stalled = a.status === "running"
      && (lease.state === "active" || lease.state === "suspect_active")
      && (lease.outstandingToolUses ?? 0) === 0
      && nowMs - lease.lastWorkAt >= a.turnSilence.normalBudgetMs
      && nowMs >= lease.nativeDeadlineAt;
    if (stalled) {
      const repeatedSessionStall = a.sessionId !== null && a.stalledSessionId === a.sessionId;
      const forgetSessionId = repeatedSessionStall ? a.sessionId! : undefined;
      agents[id] = {
        ...a,
        status: "stopping",
        sessionId: repeatedSessionStall ? null : a.sessionId,
        stalledSessionId: repeatedSessionStall ? null : a.sessionId,
        idleSince: null,
        stoppingSince: nowMs,
      };
      effects.push(forgetSessionId
        ? { type: "terminate_stalled", agentId: id, forgetSessionId }
        : a.sessionId !== null
          ? { type: "terminate_stalled", agentId: id, recordSessionId: a.sessionId }
          : { type: "terminate_stalled", agentId: id });
      continue;
    }

    const expiredAdmission = a.status === "running"
      && a.pendingAdmissions.filter((entry) =>
        !entry.driverAcknowledged && nowMs - entry.admittedAt >= state.staleThresholdMs);
    if (expiredAdmission && expiredAdmission.length > 0 && a.execution.sessionInstanceId !== null) {
      agents[id] = {
        ...a,
        pendingAdmissions: a.pendingAdmissions.filter((entry) => !expiredAdmission.includes(entry)),
        status: "stopping",
        idleSince: null,
        stoppingSince: nowMs,
      };
      effects.push(...recoveryEffects(a, expiredAdmission));
      effects.push({
        type: "expire_admission",
        agentId: id,
        sessionInstanceId: a.execution.sessionInstanceId,
        commandIds: expiredAdmission.map((entry) => entry.commandId),
      });
      continue;
    }

    const resetStuck =
      a.resetting &&
      a.status !== "stopping" &&
      a.resettingSince !== null &&
      nowMs - a.resettingSince >= state.resetStuckThresholdMs;
    if (resetStuck) {
      agents[id] = { ...a, status: "stopping", idleSince: null, stoppingSince: nowMs };
      effects.push({ type: "terminate_stalled", agentId: id });
      continue;
    }

    const stoppingStuck =
      a.status === "stopping" &&
      a.stoppingSince !== null &&
      nowMs - a.stoppingSince >= state.stoppingStuckThresholdMs;
    if (stoppingStuck) {
      effects.push({ type: "force_exit", agentId: id, reason: "stopping_stuck" });
      continue;
    }

    const idleResetEligible =
      a.idleSince !== null &&
      a.sessionId !== null &&
      a.inbox.length === 0 &&
      a.pendingAdmissions.length === 0 &&
      !a.resetting &&
      state.idleResetTimeoutMs > 0 &&
      Number.isFinite(state.idleResetTimeoutMs) &&
      (
        (a.status === "idle" && lease.state === "detached") ||
        (a.status === "running" && lease.state === "none" && lease.lastTerminal !== null)
      );
    if (idleResetEligible && nowMs - a.idleSince! >= state.idleResetTimeoutMs) {
      effects.push({ type: "reset_idle_session", agentId: id, sessionId: a.sessionId! });
      continue;
    }

    const idleEligible =
      a.status === "running" &&
      lease.state === "none" &&
      a.pendingAdmissions.length === 0 &&
      lease.lastTerminal !== null &&
      a.inbox.length === 0 &&
      state.idleTimeoutMs > 0 &&
      Number.isFinite(state.idleTimeoutMs);
    if (idleEligible && a.idleSince !== null && nowMs - a.idleSince >= state.idleTimeoutMs) {
      // Preserve idleSince across process hibernation: the per-agent inactivity
      // clock continues until work arrives or its resumable session is reset.
      agents[id] = { ...a, status: "stopping", stoppingSince: nowMs };
      effects.push({ type: "stop", agentId: id, reason: "idle_timeout" });
    }
  }
  return { state: { ...state, agents }, effects };
}

function freshAgent(agentId: string): AgentState {
  return {
    agentId,
    status: "idle",
    inbox: [],
    sessionId: null,
    stalledSessionId: null,
    execution: { sessionInstanceId: null, lease: { state: "detached" } },
    pendingAdmissions: [],
    turnId: null,
    turnActive: false,
    lastProgressAt: 0,
    lastNativeActivityAt: 0,
    lastNativeActivityKind: null,
    runtimePhase: "idle",
    backendTurnId: null,
    turnSilence: DEFAULT_TURN_SILENCE_POLICY,
    lastDeliverAt: null,
    idleSince: null,
    stoppingSince: null,
    resetting: false,
    resettingSince: null,
  };
}

function enterStable(agent: AgentState, status: "running" | "idle"): void {
  agent.status = status;
  agent.resetting = false;
  agent.resettingSince = null;
  agent.stoppingSince = null;
}

function drainInbox(agent: AgentState): AgentMsg[] {
  const seenIds = new Set<string>();
  const unique: AgentMsg[] = [];
  for (const m of agent.inbox) {
    if (m.id && seenIds.has(m.id)) continue;
    if (m.id) seenIds.add(m.id);
    unique.push(m);
  }
  agent.inbox = [];
  return unique;
}

function clone(a: AgentState): AgentState {
  return {
    ...a,
    inbox: [...a.inbox],
    pendingAdmissions: a.pendingAdmissions.map((entry) => ({ ...entry, exactAgentMsg: { ...entry.exactAgentMsg } })),
    execution: cloneExecution(a.execution),
  };
}

function cloneExecution(execution: ExecutionEpoch): ExecutionEpoch {
  if (execution.sessionInstanceId === null) return { sessionInstanceId: null, lease: { state: "detached" } };
  const lease = execution.lease;
  return { sessionInstanceId: execution.sessionInstanceId, lease: { ...lease } };
}

function matchesSession(agent: AgentState, sessionInstanceId: string): agent is AgentState & {
  execution: { sessionInstanceId: string; lease: Exclude<RootLease, { state: "detached" }> };
} {
  return agent.execution.sessionInstanceId === sessionInstanceId;
}

function identityOf(event: { sessionInstanceId: string; turnId: string }): TurnIdentity {
  return { sessionInstanceId: event.sessionInstanceId, turnId: event.turnId };
}

function sameIdentity(left: TurnIdentity, right: TurnIdentity): boolean {
  return left.sessionInstanceId === right.sessionInstanceId && left.turnId === right.turnId;
}

function leaseIsWorking(lease: RootLease): boolean {
  return lease.state === "active" || lease.state === "suspect_active";
}

function syncExecutionProjection(agent: AgentState): void {
  const lease = agent.execution.lease;
  agent.turnActive = leaseIsWorking(lease) || agent.pendingAdmissions.length > 0;
  agent.turnId = lease.state === "active" || lease.state === "suspect_active"
    ? lease.identity.turnId
    : lease.state === "none"
      ? lease.lastTerminal?.identity.turnId ?? null
      : null;
  agent.lastDeliverAt = agent.pendingAdmissions.length > 0
    ? Math.max(...agent.pendingAdmissions.map((entry) => entry.admittedAt))
    : null;
}

function recoveryEffects(agent: AgentState, records: readonly PendingAdmission[]): ManagerEffect[] {
  return records
    .filter((record) => record.requeueOnFailure)
    .map((record) => ({
      type: "requeue_delivery" as const,
      agentId: agent.agentId,
      message: record.exactAgentMsg,
      mode: record.mode,
    }));
}

function commit(state: ManagerState, agent: AgentState, effects: ManagerEffect[]): ReduceResult {
  return { state: { ...state, agents: { ...state.agents, [agent.agentId]: agent } }, effects };
}

function mutate(state: ManagerState, agentId: string, fn: (a: AgentState) => void): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  fn(agent);
  return commit(state, agent, []);
}

function withAgent(
  state: ManagerState,
  agentId: string,
  make: (a: AgentState | undefined) => AgentState,
  effects: ManagerEffect[],
): ReduceResult {
  const agent = make(state.agents[agentId]);
  return { state: { ...state, agents: { ...state.agents, [agentId]: agent } }, effects };
}

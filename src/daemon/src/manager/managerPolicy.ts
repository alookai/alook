
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
  | { state: "active"; identity: TurnIdentity; lastWorkAt: number; outstandingToolUses?: number }
  | {
      state: "suspect_active";
      identity: TurnIdentity;
      lastWorkAt: number;
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
  execution: ExecutionEpoch;
  pendingAdmissions: PendingAdmission[];
  turnId: string | null;
  turnActive: boolean;
  lastProgressAt: number;
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
  resetStuckThresholdMs: number;
  stoppingStuckThresholdMs: number;
}

export type ManagerEvent =
  | { type: "register"; agentId: string }
  | { type: "wake"; agentId: string; message: AgentMsg; nowMs: number }
  | { type: "spawned"; agentId: string; nowMs: number }
  | { type: "backend_session"; agentId: string; sessionId: string }
  | { type: "attach_session"; agentId: string; sessionInstanceId: string; nowMs: number }
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
  | { type: "begin_reset"; agentId: string; nowMs: number }
  | { type: "rewake_after_reset"; agentId: string; message: AgentMsg }
  | { type: "runtime_signal"; agentId: string; kind: string; nowMs: number }
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
  | { type: "terminate_stalled"; agentId: string }
  | { type: "expire_admission"; agentId: string; sessionInstanceId: string; commandIds: string[] }
  | { type: "requeue_delivery"; agentId: string; message: AgentMsg; mode: "busy" | "idle" }
  | { type: "force_exit"; agentId: string; reason: string };

export const DEFAULT_STALE_THRESHOLD_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
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
): ManagerState {
  return { agents: {}, staleThresholdMs, idleTimeoutMs, resetStuckThresholdMs, stoppingStuckThresholdMs };
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
        a.lastProgressAt = event.nowMs;
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
      });

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
        a.execution.lease = { state: "active", identity, lastWorkAt: event.nowMs };
        a.lastProgressAt = event.nowMs;
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
          a.execution.lease = { ...lease, lastWorkAt: event.nowMs };
        } else {
          const terminal = lease.state === "none" ? lease.lastTerminal : null;
          if (!terminal || !sameIdentity(terminal.identity, identity)) return;
          a.execution.lease = {
            state: "suspect_active",
            identity,
            lastWorkAt: event.nowMs,
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
      return onTurnCompleted(state, event.agentId, event.sessionInstanceId, event.nowMs, event.turnId);

    case "session_closed":
      if (state.agents[event.agentId]?.execution.sessionInstanceId !== event.sessionInstanceId) {
        return { state, effects: [] };
      }
      {
        const agent = clone(state.agents[event.agentId]!);
        const closing = agent.pendingAdmissions.filter((entry) => entry.sessionInstanceId === event.sessionInstanceId);
        agent.pendingAdmissions = agent.pendingAdmissions.filter((entry) => entry.sessionInstanceId !== event.sessionInstanceId);
        agent.execution = { sessionInstanceId: null, lease: { state: "detached" } };
        agent.idleSince = null;
        syncExecutionProjection(agent);
        return commit(state, agent, recoveryEffects(agent, closing));
      }

    case "exit":
      return onExit(state, event.agentId);

    case "tick":
      return onTick(state, event.nowMs);

    case "runtime_signal":
      return { state, effects: [] };

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
  syncExecutionProjection(agent);
  if (agent.inbox.length > 0) {
    const messages = drainInbox(agent);
    return commit(state, agent, messages.map((queued) => ({ type: "send", agentId, message: queued, mode: "idle" })));
  }

  agent.idleSince = nowMs;
  return commit(state, agent, []);
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
        agent.execution.lease = { ...lease, lastWorkAt: event.nowMs, outstandingToolUses };
      } else {
        const unblockedLease = { ...lease };
        delete unblockedLease.outstandingToolUses;
        agent.execution.lease = { ...unblockedLease, lastWorkAt: event.nowMs };
      }
    } else {
      const terminal = lease.state === "none" ? lease.lastTerminal : null;
      if (lifecycle !== "started" || !terminal || !sameIdentity(terminal.identity, identity)) return;
      agent.execution.lease = {
        state: "suspect_active",
        identity,
        lastWorkAt: event.nowMs,
        outstandingToolUses: 1,
        reason: "work_after_terminal",
      };
    }
    agent.lastProgressAt = event.nowMs;
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
      && nowMs - lease.lastWorkAt >= state.staleThresholdMs;
    if (stalled) {
      agents[id] = { ...a, status: "stopping", idleSince: null, stoppingSince: nowMs };
      effects.push({ type: "terminate_stalled", agentId: id });
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

    const idleEligible =
      a.status === "running" &&
      lease.state === "none" &&
      a.pendingAdmissions.length === 0 &&
      lease.lastTerminal !== null &&
      a.inbox.length === 0 &&
      state.idleTimeoutMs > 0 &&
      Number.isFinite(state.idleTimeoutMs);
    if (idleEligible && a.idleSince !== null && nowMs - a.idleSince >= state.idleTimeoutMs) {
      agents[id] = { ...a, status: "stopping", idleSince: null, stoppingSince: nowMs };
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
    execution: { sessionInstanceId: null, lease: { state: "detached" } },
    pendingAdmissions: [],
    turnId: null,
    turnActive: false,
    lastProgressAt: 0,
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

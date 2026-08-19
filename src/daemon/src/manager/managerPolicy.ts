/** Side-effect-free manager lifecycle policy; backend delivery belongs to agent-driver. */

export type AgentStatus = "idle" | "starting" | "running" | "stopping";

export interface AgentMsg {
  id?: string;
  seq?: number;
  text: string;
}

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  inbox: AgentMsg[];
  sessionId: string | null;
  turnActive: boolean;
  lastProgressAt: number;
  /** Last delivery awaiting observable progress; null means none. */
  lastDeliverAt: number | null;
  idleSince: number | null;
  /** Start of a stop awaiting exit; drives the stuck-stop backstop. */
  stoppingSince: number | null;
  /** Reset gates non-idle wakes until a stable state is reached. */
  resetting: boolean;
  /** Start of the active reset window; null outside reset. */
  resettingSince: number | null;
}

export function isActivelyWorking(agent: AgentState): boolean {
  return agent.status === "running" && (agent.turnActive || agent.inbox.length > 0);
}

export interface ManagerState {
  agents: Record<string, AgentState>;
  staleThresholdMs: number;
  /** 0/Infinity disables idle hibernation. */
  idleTimeoutMs: number;
  resetStuckThresholdMs: number;
  stoppingStuckThresholdMs: number;
}

export type ManagerEvent =
  | { type: "register"; agentId: string }
  | { type: "wake"; agentId: string; message: AgentMsg; nowMs: number }
  | { type: "spawned"; agentId: string; nowMs: number }
  | { type: "session"; agentId: string; sessionId: string }
  | { type: "progress"; agentId: string; nowMs: number }
  /** Non-clean turn metadata; terminationCause is policy, errorDetail is trace-only. */
  | {
      type: "turn_end";
      agentId: string;
      nowMs: number;
      endReason?: "errored";
      terminationCause?: "runtime_error" | "killed_stalled";
      errorDetail?: string;
    }
  /** Physical exit facts are observability-only; reducer policy ignores them. */
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
      return onWake(state, event.agentId, event.message, event.nowMs);

    case "spawned":
      return mutate(state, event.agentId, (a) => {
        enterStable(a, "running");
        a.turnActive = true;
        a.lastProgressAt = event.nowMs;
        a.lastDeliverAt = null;
        a.idleSince = null;
      });

    case "session":
      return mutate(state, event.agentId, (a) => {
        a.sessionId = event.sessionId;
      });

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
      });

    case "rewake_after_reset":
      if (!state.agents[event.agentId]) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        a.inbox = [...a.inbox, event.message];
        a.idleSince = null;
      });

    case "progress":
      return mutate(state, event.agentId, (a) => {
        a.lastProgressAt = event.nowMs;
        // Root progress is authoritative evidence that the turn remains active.
        if (a.status === "running" && !a.turnActive) {
          a.turnActive = true;
          a.idleSince = null;
        }
      });

    case "turn_end":
      return onTurnEnd(state, event.agentId, event.nowMs);

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
        if (event.mode === "idle") a.turnActive = false;
        a.lastDeliverAt = null;
        a.idleSince = null;
      });
  }
}

function onWake(state: ManagerState, agentId: string, message: AgentMsg, nowMs: number): ReduceResult {
  const existing = state.agents[agentId];
  const agent = existing ? clone(existing) : null;
  if (!agent) {
    return { state, effects: [] };
  }

  // Idle reset wakes must spawn; other reset wakes wait for the replacement.
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
    const mode = agent.turnActive ? "busy" : "idle";
    if (mode === "idle") agent.turnActive = true;
    agent.lastDeliverAt = nowMs;
    return commit(state, agent, messages.map((queued) => ({ type: "send", agentId, message: queued, mode })));
  }

  return commit(state, agent, []);
}

function onTurnEnd(state: ManagerState, agentId: string, nowMs: number): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  agent.turnActive = false;
  agent.lastProgressAt = nowMs;
  if (agent.inbox.length > 0) {
    const messages = drainInbox(agent);
    agent.turnActive = true;
    agent.lastDeliverAt = nowMs;
    return commit(state, agent, messages.map((queued) => ({ type: "send", agentId, message: queued, mode: "idle" })));
  }

  agent.idleSince = nowMs;
  return commit(state, agent, []);
}

function onExit(state: ManagerState, agentId: string): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  agent.turnActive = false;
  agent.stoppingSince = null;
  agent.lastDeliverAt = null;

  // Queued work respawns without closing the reset window.
  if (agent.inbox.length > 0) {
    agent.status = "starting";
    const messages = drainInbox(agent);
    return commit(state, agent, [
      { type: "spawn", agentId, messages, resumeSessionId: agent.sessionId },
    ]);
  }
  enterStable(agent, "idle");
  return commit(state, agent, []);
}

function onTick(state: ManagerState, nowMs: number): ReduceResult {
  const effects: ManagerEffect[] = [];
  const agents = { ...state.agents };
  for (const id of Object.keys(agents)) {
    const a = agents[id];

    const stalled =
      a.status === "running" &&
      a.turnActive &&
      nowMs - a.lastProgressAt >= state.staleThresholdMs;
    // A sent command without subsequent progress is a generic deaf-session signal.
    const suspectedDeaf =
      a.status === "running" &&
      a.lastDeliverAt !== null &&
      a.lastDeliverAt > a.lastProgressAt &&
      nowMs - a.lastDeliverAt >= state.staleThresholdMs;
    if (stalled || suspectedDeaf) {
      agents[id] = { ...a, status: "stopping", idleSince: null, stoppingSince: nowMs };
      effects.push({ type: "terminate_stalled", agentId: id });
      continue;
    }

    // A reset that never reaches a stable state must be restarted.
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

    // A stop whose exit never arrives uses the synthetic-exit backstop.
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
      !a.turnActive &&
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
    turnActive: false,
    lastProgressAt: 0,
    lastDeliverAt: null,
    idleSince: null,
    stoppingSince: null,
    resetting: false,
    resettingSince: null,
  };
}

/** Single owner for closing reset/stopping windows on stable transitions. */
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
  };
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

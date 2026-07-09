/**
 * Agent process manager — pure policy core.
 *
 * This is the portable, side-effect-free brain of the manager. It decides, for
 * each agent, WHAT should happen (spawn / steer / deliver / stop / terminate)
 * given the events flowing in — but it never touches a process, timer, or
 * socket itself. The thin executor (`managerRuntime.ts`) applies the emitted
 * effects against real runtime sessions.
 *
 * It models the orchestration the daemon's `agentProcessManager` does, distilled
 * to its decisions:
 *   - **single-flight**: at most one live process per agent; concurrent wakes
 *     queue, never spawn a second process.
 *   - **wake/sleep**: spawn when work arrives and idle; go idle (sleepable) when
 *     a turn ends with an empty inbox.
 *   - **queue + coalesce**: messages arriving mid-turn are buffered and either
 *     steered into a persistent process or delivered to the next per-turn spawn.
 *   - **stalled recovery**: if a running process makes no progress past a
 *     threshold, terminate it for restart.
 *
 * Per-runtime delivery nuance (gated steering, etc.) is delegated to the
 * existing `apmStateMachine` reducers (read-only; see `onRuntimeSignal` below)
 * — this layer is the higher-level lifecycle/queue orchestrator above them.
 * See plans/wire-gated-busy-steering-daemon.md for how gating is wired up.
 */
import type { BusyDeliveryMode, DriverLifecycle } from "../types.js";
import {
  type ApmGatedSteeringState,
  createInitialApmGatedSteeringState,
  reduceApmGatedToolUse,
  reduceApmGatedCompaction,
  reduceApmGatedReview,
  reduceApmGatedError,
  reduceApmGatedFlushReadiness,
  reduceApmGatedRecentEvent,
} from "../runtime/apmStateMachine.js";

export type AgentStatus = "idle" | "starting" | "running" | "stopping";

export interface AgentMsg {
  /** Monotonic sequence (for ordering / dedup); optional. */
  seq?: number;
  text: string;
}

/** Static per-agent capabilities the policy needs (from the driver). */
export interface AgentRuntimeCaps {
  lifecycleKind: DriverLifecycle["kind"];
  supportsStdinNotification: boolean;
  busyDeliveryMode: BusyDeliveryMode;
}

export interface AgentState {
  agentId: string;
  status: AgentStatus;
  caps: AgentRuntimeCaps;
  inbox: AgentMsg[];
  sessionId: string | null;
  /** Whether a turn is currently in flight (between spawn/turn_start and turn_end). */
  turnActive: boolean;
  /** ms timestamp of the last observed progress (event), for stall detection. */
  lastProgressAt: number;
  /** ms timestamp since which the agent has been idle (running, no turn, empty inbox); null if not idle. */
  idleSince: number | null;
  /**
   * Coarse gated-steering phase (tool/compaction/review boundaries). Only
   * meaningfully consulted when `caps.busyDeliveryMode === "gated"`; kept on
   * every agent (harmless/unused otherwise) so the reducer set never needs a
   * null-check.
   */
  apm: ApmGatedSteeringState;
}

export interface ManagerState {
  agents: Record<string, AgentState>;
  /** Stall threshold: no progress for this long while running ⇒ terminate. */
  staleThresholdMs: number;
  /**
   * Idle hibernation threshold: a persistent keep-alive process that has sat
   * idle (turn ended, inbox empty) for this long is stopped to free resources.
   * Its sessionId is preserved so the next wake resumes. 0/∞ disables.
   */
  idleTimeoutMs: number;
}

/* ------------------------------------------------------------------ */
/* Events (inputs) and Effects (outputs)                               */
/* ------------------------------------------------------------------ */

export type ManagerEvent =
  | { type: "register"; agentId: string; caps: AgentRuntimeCaps }
  | { type: "wake"; agentId: string; message: AgentMsg; nowMs: number }
  | { type: "spawned"; agentId: string; nowMs: number }
  | { type: "session"; agentId: string; sessionId: string }
  | { type: "progress"; agentId: string; nowMs: number }
  | { type: "turn_end"; agentId: string; nowMs: number }
  | { type: "exit"; agentId: string }
  | { type: "tick"; nowMs: number }
  /**
   * Generic passthrough of a `ParsedEvent`'s `kind` string, forwarded for
   * EVERY runtime event (not just the ones the reducer acts on) so the
   * gated-steering diagnostics ring buffer (`reduceApmGatedRecentEvent`) sees
   * a complete history. See `onRuntimeSignal`.
   */
  | { type: "runtime_signal"; agentId: string; kind: string; nowMs: number };

export type ManagerEffect =
  | { type: "spawn"; agentId: string; prompt: string; resumeSessionId: string | null }
  | { type: "send"; agentId: string; text: string; mode: "busy" | "idle" }
  | { type: "stop"; agentId: string; reason: string }
  | { type: "terminate_stalled"; agentId: string }
  /**
   * Pure observability: a gated agent has a non-empty inbox but nothing was
   * actually sent — either a mid-turn wake was held, or a boundary flush
   * attempt was still blocked. Never emitted for `direct`/`none` drivers.
   */
  | { type: "gated_hold"; agentId: string; reason: string; blockedReason: string | null; recentEvents: string[] };

/** Default thresholds (ms). */
export const DEFAULT_STALE_THRESHOLD_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

export interface ReduceResult {
  state: ManagerState;
  effects: ManagerEffect[];
}

export function createInitialManagerState(
  staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): ManagerState {
  return { agents: {}, staleThresholdMs, idleTimeoutMs };
}

/* ------------------------------------------------------------------ */
/* The reducer                                                         */
/* ------------------------------------------------------------------ */

export function reduceManager(state: ManagerState, event: ManagerEvent): ReduceResult {
  switch (event.type) {
    case "register":
      return withAgent(state, event.agentId, (a) => a ?? freshAgent(event.agentId, event.caps), []);

    case "wake":
      return onWake(state, event.agentId, event.message);

    case "spawned":
      return mutate(state, event.agentId, (a) => {
        a.status = "running";
        a.turnActive = true;
        a.lastProgressAt = event.nowMs;
        a.idleSince = null;
      });

    case "session":
      return mutate(state, event.agentId, (a) => {
        a.sessionId = event.sessionId;
      });

    case "progress":
      return mutate(state, event.agentId, (a) => {
        a.lastProgressAt = event.nowMs;
      });

    case "turn_end":
      return onTurnEnd(state, event.agentId, event.nowMs);

    case "exit":
      return onExit(state, event.agentId);

    case "tick":
      return onTick(state, event.nowMs);

    case "runtime_signal":
      return onRuntimeSignal(state, event.agentId, event.kind);
  }
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                      */
/* ------------------------------------------------------------------ */

function onWake(state: ManagerState, agentId: string, message: AgentMsg): ReduceResult {
  const existing = state.agents[agentId];
  const agent = existing ? clone(existing) : null;
  if (!agent) {
    // Unknown agent — must be registered first. Drop with no effect.
    return { state, effects: [] };
  }

  // Always enqueue the message first; any wake clears the idle timer.
  agent.inbox = [...agent.inbox, message];
  agent.idleSince = null;

  // Idle ⇒ spawn (single-flight: only from idle). Starting/stopping ⇒ just queue.
  if (agent.status === "idle") {
    agent.status = "starting";
    const prompt = drainInboxToPrompt(agent);
    return commit(state, agent, [
      { type: "spawn", agentId, prompt, resumeSessionId: agent.sessionId },
    ]);
  }

  // Running:
  if (agent.status === "running") {
    // Persistent + can take stdin ⇒ steer/deliver into the live process.
    if (agent.caps.lifecycleKind === "persistent" && agent.caps.supportsStdinNotification) {
      // Gated + mid-turn: a raw stdin write right now could collide with an
      // in-flight tool call / signed thinking block / compaction / review.
      // The message is already enqueued above — hold instead of draining it;
      // `onRuntimeSignal` flushes it at the next safe boundary.
      const isGatedMidTurn = agent.caps.busyDeliveryMode === "gated" && agent.turnActive;
      if (isGatedMidTurn) {
        return commit(state, agent, [
          {
            type: "gated_hold",
            agentId,
            reason: "mid_turn_wake",
            blockedReason: agent.apm.phase,
            recentEvents: agent.apm.recentEvents,
          },
        ]);
      }
      const text = drainInboxToPrompt(agent);
      const mode = agent.turnActive ? "busy" : "idle";
      return commit(state, agent, [{ type: "send", agentId, text, mode }]);
    }
    // Per-turn or no stdin ⇒ keep queued; delivered after exit / next spawn.
    return commit(state, agent, []);
  }

  // starting / stopping ⇒ queue only (coalesce); handled on spawned/exit.
  return commit(state, agent, []);
}

function onTurnEnd(state: ManagerState, agentId: string, nowMs: number): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  agent.turnActive = false;
  agent.lastProgressAt = nowMs;
  // Fresh turn ⇒ fresh gated phase; prevents a stale compacting/reviewing/
  // outstandingToolUses flag from one turn silently blocking a flush in the
  // next turn.
  agent.apm = createInitialApmGatedSteeringState();

  // Per-turn runtimes exit on their own; the process will emit "exit".
  if (agent.caps.lifecycleKind === "per_turn") {
    return commit(state, agent, []);
  }

  // Persistent: if queued messages exist, deliver them as a fresh (idle) turn.
  if (agent.inbox.length > 0 && agent.caps.supportsStdinNotification) {
    const text = drainInboxToPrompt(agent);
    agent.turnActive = true;
    return commit(state, agent, [{ type: "send", agentId, text, mode: "idle" }]);
  }

  // Nothing pending ⇒ idle; start the idle-hibernation clock.
  agent.idleSince = nowMs;
  return commit(state, agent, []);
}

/**
 * Handles one forwarded `ParsedEvent.kind` for gated-steering phase tracking
 * and boundary flush attempts. Only meaningfully acts when the agent is
 * `running`, `turnActive`, and declares `busyDeliveryMode: "gated"` —
 * otherwise it's a no-op (still records `recentEvents` for diagnostics via
 * `reduceApmGatedRecentEvent`, cheap and harmless).
 *
 * Pinned execution order per branch (deliberately different from
 * `session-runner.ts`, which calls `reduceApmGatedRecentEvent` first — here
 * it runs last so the ring buffer reflects the phase actually reached, not
 * the incoming phase):
 *   1. Run the kind-specific reducer and assign its `nextState`.
 *   2. Run `reduceApmGatedRecentEvent` and assign its `nextState` again.
 *   3. If the branch calls for it, attempt a flush via
 *      `reduceApmGatedFlushReadiness`, reading the now-fully-updated `apm`.
 */
function onRuntimeSignal(state: ManagerState, agentId: string, kind: string): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);

  const isGatedActive =
    agent.status === "running" && agent.turnActive && agent.caps.busyDeliveryMode === "gated";
  if (!isGatedActive) {
    // Still record the event for diagnostics — cheap and harmless even when
    // not gated (the ring buffer is unused unless busyDeliveryMode is gated).
    agent.apm = reduceApmGatedRecentEvent(agent.apm, { event: kind }).nextState;
    return commit(state, agent, []);
  }

  let attemptFlushReason: string | null = null;
  switch (kind) {
    case "tool_call":
      agent.apm = reduceApmGatedToolUse(agent.apm, { kind }).nextState;
      break;
    case "tool_output":
      agent.apm = reduceApmGatedToolUse(agent.apm, { kind }).nextState;
      attemptFlushReason = "tool_batch_complete";
      break;
    case "compaction_started":
    case "compaction_finished":
      agent.apm = reduceApmGatedCompaction(agent.apm, { kind }).nextState;
      if (kind === "compaction_finished") attemptFlushReason = "compaction_finished";
      break;
    case "review_started":
    case "review_finished":
      agent.apm = reduceApmGatedReview(agent.apm, { kind }).nextState;
      if (kind === "review_finished") attemptFlushReason = "review_finished";
      break;
    case "error":
      agent.apm = reduceApmGatedError(agent.apm, { disableToolBoundaryFlush: true }).nextState;
      break;
    default:
      // "text" / "thinking" / "internal_progress" / "runtime_diagnostic" /
      // "telemetry" / "session_init" / "turn_end" — no phase change here;
      // "turn_end" is already handled by onTurnEnd via its own event.
      break;
  }

  agent.apm = reduceApmGatedRecentEvent(agent.apm, { event: kind }).nextState;

  if (attemptFlushReason === null) return commit(state, agent, []);
  // Attempting a flush on every tool_output is intentional (not just when
  // the last outstanding tool just closed): it lets `reduceApmGatedFlushReadiness`
  // be the single source of truth for "is it safe", and surfaces a
  // `gated_hold` for "one of several nested tool calls just closed" too.
  if (agent.inbox.length === 0) return commit(state, agent, []);

  const readiness = reduceApmGatedFlushReadiness(agent.apm, {
    isGated: true,
    hasSession: agent.sessionId != null,
    inboxLength: agent.inbox.length,
    reason: attemptFlushReason,
  });
  if (readiness.shouldNotify) {
    const text = drainInboxToPrompt(agent);
    return commit(state, agent, [{ type: "send", agentId, text, mode: "busy" }]);
  }
  return commit(state, agent, [
    {
      type: "gated_hold",
      agentId,
      reason: attemptFlushReason,
      blockedReason: readiness.blockedReason,
      recentEvents: agent.apm.recentEvents,
    },
  ]);
}

function onExit(state: ManagerState, agentId: string): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);
  agent.turnActive = false;

  // Per-turn: if more messages queued, immediately respawn for the next batch.
  if (agent.inbox.length > 0) {
    agent.status = "starting";
    const prompt = drainInboxToPrompt(agent);
    return commit(state, agent, [
      { type: "spawn", agentId, prompt, resumeSessionId: agent.sessionId },
    ]);
  }
  agent.status = "idle";
  return commit(state, agent, []);
}

function onTick(state: ManagerState, nowMs: number): ReduceResult {
  const effects: ManagerEffect[] = [];
  const agents = { ...state.agents };
  for (const id of Object.keys(agents)) {
    const a = agents[id];

    // Stalled recovery: running, turn in flight, no progress past threshold.
    const stalled =
      a.status === "running" &&
      a.turnActive &&
      nowMs - a.lastProgressAt >= state.staleThresholdMs &&
      // Only restartable runtimes (persistent+direct, or per-turn) — mirror daemon policy.
      (a.caps.lifecycleKind === "per_turn" ||
        (a.caps.supportsStdinNotification && a.caps.busyDeliveryMode === "direct"));
    if (stalled) {
      agents[id] = { ...a, status: "stopping", idleSince: null };
      effects.push({ type: "terminate_stalled", agentId: id });
      continue;
    }

    // Idle hibernation: a persistent keep-alive process that has sat idle (turn
    // ended, inbox empty) past the timeout is stopped to free resources. Its
    // sessionId is preserved, so the next wake resumes it.
    const idleEligible =
      a.status === "running" &&
      !a.turnActive &&
      a.inbox.length === 0 &&
      a.caps.lifecycleKind === "persistent" &&
      state.idleTimeoutMs > 0 &&
      Number.isFinite(state.idleTimeoutMs);
    if (idleEligible && a.idleSince !== null && nowMs - a.idleSince >= state.idleTimeoutMs) {
      agents[id] = { ...a, status: "stopping", idleSince: null };
      effects.push({ type: "stop", agentId: id, reason: "idle_timeout" });
    }
  }
  return { state: { ...state, agents }, effects };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function freshAgent(agentId: string, caps: AgentRuntimeCaps): AgentState {
  return {
    agentId,
    status: "idle",
    caps,
    inbox: [],
    sessionId: null,
    turnActive: false,
    lastProgressAt: 0,
    idleSince: null,
    apm: createInitialApmGatedSteeringState(),
  };
}

/** Coalesce all queued messages into one prompt, deduplicating identical lines. */
function drainInboxToPrompt(agent: AgentState): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const m of agent.inbox) {
    if (!seen.has(m.text)) {
      seen.add(m.text);
      unique.push(m.text);
    }
  }
  agent.inbox = [];
  return unique.join("\n");
}

function clone(a: AgentState): AgentState {
  return {
    ...a,
    inbox: [...a.inbox],
    caps: { ...a.caps },
    apm: { ...a.apm, recentEvents: [...a.apm.recentEvents] },
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

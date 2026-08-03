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
  /**
   * ms timestamp of the last `send` effect emitted toward the live process
   * (drain-send / onTurnEnd drain / gated flush); null if none this lifecycle.
   * Paired with `lastProgressAt` to detect a deaf process: a `send` was
   * dispatched (`lastDeliverAt > lastProgressAt`) yet no process-reported
   * event followed within the stale window — the message went into a stdin
   * nothing is reading. This is the ONLY signal that catches the
   * gated-no-turn_end permanent orphan, which slips both existing onTick
   * predicates. See plans/daemon-fsm-desync.md batch A.
   */
  lastDeliverAt: number | null;
  /** ms timestamp since which the agent has been idle (running, no turn, empty inbox); null if not idle. */
  idleSince: number | null;
  /**
   * ms timestamp at which the agent entered `stopping`; null whenever it is not
   * `stopping`. A `stop`/`terminate_stalled` effect expects the process to emit
   * `exit` shortly after, which drives `onExit` → respawn/idle. If that `exit`
   * never arrives (the stop was a no-op because the session handle was already
   * gone, or the kill didn't take), the agent is wedged in `stopping` FOREVER:
   * no onTick predicate keys on `stopping` (stalled/suspectedDeaf/idle need
   * `running`, resetStuck needs `resetting` and even guards `!== "stopping"`),
   * and `onWake` only queues in `stopping`. This clock is the ONLY escape: a
   * tick that finds `stopping` older than `stoppingStuckThresholdMs` forces the
   * agent out (see `onTick`'s stopping-stuck branch). SET at every transition
   * into `stopping`; CLEARED by `enterStable` (→ running/idle) and `onExit`.
   * See plans/daemon-fsm-desync.md batch L3 (stopping-wedge black hole).
   */
  stoppingSince: number | null;
  /**
   * True during an owner-triggered reset window. Gates every inbound wake to
   * inbox-only (no `spawn`, no `send`, no `gated_hold`) EXCEPT when the
   * agent is currently `idle` — the orchestrator's idle branch relies on
   * `deliver` still emitting a spawn to kick a fresh session; if the gate
   * blocked idle too, the reset would silently reset-lock the agent. SET at
   * `begin_reset`; CLEARED exclusively by `enterStable` (the single owner of
   * every transition into a stable `running`/`idle` state — see its doc). See
   * plans/bot-reset-session-v2.md and plans/daemon-fsm-desync.md batch C.
   */
  resetting: boolean;
  /**
   * ms timestamp at which the current reset window began (`begin_reset`); null
   * when not resetting. Owned by this (recovery) layer alongside `resetting`
   * itself — SET at `begin_reset`, cleared by `enterStable`. Batch D's
   * reconcile READS it to detect a reset that never converged (`resetting`
   * still true, `resettingSince` older than the stale window ⇒ the clearing
   * event never arrived), then escalates through `enterStable` — state
   * ownership here, detection ownership there. See plans/daemon-fsm-desync.md
   * batch C/D.
   */
  resettingSince: number | null;
  /**
   * Coarse gated-steering phase (tool/compaction/review boundaries). Only
   * meaningfully consulted when `caps.busyDeliveryMode === "gated"`; kept on
   * every agent (harmless/unused otherwise) so the reducer set never needs a
   * null-check.
   */
  apm: ApmGatedSteeringState;
}

/**
 * An agent counts as actively working iff its process is `running` AND it has
 * work in hand — a turn in flight, or queued inbox not yet drained into a turn.
 * `running` alone is not enough: a persistent agent stays `running` for up to
 * `idleTimeoutMs` after a turn ends with an empty inbox, which is genuinely
 * idle. Single source of truth for both the activity derivation and the
 * durability re-assert, so they can never disagree.
 */
export function isActivelyWorking(agent: AgentState): boolean {
  return agent.status === "running" && (agent.turnActive || agent.inbox.length > 0);
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
  /**
   * Reset-window convergence threshold: `resetting` stuck true past this long
   * (measured from `resettingSince`) ⇒ the reconcile watchdog escalates. See
   * `DEFAULT_RESET_STUCK_THRESHOLD_MS`.
   */
  resetStuckThresholdMs: number;
  /**
   * Stopping-stuck escalation threshold: `status === "stopping"` for longer than
   * this (from `stoppingSince`) ⇒ the process's `exit` never arrived, so force
   * the agent out of the black hole. See `DEFAULT_STOPPING_STUCK_THRESHOLD_MS`.
   */
  stoppingStuckThresholdMs: number;
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
  /**
   * `endReason:"errored"` is set when a turn ended NON-cleanly — either a
   * mid-turn runtime `error` OR a `terminate_stalled` kill (managerRuntime
   * buffers the cause, stamps it here on the trailing turn_end). Absent = clean
   * turn-end. STRICTLY BINARY (single literal, not a union) so the rewake gate
   * keyed on `=== "errored"` can't be silently widened — red line 1. The CAUSE
   * rides on the separate `terminationCause` field (for B2 policy branching:
   * `killed_stalled` gets a tighter rewake bound than `runtime_error` since an
   * input-caused hang recurs deterministically); `errorDetail` is free-text.
   * B1 only RECORDS these (trace); the rewake policy that consumes them is B2.
   * See plans/daemon-runtime-error-rewake.md.
   */
  | {
      type: "turn_end";
      agentId: string;
      nowMs: number;
      endReason?: "errored";
      terminationCause?: "runtime_error" | "killed_stalled";
      errorDetail?: string;
    }
  /**
   * `exitCode`/`exitSignal`/`abnormal` are the RAW PHYSICAL termination fact of
   * the process, recorded for fsm-trace forensics (T1,
   * plans/daemon-trace-completeness-charter.md) — how the process died, for
   * EVERY exit path, so a hard exit (segfault/OOM/external SIGKILL, which
   * bypasses the normalizer and emits no turn_end) is distinguishable from a
   * clean exit in the trace. OBSERVABILITY ONLY: `onExit` must NOT branch its
   * respawn-vs-idle decision on these (red line — kept read-only). What the exit
   * MEANS in FSM terms (deliberate kill vs crash) is a separate semantic layer
   * left to T3, which may only LAYER fields on top, never overwrite these.
   */
  | { type: "exit"; agentId: string; exitCode?: number | null; exitSignal?: string | null; abnormal?: boolean }
  | { type: "tick"; nowMs: number }
  /**
   * Owner-triggered "reset session". Nulls `AgentState.sessionId` so the next
   * `doSpawn`'s resume chain resolves to null. Does NOT change `phase` — a
   * live process keeps running; the reset only affects the NEXT spawn.
   */
  | { type: "reset_session"; agentId: string }
  /**
   * Owner-triggered reset window began. Sets `agent.resetting = true`. No
   * effects — the orchestrator dispatches `deliver` (idle branch) or
   * `enqueueRewake` immediately after, and `stop()` follows on live branch.
   */
  | { type: "begin_reset"; agentId: string; nowMs: number }
  /**
   * Enqueue a synthetic rewake message into the agent's inbox WITHOUT
   * emitting any effect. Used by the reset orchestrator's live/starting/
   * stopping branch — a `send` toward the ManagedSession that `stop()` is
   * about to delete would be silently dropped; the queued message rides the
   * `onExit` drain-then-spawn path instead.
   */
  | { type: "rewake_after_reset"; agentId: string; message: AgentMsg }
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
   * Stopping-stuck escalation (batch L3): the agent has sat in `stopping` past
   * `stoppingStuckThresholdMs` — the `exit` a prior stop/terminate expected never
   * arrived, so the agent is wedged in the one state no other watchdog can reach.
   * The runtime handler force-kills any still-tracked process (best effort; warns
   * if none is available — a possible orphan) and dispatches a SYNTHETIC `exit`
   * so the FSM traverses the normal `onExit` → respawn/idle recovery. Universal
   * backstop: covers both a no-op stop (session handle already gone) and a stop
   * that ran but produced no exit. See plans/daemon-fsm-desync.md batch L3.
   */
  | { type: "force_exit"; agentId: string; reason: string }
  /**
   * Pure observability: a gated agent has a non-empty inbox but nothing was
   * actually sent — either a mid-turn wake was held, or a boundary flush
   * attempt was still blocked. Never emitted for `direct`/`none` drivers.
   */
  | { type: "gated_hold"; agentId: string; reason: string; blockedReason: string | null; recentEvents: string[] };

/** Default thresholds (ms). */
export const DEFAULT_STALE_THRESHOLD_MS = 120_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/**
 * Reset-window convergence threshold: how long after a reset was initiated
 * (`begin_reset` stamps `resettingSince`) the agent may stay non-stable
 * (`resetting` still true, never reached `running`/`idle` via `enterStable`)
 * before the reconcile watchdog forces it out. Deliberately a SEPARATE constant
 * from `staleThresholdMs` — that one measures "a running turn made no progress",
 * this one measures "a restart never converged". Different physical processes,
 * independently tunable; sharing a constant would couple two unrelated timeouts.
 * See plans/daemon-fsm-desync.md batch D.
 */
export const DEFAULT_RESET_STUCK_THRESHOLD_MS = 120_000;
/**
 * Stopping-stuck escalation threshold (ms): how long an agent may sit in
 * `stopping` — waiting for a `stop`/`terminate_stalled`'s expected `exit` — before
 * the tick concludes the exit will never come and forces the agent out (force-kill
 * the orphaned process if any + a synthetic `exit` to drive onExit→respawn). MUST
 * be comfortably larger than `SESSION_STOP_GRACE_MS` (the legitimate SIGTERM→SIGKILL
 * grace, 2s) so it never races an in-flight stop that's about to succeed — this is
 * a black-hole safety net, not a fast path. See plans/daemon-fsm-desync.md batch L3.
 */
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

/* ------------------------------------------------------------------ */
/* The reducer                                                         */
/* ------------------------------------------------------------------ */

export function reduceManager(state: ManagerState, event: ManagerEvent): ReduceResult {
  switch (event.type) {
    case "register":
      return withAgent(state, event.agentId, (a) => a ?? freshAgent(event.agentId, event.caps), []);

    case "wake":
      return onWake(state, event.agentId, event.message, event.nowMs);

    case "spawned":
      return mutate(state, event.agentId, (a) => {
        // Single owner of the stable-state transition: `enterStable` sets
        // status="running" AND clears the reset window (resetting/
        // resettingSince) atomically — covering the idle-branch reset path
        // (deliver → spawn directly, no `exit` fires) without a separate clear.
        enterStable(a, "running");
        a.turnActive = true;
        a.lastProgressAt = event.nowMs;
        // Fresh process ⇒ no outstanding unanswered delivery yet. Clearing keeps
        // the suspected-deaf detector (onTick) from carrying a prior lifecycle's
        // `lastDeliverAt` across a respawn. Redundant with `lastProgressAt` being
        // bumped here (a stale deliver would already be < progress), but explicit
        // so the fresh-lifecycle invariant doesn't rely on that coincidence.
        a.lastDeliverAt = null;
        a.idleSince = null;
      });

    case "session":
      return mutate(state, event.agentId, (a) => {
        a.sessionId = event.sessionId;
      });

    case "reset_session":
      // No-op on an unknown agent — matches AgentProcessManager.forgetSession's
      // "safe on unknown id" contract. On a known agent, just null the
      // sessionId; phase/status/turnActive are unchanged so a live process
      // keeps running through its current turn.
      if (!state.agents[event.agentId]) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        a.sessionId = null;
      });

    case "begin_reset":
      if (!state.agents[event.agentId]) return { state, effects: [] };
      return mutate(state, event.agentId, (a) => {
        a.resetting = true;
        // Stamp the window's start so batch D's reconcile can detect a reset
        // that never converged (still resetting, `resettingSince` older than
        // the stale window ⇒ the clearing event never arrived).
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
      });

    case "turn_end":
      return onTurnEnd(state, event.agentId, event.nowMs);

    case "exit":
      return onExit(state, event.agentId);

    case "tick":
      return onTick(state, event.nowMs);

    case "runtime_signal":
      return onRuntimeSignal(state, event.agentId, event.kind, event.nowMs);
  }
}

/* ------------------------------------------------------------------ */
/* Event handlers                                                      */
/* ------------------------------------------------------------------ */

function onWake(state: ManagerState, agentId: string, message: AgentMsg, nowMs: number): ReduceResult {
  const existing = state.agents[agentId];
  const agent = existing ? clone(existing) : null;
  if (!agent) {
    // Unknown agent — must be registered first. Drop with no effect.
    return { state, effects: [] };
  }

  // Reset window: gate every non-idle wake to inbox-only. Idle is exempted
  // deliberately — the orchestrator's idle branch calls `deliver` right
  // after `markResetting`, and if the gate blocked idle too the spawn would
  // never fire, so `resetting` would stay stuck forever. Idle safety is
  // fine: no live session to steer against, and the moment `deliver`'s
  // spawn effect flips status to `starting`, subsequent wakes hit the
  // regular gate branch. See plans/bot-reset-session-v2.md.
  if (agent.resetting && agent.status !== "idle") {
    agent.inbox = [...agent.inbox, message];
    agent.idleSince = null;
    return commit(state, agent, []);
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
      if (mode === "idle") agent.turnActive = true;
      agent.lastDeliverAt = nowMs;
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
    agent.lastDeliverAt = nowMs;
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
function onRuntimeSignal(state: ManagerState, agentId: string, kind: string, nowMs: number): ReduceResult {
  const existing = state.agents[agentId];
  if (!existing) return { state, effects: [] };
  const agent = clone(existing);

  // Reset window: never emit a `send` toward the dying session, even for gated
  // drivers whose boundary flush would otherwise fire on a mid-shutdown
  // tool_output. Doing so would drain REWAKE from the inbox into a doomed
  // session and lose it before `onExit`'s drain-and-spawn runs. Still update
  // the diagnostics ring buffer so recentEvents reflects the reset window.
  const isGatedActive =
    !agent.resetting &&
    agent.status === "running" &&
    agent.turnActive &&
    agent.caps.busyDeliveryMode === "gated";
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
    agent.lastDeliverAt = nowMs;
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
  // The process is gone, so `stopping` no longer applies — clear the
  // stopping-stuck clock here (covers BOTH onExit branches: the respawn path
  // sets status="starting" directly, not via enterStable, so it wouldn't be
  // cleared otherwise; the settle-idle path goes through enterStable which also
  // clears it, harmless to do twice).
  agent.stoppingSince = null;
  // Fresh process ⇒ fresh gated-steering horizon. Symmetric with `onTurnEnd`;
  // prevents a dead process's `compacting` / outstanding-tool-use flags from
  // silently carrying into the next spawn and re-blocking `onWake`.
  agent.apm = createInitialApmGatedSteeringState();
  // The dead process can't answer any prior delivery — drop the outstanding
  // deliver marker so the suspected-deaf detector starts clean for the respawn.
  agent.lastDeliverAt = null;

  // Per-turn / reset-respawn: if messages are queued (drained rewake + unreads),
  // respawn for the next batch. `status = "starting"` is TRANSIENT — the reset
  // window (`resetting`) deliberately stays OPEN across it and closes only when
  // the fresh process reaches `running` via `spawned` → `enterStable`. This is
  // the batch-C semantic: a reset ends at "context re-established", not at "old
  // process died". If the respawn itself wedges (new process never emits
  // `spawned`), `resetting` stays true with an aging `resettingSince`, so
  // batch D's reconcile catches the stuck-in-`starting` orphan — which the old
  // "clear at onExit" behavior left invisible to every running-gated detector.
  if (agent.inbox.length > 0) {
    agent.status = "starting";
    const prompt = drainInboxToPrompt(agent);
    return commit(state, agent, [
      { type: "spawn", agentId, prompt, resumeSessionId: agent.sessionId },
    ]);
  }
  // No respawn (incl. the spawn-failure path: `doSpawn` dispatched an immediate
  // `exit` after draining the inbox into the failed spawn's prompt) ⇒ the agent
  // settles idle. `enterStable` closes the reset window here — the single owner
  // of clearing `resetting`, so a failed reset can never leave it stuck.
  enterStable(agent, "idle");
  return commit(state, agent, []);
}

function onTick(state: ManagerState, nowMs: number): ReduceResult {
  const effects: ManagerEffect[] = [];
  const agents = { ...state.agents };
  for (const id of Object.keys(agents)) {
    const a = agents[id];

    // Stalled recovery: running, turn in flight, no progress past threshold.
    // Gated runtimes are normally excluded from restart (their tool-batch/
    // compaction/review boundaries do the flushing), BUT a silent gated turn
    // with queued inbox has no other exit — every wake hits `gated_hold` and
    // nothing frees it. Include gated when work is backing up so `onExit`'s
    // drain-and-respawn can rescue it.
    const stalled =
      a.status === "running" &&
      a.turnActive &&
      nowMs - a.lastProgressAt >= state.staleThresholdMs &&
      (a.caps.lifecycleKind === "per_turn" ||
        (a.caps.supportsStdinNotification && a.caps.busyDeliveryMode === "direct") ||
        (a.caps.supportsStdinNotification &&
          a.caps.busyDeliveryMode === "gated" &&
          a.inbox.length > 0));
    // Suspected-deaf (plans/daemon-fsm-desync.md batch A): a `send` was
    // dispatched (`lastDeliverAt` set, and NEWER than the last process-reported
    // progress) yet the stale window elapsed with no event following it — the
    // message went into a stdin nothing is reading. This is the ONE trigger
    // that catches the `gated`-no-`turn_end` permanent orphan, which slips BOTH
    // existing predicates: `stalled`'s gated sub-clause needs `inbox.length > 0`
    // but the inbox was drained empty by the very send that stamped
    // `lastDeliverAt`, and `idleEligible` needs `!turnActive` but the drain-send
    // set `turnActive = true`. Reuses the existing `terminate_stalled` recovery
    // (SIGKILL → exit → onExit drain-respawn) — batch A adds a trigger, not a
    // new recovery path. Batch D upgrades this same suspicion to a confirmed
    // diagnosis via a liveness probe before any destructive action on the
    // runtime kinds that lack the SIGKILL backstop (SDK); here it only fires for
    // a stdin-capable persistent agent whose recovery is physically reliable.
    const suspectedDeaf =
      a.status === "running" &&
      a.caps.lifecycleKind === "persistent" &&
      a.caps.supportsStdinNotification &&
      a.lastDeliverAt !== null &&
      a.lastDeliverAt > a.lastProgressAt &&
      nowMs - a.lastDeliverAt >= state.staleThresholdMs;
    if (stalled || suspectedDeaf) {
      agents[id] = { ...a, status: "stopping", idleSince: null, stoppingSince: nowMs };
      effects.push({ type: "terminate_stalled", agentId: id });
      continue;
    }

    // Reset-stuck reconcile (plans/daemon-fsm-desync.md batch D): the reset
    // window (`resetting`) is closed exclusively by `enterStable` when the agent
    // reaches a stable `running`/`idle` state. If the converging event never
    // arrives — an idle-branch spawn whose process never emits `spawned`, or an
    // onExit-respawn that wedges in `starting` — `resetting` stays true forever
    // with an aging `resettingSince`, and every wake gets gated to the inbox
    // (onWake's reset gate) and never delivered = a permanent orphan. The three
    // predicates above can't catch it: they all require `status === "running"`,
    // but a reset-stuck agent is stuck in `starting`/`stopping` (never reached
    // running, so `enterStable` never ran, so `resetting` is still true). This
    // is the ONE belief-vs-reality gap the running-keyed detectors leave open.
    // Escalate by forcing an `exit`: `onExit` drains any queued rewake and
    // respawns (or settles idle), and its `enterStable` atomically closes the
    // window — recovery REUSES C's single-owner clear, no second clear path.
    // The `status !== "stopping"` guard is what makes this NOT fire-and-assume
    // AND storm-free: the escalate flips status to `stopping`, so it can't
    // re-issue a `terminate_stalled` every tick while the (guaranteed) exit is
    // in flight — the running-keyed predicates get this for free by leaving
    // `running`, but `resetStuck` keys on `resetting` (which `enterStable`, not
    // this branch, clears) so it needs the explicit guard. Re-escalation still
    // happens correctly when it's warranted: if the forced exit's respawn wedges
    // AGAIN, onExit puts the agent back in `starting` (not `stopping`) with
    // `resetting` still true and `resettingSince` still aging, so a later tick
    // fires this anew — the recovery keeps trying until the reset converges to a
    // stable state (`enterStable` clears `resetting` → this stops firing).
    // Mutually exclusive with stalled/suspectedDeaf by the disjoint `status`
    // precondition (they need `running`; a reset-stuck orphan is in `starting`).
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

    // Stopping-stuck escalation (plans/daemon-fsm-desync.md batch L3): the black
    // hole. A `stop`/`terminate_stalled` set status=`stopping` expecting the
    // process to emit `exit` (→ onExit → respawn/idle). If that `exit` never
    // comes — the stop was a no-op (session handle already gone), or the kill
    // didn't take — the agent is wedged in `stopping` PERMANENTLY: no predicate
    // above keys on `stopping` (stalled/suspectedDeaf/idle need `running`;
    // resetStuck needs `resetting` AND guards `!== "stopping"`), and `onWake`
    // only queues in `stopping` (inbox grows unboundedly, never delivered —
    // observed live: Olivia 2026-07-31 stuck 12min, inbox climbing, process
    // still alive). This is the ONE escape. Force the agent out via `force_exit`
    // (runtime handler best-effort-kills any tracked process, then dispatches a
    // SYNTHETIC `exit` so the FSM runs the normal onExit recovery). Threshold ≫
    // SESSION_STOP_GRACE_MS so it never races a legitimate in-flight stop.
    // Storm-free: `force_exit` → onExit → enterStable clears `stoppingSince`, so
    // it can't re-fire for the same stopping episode; if the respawn wedges in
    // `stopping` again, a fresh `stoppingSince` restarts the clock and it re-
    // escalates — converging until a respawn sticks.
    const stoppingStuck =
      a.status === "stopping" &&
      a.stoppingSince !== null &&
      nowMs - a.stoppingSince >= state.stoppingStuckThresholdMs;
    if (stoppingStuck) {
      // Leave stoppingSince set until the synthetic exit's onExit clears it —
      // status stays `stopping` this tick, so the `!== "stopping"` shape holds
      // and nothing else touches it; the effect drives the transition out.
      effects.push({ type: "force_exit", agentId: id, reason: "stopping_stuck" });
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
      agents[id] = { ...a, status: "stopping", idleSince: null, stoppingSince: nowMs };
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
    lastDeliverAt: null,
    idleSince: null,
    stoppingSince: null,
    resetting: false,
    resettingSince: null,
    apm: createInitialApmGatedSteeringState(),
  };
}

/**
 * Move an agent into a STABLE lifecycle state (`running` or `idle`) — the
 * SINGLE owner of clearing the reset window. Every transition into a stable
 * state MUST go through here, never a bare `agent.status = "running"/"idle"`
 * assignment: that is what makes "the reset window ends exactly when the agent
 * reaches a stable state" a structural invariant instead of two hand-maintained
 * clear sites (`onSpawned` and `onExit`) that a deaf/hung process can both miss.
 *
 * Batch C (plans/daemon-fsm-desync.md): the old design cleared `resetting` in
 * `onSpawned` (idle-branch) and `onExit` (kill-branch) — both event-driven, so
 * an event that never arrives (SDK start wedged → no `spawned`; process won't
 * emit `exit`) left `resetting` stuck true forever, reset-locking every future
 * wake. Folding the clear into the stable-state transition means: whatever path
 * reaches `running`/`idle`, the window closes atomically with it. Batch D's
 * reconcile, on detecting a reset that never converged (`resettingSince` stale),
 * escalates through this same helper — recovery reuses the primitive.
 *
 * `starting`/`stopping` are TRANSIENT (still mid-reset) and deliberately do NOT
 * go through here — they don't clear the window.
 */
function enterStable(agent: AgentState, status: "running" | "idle"): void {
  agent.status = status;
  agent.resetting = false;
  agent.resettingSince = null;
  // Left `stopping` (reached a stable state) ⇒ the stopping-stuck clock is moot.
  agent.stoppingSince = null;
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

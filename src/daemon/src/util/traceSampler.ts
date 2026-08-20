/**
 * FSM-trace sampler — heartbeat throttling so the bounded trace retains a
 * useful HISTORY WINDOW instead of being flushed by routine noise
 * (plans/daemon-trace-completeness-charter.md T4).
 *
 * WHY: the default trace is capped at 32 MiB per generation (64 MiB for active
 * + `.1`, rotatingFileSink). At the executable N=8 operational envelope, the
 * sampler retains 8,168 rows / 4,010,728 serialized JSONL bytes per hour
 * (3.825 MiB/h), so the two generations preserve approximately 16.73 hours.
 * Unchanged-state heartbeats carry no new information and would otherwise flush
 * information-rich transitions far sooner; write rate still scales with agent
 * count, so a much larger fleet needs the byte budget revisited.
 *
 * INVARIANT (Cecilia 架构#423 ③): a row is sampleable IFF its information can be
 * fully reconstructed from the retained neighbors; otherwise it is sacrosanct.
 * Concretely:
 *   - SACROSANCT, never dropped:
 *       · any non-`tick` event (transition/lifecycle: exit, turn_end,
 *         reset_session, begin_reset, rewake_after_reset, spawned, wake,
 *         register, session);
 *       · ANY row whose `effects` is non-empty — the watchdog-fired frame
 *         (terminate_stalled/force_exit/…). This is where the PEAK
 *         `sinceProgressMs` lives (Blair's 121846ms was on the
 *         `effects:['terminate_stalled']` tick; the following turn_end had
 *         already reset it to 0). Dropping it would shorten the reconstructed
 *         "stuck for how long". (Cecilia 架构#423 ④.)
 *   - SAMPLEABLE (throttled): unchanged-state `tick`, plus `root_work` /
 *     `runtime_signal` heartbeats. An unchanged-state tick is one with
 *     `effects==[]` AND status/turnActive/inbox/resetting/stopping unchanged
 *     from the previous emitted tick for that agent.
 *
 * WEDGE RECONSTRUCTION (Claudette 架构#421 assertion ②): a stuck run must remain
 * reconstructable — which state/phase, how long, through to kill — from the
 * retained rows alone. Guaranteed by: the edge INTO the stuck state is emitted
 * (state change), interior points every `throttleMs` bound the slope, the last
 * unchanged tick of the run is TAIL-FLUSHED (held and emitted right before the
 * next emitted tick-stream row), and the terminating frame (effects tick / a
 * transition) is sacrosanct. `sinceProgressMs` is self-contained on each tick
 * row, so duration reconstructs from the tick stream alone even when the
 * `root_work` stream is fully folded.
 */

/** Sampler-visible subset of the manager's explicitly allowlisted trace rows. */
interface TraceRec {
  recordKind: "fsm" | "turn_span";
  agentId: string;
  event: string;
  effects: string[];
  nowMs: number;
  status?: unknown;
  turnActive?: unknown;
  inbox?: unknown;
  resetting?: unknown;
  stoppingSince?: unknown;
  deliveryPhase?: unknown;
}

export interface TraceSampler {
  /** Offer one record; the sampler emits it (and any tail-flush) or folds it. */
  offer(rec: TraceRec): void;
}

/** Streams that are throttled rather than always-emitted. */
const SAMPLEABLE_EVENTS = new Set(["tick", "root_work", "runtime_signal"]);
const SACRED_TURN_SPAN_EVENTS = new Set(["turn_begin", "turn_end", "turn_abort"]);

/** Default heartbeat throttle: at most one folded-stream row per agent per this. */
export const DEFAULT_TRACE_SAMPLE_MS = 30_000;
/** Cap for each generation of the default-on local FSM trace (active and `.1`). */
export const DEFAULT_TRACE_FILE_MAX_BYTES = 32 * 1024 * 1024;

interface AgentSamplerState {
  /** Last emitted tick's reconstruct-key (state fingerprint); null before first. */
  lastTickKey: string | null;
  /** nowMs of the last emitted `tick` for this agent (for the throttle window). */
  lastTickEmitAt: number;
  /** The most recent throttled (folded) unchanged tick, held for tail-flush. */
  pendingTick: TraceRec | null;
  /** Last emitted `root_work` nowMs. */
  lastProgressEmitAt: number;
  /** Last emitted `runtime_signal` deliveryPhase (edge detection) + nowMs. */
  lastSignalPhase: string | null;
  lastSignalEmitAt: number;
}

function newAgentState(): AgentSamplerState {
  return {
    lastTickKey: null,
    lastTickEmitAt: Number.NEGATIVE_INFINITY,
    pendingTick: null,
    lastProgressEmitAt: Number.NEGATIVE_INFINITY,
    lastSignalPhase: null,
    lastSignalEmitAt: Number.NEGATIVE_INFINITY,
  };
}

/** The reconstruct-key: two ticks with the same key are informationally identical. */
function tickKey(rec: TraceRec): string {
  return [
    rec.status,
    rec.turnActive,
    rec.inbox,
    rec.resetting,
    rec.stoppingSince == null ? "s0" : "s1",
  ].join("|");
}

function hasEffects(rec: TraceRec): boolean {
  const e = rec.effects;
  return Array.isArray(e) && e.length > 0;
}

function nowOf(rec: TraceRec): number {
  return typeof rec.nowMs === "number" ? rec.nowMs : 0;
}

/**
 * @param emit       called for each row that survives sampling (in order).
 * @param throttleMs min gap between folded-stream rows per agent (default 30s).
 */
export function createTraceSampler(
  emit: (rec: TraceRec) => void,
  throttleMs: number = DEFAULT_TRACE_SAMPLE_MS,
): TraceSampler {
  const perAgent = new Map<string, AgentSamplerState>();

  const stateFor = (agentId: string): AgentSamplerState => {
    let s = perAgent.get(agentId);
    if (!s) {
      s = newAgentState();
      perAgent.set(agentId, s);
    }
    return s;
  };

  /** Emit the held tail tick (if any) so an unchanged run's LAST row survives. */
  const flushPending = (s: AgentSamplerState): void => {
    if (s.pendingTick) {
      const p = s.pendingTick;
      s.pendingTick = null;
      s.lastTickEmitAt = nowOf(p);
      emit(p);
    }
  };

  return {
    offer(rec: TraceRec): void {
      const agentId = typeof rec.agentId === "string" ? rec.agentId : null;
      // No agent id (shouldn't happen for emitted rows) → pass through untouched.
      if (!agentId) {
        emit(rec);
        return;
      }
      const s = stateFor(agentId);
      const event = rec.event;

      // Lifecycle rows are explicitly sacred rather than relying on their
      // current absence from SAMPLEABLE_EVENTS. This survives future sampler
      // expansion and preserves the pending tick tail before the boundary.
      if (rec.recordKind === "turn_span" && SACRED_TURN_SPAN_EVENTS.has(String(event))) {
        flushPending(s);
        emit(rec);
        return;
      }

      // Sacrosanct: any non-sampleable event, or ANY row carrying effects (the
      // watchdog-fired frame). Flush the pending tail first so run order + the
      // last unchanged tick are preserved ahead of the terminating frame.
      if (!SAMPLEABLE_EVENTS.has(event as string) || hasEffects(rec)) {
        flushPending(s);
        // A sacrosanct tick still updates the tick anchors (it IS an emitted tick).
        if (event === "tick") {
          s.lastTickKey = tickKey(rec);
          s.lastTickEmitAt = nowOf(rec);
        }
        emit(rec);
        return;
      }

      // ---- Sampleable heartbeat streams ----
      if (event === "tick") {
        const key = tickKey(rec);
        const now = nowOf(rec);
        // State-change EDGE → always emit (the run boundary; carries the fresh
        // state). Flush the prior run's tail first.
        if (key !== s.lastTickKey) {
          flushPending(s);
          s.lastTickKey = key;
          s.lastTickEmitAt = now;
          emit(rec);
          return;
        }
        // Unchanged state: emit at most one per throttle window; otherwise HOLD
        // as the run's tail (overwrite — we only need the latest folded one).
        if (now - s.lastTickEmitAt >= throttleMs) {
          s.pendingTick = null; // this row supersedes any earlier held tail
          s.lastTickEmitAt = now;
          emit(rec);
        } else {
          s.pendingTick = rec;
        }
        return;
      }

      if (event === "root_work") {
        // Redundant with the next tick's sinceProgressMs; keep a sparse sample
        // for a coarse liveness pulse, fold the rest.
        const now = nowOf(rec);
        if (now - s.lastProgressEmitAt >= throttleMs) {
          s.lastProgressEmitAt = now;
          emit(rec);
        }
        return;
      }

      // runtime_signal: keep phase-change EDGES, throttle same-phase runs.
      if (event === "runtime_signal") {
        const phase = typeof rec.deliveryPhase === "string" ? rec.deliveryPhase : "";
        const now = nowOf(rec);
        if (phase !== s.lastSignalPhase || now - s.lastSignalEmitAt >= throttleMs) {
          s.lastSignalPhase = phase;
          s.lastSignalEmitAt = now;
          emit(rec);
        }
        return;
      }

      // Unreachable (SAMPLEABLE_EVENTS covered above), but fail-open: emit.
      emit(rec);
    },
  };
}

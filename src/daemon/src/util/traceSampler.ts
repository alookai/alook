/**
 * FSM-trace sampler — heartbeat throttling so the bounded trace retains a
 * useful HISTORY WINDOW instead of being flushed by routine noise
 * (plans/daemon-trace-completeness-charter.md T4).
 *
 * WHY: the default trace is size-capped (8MB×2, rotatingFileSink). Measured at
 * N≈8 agents, ~74% of all rows are UNCHANGED-STATE `tick` heartbeats (~every
 * 2s/agent) that carry no new information — they flush the information-rich
 * transition rows (exit/turn_end/reset/spawn-fail/kill) out of the window in
 * ~2h. An incident is often investigated hours later (the Blair stall-kill was
 * looked at ~3h after), so the meaningful rows must survive far longer. This
 * sampler folds the redundant heartbeats while keeping every transition and the
 * forensic anchors, lifting transition-row retention to ≥12h @ N=8 at the same
 * byte budget (see charter T4; ≥12h is @ N=8 — write rate scales with agent
 * count, so a much larger fleet needs the byte budget revisited).
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
 *   - SAMPLEABLE (throttled): unchanged-state `tick`, plus `progress` /
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
 * `progress` stream is fully folded.
 */

/** A trace record as produced by the manager's onFsmTransition callback. */
type TraceRec = Record<string, unknown>;

export interface TraceSampler {
  /** Offer one record; the sampler emits it (and any tail-flush) or folds it. */
  offer(rec: TraceRec): void;
}

/** Streams that are throttled rather than always-emitted. */
const SAMPLEABLE_EVENTS = new Set(["tick", "progress", "runtime_signal"]);

/** Default heartbeat throttle: at most one folded-stream row per agent per this. */
export const DEFAULT_TRACE_SAMPLE_MS = 30_000;

interface AgentSamplerState {
  /** Last emitted tick's reconstruct-key (state fingerprint); null before first. */
  lastTickKey: string | null;
  /** nowMs of the last emitted `tick` for this agent (for the throttle window). */
  lastTickEmitAt: number;
  /** The most recent throttled (folded) unchanged tick, held for tail-flush. */
  pendingTick: TraceRec | null;
  /** Last emitted `progress` nowMs. */
  lastProgressEmitAt: number;
  /** Last emitted `runtime_signal` apmPhase (edge detection) + nowMs. */
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

      if (event === "progress") {
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
        const phase = typeof rec.apmPhase === "string" ? rec.apmPhase : "";
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

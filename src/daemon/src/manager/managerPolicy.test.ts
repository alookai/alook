import { describe, it, expect } from "vitest";
import {
  reduceManager,
  createInitialManagerState,
  isActivelyWorking,
  type ManagerState,
  type AgentState,
  type AgentStatus,
} from "./managerPolicy.js";

interface LegacyCaps {
  lifecycleKind: "persistent" | "per_turn";
  supportsStdinNotification: boolean;
  busyDeliveryMode: "gated" | "direct" | "none";
}
const PERSISTENT_GATED: LegacyCaps = {
  lifecycleKind: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "gated",
};
/** Matches Pi — NOT Codex, which this plan moves to "gated". */
const PERSISTENT_DIRECT: LegacyCaps = {
  lifecycleKind: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "direct",
};
const PER_TURN: LegacyCaps = {
  lifecycleKind: "per_turn",
  supportsStdinNotification: false,
  busyDeliveryMode: "none",
};

function register(state: ManagerState, agentId: string, _caps: LegacyCaps): ManagerState {
  return reduceManager(state, { type: "register", agentId }).state;
}

describe("reduceManager — single-flight spawn", () => {
  it("first wake from idle spawns; second wake while starting does NOT spawn again", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);

    const r1 = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 });
    expect(r1.effects).toEqual([{ type: "spawn", agentId: "a", messages: [{ text: "m1" }], resumeSessionId: null }]);
    expect(r1.state.agents.a.status).toBe("starting");

    // Mid-start second wake: queue only, no second spawn (single-flight).
    const r2 = reduceManager(r1.state, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 2 });
    expect(r2.effects).toEqual([]);
    expect(r2.state.agents.a.inbox.map((m) => m.text)).toEqual(["m2"]);
  });

  it("drops a wake for an unknown (unregistered) agent", () => {
    const s = createInitialManagerState();
    const r = reduceManager(s, { type: "wake", agentId: "ghost", message: { text: "x" }, nowMs: 1 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.ghost).toBeUndefined();
  });
});

describe("reduceManager — steering a running persistent agent", () => {
  it("direct (Pi profile): wake while running+turnActive still steers as busy immediately — regression guard, gating must not affect non-gated drivers", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state; // running, turnActive

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", message: { text: "m2" }, mode: "busy" }]);
    // Never held for a direct driver.
    expect(r.effects.some((e) => e.type === "gated_hold")).toBe(false);
  });

  it("gated: wake while running but turnActive=false steers as idle immediately — unchanged from today", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 3 }).state; // running, turnActive=false, idle

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 4 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", message: { text: "m2" }, mode: "idle" }]);
  });

  it("re-waking a hibernating-but-alive persistent agent (running, turnActive=false) sets turnActive=true on commit — mirrors onTurnEnd's redeliver branch", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 3 }).state; // running, turnActive=false, idle

    expect(s.agents.a.turnActive).toBe(false);
    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 4 });
    expect(r.state.agents.a.turnActive).toBe(true);
  });
});

describe("reduceManager — turn_end behavior", () => {
  it("persistent with queued messages delivers them as a fresh idle turn", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    // queue while running but pretend not steered: directly push via wake after turn?
    // Simulate a message arriving then the turn ending with it still queued:
    s = { ...s, agents: { ...s.agents, a: { ...s.agents.a, inbox: [{ text: "queued" }] } } };

    const r = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 5 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", message: { text: "queued" }, mode: "idle" }]);
    expect(r.state.agents.a.turnActive).toBe(true);
  });

  it("persistent with empty inbox goes idle and starts the idle clock", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;

    const r = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 5 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.turnActive).toBe(false);
    expect(r.state.agents.a.idleSince).toBe(5);
  });
});

describe("reduceManager — tick: stall + idle hibernation", () => {
  it("terminates a stalled per-turn agent past the stale threshold", () => {
    let s = createInitialManagerState(100); // staleThresholdMs = 100
    s = register(s, "a", PER_TURN);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state; // lastProgressAt=0, turnActive

    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([{ type: "terminate_stalled", agentId: "a" }]);
    expect(r.state.agents.a.status).toBe("stopping");
  });

  it("does NOT stall before the threshold", () => {
    let s = createInitialManagerState(100);
    s = register(s, "a", PER_TURN);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    expect(reduceManager(s, { type: "tick", nowMs: 50 }).effects).toEqual([]);
  });

  it("stops a persistent agent that sat idle past the idle timeout (sessionId preserved)", () => {
    let s = createInitialManagerState(100_000, 100); // idleTimeoutMs = 100
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "session", agentId: "a", sessionId: "sess-1" }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 0 }).state; // idleSince=0

    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([{ type: "stop", agentId: "a", reason: "idle_timeout" }]);
    expect(r.state.agents.a.sessionId).toBe("sess-1"); // preserved for resume
  });

  it("idle timeout of 0 disables hibernation", () => {
    let s = createInitialManagerState(100_000, 0);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 0 }).state;
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });
});

// Batch A (plans/daemon-fsm-desync.md): the suspected-deaf detector catches the
// gated-no-further-turn_end permanent orphan that slips BOTH existing tick
// predicates. Reproduces Olivia's wedge: a gated agent turn-ends idle, a later
// wake drain-sends (stamping lastDeliverAt, re-arming turnActive), then the
// process goes deaf — no progress, no turn_end, no exit ever follows.
describe("reduceManager — tick: suspected-deaf detection (batch A)", () => {
  // Build the exact orphan tuple: running, turnActive (from the drain-send),
  // inbox empty (drained), lastDeliverAt > lastProgressAt, past the threshold.
  function toDeafOrphan(staleMs = 100) {
    let s = createInitialManagerState(staleMs);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "session", agentId: "a", sessionId: "sess-1" }).state;
    // Turn ends → turnActive false, idleSince armed, lastProgressAt=10.
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 10 }).state;
    // A later wake on the now-idle turn drain-sends into the (about-to-go-deaf)
    // process: stamps lastDeliverAt=20, re-arms turnActive, drains the inbox.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 20 }).state;
    return s;
  }

  it("terminates a gated agent whose delivery got no process response past the threshold", () => {
    const s = toDeafOrphan();
    expect(s.agents.a.turnActive).toBe(true);
    expect(s.agents.a.inbox.length).toBe(0); // drained — slips stalled's gated sub-clause
    expect(s.agents.a.lastDeliverAt).toBe(20);
    expect(s.agents.a.lastProgressAt).toBe(10); // deliver newer than last progress

    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([{ type: "terminate_stalled", agentId: "a" }]);
    expect(r.state.agents.a.status).toBe("stopping");
  });

  it("does NOT terminate before the stale window elapses after delivery", () => {
    const s = toDeafOrphan();
    expect(reduceManager(s, { type: "tick", nowMs: 100 }).effects).toEqual([]); // 100-20 < 100
  });

  it("does NOT flag a healthy agent whose process reported progress after the delivery", () => {
    let s = toDeafOrphan();
    // Process answers: a progress event lands after the deliver → lastProgressAt
    // (30) overtakes lastDeliverAt (20), so the suspicion clears on its own.
    s = reduceManager(s, { type: "progress", agentId: "a", nowMs: 30 }).state;
    s = { ...s, agents: { ...s.agents, a: { ...s.agents.a, turnActive: false } } };
    expect(reduceManager(s, { type: "tick", nowMs: 200 }).effects).toEqual([]);
  });

  it("does NOT flag a fresh agent that never had a delivery (lastDeliverAt null)", () => {
    let s = createInitialManagerState(100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    expect(s.agents.a.lastDeliverAt).toBeNull();
    s = { ...s, agents: { ...s.agents, a: { ...s.agents.a, turnActive: false } } };
    expect(reduceManager(s, { type: "tick", nowMs: 200 }).effects).toEqual([]);
  });

  it("clears lastDeliverAt across a respawn (no cross-lifecycle stale suspicion)", () => {
    let s = toDeafOrphan();
    // The orphan gets terminated → exit → onExit; then respawn. lastDeliverAt
    // must be null again so the next lifecycle starts clean.
    s = reduceManager(s, { type: "tick", nowMs: 200 }).state; // → stopping + terminate
    s = reduceManager(s, { type: "exit", agentId: "a" }).state;
    expect(s.agents.a.lastDeliverAt).toBeNull();
  });
});

// Batch D (plans/daemon-fsm-desync.md): the reset-stuck reconcile. The reset
// window (`resetting`) closes only via `enterStable` at a stable running/idle
// state; if the converging event never arrives the agent wedges in `starting`
// with `resetting` stuck true — invisible to the three running-keyed onTick
// predicates. This watchdog is the ONLY thing that catches it.
describe("reduceManager — tick: reset-stuck reconcile (batch D)", () => {
  // Build a reset that respawned but never reached `running`: begin_reset →
  // queued rewake → exit (onExit respawns into `starting`, resetting STAYS true
  // per batch C) → no `spawned` ever arrives. resettingSince is the begin_reset
  // stamp; the respawn is still inside the same never-closed window.
  function toResetStuckOrphan(resetStuckMs = 100) {
    let s = createInitialManagerState(100_000, 100_000, resetStuckMs);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state; // running
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 10 }).state; // resetting, resettingSince=10
    s = reduceManager(s, { type: "rewake_after_reset", agentId: "a", message: { text: "rewake" } }).state;
    s = reduceManager(s, { type: "exit", agentId: "a" }).state; // onExit → respawn, status=starting, resetting stays
    return s;
  }

  it("escalates a reset that never converged (resetting stuck in starting past the threshold)", () => {
    const s = toResetStuckOrphan();
    expect(s.agents.a.status).toBe("starting");
    expect(s.agents.a.resetting).toBe(true);
    expect(s.agents.a.resettingSince).toBe(10);

    // now - resettingSince = 200 - 10 = 190 >= 100 → escalate.
    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([{ type: "terminate_stalled", agentId: "a" }]);
    expect(r.state.agents.a.status).toBe("stopping");
  });

  it("does NOT escalate before the reset-stuck threshold elapses", () => {
    const s = toResetStuckOrphan();
    // now - resettingSince = 100 - 10 = 90 < 100 → not yet.
    expect(reduceManager(s, { type: "tick", nowMs: 100 }).effects).toEqual([]);
  });

  it("does NOT re-escalate every tick while the forced exit is in flight (stopping guard)", () => {
    let s = toResetStuckOrphan();
    s = reduceManager(s, { type: "tick", nowMs: 200 }).state; // → stopping + terminate
    expect(s.agents.a.status).toBe("stopping");
    // Next tick before the exit lands: resetting still true, but status is
    // stopping → guard blocks a second terminate_stalled (no storm).
    expect(reduceManager(s, { type: "tick", nowMs: 210 }).effects).toEqual([]);
  });

  it("stops firing once the reset converges (enterStable clears resetting)", () => {
    let s = toResetStuckOrphan();
    // The respawn finally reaches running → spawned → enterStable clears the
    // reset window. The reconcile must go quiet.
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 150 }).state;
    expect(s.agents.a.resetting).toBe(false);
    expect(s.agents.a.resettingSince).toBeNull();
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });

  it("re-escalates on a later tick if the forced exit's respawn wedges again", () => {
    let s = toResetStuckOrphan();
    s = reduceManager(s, { type: "tick", nowMs: 200 }).state; // → stopping + terminate
    // A new wake arrives during the still-open reset window — gated to inbox
    // (onWake's reset gate), NOT delivered. So the forced exit's onExit has
    // queued work → respawns into `starting` again, resetting still true (the
    // reset STILL hasn't converged). Without the new wake the first onExit would
    // have drained the sole rewake and settled idle = converged (correct); the
    // re-wedge only exists when there's fresh queued work each cycle.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 210 }).state;
    s = reduceManager(s, { type: "exit", agentId: "a" }).state;
    expect(s.agents.a.status).toBe("starting");
    expect(s.agents.a.resetting).toBe(true);
    // A later tick past the (unchanged, begin_reset-stamped) window fires anew.
    const r = reduceManager(s, { type: "tick", nowMs: 400 });
    expect(r.effects).toEqual([{ type: "terminate_stalled", agentId: "a" }]);
  });

  it("does NOT escalate a normal (converged) agent with resetting false", () => {
    let s = createInitialManagerState(100_000, 100_000, 100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state; // running, resetting=false
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });
});

// Batch L3 (plans/daemon-fsm-desync.md): the stopping-wedge black hole. A
// stop/terminate set status=stopping expecting an `exit` that never arrived
// (no-op stop / kill didn't take). No other predicate keys on `stopping`, and
// onWake only queues there → permanent wedge (observed live: Olivia 2026-07-31,
// stuck 12min+, inbox climbing, process still alive). This branch forces it out
// via `force_exit` (runtime handler kills any tracked proc + synthetic exit).
describe("reduceManager — tick: stopping-stuck escalation (batch L3)", () => {
  // Drive an agent into `stopping` via idle-timeout, then WITHHOLD the exit —
  // exactly the wedge. staleThreshold huge so nothing else fires; idleTimeout
  // small to enter stopping; stoppingStuck = the arg under test (4th).
  function toStoppingStuck(stoppingStuckMs = 100) {
    let s = createInitialManagerState(1_000_000, 50, 1_000_000, stoppingStuckMs);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 0 }).state; // idleSince=0
    // Idle-timeout tick (past idleTimeout=50) → status=stopping, stoppingSince stamped.
    s = reduceManager(s, { type: "tick", nowMs: 100 }).state;
    return s;
  }

  it("stamps stoppingSince and issues stop when entering stopping", () => {
    let s = createInitialManagerState(1_000_000, 50, 1_000_000, 100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 0 }).state;
    const r = reduceManager(s, { type: "tick", nowMs: 100 });
    expect(r.effects).toEqual([{ type: "stop", agentId: "a", reason: "idle_timeout" }]);
    expect(r.state.agents.a.status).toBe("stopping");
    expect(r.state.agents.a.stoppingSince).toBe(100);
  });

  it("force_exits an agent wedged in stopping past the threshold (the black-hole escape)", () => {
    const s = toStoppingStuck();
    expect(s.agents.a.status).toBe("stopping");
    expect(s.agents.a.stoppingSince).toBe(100);
    // No exit ever came. nowMs - stoppingSince = 250 - 100 = 150 >= 100 → escape.
    const r = reduceManager(s, { type: "tick", nowMs: 250 });
    expect(r.effects).toEqual([{ type: "force_exit", agentId: "a", reason: "stopping_stuck" }]);
    // Still stopping this tick (the effect drives the transition out via onExit).
    expect(r.state.agents.a.status).toBe("stopping");
  });

  it("does NOT force_exit before the stopping-stuck threshold elapses", () => {
    const s = toStoppingStuck();
    // nowMs - stoppingSince = 150 - 100 = 50 < 100 → not yet.
    expect(reduceManager(s, { type: "tick", nowMs: 150 }).effects).toEqual([]);
  });

  it("clears stoppingSince on the synthetic exit (onExit) so it can't re-fire for the same episode", () => {
    let s = toStoppingStuck();
    s = reduceManager(s, { type: "tick", nowMs: 250 }).state; // force_exit emitted
    // The synthetic exit lands: onExit → settle idle (empty inbox) → stoppingSince cleared.
    s = reduceManager(s, { type: "exit", agentId: "a" }).state;
    expect(s.agents.a.stoppingSince).toBeNull();
    expect(s.agents.a.status).toBe("idle");
    // No more force_exit — the episode is over.
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });

  it("re-escalates if a respawn wedges in stopping AGAIN (fresh stoppingSince restarts the clock)", () => {
    let s = toStoppingStuck();
    // A wake queued during stopping so onExit respawns rather than settling idle.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 200 }).state;
    s = reduceManager(s, { type: "tick", nowMs: 250 }).state; // force_exit
    s = reduceManager(s, { type: "exit", agentId: "a" }).state; // onExit → respawn (inbox>0) → starting
    expect(s.agents.a.status).toBe("starting");
    expect(s.agents.a.stoppingSince).toBeNull(); // cleared by onExit
    // The respawn never reaches running and gets stopped again (simulate another
    // idle-timeout path isn't reachable in starting; instead drive it via a
    // fresh stopping through the reset-stuck-like route is out of scope here).
    // Minimal: confirm a NEW stopping stamps a fresh clock.
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 300 }).state; // running
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 300 }).state; // idle
    s = reduceManager(s, { type: "tick", nowMs: 400 }).state; // idle-timeout → stopping again
    expect(s.agents.a.status).toBe("stopping");
    expect(s.agents.a.stoppingSince).toBe(400); // fresh clock, not the old 100
    const r = reduceManager(s, { type: "tick", nowMs: 550 }); // 550-400=150>=100
    expect(r.effects).toEqual([{ type: "force_exit", agentId: "a", reason: "stopping_stuck" }]);
  });

  it("does NOT force_exit a healthy running agent (stoppingSince null)", () => {
    let s = createInitialManagerState(1_000_000, 1_000_000, 1_000_000, 100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    expect(s.agents.a.stoppingSince).toBeNull();
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });
});

describe("reduceManager — reset_session", () => {
  it("nulls sessionId on a known agent without changing status/turnActive", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "session", agentId: "a", sessionId: "sess-1" }).state;
    expect(s.agents.a.sessionId).toBe("sess-1");
    const prevStatus = s.agents.a.status;
    const prevTurnActive = s.agents.a.turnActive;

    const r = reduceManager(s, { type: "reset_session", agentId: "a" });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.sessionId).toBeNull();
    expect(r.state.agents.a.status).toBe(prevStatus);
    expect(r.state.agents.a.turnActive).toBe(prevTurnActive);
  });

  it("no-op on an unknown agentId", () => {
    const s = createInitialManagerState();
    const r = reduceManager(s, { type: "reset_session", agentId: "ghost" });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.ghost).toBeUndefined();
  });
});

describe("reduceManager — begin_reset / rewake_after_reset", () => {
  it("begin_reset sets resetting=true, stamps resettingSince, and emits no effects", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    const r = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 42 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.resetting).toBe(true);
    // Window start stamped so batch D can detect a reset that never converged.
    expect(r.state.agents.a.resettingSince).toBe(42);
  });

  it("rewake_after_reset appends to inbox and emits no effects", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    const r = reduceManager(s, { type: "rewake_after_reset", agentId: "a", message: { text: "rewake" } });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["rewake"]);
  });

  it("both events are no-ops on an unknown agent", () => {
    const s = createInitialManagerState();
    expect(reduceManager(s, { type: "begin_reset", agentId: "ghost", nowMs: 1 }).state.agents.ghost).toBeUndefined();
    expect(
      reduceManager(s, { type: "rewake_after_reset", agentId: "ghost", message: { text: "x" } }).state.agents.ghost,
    ).toBeUndefined();
  });
});

describe("reduceManager — onWake `resetting` gate", () => {
  it("persistent+direct + running + resetting=true: wake queues to inbox only, NO send/gated_hold effect", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    // Set resetting via the FSM event (bypassing onSpawned's auto-clear
    // which fires before this event).
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;
    expect(s.agents.a.resetting).toBe(true);
    expect(s.agents.a.status).toBe("running");

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "unread" }, nowMs: 3 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["unread"]);
  });

  it("gated + running + turnActive + resetting=true: wake queues only, NO gated_hold effect", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "unread" }, nowMs: 3 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["unread"]);
  });

  it("starting + resetting=true: wake queues (does NOT spawn a second process)", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    // status=starting now
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "unread" }, nowMs: 2 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["unread"]);
  });

  it("idle + resetting=true: wake IS EXEMPTED — still spawns (idle branch of reset orchestrator relies on this)", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;
    expect(s.agents.a.resetting).toBe(true);
    expect(s.agents.a.status).toBe("idle");

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "rewake" }, nowMs: 1 });
    expect(r.effects).toEqual([{ type: "spawn", agentId: "a", messages: [{ text: "rewake" }], resumeSessionId: null }]);
    expect(r.state.agents.a.status).toBe("starting");
  });
});

describe("reduceManager — onExit / onSpawned clear resetting", () => {
  it("onExit clears resetting and drains inbox (rewake + queued unread) into ONE spawn", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    // Simulate live agent
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    // Begin reset: mark + enqueue rewake
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;
    s = reduceManager(s, { type: "rewake_after_reset", agentId: "a", message: { text: "REWAKE" } }).state;
    // Real unread arrives during reset window — gate queues to inbox.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "unread" }, nowMs: 3 }).state;
    expect(s.agents.a.inbox.map((m) => m.text)).toEqual(["REWAKE", "unread"]);

    // Kill lands → exit → drains rewake+unread into ONE respawn.
    const r = reduceManager(s, { type: "exit", agentId: "a" });
    expect(r.effects).toEqual([{
      type: "spawn",
      agentId: "a",
      messages: [{ text: "REWAKE" }, { text: "unread" }],
      resumeSessionId: null,
    }]);
    // Batch C semantic change (intentional): the reset window stays OPEN across
    // the respawn's transient `starting` state — it closes only when the fresh
    // process reaches `running` via `spawned`/`enterStable`, i.e. when context
    // is actually re-established, not merely when the old process died.
    expect(r.state.agents.a.status).toBe("starting");
    expect(r.state.agents.a.resetting).toBe(true);
    // ...and closes on the respawn's `spawned`.
    const r2 = reduceManager(r.state, { type: "spawned", agentId: "a", nowMs: 5 });
    expect(r2.state.agents.a.status).toBe("running");
    expect(r2.state.agents.a.resetting).toBe(false);
    expect(r2.state.agents.a.resettingSince).toBeNull();
  });

  it("respawn that itself wedges keeps resetting true + resettingSince aging → batch D's reconcile can catch the stuck-in-starting orphan", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 3 }).state;
    s = reduceManager(s, { type: "rewake_after_reset", agentId: "a", message: { text: "REWAKE" } }).state;
    // Kill → exit → respawn emitted, status goes to the transient `starting`.
    const r = reduceManager(s, { type: "exit", agentId: "a" });
    expect(r.effects[0]).toMatchObject({ type: "spawn", agentId: "a" });
    // The respawn never lands a `spawned` (new process wedged). The reset window
    // stays open with its ORIGINAL start time — the signal batch D reads to
    // detect a reset that never converged. Under the old "clear at onExit"
    // behavior this was `resetting=false, status=starting`, invisible to every
    // running-gated recovery predicate.
    expect(r.state.agents.a.status).toBe("starting");
    expect(r.state.agents.a.resetting).toBe(true);
    expect(r.state.agents.a.resettingSince).toBe(3);
  });

  it("onSpawned clears resetting (idle-branch reset spawn)", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;
    // Idle-branch deliver emits spawn (idle exempt).
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "REWAKE" }, nowMs: 1 }).state;
    expect(s.agents.a.resetting).toBe(true);
    const r = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 });
    expect(r.state.agents.a.resetting).toBe(false);
  });

  it("spawn-failure path (exit fires with empty inbox) still clears resetting → no permanent reset-lock", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "begin_reset", agentId: "a", nowMs: 1 }).state;
    // Simulate driver.start() rejecting: `doSpawn` dispatches an immediate
    // exit; by then drainInboxToPrompt already emptied the inbox into the
    // (failed) spawn's prompt.
    s = { ...s, agents: { ...s.agents, a: { ...s.agents.a, status: "starting", inbox: [] } } };
    const r = reduceManager(s, { type: "exit", agentId: "a" });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.status).toBe("idle");
    expect(r.state.agents.a.resetting).toBe(false);
  });

});

describe("isActivelyWorking — single source of truth for the profile pill", () => {
  function agentWith(fields: { status: AgentStatus; turnActive: boolean; inbox: number }): AgentState {
    return {
      agentId: "a",
      status: fields.status,
      inbox: Array.from({ length: fields.inbox }, (_, i) => ({ seq: i, text: "m" })),
      sessionId: null,
      turnActive: fields.turnActive,
      lastProgressAt: 0,
      lastDeliverAt: null,
      idleSince: null,
      stoppingSince: null,
      resetting: false,
      resettingSince: null,
    };
  }

  it("running + turn in flight ⇒ working", () => {
    expect(isActivelyWorking(agentWith({ status: "running", turnActive: true, inbox: 0 }))).toBe(true);
  });

  it("running + no turn + queued inbox ⇒ working (the reported bug: mid-task between turns)", () => {
    expect(isActivelyWorking(agentWith({ status: "running", turnActive: false, inbox: 2 }))).toBe(true);
  });

  it("running + no turn + empty inbox ⇒ NOT working (genuinely idle, pre-hibernation)", () => {
    expect(isActivelyWorking(agentWith({ status: "running", turnActive: false, inbox: 0 }))).toBe(false);
  });

  it("non-running states are never working, even with a queued inbox", () => {
    for (const status of ["idle", "starting", "stopping"] as AgentStatus[]) {
      expect(isActivelyWorking(agentWith({ status, turnActive: true, inbox: 3 }))).toBe(false);
    }
  });
});

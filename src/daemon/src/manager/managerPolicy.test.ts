import { describe, it, expect } from "vitest";
import {
  reduceManager,
  createInitialManagerState,
  isActivelyWorking,
  type ManagerState,
  type AgentState,
  type AgentStatus,
  type AgentRuntimeCaps,
} from "./managerPolicy";
import { createInitialApmGatedSteeringState } from "../runtime/apmStateMachine";

const PERSISTENT_GATED: AgentRuntimeCaps = {
  lifecycleKind: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "gated",
};
/** Matches Pi/Kimi — NOT Codex, which this plan moves to "gated". */
const PERSISTENT_DIRECT: AgentRuntimeCaps = {
  lifecycleKind: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "direct",
};
const PER_TURN: AgentRuntimeCaps = {
  lifecycleKind: "per_turn",
  supportsStdinNotification: false,
  busyDeliveryMode: "none",
};

function register(state: ManagerState, agentId: string, caps: AgentRuntimeCaps): ManagerState {
  return reduceManager(state, { type: "register", agentId, caps }).state;
}

describe("reduceManager — single-flight spawn", () => {
  it("first wake from idle spawns; second wake while starting does NOT spawn again", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);

    const r1 = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 });
    expect(r1.effects).toEqual([{ type: "spawn", agentId: "a", prompt: "m1", resumeSessionId: null }]);
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
  it("gated: wake while running+turnActive is HELD, not steered — message stays in inbox", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state; // running, turnActive

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 });
    expect(r.effects).toEqual([
      { type: "gated_hold", agentId: "a", reason: "mid_turn_wake", blockedReason: "idle", recentEvents: [] },
    ]);
    // Held, not dropped.
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["m2"]);
  });

  it("direct (Pi/Kimi profile): wake while running+turnActive still steers as busy immediately — regression guard, gating must not affect non-gated drivers", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_DIRECT);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state; // running, turnActive

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "m2", mode: "busy" }]);
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
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "m2", mode: "idle" }]);
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

describe("reduceManager — none-driver (per-turn) mid-turn wake — regression", () => {
  it("wake while running (per-turn, mid-turn) stays queued for the next spawn; no send", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PER_TURN);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state; // running, turnActive

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["m2"]);
  });
});

describe("reduceManager — onRuntimeSignal (gated tool/compaction/review boundaries)", () => {
  /** Register + wake + spawn + session_init — a running, turnActive, gated agent with a known session. */
  function gatedRunningWithSession(): ManagerState {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    s = reduceManager(s, { type: "session", agentId: "a", sessionId: "sess_1" }).state;
    return s;
  }

  /** Same, but WITHOUT a session_init — for the missing_session test. */
  function gatedRunningNoSession(): ManagerState {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    return s;
  }

  it("tool_call then tool_output (single outstanding tool) flushes a held message as busy, draining the inbox", () => {
    let s = gatedRunningWithSession();
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 3 }).state; // held (gated_hold)

    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 4 }).state;
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_output", nowMs: 5 });

    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "busy" }]);
    expect(r.state.agents.a.inbox).toEqual([]);
  });

  it("tool_call/tool_output boundary WITHOUT a prior session_init is held with blockedReason: missing_session", () => {
    let s = gatedRunningNoSession();
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 3 }).state;

    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 4 }).state;
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_output", nowMs: 5 });

    expect(r.effects).toEqual([
      { type: "gated_hold", agentId: "a", reason: "tool_batch_complete", blockedReason: "missing_session", recentEvents: expect.any(Array) },
    ]);
    expect(r.state.agents.a.inbox.map((m) => m.text)).toEqual(["held"]);
  });

  it("two nested tool_calls, only one tool_output closes (outstandingToolUses stays > 0) — flush is attempted but blocked with outstanding_tool_uses, not missing_session", () => {
    let s = gatedRunningWithSession();
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 3 }).state;

    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 4 }).state;
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 5 }).state; // outstandingToolUses = 2
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_output", nowMs: 6 }); // -> 1, still > 0

    expect(r.effects).toEqual([
      { type: "gated_hold", agentId: "a", reason: "tool_batch_complete", blockedReason: "outstanding_tool_uses", recentEvents: expect.any(Array) },
    ]);
    expect(r.state.agents.a.apm.outstandingToolUses).toBe(1);
  });

  it("compaction_started then compaction_finished flushes a held message on compaction_finished", () => {
    let s = gatedRunningWithSession();
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 3 }).state;

    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "compaction_started", nowMs: 4 }).state;
    expect(s.agents.a.apm.compacting).toBe(true);
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "compaction_finished", nowMs: 5 });

    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "busy" }]);
  });

  it("review_started then review_finished flushes a held message on review_finished", () => {
    let s = gatedRunningWithSession();
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 3 }).state;

    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "review_started", nowMs: 4 }).state;
    expect(s.agents.a.apm.reviewing).toBe(true);
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "review_finished", nowMs: 5 });

    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "busy" }]);
  });

  it("an error disables tool-boundary flushing until the next turn_end — a later tool_output boundary is held with blockedReason: tool_boundary_flush_disabled, not missing_session", () => {
    let s = gatedRunningWithSession();
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "error", nowMs: 3 }).state;
    expect(s.agents.a.apm.toolBoundaryFlushDisabled).toBe(true);

    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 4 }).state;
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 5 }).state;
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_output", nowMs: 6 });

    expect(r.effects).toEqual([
      { type: "gated_hold", agentId: "a", reason: "tool_batch_complete", blockedReason: "tool_boundary_flush_disabled", recentEvents: expect.any(Array) },
    ]);
  });

  it("turn_end while a message is still held flushes it as mode:idle — unchanged, independent of hasSession/phase", () => {
    let s = gatedRunningNoSession(); // no session_init at all
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 3 }).state;

    const r = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 4 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "idle" }]);
  });

  it("turn_end resets the gated phase — a stale compacting flag from the PRIOR turn does not block a flush in the NEXT turn", () => {
    let s = gatedRunningWithSession();

    // Turn 1: enter compacting, never finish it.
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "compaction_started", nowMs: 3 }).state;
    expect(s.agents.a.apm.compacting).toBe(true);
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 4 }).state;

    // Turn 2: session_id persists across turn_end; re-spawn for the new turn.
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 5 }).state;
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 6 }).state;
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 7 }).state;
    const r = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_output", nowMs: 8 });

    // If `compacting` had leaked across turn_end, this would be blocked with
    // blockedReason: "compacting" instead of flushing.
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "busy" }]);
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
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "queued", mode: "idle" }]);
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

describe("reduceManager — per-turn respawn", () => {
  it("exit with queued messages respawns; exit with empty inbox goes idle", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PER_TURN);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    // A new message arrives mid-run: per-turn keeps it queued (no steer).
    const queued = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 });
    expect(queued.effects).toEqual([]);

    const onExit = reduceManager(queued.state, { type: "exit", agentId: "a" });
    expect(onExit.effects).toEqual([{ type: "spawn", agentId: "a", prompt: "m2", resumeSessionId: null }]);

    // Now exit again with nothing queued → idle.
    const spawned = reduceManager(onExit.state, { type: "spawned", agentId: "a", nowMs: 4 }).state;
    const idle = reduceManager(spawned, { type: "exit", agentId: "a" });
    expect(idle.effects).toEqual([]);
    expect(idle.state.agents.a.status).toBe("idle");
  });
});

describe("reduceManager — coalesce", () => {
  it("multiple queued messages drain into one joined prompt", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PER_TURN);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 }).state;
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m3" }, nowMs: 4 }).state;

    const r = reduceManager(s, { type: "exit", agentId: "a" });
    expect(r.effects).toEqual([{ type: "spawn", agentId: "a", prompt: "m2\nm3", resumeSessionId: null }]);
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

  it("terminates a stalled gated agent when inbox has queued work", () => {
    let s = createInitialManagerState(100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "session", agentId: "a", sessionId: "sess-1" }).state;
    // A second wake mid-turn is held (gated) and lands in the inbox.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 10 }).state;
    expect(s.agents.a.inbox.length).toBe(1);
    expect(s.agents.a.turnActive).toBe(true);

    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([{ type: "terminate_stalled", agentId: "a" }]);
    expect(r.state.agents.a.status).toBe("stopping");
  });

  it("does NOT terminate a stalled gated agent whose inbox is empty", () => {
    let s = createInitialManagerState(100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    // Inbox drained on spawn; no queued work.
    expect(s.agents.a.inbox.length).toBe(0);
    expect(s.agents.a.turnActive).toBe(true);

    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([]);
    expect(r.state.agents.a.status).toBe("running");
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
    expect(reduceManager(s, { type: "tick", nowMs: 200 }).effects).toEqual([]);
  });

  it("does NOT flag a fresh agent that never had a delivery (lastDeliverAt null)", () => {
    let s = createInitialManagerState(100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    expect(s.agents.a.lastDeliverAt).toBeNull();
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

// Batch L2 (plans/daemon-fsm-desync.md): the stranded-held-inbox re-delivery.
// Reproduces Olivia 2026-07-31: a mid-turn wake is gated_held into the inbox,
// then the turn's `turn_end` runtime event is lost (a wake raced the turn close
// by ~1s), so `turnActive` stays stuck true while the process is demonstrably
// idle (`apm.phase === "idle"`) — the held message strands forever. The GENTLE
// backstop re-delivers it (a `send`, no kill), checked BEFORE `stalled` so a
// recoverable strand is fed rather than terminated.
describe("reduceManager — tick: stranded-held-inbox re-delivery (batch L2)", () => {
  // Build the exact wedge tuple: running, turnActive=true, apm.phase idle,
  // inbox non-empty (a held mid-turn wake), heldSince stamped — the state Olivia
  // was stuck in. staleThresholdMs kept huge so `stalled`/`suspectedDeaf` can't
  // fire and confound the assertion; strandedInboxThresholdMs is the 4th arg.
  function toStrandedWedge(strandedMs = 100) {
    let s = createInitialManagerState(1_000_000, 300_000, 120_000, strandedMs);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state; // running, turnActive, apm.phase idle
    s = reduceManager(s, { type: "session", agentId: "a", sessionId: "sess-1" }).state;
    // A mid-turn wake at t=10 is gated-held (turnActive true) — lands in inbox,
    // stamps heldSince=10. This is the message that will strand.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 10 }).state;
    return s;
  }

  it("re-delivers a held message once the process has sat idle holding it past the threshold", () => {
    const s = toStrandedWedge();
    expect(s.agents.a.turnActive).toBe(true);
    expect(s.agents.a.apm.phase).toBe("idle");
    expect(s.agents.a.inbox.length).toBe(1);
    expect(s.agents.a.heldSince).toBe(10);

    const r = reduceManager(s, { type: "tick", nowMs: 200 }); // 200-10 >= 100
    // GENTLE: a plain idle send draining the inbox — NOT a terminate.
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "idle" }]);
    expect(r.state.agents.a.status).toBe("running"); // no kill, still running
    expect(r.state.agents.a.inbox.length).toBe(0); // drained
    expect(r.state.agents.a.heldSince).toBeNull(); // strand cleared
    // Upgrade chain armed: lastDeliverAt stamped so suspectedDeaf takes over if
    // this re-deliver also gets no response.
    expect(r.state.agents.a.lastDeliverAt).toBe(200);
    expect(r.state.agents.a.turnActive).toBe(true);
  });

  it("does NOT re-deliver before the stranded threshold elapses", () => {
    const s = toStrandedWedge();
    expect(reduceManager(s, { type: "tick", nowMs: 50 }).effects).toEqual([]); // 50-10 < 100
  });

  it("measures from the OLDEST held wake — a later coalescing wake does not reset the clock", () => {
    let s = toStrandedWedge();
    // A second held wake at t=90 coalesces in; heldSince must stay 10, not jump.
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held2" }, nowMs: 90 }).state;
    expect(s.agents.a.heldSince).toBe(10);
    expect(s.agents.a.inbox.length).toBe(2);
    // At t=115 the oldest strand is 105ms (>=100) → fire, even though the newest
    // wake is only 25ms old. Both held messages drain together.
    const r = reduceManager(s, { type: "tick", nowMs: 115 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held\nheld2", mode: "idle" }]);
    expect(r.state.agents.a.heldSince).toBeNull();
  });

  it("re-delivers (does not kill) BEFORE stalled would escalate — gentle-first ordering", () => {
    // Both stranded (L2) and stalled key on running+turnActive+gated+inbox>0;
    // with a small stale threshold too, L2 must win by running first + continue.
    let s = createInitialManagerState(100, 300_000, 120_000, 100); // staleMs==strandedMs==100
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 10 }).state;
    const r = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "idle" }]);
    expect(r.effects.some((e) => e.type === "terminate_stalled")).toBe(false);
  });

  it("does NOT re-deliver when the process reports a turn genuinely in flight (apm.phase not idle)", () => {
    let s = toStrandedWedge();
    // A tool_call moves apm.phase off idle — the process IS mid-work, so holding
    // is correct and a raw send could collide. L2 must not fire.
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "tool_call", nowMs: 20 }).state;
    expect(s.agents.a.apm.phase).not.toBe("idle");
    expect(reduceManager(s, { type: "tick", nowMs: 200 }).effects).toEqual([]);
  });

  it("clears heldSince on a normal onTurnEnd redeliver so no stale strand lingers", () => {
    let s = toStrandedWedge();
    expect(s.agents.a.heldSince).toBe(10);
    // The lost turn_end finally arrives (or a real one does): onTurnEnd drains
    // the held inbox itself → heldSince must clear, so L2 won't double-fire.
    const r = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 30 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "idle" }]);
    expect(r.state.agents.a.heldSince).toBeNull();
  });

  it("UPGRADE CHAIN: a re-deliver that STILL gets no response escalates to suspectedDeaf (why L2 needs no kill branch)", () => {
    // strandedMs=100, staleMs=100: L2 re-delivers first (gentle), and if the
    // process is genuinely deaf the re-deliver's stamped lastDeliverAt arms
    // suspectedDeaf, which terminates+respawns after the stale window.
    let s = createInitialManagerState(100, 300_000, 120_000, 100);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "held" }, nowMs: 10 }).state;
    // t=200: L2 re-delivers (gentle send, no kill), stamps lastDeliverAt=200.
    const r1 = reduceManager(s, { type: "tick", nowMs: 200 });
    expect(r1.effects).toEqual([{ type: "send", agentId: "a", text: "held", mode: "idle" }]);
    s = r1.state;
    expect(s.agents.a.lastDeliverAt).toBe(200);
    // The process never answers the re-deliver → no progress after 200. At
    // t=400 (>=100 past the deliver) suspectedDeaf fires: NOW it's a kill.
    const r2 = reduceManager(s, { type: "tick", nowMs: 400 });
    expect(r2.effects).toEqual([{ type: "terminate_stalled", agentId: "a" }]);
    expect(r2.state.agents.a.status).toBe("stopping");
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
    expect(r.effects).toEqual([{ type: "spawn", agentId: "a", prompt: "rewake", resumeSessionId: null }]);
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
    expect(r.effects).toEqual([{ type: "spawn", agentId: "a", prompt: "REWAKE\nunread", resumeSessionId: null }]);
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

  it("onExit resets apm — a dead process's `compacting` flag doesn't leak into the respawn", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state;
    // Enter compaction, then queue mid-turn work.
    s = reduceManager(s, { type: "runtime_signal", agentId: "a", kind: "compaction_started", nowMs: 3 }).state;
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 4 }).state;
    expect(s.agents.a.apm.compacting).toBe(true);
    expect(s.agents.a.apm.phase).toBe("compacting");
    expect(s.agents.a.inbox.length).toBe(1);

    // Stall-recovery kill → exit. Respawn should start with a fresh apm.
    const r = reduceManager(s, { type: "exit", agentId: "a" });
    expect(r.effects[0]).toMatchObject({ type: "spawn", agentId: "a" });
    expect(r.state.agents.a.apm.compacting).toBe(false);
    expect(r.state.agents.a.apm.phase).toBe("idle");
    expect(r.state.agents.a.apm.outstandingToolUses).toBe(0);
  });
});

describe("isActivelyWorking — single source of truth for the profile pill", () => {
  function agentWith(fields: { status: AgentStatus; turnActive: boolean; inbox: number }): AgentState {
    return {
      agentId: "a",
      status: fields.status,
      caps: PERSISTENT_GATED,
      inbox: Array.from({ length: fields.inbox }, (_, i) => ({ seq: i, text: "m" })),
      sessionId: null,
      turnActive: fields.turnActive,
      lastProgressAt: 0,
      idleSince: null,
      resetting: false,
      apm: createInitialApmGatedSteeringState(),
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

import { describe, it, expect } from "vitest";
import {
  reduceManager,
  createInitialManagerState,
  type ManagerState,
  type AgentRuntimeCaps,
} from "./managerPolicy";

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

  it("idle timeout of 0 disables hibernation", () => {
    let s = createInitialManagerState(100_000, 0);
    s = register(s, "a", PERSISTENT_GATED);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 0 }).state;
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });
});

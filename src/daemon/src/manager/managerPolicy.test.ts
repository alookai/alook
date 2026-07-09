import { describe, it, expect } from "vitest";
import {
  reduceManager,
  createInitialManagerState,
  type ManagerState,
  type AgentRuntimeCaps,
} from "./managerPolicy";

const PERSISTENT_STEERABLE: AgentRuntimeCaps = {
  lifecycleKind: "persistent",
  supportsStdinNotification: true,
  busyDeliveryMode: "gated",
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
    s = register(s, "a", PERSISTENT_STEERABLE);

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
  it("wake while running+turnActive steers as busy", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_STEERABLE);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 1 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 2 }).state; // running, turnActive

    const r = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m2" }, nowMs: 3 });
    expect(r.effects).toEqual([{ type: "send", agentId: "a", text: "m2", mode: "busy" }]);
  });
});

describe("reduceManager — turn_end behavior", () => {
  it("persistent with queued messages delivers them as a fresh idle turn", () => {
    let s = createInitialManagerState();
    s = register(s, "a", PERSISTENT_STEERABLE);
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
    s = register(s, "a", PERSISTENT_STEERABLE);
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
    s = register(s, "a", PERSISTENT_STEERABLE);
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
    s = register(s, "a", PERSISTENT_STEERABLE);
    s = reduceManager(s, { type: "wake", agentId: "a", message: { text: "m1" }, nowMs: 0 }).state;
    s = reduceManager(s, { type: "spawned", agentId: "a", nowMs: 0 }).state;
    s = reduceManager(s, { type: "turn_end", agentId: "a", nowMs: 0 }).state;
    expect(reduceManager(s, { type: "tick", nowMs: 10_000 }).effects).toEqual([]);
  });
});

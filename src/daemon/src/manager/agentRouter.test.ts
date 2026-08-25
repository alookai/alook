import { describe, it, expect } from "vitest";
import { AgentRouter, UnknownRuntimeError, UnknownBotError } from "./agentRouter";
import type { AgentProcessManager } from "./managerRuntime";
import type { HostControlChannel, HostCommand, SessionErrorFrame } from "../server/contract";
import type { Logger } from "../logger";

/** Stub logger — records calls per level for assertions. */
function stubLogger(): Logger & { calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> } {
  const calls: Record<"debug" | "info" | "warn" | "error", Array<[string, unknown[]]>> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const logger = {
    calls,
    debug: (m: string, ...d: unknown[]) => calls.debug.push([m, d]),
    info: (m: string, ...d: unknown[]) => calls.info.push([m, d]),
    warn: (m: string, ...d: unknown[]) => calls.warn.push([m, d]),
    error: (m: string, ...d: unknown[]) => calls.error.push([m, d]),
    child: () => logger,
  };
  return logger;
}

/**
 * Fake manager recording deliver/register; enough for router behavior tests.
 * `deliverReturns` controls the boolean `deliver` reports (whether the wake
 * produced an executable effect) — leave undefined to mimic a legacy void
 * `deliver`, which must NOT trigger the honest-ack diagnostic.
 */
function fakeManager(
  initialStatuses: Record<string, "idle" | "starting" | "running" | "stopping"> = {},
  deliverReturns?: boolean,
) {
  const delivers: Array<{ agentId: string; id?: string; text: string; seq?: number }> = [];
  const registers: Array<{ agentId: string; sessionId?: string; launchId?: string }> = [];
  const forgets: string[] = [];
  const resets: Array<{ agentId: string; rewakePrompt: string; launchId: string; barrierType?: string }> = [];
  const switches: Array<{ agentId: string; rewakePrompt: string; launchId: string }> = [];
  const order: string[] = [];
  const statuses: Record<string, "idle" | "starting" | "running" | "stopping"> = { ...initialStatuses };
  const mgr = {
    register(agentId: string, launch?: { sessionId?: string; launchId?: string }) {
      registers.push({ agentId, sessionId: launch?.sessionId, launchId: launch?.launchId });
      order.push(`register:${agentId}`);
    },
    deliver(agentId: string, m: { id?: string; seq?: number; text: string }) {
      delivers.push({ agentId, id: m.id, text: m.text, seq: m.seq });
      order.push(`deliver:${agentId}`);
      return deliverReturns;
    },
    forgetSession(agentId: string) {
      forgets.push(agentId);
      order.push(`forget:${agentId}`);
    },
    async resetSession(agentId: string, opts: { launchId: string; rewakePrompt: string; barrierType?: string }) {
      resets.push({ agentId, rewakePrompt: opts.rewakePrompt, launchId: opts.launchId, barrierType: opts.barrierType });
      order.push(`reset:${agentId}`);
    },
    async switchModel(agentId: string, opts: { launchId: string; rewakePrompt: string }) {
      switches.push({ agentId, rewakePrompt: opts.rewakePrompt, launchId: opts.launchId });
      order.push(`switch:${agentId}`);
    },
    stop() {},
    liveSessionReports: () => [],
    snapshot() {
      const agents: Record<string, { status: string }> = {};
      for (const [id, status] of Object.entries(statuses)) agents[id] = { status };
      return { agents };
    },
  } as unknown as AgentProcessManager;
  return { mgr, delivers, registers, statuses, forgets, resets, switches, order };
}

/** Fake channel capturing acks + the command handler the router registers. */
function fakeChannel() {
  let handler: ((c: HostCommand) => void | Promise<void>) | null = null;
  const wakeAcks: Array<{ agentId: string; launchId: string; status: string }> = [];
  const readys: Array<Parameters<HostControlChannel["reportReady"]>[0]> = [];
  const sessionErrors: SessionErrorFrame[] = [];
  const typings: Array<{ agentId: string; channelId: string }> = [];
  const ch: HostControlChannel = {
    onCommand(cb) {
      handler = cb;
    },
    async reportReady(ready) {
      readys.push(ready);
    },
    async reportAgentSession() {},
    async reportWakeAck(info) {
      wakeAcks.push({ agentId: info.agentId, launchId: info.launchId, status: info.status });
    },
    async reportSessionError(frame) {
      sessionErrors.push(frame);
    },
    reportAgentTyping(info) {
      typings.push(info);
    },
    onResync() {},
  };
  return { ch, wakeAcks, readys, sessionErrors, typings, fire: (c: HostCommand) => handler?.(c) };
}

describe("AgentRouter — agent:wake", () => {
  it("registers the runtime config, delivers a generic notice, and acks the wake", async () => {
    const { mgr, delivers, registers } = fakeManager();
    const { ch, wakeAcks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    });

    expect(registers).toEqual([{ agentId: "a1", sessionId: undefined, launchId: "l1" }]);
    expect(delivers).toEqual([{
      agentId: "a1",
      id: "a1:wake:/demo#1234/general:7:admission:1",
      text: "You have unread messages.",
      seq: 7,
    }]);
    expect(wakeAcks).toEqual([{ agentId: "a1", launchId: "l1", status: "ok" }]);
  });

  it("uses a custom formatUnreadNoticeText when provided", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, fire } = fakeChannel();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      formatUnreadNoticeText: (notice) => `custom: ${notice.channel}#${notice.latestSeq}`,
    });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    });

    expect(delivers).toEqual([{
      agentId: "a1",
      id: "a1:wake:/demo#1234/general:7:admission:1",
      text: "custom: /demo#1234/general#7",
      seq: 7,
    }]);
  });

  it("gives each admitted replay of the same semantic wake a distinct driver command id", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, wakeAcks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    const wake: HostCommand = {
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    };
    await fire(wake);
    await fire(wake);

    expect(delivers.map((delivery) => delivery.id)).toEqual([
      "a1:wake:/demo#1234/general:7:admission:1",
      "a1:wake:/demo#1234/general:7:admission:2",
    ]);
    expect(wakeAcks.length).toBe(2);
  });

  const NO_EFFECT_DIAG = "agent:wake produced no effect (coalesced onto running agent)";

  it("logs an honest-ack diagnostic when a no-effect wake lands on a running agent, keeping the wire ack ok", async () => {
    const { mgr } = fakeManager({ a1: "running" }, false);
    const { ch, wakeAcks, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    });

    // Diagnostic surfaced (batch B), but the wire ack is still ok — reachability
    // honesty is batch D, this router only reports the local "no effect" fact.
    expect(logger.calls.info.some(([m]) => m === NO_EFFECT_DIAG)).toBe(true);
    expect(wakeAcks).toEqual([{ agentId: "a1", launchId: "l1", status: "ok" }]);
  });

  it("does NOT log the diagnostic when deliver produced an effect", async () => {
    const { mgr } = fakeManager({ a1: "idle" }, true);
    const { ch, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    });

    expect(logger.calls.info.some(([m]) => m === NO_EFFECT_DIAG)).toBe(false);
  });

  it("does NOT log the diagnostic for a benign no-effect coalesce on a non-running agent (starting)", async () => {
    // A no-effect wake while starting/stopping/reset-window is routine
    // queue-and-drain, not the deaf-orphan fault — must stay quiet (batch A
    // narrowing per Claudette's gate observation).
    const { mgr } = fakeManager({ a1: "starting" }, false);
    const { ch, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    });

    expect(logger.calls.info.some(([m]) => m === NO_EFFECT_DIAG)).toBe(false);
  });
});

describe("AgentRouter — agent:reset", () => {
  const CFG = { version: 1 as const, runtime: "mock", model: { kind: "default" as const }, mode: { kind: "default" as const } };

  it("calls onBeforeAgent then manager.resetSession exactly once with a rewake prompt, adds to running set", async () => {
    const { mgr, resets, order } = fakeManager();
    const { ch, fire } = fakeChannel();
    const beforeCalls: string[] = [];
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      onBeforeAgent: async (id) => { beforeCalls.push(id); order.push(`before:${id}`); },
    });
    await router.start();

    await fire({ type: "agent:reset", agentId: "a1", config: CFG, launchId: "l1" });

    expect(beforeCalls).toEqual(["a1"]);
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ agentId: "a1", launchId: "l1" });
    expect(resets[0].rewakePrompt.length).toBeGreaterThan(0);
    expect(resets[0].rewakePrompt).not.toContain("todo.md");
    expect(resets[0].rewakePrompt).toContain("$ALOOK_CLI message mark list");
    // Ordering: onBeforeAgent completes before resetSession fires.
    expect(order[0]).toBe("before:a1");
    expect(order[1]).toBe("reset:a1");
    expect(router.buildReady().runningAgents).toContain("a1");
  });

  it("a generic thrown error from resetSession is logged, sends an error ack, doesn't crash, and does NOT add to running set", async () => {
    const mgr = {
      resetSession: async () => { throw new Error("boom"); },
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, wakeAcks, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger });
    await router.start();

    await fire({ type: "agent:reset", agentId: "a1", config: CFG, launchId: "l1" });
    expect(router.buildReady().runningAgents).not.toContain("a1");
    expect(logger.calls.warn.some(([m]) => m === "agent:reset failed")).toBe(true);
    // The web gets a negative signal, not just a daemon log line.
    expect(wakeAcks).toContainEqual({ agentId: "a1", launchId: "l1", status: "error" });
  });

  it("UnknownRuntimeError from resetSession → forwards session.error{runtime_not_available}, running set untouched", async () => {
    const throwing = new UnknownRuntimeError("unknown-runtime", ["claude", "codex"]);
    const mgr = {
      resetSession: async () => { throw throwing; },
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, sessionErrors, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "claude" }, { id: "codex" }] });
    await router.start();

    await fire({
      type: "agent:reset",
      agentId: "a1",
      config: { ...CFG, runtime: "unknown-runtime" },
      launchId: "l1",
    });
    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]).toMatchObject({
      type: "session.error",
      code: "runtime_not_available",
      agentId: "a1",
      payload: { requested: "unknown-runtime", available: ["claude", "codex"] },
    });
    expect(router.buildReady().runningAgents).not.toContain("a1");
  });
});

describe("AgentRouter — machine:reset_all (batch reset)", () => {
  const CFG = { version: 1 as const, runtime: "mock", model: { kind: "default" as const }, mode: { kind: "default" as const } };

  it("loops resetSession over every entry in the resets array (all agents reset, in order)", async () => {
    const { mgr, resets, order } = fakeManager();
    const { ch, fire } = fakeChannel();
    const before: string[] = [];
    const router = new AgentRouter({
      manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }],
      onBeforeAgent: async (id) => { before.push(id); },
    });
    await router.start();

    await fire({ type: "machine:reset_all", resets: [
      { agentId: "a1", config: CFG, launchId: "l1" },
      { agentId: "a2", config: CFG, launchId: "l2" },
      { agentId: "a3", config: CFG, launchId: "l3" },
    ] });

    // Every entry reset, once each; onBeforeAgent ran for each (gate inherited).
    expect(resets.map((r) => r.agentId)).toEqual(["a1", "a2", "a3"]);
    expect(before).toEqual(["a1", "a2", "a3"]);
    // Each agent's before precedes its reset (same orchestration as single reset).
    expect(order.indexOf("reset:a2")).toBeGreaterThan(order.indexOf("reset:a1"));
    expect(router.buildReady().runningAgents).toEqual(expect.arrayContaining(["a1", "a2", "a3"]));
  });

  it("a foreign/unknown agentId (onBeforeAgent throws) is NOT reset, but the batch continues (per-entry independence + inherited ownership gate)", async () => {
    const { mgr, resets } = fakeManager();
    const { ch, wakeAcks, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({
      manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger,
      // Mirror createDaemon's onBeforeAgent botsById gate: a2 is not bound here.
      onBeforeAgent: async (id) => { if (id === "a2") throw new UnknownBotError(id); },
    });
    await router.start();

    await fire({ type: "machine:reset_all", resets: [
      { agentId: "a1", config: CFG, launchId: "l1" },
      { agentId: "a2", config: CFG, launchId: "l2" }, // foreign → gated
      { agentId: "a3", config: CFG, launchId: "l3" },
    ] });

    // a2 gated out (never reset); a1 + a3 reset — one bad entry doesn't abort batch.
    expect(resets.map((r) => r.agentId)).toEqual(["a1", "a3"]);
    // a2 gets a negative ack (bot_unknown), not silent.
    expect(wakeAcks).toContainEqual(expect.objectContaining({ agentId: "a2", status: "error" }));
    expect(router.buildReady().runningAgents).not.toContain("a2");
  });

  it("one entry's resetSession throwing doesn't abort the rest (per-entry try/catch)", async () => {
    const resets: string[] = [];
    const mgr = {
      resetSession: async (agentId: string) => {
        if (agentId === "a2") throw new Error("boom");
        resets.push(agentId);
      },
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, wakeAcks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger: stubLogger() });
    await router.start();

    await fire({ type: "machine:reset_all", resets: [
      { agentId: "a1", config: CFG, launchId: "l1" },
      { agentId: "a2", config: CFG, launchId: "l2" }, // throws
      { agentId: "a3", config: CFG, launchId: "l3" },
    ] });

    expect(resets).toEqual(["a1", "a3"]); // a2 failed, a1 + a3 still ran
    expect(wakeAcks).toContainEqual(expect.objectContaining({ agentId: "a2", status: "error" }));
  });
});

describe("AgentRouter — agent:nap", () => {
  const CFG = { version: 1 as const, runtime: "mock", model: { kind: "default" as const }, mode: { kind: "default" as const } };

  it("onBeforeAgent then resetSession with the handoff spliced into the rewake prompt + nap barrier, adds to running", async () => {
    const { mgr, resets, order } = fakeManager();
    const { ch, fire } = fakeChannel();
    const beforeCalls: string[] = [];
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      onBeforeAgent: async (id) => { beforeCalls.push(id); order.push(`before:${id}`); },
    });
    await router.start();

    const handoff = "  Was mid-review of PR #42; next: run the QA suite.  \n";
    await fire({ type: "agent:nap", agentId: "a1", config: CFG, launchId: "l1", handoff });

    expect(beforeCalls).toEqual(["a1"]);
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({ agentId: "a1", launchId: "l1", barrierType: "nap" });
    // The agent's own handoff is carried inline in the rewake prompt (not a file, not a message).
    expect(resets[0].rewakePrompt).toContain(handoff);
    expect(resets[0].rewakePrompt).not.toContain("todo.md");
    expect(resets[0].rewakePrompt).toContain("$ALOOK_CLI message mark list");
    expect(order[0]).toBe("before:a1");
    expect(order[1]).toBe("reset:a1");
    expect(router.buildReady().runningAgents).toContain("a1");
  });
});

describe("AgentRouter — agent:model_switch", () => {
  const CFG = {
    version: 1 as const,
    runtime: "mock",
    model: { kind: "named" as const, name: "opus" },
    mode: { kind: "default" as const },
  };

  it("calls onBeforeAgent BEFORE switchModel, with the pushed config, launchId, and the model-switch rewake prompt", async () => {
    const { mgr, switches, order } = fakeManager();
    const { ch, fire } = fakeChannel();
    const beforeCalls: string[] = [];
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      onBeforeAgent: async (id) => { beforeCalls.push(id); order.push(`before:${id}`); },
    });
    await router.start();

    await fire({ type: "agent:model_switch", agentId: "a1", config: CFG, launchId: "l1" });

    expect(beforeCalls).toEqual(["a1"]);
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ agentId: "a1", launchId: "l1" });
    expect(switches[0].rewakePrompt).toBe("You were just switched to a different model. Continue any unfinished work.");
    // Enroll gate: onBeforeAgent completes before switchModel fires.
    expect(order[0]).toBe("before:a1");
    expect(order[1]).toBe("switch:a1");
    expect(router.buildReady().runningAgents).toContain("a1");
  });

  it("UnknownRuntimeError → session.error{runtime_not_available}; generic error → warn, running set untouched", async () => {
    const throwing = new UnknownRuntimeError("unknown-runtime", ["claude", "codex"]);
    const mgrUnknown = {
      switchModel: async () => { throw throwing; },
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, sessionErrors, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgrUnknown, channel: ch, runtimeReport: [{ id: "claude" }, { id: "codex" }] });
    await router.start();
    await fire({ type: "agent:model_switch", agentId: "a1", config: { ...CFG, runtime: "unknown-runtime" }, launchId: "l1" });
    expect(sessionErrors).toHaveLength(1);
    expect(sessionErrors[0]).toMatchObject({ type: "session.error", code: "runtime_not_available", agentId: "a1" });
    expect(router.buildReady().runningAgents).not.toContain("a1");

    const mgrGeneric = {
      switchModel: async () => { throw new Error("boom"); },
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch: ch2, wakeAcks: wakeAcks2, fire: fire2 } = fakeChannel();
    const logger = stubLogger();
    const router2 = new AgentRouter({ manager: mgrGeneric, channel: ch2, runtimeReport: [{ id: "mock" }], logger });
    await router2.start();
    await fire2({ type: "agent:model_switch", agentId: "a2", config: CFG, launchId: "l1" });
    expect(logger.calls.warn.some(([m]) => m === "agent:model_switch failed")).toBe(true);
    expect(router2.buildReady().runningAgents).not.toContain("a2");
    // The web gets a negative signal, not just a daemon log line.
    expect(wakeAcks2).toContainEqual({ agentId: "a2", launchId: "l1", status: "error" });
  });
});

// B2 convergence: the RESTART-FAMILY commands (reset / nap / model_switch) all
// route through the shared `runRestartCommand` handler. This pins that every
// restart-family command is handled (none silently missing an arm) AND handled
// via the shared path (enroll → manager call → running-set add + ready resend).
// SCOPE: restart family ONLY — `agent:wake` and `agent:stop` are deliberately
// NOT in this set (they have materially different shapes: wake's typing/DM
// tracking + bot_runtime_missing acks; stop's reportStoppedAck + no enroll), so
// this is NOT an "all agent:* commands" completeness check. New restart-family
// commands are O(1) (add a case delegating to runRestartCommand); a new
// structurally-different command still writes its own arm.
describe("AgentRouter — restart-family command dispatch (B2 table)", () => {
  const CFG = { version: 1 as const, runtime: "mock", model: { kind: "default" as const }, mode: { kind: "default" as const } };

  const RESTART_CMDS = [
    { type: "agent:reset" as const, extra: {} },
    { type: "agent:nap" as const, extra: { handoff: "did X; next Y" } },
    { type: "agent:model_switch" as const, extra: {} },
  ];

  for (const { type, extra } of RESTART_CMDS) {
    it(`${type} routes through the shared handler: onBeforeAgent → manager call → running-set add`, async () => {
      const { mgr, order } = fakeManager();
      const { ch, fire } = fakeChannel();
      const before: string[] = [];
      const router = new AgentRouter({
        manager: mgr,
        channel: ch,
        runtimeReport: [{ id: "mock" }],
        onBeforeAgent: async (id) => { before.push(id); order.push(`before:${id}`); },
      });
      await router.start();

      await fire({ type, agentId: "a1", config: CFG, launchId: "l1", ...extra } as never);

      // Shared-handler invariants, identical across all three restart commands:
      expect(before).toEqual(["a1"]);            // enroll ran
      expect(order[0]).toBe("before:a1");        // enroll BEFORE the manager call
      expect(router.buildReady().runningAgents).toContain("a1"); // joined running-set on success
    });
  }
});

describe("AgentRouter — unknown runtime → session.error", () => {
  it("catches UnknownRuntimeError from driverFor and forwards session.error{runtime_not_available}", async () => {
    // Manager whose register() re-throws whatever driverFor throws — mimics
    // the real AgentProcessManager which calls opts.driverFor eagerly.
    const throwing: UnknownRuntimeError = new UnknownRuntimeError("unknown-runtime", ["claude", "codex"]);
    const mgr = {
      register() {
        throw throwing;
      },
      deliver() {},
      stop() {},
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, sessionErrors, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "claude" }, { id: "codex" }] });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "unknown-runtime", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
    });

    expect(sessionErrors.length).toBe(1);
    expect(sessionErrors[0]).toMatchObject({
      type: "session.error",
      code: "runtime_not_available",
      agentId: "a1",
      payload: { requested: "unknown-runtime", available: ["claude", "codex"] },
    });
  });
});

describe("AgentRouter — buildReady runtimeReport", () => {
  it("emits runtimeReport when provided", async () => {
    const { mgr } = fakeManager();
    const { ch, readys } = fakeChannel();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [
        { id: "claude", version: "1.0.42" },
        { id: "codex", version: "0.8.1" },
      ],
    });
    await router.start();
    expect(readys[0]).toMatchObject({
      runtimeReport: [
        { id: "claude", version: "1.0.42" },
        { id: "codex", version: "0.8.1" },
      ],
    });
  });

  it("passes runtimeReport through with only bare ids", async () => {
    const { mgr } = fakeManager();
    const { ch, readys } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "claude" }] });
    await router.start();
    expect(readys[0]).toMatchObject({ runtimeReport: [{ id: "claude" }] });
  });
});

// ---------------------------------------------------------------------------
// Runtime health — mutable map, coalesced sendReady, short-circuit dispatch
// ---------------------------------------------------------------------------

function fakeChannelWithSendReady() {
  const base = fakeChannel();
  const readyResends: Array<Parameters<HostControlChannel["reportReady"]>[0]> = [];
  (base.ch as HostControlChannel).sendReady = (ready) => {
    readyResends.push(ready);
  };
  return { ...base, readyResends };
}

describe("AgentRouter — runtime health map", () => {
  it("seeds the map from constructor runtimeReport with defaulted status='healthy'", () => {
    const { mgr } = fakeManager();
    const { ch } = fakeChannel();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "codex" }, { id: "claude", version: "1.0.0" }],
    });
    expect(router.isRuntimeHealthy("codex")).toBe(true);
    expect(router.isRuntimeHealthy("claude")).toBe(true);
    expect(router.healthyRuntimeIds()).toEqual(["codex", "claude"]);
  });

  it("markRuntimeUnhealthy flips the map entry AND schedules exactly one sendReady per tick", () => {
    const { mgr } = fakeManager();
    const { ch, readyResends } = fakeChannelWithSendReady();
    const scheduled: Array<() => void> = [];
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "codex" }, { id: "claude" }],
      scheduleReadyResend: (fn) => {
        scheduled.push(fn);
      },
    });
    // 3 mutations in the same tick — different ids AND repeat id.
    router.markRuntimeUnhealthy("codex", "ENOENT");
    router.markRuntimeUnhealthy("claude", "ENOENT");
    router.markRuntimeUnhealthy("codex", "ENOENT"); // repeat — idempotent, no new resend
    // Coalescer scheduled exactly ONE resend regardless of how many mutations fired.
    expect(scheduled).toHaveLength(1);
    // Flush the pending microtask.
    scheduled[0]!();
    expect(readyResends).toHaveLength(1);
    const emitted = readyResends[0]!.runtimeReport;
    expect(emitted.find((r) => r.id === "codex")?.status).toBe("unhealthy");
    expect(emitted.find((r) => r.id === "codex")?.lastError).toBe("ENOENT");
    expect(emitted.find((r) => r.id === "claude")?.status).toBe("unhealthy");
    // After the flush, the next mutation batches again.
    router.markRuntimeUnhealthy("codex", "different_reason");
    expect(scheduled).toHaveLength(2);
  });

  it.each(["handshake_timeout", "pre_handshake_exit", "spawn_threw", "other"])(
    "keeps the runtime retryable after the transient spawn failure %s",
    (reason) => {
      const { mgr } = fakeManager();
      const { ch } = fakeChannel();
      const scheduled: Array<() => void> = [];
      const router = new AgentRouter({
        manager: mgr,
        channel: ch,
        runtimeReport: [{ id: "cursor" }],
        scheduleReadyResend: (fn) => scheduled.push(fn),
      });

      router.recordRuntimeSpawnFailure("cursor", reason);

      expect(router.isRuntimeHealthy("cursor")).toBe(true);
      expect(router.healthyRuntimeIds()).toEqual(["cursor"]);
      expect(scheduled).toHaveLength(0);
    },
  );

  it.each(["ENOENT", "EACCES", "ENOEXEC", "EPERM"])(
    "marks the runtime globally unhealthy after the definitive executable failure %s",
    (reason) => {
      const { mgr } = fakeManager();
      const { ch } = fakeChannel();
      const router = new AgentRouter({
        manager: mgr,
        channel: ch,
        runtimeReport: [{ id: "cursor" }],
        scheduleReadyResend: (fn) => fn(),
      });

      router.recordRuntimeSpawnFailure("cursor", reason);

      expect(router.isRuntimeHealthy("cursor")).toBe(false);
      expect(router.buildReady().runtimeReport).toEqual([
        expect.objectContaining({ id: "cursor", status: "unhealthy", lastError: reason }),
      ]);
    },
  );

  it("markRuntimeHealthy clears lastError/lastErrorAt when flipping back", () => {
    const { mgr } = fakeManager();
    const { ch, readyResends } = fakeChannelWithSendReady();
    let flush: (() => void) | null = null;
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "codex" }],
      scheduleReadyResend: (fn) => {
        flush = fn;
      },
    });
    router.markRuntimeUnhealthy("codex", "ENOENT");
    flush!();
    router.markRuntimeHealthy("codex");
    flush!();
    const emitted = readyResends[1]!.runtimeReport;
    const codex = emitted.find((r) => r.id === "codex");
    expect(codex?.status).toBe("healthy");
    expect(codex?.lastError).toBeUndefined();
    expect(codex?.lastErrorAt).toBeUndefined();
  });

  it("silently no-ops on unknown ids — no map insertion, no scheduled resend", () => {
    const { mgr } = fakeManager();
    const { ch } = fakeChannel();
    const scheduled: Array<() => void> = [];
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "codex" }],
      scheduleReadyResend: (fn) => scheduled.push(fn),
    });
    router.markRuntimeUnhealthy("does-not-exist", "ENOENT");
    router.markRuntimeHealthy("does-not-exist");
    expect(scheduled).toHaveLength(0);
    expect(router.isRuntimeHealthy("does-not-exist")).toBe(false);
    // "codex" untouched.
    expect(router.isRuntimeHealthy("codex")).toBe(true);
  });

  it("healthyRuntimeIds filters out unhealthy runtimes; buildReady still ships the FULL list (unhealthy included) for the wire", () => {
    const { mgr } = fakeManager();
    const { ch } = fakeChannel();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "codex" }, { id: "claude" }, { id: "cursor" }],
      scheduleReadyResend: (fn) => fn(),
    });
    router.markRuntimeUnhealthy("cursor", "ENOENT");
    expect(router.healthyRuntimeIds()).toEqual(["codex", "claude"]);
    // buildReady MUST include all three so the DO/canonical-diff sees the
    // unhealthy transition. A future "clean up the wire" refactor that strips
    // unhealthy entries would silently regress the /community picker gating.
    const ready = router.buildReady();
    expect(ready.runtimeReport.map((r) => r.id)).toEqual([
      "codex",
      "claude",
      "cursor",
    ]);
    const cursor = ready.runtimeReport.find((r) => r.id === "cursor");
    expect(cursor?.status).toBe("unhealthy");
    expect(cursor?.lastError).toBe("ENOENT");
    expect(typeof cursor?.lastErrorAt).toBe("string");
  });

  it("survives a disconnected channel — health mutations don't throw when sendReady is absent", () => {
    const { mgr } = fakeManager();
    const chWithoutSendReady: HostControlChannel = {
      onCommand() {},
      async reportReady() {},
      async reportAgentSession() {},
    };
    const router = new AgentRouter({
      manager: mgr,
      channel: chWithoutSendReady,
      runtimeReport: [{ id: "codex" }],
      scheduleReadyResend: (fn) => fn(),
    });
    // Should not throw — sendReady is optional on the channel interface.
    expect(() => router.markRuntimeUnhealthy("codex", "ENOENT")).not.toThrow();
    // Map still mutated for the next resyncOnConnect to pick up.
    expect(router.isRuntimeHealthy("codex")).toBe(false);
  });
});

describe("AgentRouter — logging", () => {
  it("logs info when agent:wake is received, and info for the ack (ok status)", async () => {
    const { mgr } = fakeManager();
    const { ch, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 7 },
    });

    expect(
      logger.calls.info.some(
        ([m, d]) => m === "agent:wake received" && (d[0] as any).agentId === "a1" && (d[0] as any).channel === "/demo#1234/general",
      ),
    ).toBe(true);
    expect(logger.calls.info.some(([m, d]) => m === "agent:wake ack" && (d[0] as any).status === "ok")).toBe(true);
  });

  it("logs info for the ack with error status when the wake fails", async () => {
    const throwing: UnknownRuntimeError = new UnknownRuntimeError("unknown-runtime", ["claude"]);
    const mgr = {
      register() {
        throw throwing;
      },
      deliver() {},
      stop() {},
      liveSessionReports: () => [],
    } as unknown as AgentProcessManager;
    const { ch, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "claude" }], logger });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "unknown-runtime", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo#1234/general", latestSeq: 1 },
    });

    expect(logger.calls.info.some(([m, d]) => m === "agent:wake ack" && (d[0] as any).status === "error")).toBe(
      true,
    );
  });

  it("logs info on agent:stop received + ack", async () => {
    const { mgr } = fakeManager();
    const { ch, fire } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }], logger });
    await router.start();

    await fire({ type: "agent:stop", agentId: "a1" });

    expect(logger.calls.info.some(([m, d]) => m === "agent:stop received" && (d[0] as any).agentId === "a1")).toBe(
      true,
    );
    expect(logger.calls.info.some(([m, d]) => m === "agent:stop ack" && (d[0] as any).status === "ok")).toBe(true);
  });

  it("logs warn/info from markRuntimeUnhealthy/markRuntimeHealthy only on actual state changes", () => {
    const { mgr } = fakeManager();
    const { ch } = fakeChannel();
    const logger = stubLogger();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "codex" }],
      logger,
      scheduleReadyResend: (fn) => fn(),
    });

    router.markRuntimeUnhealthy("codex", "ENOENT");
    // Idempotent repeat — no new warn log.
    router.markRuntimeUnhealthy("codex", "ENOENT");
    expect(logger.calls.warn.filter(([m]) => m === "runtime marked unhealthy")).toHaveLength(1);

    router.markRuntimeHealthy("codex");
    router.markRuntimeHealthy("codex"); // idempotent — already healthy
    expect(logger.calls.info.filter(([m]) => m === "runtime marked healthy again")).toHaveLength(1);
  });
});

describe("AgentRouter — bot typing indicator", () => {
  function makeTracker() {
    const scopes = new Map<string, Set<string>>();
    return {
      add(agentId: string, dm: string) {
        let s = scopes.get(agentId);
        if (!s) { s = new Set(); scopes.set(agentId, s); }
        s.add(dm);
      },
      snapshot(agentId: string) {
        return [...(scopes.get(agentId) ?? [])];
      },
      hasAny(agentId: string) {
        return (scopes.get(agentId)?.size ?? 0) > 0;
      },
      clear(agentId: string) {
        scopes.delete(agentId);
      },
    };
  }

  it("first wake (unregistered → running): router does NOT emit typing (FSM owns first frame)", async () => {
    const { mgr } = fakeManager();
    const { ch, typings, fire } = fakeChannel();
    const tracker = makeTracker();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      typingTracker: tracker,
    });
    await router.start();
    await fire({
      type: "agent:wake",
      agentId: "bot_1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: {
        kind: "unread_notice",
        channel: "/.dm/peer#0042",
        latestSeq: 1,
        channelId: "dm_1",
      },
    });
    expect(typings).toEqual([]);
    expect(tracker.snapshot("bot_1")).toEqual(["dm_1"]);
  });

  it("mid-turn wake (beforeStatus=running AND wasActive=true): router emits ONCE for the newly-added scope", async () => {
    const { mgr, statuses } = fakeManager({ bot_1: "running" });
    const { ch, typings, fire } = fakeChannel();
    const tracker = makeTracker();
    tracker.add("bot_1", "dm_1"); // wasActive=true — bot already handling dm_1
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      typingTracker: tracker,
    });
    await router.start();
    // Sanity: statuses map preserved after start
    expect(statuses.bot_1).toBe("running");
    await fire({
      type: "agent:wake",
      agentId: "bot_1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l2",
      unreadNotice: {
        kind: "unread_notice",
        channel: "/.dm/peer2#0042",
        latestSeq: 3,
        channelId: "dm_2",
      },
    });
    expect(typings).toEqual([{ agentId: "bot_1", channelId: "dm_2" }]);
  });

  it("wake during stopping (beforeStatus=stopping): router does NOT emit — FSM will fire stopping→running", async () => {
    const { mgr } = fakeManager({ bot_1: "stopping" });
    const { ch, typings, fire } = fakeChannel();
    const tracker = makeTracker();
    tracker.add("bot_1", "dm_prev"); // wasActive=true (stale from prior turn)
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      typingTracker: tracker,
    });
    await router.start();
    await fire({
      type: "agent:wake",
      agentId: "bot_1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l3",
      unreadNotice: {
        kind: "unread_notice",
        channel: "/.dm/peer#0042",
        latestSeq: 4,
        channelId: "dm_1",
      },
    });
    expect(typings).toEqual([]);
  });

  it("wake without dmConversationId (channel/thread scope): tracker untouched, no typing frame", async () => {
    const { mgr } = fakeManager();
    const { ch, typings, fire } = fakeChannel();
    const tracker = makeTracker();
    const router = new AgentRouter({
      manager: mgr,
      channel: ch,
      runtimeReport: [{ id: "mock" }],
      typingTracker: tracker,
    });
    await router.start();
    await fire({
      type: "agent:wake",
      agentId: "bot_1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l4",
      unreadNotice: {
        kind: "unread_notice",
        channel: "/srv_1/general",
        latestSeq: 5,
      },
    });
    expect(typings).toEqual([]);
    expect(tracker.snapshot("bot_1")).toEqual([]);
    expect(tracker.hasAny("bot_1")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { AgentRouter, UnknownRuntimeError } from "./agentRouter";
import type { AgentProcessManager } from "./managerRuntime";
import type { HostControlChannel, HostCommand, Message, SessionErrorFrame } from "../server/contract";

function msg(seq: string, text: string): Message {
  return { seq, channel: "/demo/general", sender: "@gustavo", content: { text }, time: "t" };
}

/** Fake manager recording deliver/register; enough for router behavior tests. */
function fakeManager() {
  const delivers: Array<{ agentId: string; text: string }> = [];
  const mgr = {
    register() {},
    deliver(agentId: string, m: { seq: number; text: string }) {
      delivers.push({ agentId, text: m.text });
    },
    stop() {},
    liveSessionReports: () => [],
  } as unknown as AgentProcessManager;
  return { mgr, delivers };
}

/** Fake channel capturing acks + the command handler the router registers. */
function fakeChannel() {
  let handler: ((c: HostCommand) => void | Promise<void>) | null = null;
  const acks: string[] = [];
  const readys: Array<Parameters<HostControlChannel["reportReady"]>[0]> = [];
  const sessionErrors: SessionErrorFrame[] = [];
  const ch: HostControlChannel = {
    onCommand(cb) {
      handler = cb;
    },
    async reportReady(ready) {
      readys.push(ready);
    },
    async reportAgentSession() {},
    async reportDeliverAck(info) {
      acks.push(info.deliveryId);
    },
    async reportSessionError(frame) {
      sessionErrors.push(frame);
    },
    onResync() {},
  };
  return { ch, acks, readys, sessionErrors, fire: (c: HostCommand) => handler?.(c) };
}

describe("AgentRouter — at-least-once dedup", () => {
  it("acks every delivery, but only wakes the manager once per deliveryId", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, acks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    const deliver: HostCommand = { type: "agent:deliver", agentId: "a1", message: msg("#1", "hello"), deliveryId: "dlv_1" };
    await fire(deliver);
    await fire(deliver); // redelivery of the SAME id (e.g. after a reconnect)

    // Manager woken exactly once; both deliveries acked (so the server retires it).
    expect(delivers.length).toBe(1);
    expect(delivers[0]).toEqual({ agentId: "a1", text: "hello" });
    expect(acks).toEqual(["dlv_1", "dlv_1"]);
  });

  it("agent:start wake delivers + acks its deliveryId", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, acks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    await fire({
      type: "agent:start",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      wakeMessage: msg("#1", "wake"),
      deliveryId: "dlv_w",
      launchId: "l1",
    });
    expect(delivers).toEqual([{ agentId: "a1", text: "wake" }]);
    expect(acks).toEqual(["dlv_w"]);
  });
});

describe("AgentRouter — unknown runtime → session.error", () => {
  it("catches UnknownRuntimeError from driverFor and forwards session.error{runtime_not_available}", async () => {
    // Manager whose register() re-throws whatever driverFor throws — mimics
    // the real AgentProcessManager which calls opts.driverFor eagerly.
    const throwing: UnknownRuntimeError = new UnknownRuntimeError("gemini", ["claude", "codex"]);
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
      type: "agent:start",
      agentId: "a1",
      config: { version: 1, runtime: "gemini", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
    });

    expect(sessionErrors.length).toBe(1);
    expect(sessionErrors[0]).toMatchObject({
      type: "session.error",
      code: "runtime_not_available",
      agentId: "a1",
      payload: { requested: "gemini", available: ["claude", "codex"] },
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
      runtimeReport: [{ id: "codex" }, { id: "claude" }, { id: "gemini" }],
      scheduleReadyResend: (fn) => fn(),
    });
    router.markRuntimeUnhealthy("gemini", "ENOENT");
    expect(router.healthyRuntimeIds()).toEqual(["codex", "claude"]);
    // buildReady MUST include all three so the DO/canonical-diff sees the
    // unhealthy transition. A future "clean up the wire" refactor that strips
    // unhealthy entries would silently regress the /community picker gating.
    const ready = router.buildReady();
    expect(ready.runtimeReport.map((r) => r.id)).toEqual([
      "codex",
      "claude",
      "gemini",
    ]);
    const gemini = ready.runtimeReport.find((r) => r.id === "gemini");
    expect(gemini?.status).toBe("unhealthy");
    expect(gemini?.lastError).toBe("ENOENT");
    expect(typeof gemini?.lastErrorAt).toBe("string");
  });

  it("survives a disconnected channel — health mutations don't throw when sendReady is absent", () => {
    const { mgr } = fakeManager();
    const chWithoutSendReady: HostControlChannel = {
      onCommand() {},
      async reportReady() {},
      async reportAgentSession() {},
      async reportDeliverAck() {},
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

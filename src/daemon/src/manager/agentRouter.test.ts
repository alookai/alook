import { describe, it, expect } from "vitest";
import { AgentRouter, UnknownRuntimeError } from "./agentRouter";
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

/** Fake manager recording deliver/register; enough for router behavior tests. */
function fakeManager() {
  const delivers: Array<{ agentId: string; text: string; seq?: number }> = [];
  const registers: Array<{ agentId: string; sessionId?: string; launchId?: string }> = [];
  const mgr = {
    register(agentId: string, launch?: { sessionId?: string; launchId?: string }) {
      registers.push({ agentId, sessionId: launch?.sessionId, launchId: launch?.launchId });
    },
    deliver(agentId: string, m: { seq?: number; text: string }) {
      delivers.push({ agentId, text: m.text, seq: m.seq });
    },
    stop() {},
    liveSessionReports: () => [],
  } as unknown as AgentProcessManager;
  return { mgr, delivers, registers };
}

/** Fake channel capturing acks + the command handler the router registers. */
function fakeChannel() {
  let handler: ((c: HostCommand) => void | Promise<void>) | null = null;
  const wakeAcks: Array<{ agentId: string; launchId: string; status: string }> = [];
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
    async reportWakeAck(info) {
      wakeAcks.push({ agentId: info.agentId, launchId: info.launchId, status: info.status });
    },
    async reportSessionError(frame) {
      sessionErrors.push(frame);
    },
    onResync() {},
  };
  return { ch, wakeAcks, readys, sessionErrors, fire: (c: HostCommand) => handler?.(c) };
}

describe("AgentRouter — agent:wake", () => {
  it("registers the runtime config, delivers the notice text, and acks the wake", async () => {
    const { mgr, delivers, registers } = fakeManager();
    const { ch, wakeAcks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    await fire({
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 7 },
    });

    expect(registers).toEqual([{ agentId: "a1", sessionId: undefined, launchId: "l1" }]);
    expect(delivers).toEqual([{ agentId: "a1", text: "You have unread messages in channel /demo/general.", seq: 7 }]);
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
      unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 7 },
    });

    expect(delivers).toEqual([{ agentId: "a1", text: "custom: /demo/general#7", seq: 7 }]);
  });

  it("repeated agent:wake commands for the same agent each register + deliver again (no dedup — no deliveryId anymore)", async () => {
    const { mgr, delivers } = fakeManager();
    const { ch, wakeAcks, fire } = fakeChannel();
    const router = new AgentRouter({ manager: mgr, channel: ch, runtimeReport: [{ id: "mock" }] });
    await router.start();

    const wake: HostCommand = {
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "mock", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 7 },
    };
    await fire(wake);
    await fire(wake);

    expect(delivers.length).toBe(2);
    expect(wakeAcks.length).toBe(2);
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
      type: "agent:wake",
      agentId: "a1",
      config: { version: 1, runtime: "gemini", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
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
      unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 7 },
    });

    expect(
      logger.calls.info.some(
        ([m, d]) => m === "agent:wake received" && (d[0] as any).agentId === "a1" && (d[0] as any).channel === "/demo/general",
      ),
    ).toBe(true);
    expect(logger.calls.info.some(([m, d]) => m === "agent:wake ack" && (d[0] as any).status === "ok")).toBe(true);
  });

  it("logs info for the ack with error status when the wake fails", async () => {
    const throwing: UnknownRuntimeError = new UnknownRuntimeError("gemini", ["claude"]);
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
      config: { version: 1, runtime: "gemini", model: { kind: "default" }, mode: { kind: "default" } },
      launchId: "l1",
      unreadNotice: { kind: "unread_notice", channel: "/demo/general", latestSeq: 1 },
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

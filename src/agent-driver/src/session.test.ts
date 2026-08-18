import { describe, expect, it } from "vitest";
import { AgentDriverSessionController, verifyAgentDriverSessionContract, type AgentDriverClock } from "./index.js";

class ManualClock implements AgentDriverClock {
  private readonly scheduled = new Set<() => void>();
  now(): number {
    return 0;
  }
  schedule(_delayMs: number, callback: () => void): () => void {
    this.scheduled.add(callback);
    return () => this.scheduled.delete(callback);
  }
  elapse(): void {
    for (const callback of [...this.scheduled]) {
      this.scheduled.delete(callback);
      callback();
    }
  }
  get pendingCount(): number {
    return this.scheduled.size;
  }
}

describe("AgentDriverSessionController", () => {
  it("passes the reusable idempotent cleanup and listener-quiescence contract", async () => {
    const clock = new ManualClock();
    let signalCleanupStarted: (() => void) | undefined;
    const cleanupStarted = new Promise<void>((resolve) => {
      signalCleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const session = new AgentDriverSessionController({
      clock,
      defaultForceAfterMs: 1_000,
      sessionId: () => "session-1",
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: async () => {
        signalCleanupStarted?.();
        await cleanup;
      },
      forceCleanup: async () => undefined,
    });

    await verifyAgentDriverSessionContract({
      session,
      cleanupStarted,
      emitLateEvent: (event) => session.emit(event),
      releaseCleanup: () => releaseCleanup?.(),
    });
    expect(clock.pendingCount).toBe(0);
    await expect(session.deliver({ deliveryId: "late", text: "late", mode: "idle" })).resolves.toEqual({
      accepted: false,
      deliveryId: "late",
      reason: "closed",
    });
  });

  it("forces a hanging cleanup after the duration and reports the deadline outcome", async () => {
    const clock = new ManualClock();
    const forced: string[] = [];
    const session = new AgentDriverSessionController({
      clock,
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: () => new Promise(() => undefined),
      forceCleanup: async (reason) => {
        forced.push(reason);
      },
    });

    const closing = session.close();
    expect(session.closed).toBe(true);
    clock.elapse();
    await expect(closing).resolves.toEqual({ status: "closed", forced: true, forceReason: "deadline" });
    clock.elapse();
    expect(forced).toEqual(["deadline"]);
    expect(clock.pendingCount).toBe(0);
  });

  it("settles an in-flight hanging delivery as closed when cleanup starts", async () => {
    const clock = new ManualClock();
    let signalDeliveryStarted: (() => void) | undefined;
    const deliveryStarted = new Promise<void>((resolve) => {
      signalDeliveryStarted = resolve;
    });
    const session = new AgentDriverSessionController({
      clock,
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: () => {
        signalDeliveryStarted?.();
        return new Promise(() => undefined);
      },
      cleanup: async () => undefined,
      forceCleanup: async () => undefined,
    });

    const delivering = session.deliver({ deliveryId: "hanging", text: "hello", mode: "initial" });
    await deliveryStarted;
    const closing = session.close();
    await expect(delivering).resolves.toEqual({
      accepted: false,
      deliveryId: "hanging",
      reason: "closed",
    });
    await expect(closing).resolves.toEqual({ status: "closed", forced: false });
    expect(clock.pendingCount).toBe(0);
  });

  it("bounds cleanup for an invalid override before reporting a typed failure", async () => {
    const clock = new ManualClock();
    const forced: string[] = [];
    let cleanupCalls = 0;
    const session = new AgentDriverSessionController({
      clock,
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: () => {
        cleanupCalls++;
        return new Promise(() => undefined);
      },
      forceCleanup: async (reason) => {
        forced.push(reason);
      },
    });

    const closing = session.close({ forceAfterMs: Number.NaN });
    expect(session.closed).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(clock.pendingCount).toBe(1);
    clock.elapse();
    await expect(closing).resolves.toEqual({
      status: "failed",
      forced: true,
      message: "forceAfterMs must be a non-negative finite duration",
    });
    expect(forced).toEqual(["deadline"]);
    expect(clock.pendingCount).toBe(0);
  });

  it("reports requested force and graceful cleanup failure without rejecting close", async () => {
    const forced: string[] = [];
    const forcedSession = new AgentDriverSessionController({
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: async () => undefined,
      forceCleanup: async (reason) => {
        forced.push(reason);
      },
    });
    await expect(forcedSession.close({ force: true })).resolves.toEqual({
      status: "closed",
      forced: true,
      forceReason: "requested",
    });
    expect(forced).toEqual(["requested"]);

    const failedSession = new AgentDriverSessionController({
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: async () => {
        throw new Error("dispose failed");
      },
      forceCleanup: async () => undefined,
    });
    await expect(failedSession.close()).resolves.toEqual({
      status: "failed",
      forced: false,
      message: "dispose failed",
    });
  });

  it("turns a synchronous cleanup throw into one shared typed result and cancels the deadline", async () => {
    const clock = new ManualClock();
    const session = new AgentDriverSessionController({
      clock,
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: () => {
        throw new Error("synchronous dispose failure");
      },
      forceCleanup: async () => undefined,
    });

    const first = session.close();
    const second = session.close({ force: true });
    expect(second).toBe(first);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual({
      status: "failed",
      forced: false,
      message: "synchronous dispose failure",
    });
    expect(secondResult).toBe(firstResult);
    expect(clock.pendingCount).toBe(0);
  });

  it("preserves an invalid-option error and a requested-force failure", async () => {
    let forceCalls = 0;
    const session = new AgentDriverSessionController({
      clock: new ManualClock(),
      defaultForceAfterMs: 25,
      sessionId: () => null,
      deliver: async (prompt) => ({ accepted: true, deliveryId: prompt.deliveryId, delivery: "prompt" }),
      cleanup: async () => undefined,
      forceCleanup: async () => {
        forceCalls++;
        throw new Error("kill failed");
      },
    });

    await expect(session.close({ force: true, forceAfterMs: -1 })).resolves.toEqual({
      status: "failed",
      forced: true,
      message: "forceAfterMs must be a non-negative finite duration; forced cleanup failed: kill failed",
    });
    expect(forceCalls).toBe(1);
  });
});

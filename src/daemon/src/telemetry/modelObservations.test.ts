import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentModelReport } from "@alook/shared";
import { ModelObservationReporter } from "./modelObservations.js";

const report = (model: string): AgentModelReport => ({ agentId: "bot", backendId: "codex", sessionInstanceId: "epoch",
  model, source: "response", observedAt: "2026-11-17T02:00:00.000Z" });
afterEach(() => vi.useRealTimers());

describe("model observation side channel", () => {
  it("coalesces a burst off the reply stack and reads only the current owner when flushing", async () => {
    vi.useFakeTimers();
    let latest: AgentModelReport | undefined = report("one");
    const read = vi.fn(() => latest);
    const send = vi.fn(() => new Promise<void>(() => {}));
    const reporter = new ModelObservationReporter(read, send, vi.fn());
    for (let i = 0; i < 100; i++) reporter.schedule("bot");
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    latest = report("two");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledExactlyOnceWith(report("two"));
    reporter.schedule("bot");
    latest = report("three");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenLastCalledWith(report("three"));
    expect(send).toHaveBeenCalledTimes(2);
    reporter.schedule("bot");
    latest = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    reporter.stop();
  });

  it("isolates failed telemetry and clears pending timers at shutdown", async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const send = vi.fn(async () => { throw new Error("offline"); });
    const reporter = new ModelObservationReporter(() => report("model"), send, error);
    reporter.schedule("bot");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(error).toHaveBeenCalledOnce();
    reporter.schedule("bot");
    reporter.stop();
    reporter.schedule("bot");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

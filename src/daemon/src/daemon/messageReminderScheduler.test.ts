import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageReminderScheduler } from "./messageReminderScheduler";
import { localISOString } from "../util/localTime";

describe("MessageReminderScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("replaces one agent+scope reminder while keeping other scopes independent", () => {
    const deliver = vi.fn();
    const scheduler = new MessageReminderScheduler({ deliver });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 1, remindAfterMs: 60_000 });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 2, remindAfterMs: 60_000 });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/b", sentSeq: 3, remindAfterMs: 60_000 });

    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls.map((call) => call[1].text)).toEqual([
      expect.stringContaining("/s#0001/a#2"),
      expect.stringContaining("/s#0001/b#3"),
    ]);
  });

  it("only a newer wake in the exact same scope cancels", () => {
    const deliver = vi.fn();
    const scheduler = new MessageReminderScheduler({ deliver });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 10, remindAfterMs: 60_000 });
    scheduler.observe("a1", "/s#0001/a", 10);
    scheduler.observe("a1", "/s#0001/other", 99);
    scheduler.observe("a2", "/s#0001/a", 99);
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledOnce();

    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 11, remindAfterMs: 60_000 });
    scheduler.observe("a1", "/s#0001/a", 12);
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("closes the send→wake→arm race with the latest observed seq", () => {
    const deliver = vi.fn();
    const scheduler = new MessageReminderScheduler({ deliver });
    scheduler.observe("a1", "/s#0001/a", 8);
    expect(
      scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 7, remindAfterMs: 60_000 }),
    ).toEqual({ armed: false, reason: "newer_message_observed" });
    vi.advanceTimersByTime(60_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("expires once, removes before delivery, and renders the arm time", () => {
    let scheduler: MessageReminderScheduler;
    const deliver = vi.fn((agentId: string) => {
      // Re-arming the same key during delivery proves the expired record was
      // removed before manager delivery/re-entrancy.
      scheduler.arm({ agentId, channel: "/s#0001/a", sentSeq: 5, remindAfterMs: 60_000 });
    });
    scheduler = new MessageReminderScheduler({ deliver });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 4, remindAfterMs: 60_000 });
    vi.advanceTimersByTime(60_000);

    expect(deliver).toHaveBeenCalledOnce();
    const prompt = deliver.mock.calls[0]![1].text;
    expect(prompt).toContain(localISOString(new Date("2026-08-13T12:00:00.000Z")));
    expect(prompt).not.toContain(localISOString(new Date("2026-08-13T12:01:00.000Z")));
    expect(prompt).toContain("/s#0001/a#4");
    expect(prompt).toContain("/s#0001/a");
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("consumes the record and contains a synchronous delivery failure", () => {
    const deliver = vi.fn(() => {
      throw new Error("delivery failed");
    });
    const scheduler = new MessageReminderScheduler({ deliver });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 4, remindAfterMs: 60_000 });

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(deliver).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("consumes the record and handles an asynchronous delivery rejection", async () => {
    const deliver = vi.fn(() => Promise.reject(new Error("delivery rejected")));
    const scheduler = new MessageReminderScheduler({ deliver });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 4, remindAfterMs: 60_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("clears one agent or the whole daemon without firing timers", () => {
    const deliver = vi.fn();
    const scheduler = new MessageReminderScheduler({ deliver });
    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 1, remindAfterMs: 60_000 });
    scheduler.arm({ agentId: "a2", channel: "/s#0001/a", sentSeq: 1, remindAfterMs: 60_000 });
    scheduler.clearAgent("a1");
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith("a2", expect.any(Object));

    scheduler.arm({ agentId: "a1", channel: "/s#0001/a", sentSeq: 2, remindAfterMs: 60_000 });
    scheduler.clearAll();
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledOnce();
  });
});

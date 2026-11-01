import { describe, expect, it, vi } from "vitest";
import {
  DAEMON_SELF_SLEEP_TIMEOUT_MS,
  DaemonSelfSleepScheduler,
  type DaemonSelfSleepClock,
} from "./daemonSelfSleep";

function manualClock() {
  const timers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
    handle: ReturnType<typeof setTimeout>;
  }> = [];
  const clock: DaemonSelfSleepClock = {
    setTimer: (callback, delayMs) => {
      const handle = { unref() {} } as ReturnType<typeof setTimeout>;
      timers.push({ callback, delayMs, cancelled: false, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const timer = timers.find((candidate) => candidate.handle === handle);
      if (timer) timer.cancelled = true;
    },
  };
  return { clock, timers };
}

describe("DaemonSelfSleepScheduler", () => {
  it("sleeps once after exactly seven idle days", () => {
    vi.useFakeTimers();
    const onSleep = vi.fn();
    const scheduler = new DaemonSelfSleepScheduler({ onSleep });
    try {
      scheduler.start();
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1_000 - 1);
      expect(onSleep).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onSleep).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1_000);
      expect(onSleep).toHaveBeenCalledOnce();
    } finally {
      scheduler.stop();
      vi.useRealTimers();
    }
  });

  it("starts correctly after activity observations during initialization", () => {
    const { clock, timers } = manualClock();
    const scheduler = new DaemonSelfSleepScheduler({ clock, onSleep: vi.fn() });

    scheduler.observeAgentActivity("idle", false);
    scheduler.observeMessage();
    scheduler.start();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(DAEMON_SELF_SLEEP_TIMEOUT_MS);
  });

  it("resets for a new message and rejects a stale queued callback", () => {
    const { clock, timers } = manualClock();
    const onSleep = vi.fn();
    const scheduler = new DaemonSelfSleepScheduler({ clock, onSleep });

    scheduler.start();
    scheduler.observeMessage();

    expect(timers).toHaveLength(2);
    expect(timers[0]?.cancelled).toBe(true);
    timers[0]?.callback();
    expect(onSleep).not.toHaveBeenCalled();
    timers[1]?.callback();
    expect(onSleep).toHaveBeenCalledOnce();
  });

  it("stays awake until the final working agent stops", () => {
    const { clock, timers } = manualClock();
    const onSleep = vi.fn();
    const scheduler = new DaemonSelfSleepScheduler({ clock, onSleep });

    scheduler.start();
    scheduler.observeAgentActivity("a", true);
    scheduler.observeAgentActivity("b", true);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.cancelled).toBe(true);

    scheduler.observeMessage();
    scheduler.observeAgentActivity("a", false);
    expect(timers).toHaveLength(1);

    scheduler.observeAgentActivity("b", false);
    expect(timers).toHaveLength(2);
    timers[1]?.callback();
    expect(onSleep).toHaveBeenCalledOnce();
  });

  it("clears the timer permanently on stop", () => {
    const { clock, timers } = manualClock();
    const onSleep = vi.fn();
    const scheduler = new DaemonSelfSleepScheduler({ clock, onSleep });

    scheduler.start();
    scheduler.stop();
    scheduler.observeMessage();
    timers[0]?.callback();

    expect(timers[0]?.cancelled).toBe(true);
    expect(timers).toHaveLength(1);
    expect(onSleep).not.toHaveBeenCalled();
  });
});

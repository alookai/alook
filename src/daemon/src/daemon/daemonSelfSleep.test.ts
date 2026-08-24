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
  it("sleeps once after the exact default idle window", () => {
    const { clock, timers } = manualClock();
    const onSleep = vi.fn();
    const scheduler = new DaemonSelfSleepScheduler({ clock, onSleep });

    scheduler.start();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.delayMs).toBe(DAEMON_SELF_SLEEP_TIMEOUT_MS);
    timers[0]?.callback();
    timers[0]?.callback();
    expect(onSleep).toHaveBeenCalledOnce();
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

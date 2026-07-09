import { describe, it, expect, vi } from "vitest";
import { SdkRuntimeSession, type SdkSessionHandle } from "./sdkRuntimeSession.js";

/**
 * See plans/sdk-runtime-session-live-isstreaming-guard.md — `send()`'s idle
 * path is a second, independent line of defense against "Agent is already
 * processing": it re-checks the vendor SDK's live `isStreaming` at the
 * moment of delivery instead of trusting the caller's `mode: "idle"` at face
 * value, and degrades to `steer()` instead of ever calling `prompt()` on a
 * session that's actually still busy.
 */
function fakeHandle(isStreaming = false) {
  return {
    isStreaming,
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
  } as SdkSessionHandle & { isStreaming: boolean; prompt: ReturnType<typeof vi.fn>; steer: ReturnType<typeof vi.fn> };
}

describe("SdkRuntimeSession.send", () => {
  it("idle send while not streaming calls prompt() directly, no wait", async () => {
    const handle = fakeHandle(false);
    const session = new SdkRuntimeSession(handle, "s1");

    await session.send("hi", "idle");

    expect(handle.prompt).toHaveBeenCalledWith("hi");
    expect(handle.steer).not.toHaveBeenCalled();
  });

  it('busy send always steers, even while not streaming (mode: "busy" never calls prompt)', async () => {
    const handle = fakeHandle(false);
    const session = new SdkRuntimeSession(handle, "s1");

    await session.send("hi", "busy");

    expect(handle.steer).toHaveBeenCalledWith("hi");
    expect(handle.prompt).not.toHaveBeenCalled();
  });

  it("idle send while streaming waits, then calls prompt() once it clears", async () => {
    vi.useFakeTimers();
    try {
      const handle = fakeHandle(true);
      const session = new SdkRuntimeSession(handle, "s1");

      const pending = session.send("hi", "idle");
      await vi.advanceTimersByTimeAsync(50);
      // Still streaming for the first couple of polls — must not have prompted yet.
      expect(handle.prompt).not.toHaveBeenCalled();

      handle.isStreaming = false; // clears mid-wait
      await vi.advanceTimersByTimeAsync(25);
      await pending;

      expect(handle.prompt).toHaveBeenCalledWith("hi");
      expect(handle.steer).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("idle send while streaming that never clears falls back to steer() after the wait window, and never calls prompt()", async () => {
    vi.useFakeTimers();
    try {
      const handle = fakeHandle(true); // stays streaming forever
      const session = new SdkRuntimeSession(handle, "s1");

      const pending = session.send("hi", "idle");
      await vi.advanceTimersByTimeAsync(1100);
      await pending;

      expect(handle.steer).toHaveBeenCalledWith("hi");
      expect(handle.prompt).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a handle with no isStreaming getter goes straight to prompt() for idle sends (backward compatible)", async () => {
    const handle = { prompt: vi.fn().mockResolvedValue(undefined), steer: vi.fn().mockResolvedValue(undefined) };
    const session = new SdkRuntimeSession(handle, "s1");

    await session.send("hi", "idle");

    expect(handle.prompt).toHaveBeenCalledWith("hi");
  });

  it("a thrown prompt() surfaces as a runtime_event error instead of rejecting send()", async () => {
    const handle = fakeHandle(false);
    handle.prompt.mockRejectedValue(new Error("boom"));
    const session = new SdkRuntimeSession(handle, "s1");
    const received: unknown[] = [];
    session.on("runtime_event", (e) => received.push(e));

    await expect(session.send("hi", "idle")).resolves.toEqual({ ok: true });

    expect(received).toContainEqual({ kind: "error", message: "boom" });
  });

  // Regression test: a failed prompt() IS the attempted turn — nothing else
  // will ever say it's over, unlike a failed steer() (see below), which
  // injects into an already-running turn that still emits its own real
  // turn_end later. Without this synthetic turn_end, the caller (e.g.
  // `SdkManagedSession.start()`, which fires the very first turn this way)
  // keeps the agent looking busy/running until the stall watchdog eventually
  // notices and terminates it, minutes later.
  it("a thrown prompt() also emits a synthetic turn_end right after the error, so the caller doesn't stay stuck 'running'", async () => {
    const handle = fakeHandle(false);
    handle.prompt.mockRejectedValue(new Error("boom"));
    const session = new SdkRuntimeSession(handle, "s1");
    const received: unknown[] = [];
    session.on("runtime_event", (e) => received.push(e));

    await session.send("hi", "idle");

    expect(received).toEqual([
      { kind: "session_init", sessionId: "s1" },
      { kind: "error", message: "boom" },
      { kind: "turn_end", sessionId: "s1" },
    ]);
  });

  it("a thrown steer() surfaces as a runtime_event error instead of rejecting send()", async () => {
    const handle = fakeHandle(false);
    handle.steer.mockRejectedValue(new Error("nope"));
    const session = new SdkRuntimeSession(handle, "s1");
    const received: unknown[] = [];
    session.on("runtime_event", (e) => received.push(e));

    await expect(session.send("hi", "busy")).resolves.toEqual({ ok: true });

    expect(received).toContainEqual({ kind: "error", message: "nope" });
  });

  // A failed steer() (mode "busy") does NOT mean the turn it was steering
  // ended — that turn is still running independently and will emit its own
  // real turn_end later. Emitting a synthetic one here would end it early.
  it("a thrown steer() does NOT emit a synthetic turn_end (the underlying turn is still running)", async () => {
    const handle = fakeHandle(false);
    handle.steer.mockRejectedValue(new Error("nope"));
    const session = new SdkRuntimeSession(handle, "s1");
    const received: unknown[] = [];
    session.on("runtime_event", (e) => received.push(e));

    await session.send("hi", "busy");

    expect(received).not.toContainEqual(expect.objectContaining({ kind: "turn_end" }));
  });

  // Same reasoning as above for the idle-but-still-streaming fallback path
  // (see "falls back to steer() after the wait window" above): it's steering
  // into an existing turn, not attempting a new one.
  it("a thrown steer() from the idle-still-streaming fallback does NOT emit a synthetic turn_end", async () => {
    vi.useFakeTimers();
    try {
      const handle = fakeHandle(true); // stays streaming forever
      handle.steer.mockRejectedValue(new Error("nope"));
      const session = new SdkRuntimeSession(handle, "s1");
      const received: unknown[] = [];
      session.on("runtime_event", (e) => received.push(e));

      const pending = session.send("hi", "idle");
      await vi.advanceTimersByTimeAsync(1100);
      await pending;

      expect(received).toContainEqual({ kind: "error", message: "nope" });
      expect(received).not.toContainEqual(expect.objectContaining({ kind: "turn_end" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

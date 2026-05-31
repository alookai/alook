import { describe, it, expect } from "vitest";
import {
  createFastLoadGateState,
  fastLoadKey,
  shouldSkipFastLoad,
  markFastLoadCompleted,
} from "./fast-load-gate";

const ID = { workspaceId: "w1", agentId: "a1", targetConvId: "c1", scrollToTaskId: null };

describe("fastLoadKey", () => {
  it("returns null on the slow path (no targetConvId)", () => {
    expect(fastLoadKey({ ...ID, targetConvId: null })).toBeNull();
    expect(fastLoadKey({ ...ID, targetConvId: undefined })).toBeNull();
  });

  it("excludes channel — same identity always yields the same key", () => {
    const k1 = fastLoadKey(ID);
    const k2 = fastLoadKey(ID);
    expect(k1).toBe(k2);
    expect(k1).toContain("w1");
    expect(k1).toContain("a1");
    expect(k1).toContain("c1");
  });

  it("changes when agent / conv / scroll target change", () => {
    const base = fastLoadKey(ID);
    expect(fastLoadKey({ ...ID, agentId: "a2" })).not.toBe(base);
    expect(fastLoadKey({ ...ID, targetConvId: "c2" })).not.toBe(base);
    expect(fastLoadKey({ ...ID, scrollToTaskId: "t9" })).not.toBe(base);
  });
});

describe("fast-load gate lifecycle", () => {
  it("TODO 6: same key re-fire AFTER completion is skipped (no flash / no re-fetch)", () => {
    const state = createFastLoadGateState();
    const key = fastLoadKey(ID)!;

    // Run #1 starts then completes.
    expect(shouldSkipFastLoad(key, state)).toBe(false);
    markFastLoadCompleted(key, state);

    // Re-fire from a pure channel-dep change → same key, already completed → skip.
    expect(shouldSkipFastLoad(key, state)).toBe(true);
  });

  it("REGRESSION: cancelled-mid-flight run does NOT strand the skeleton — recovery run proceeds", () => {
    const state = createFastLoadGateState();
    const key = fastLoadKey(ID)!;

    // Run #1 starts (does NOT complete — it gets cancelled mid-load, so
    // markFastLoadCompleted is never called for it).
    expect(shouldSkipFastLoad(key, state)).toBe(false);

    // Run #2 (recovery) fires with the SAME key while #1 is still in flight.
    // It must NOT be skipped — otherwise nobody clears messagesLoading.
    expect(shouldSkipFastLoad(key, state)).toBe(false);

    // Run #2 completes and records the marker.
    markFastLoadCompleted(key, state);

    // Now a later pure channel re-fire is correctly deduped.
    expect(shouldSkipFastLoad(key, state)).toBe(true);
  });

  it("a cancelled run that already marked nothing leaves completedKey null", () => {
    const state = createFastLoadGateState();
    const key = fastLoadKey(ID)!;
    shouldSkipFastLoad(key, state); // start, clears marker
    // (run cancelled — markFastLoadCompleted NOT called)
    expect(state.completedKey).toBeNull();
  });

  it("starting a load clears a stale completed marker (different identity)", () => {
    const state = createFastLoadGateState();
    const k1 = fastLoadKey(ID)!;
    const k2 = fastLoadKey({ ...ID, targetConvId: "c2" })!;

    shouldSkipFastLoad(k1, state);
    markFastLoadCompleted(k1, state);
    expect(state.completedKey).toBe(k1);

    // Switching to a different conversation starts a new load → marker cleared
    // until the new run finishes (no false dedup across identities).
    expect(shouldSkipFastLoad(k2, state)).toBe(false);
    expect(state.completedKey).toBeNull();
  });

  it("slow path (null key) never skips and never records a marker", () => {
    const state = createFastLoadGateState();
    expect(shouldSkipFastLoad(null, state)).toBe(false);
    markFastLoadCompleted(null, state);
    expect(state.completedKey).toBeNull();
    // A subsequent null run also proceeds.
    expect(shouldSkipFastLoad(null, state)).toBe(false);
  });
});

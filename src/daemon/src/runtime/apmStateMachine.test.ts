import { describe, it, expect } from "vitest";
import {
  createInitialApmGatedSteeringState,
  reduceApmGatedToolUse,
  reduceApmGatedCompaction,
  reduceApmGatedReview,
  reduceApmGatedFlushReadiness,
  type ApmGatedSteeringState,
} from "./apmStateMachine";

const init = createInitialApmGatedSteeringState;

describe("reduceApmGatedToolUse", () => {
  it("tool_call increments outstanding + enters tool_wait", () => {
    const { nextState } = reduceApmGatedToolUse(init(), { kind: "tool_call" });
    expect(nextState.phase).toBe("tool_wait");
    expect(nextState.outstandingToolUses).toBe(1);
  });

  it("closing the LAST outstanding tool signals a batch flush", () => {
    let s = reduceApmGatedToolUse(init(), { kind: "tool_call" }).nextState;
    const r = reduceApmGatedToolUse(s, { kind: "tool_result" });
    expect(r.nextState.outstandingToolUses).toBe(0);
    expect(r.nextState.phase).toBe("tool_boundary");
    expect(r.shouldFlushToolBatch).toBe(true);
  });

  it("closing one of several tools does NOT flush yet", () => {
    let s = reduceApmGatedToolUse(init(), { kind: "tool_call" }).nextState;
    s = reduceApmGatedToolUse(s, { kind: "tool_call" }).nextState; // 2 outstanding
    const r = reduceApmGatedToolUse(s, { kind: "tool_result" });
    expect(r.nextState.outstandingToolUses).toBe(1);
    expect(r.shouldFlushToolBatch).toBe(false);
  });
});

describe("reduceApmGatedReview", () => {
  it("review_started enters reviewing; review_finished leaves it for assistant_continuation", () => {
    const started = reduceApmGatedReview(init(), { kind: "review_started" }).nextState;
    expect(started.phase).toBe("reviewing");
    expect(started.reviewing).toBe(true);
    const finished = reduceApmGatedReview(started, { kind: "review_finished" }).nextState;
    expect(finished.reviewing).toBe(false);
    expect(finished.phase).toBe("assistant_continuation");
  });
});

describe("reduceApmGatedFlushReadiness — the gate", () => {
  const ready = { isGated: true, hasSession: true, inboxLength: 1, reason: "test" };

  it("notifies when gated, has session, inbox non-empty, and no blockers", () => {
    const r = reduceApmGatedFlushReadiness(init(), ready);
    expect(r.shouldNotify).toBe(true);
    expect(r.blockedReason).toBeNull();
    expect(r.effects[0]).toMatchObject({ kind: "notify_stdin", clauseId: "SMR-002", stdinMode: "busy" });
  });

  it("blocks: non-gated / missing session / empty inbox", () => {
    expect(reduceApmGatedFlushReadiness(init(), { ...ready, isGated: false }).blockedReason).toBe("non_gated");
    expect(reduceApmGatedFlushReadiness(init(), { ...ready, hasSession: false }).blockedReason).toBe("missing_session");
    expect(reduceApmGatedFlushReadiness(init(), { ...ready, inboxLength: 0 }).blockedReason).toBe("empty_inbox");
  });

  it("blocks while compacting / reviewing / outstanding tools", () => {
    const compacting: ApmGatedSteeringState = { ...init(), compacting: true };
    expect(reduceApmGatedFlushReadiness(compacting, ready).blockedReason).toBe("compacting");

    const reviewing: ApmGatedSteeringState = { ...init(), reviewing: true };
    expect(reduceApmGatedFlushReadiness(reviewing, ready).blockedReason).toBe("reviewing");

    const busyTools: ApmGatedSteeringState = { ...init(), outstandingToolUses: 2 };
    expect(reduceApmGatedFlushReadiness(busyTools, ready).blockedReason).toBe("outstanding_tool_uses");
  });

  it("compaction_started sets compacting; compaction_finished clears it", () => {
    const started = reduceApmGatedCompaction(init(), { kind: "compaction_started" }).nextState;
    expect(started.compacting).toBe(true);
    expect(reduceApmGatedFlushReadiness(started, ready).blockedReason).toBe("compacting");
    const finished = reduceApmGatedCompaction(started, { kind: "compaction_finished" }).nextState;
    expect(finished.compacting).toBe(false);
    expect(reduceApmGatedFlushReadiness(finished, ready).shouldNotify).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { planAgentInboxSideEffect, type PlanInput } from "./stateMachine";

function base(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    agentId: "a",
    action: "send",
    target: "#general",
    pendingMessages: [],
    recentMessages: [],
    ...overrides,
  };
}

describe("planAgentInboxSideEffect — freshness guard", () => {
  it("forwards when nothing is pending", () => {
    const r = planAgentInboxSideEffect(base());
    expect(r.outcome).toBe("forward");
  });

  it("continueAnyway bypasses the hold even with pending messages", () => {
    const r = planAgentInboxSideEffect(
      base({
        continueAnyway: true,
        pendingMessages: [{ seq: 10, sender_name: "x", message_id: "m10" }],
      }),
    );
    expect(r.outcome).toBe("forward");
    // The recorded decision is a bypass.
    const rec = r.effects.find((e) => e.type === "record_freshness_decision");
    expect(rec && (rec as any).decision.decision).toBe("bypass");
  });

  it("holds when there are unseen pending messages on the target", () => {
    const r = planAgentInboxSideEffect(
      base({
        pendingMessages: [
          { seq: 10, sender_name: "x", message_id: "m10" },
          { seq: 11, sender_name: "y", message_id: "m11" },
        ],
        modelSeenSeq: 5, // model has only seen up to 5; 10/11 are unseen
      }),
    );
    expect(r.outcome).toBe("held");
    expect(r.target).toBe("#general");
  });

  it("derives the model-seen boundary only from the messages actually returned", () => {
    const r = planAgentInboxSideEffect(
      base({
        pendingMessages: [
          { seq: 4, sender_name: "x", message_id: "m4" },
          { seq: 6, sender_name: "y", message_id: "m6" },
        ],
        modelSeenSeq: 0,
      }),
    );
    expect(r.outcome).toBe("held");
    expect((r.localResponse as any)?.seenUpToSeq).toBe(6);
    const decision = r.effects.find((effect) => effect.type === "record_freshness_decision");
    expect(decision && (decision as any).decision.pendingMaxSeq).toBe(6);
  });

  it("forwards when the model has already seen the pending messages", () => {
    const r = planAgentInboxSideEffect(
      base({
        pendingMessages: [{ seq: 3, sender_name: "x", message_id: "m3" }],
        modelSeenSeq: 10, // already seen past seq 3
      }),
    );
    expect(r.outcome).toBe("forward");
  });
});

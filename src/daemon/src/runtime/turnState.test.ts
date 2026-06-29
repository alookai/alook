import { describe, it, expect } from "vitest";
import { RuntimeTurnState } from "./turnState";

describe("RuntimeTurnState — gated steering gate", () => {
  it("cannot steer before a turn starts", () => {
    const t = new RuntimeTurnState();
    expect(t.canSteerBusy).toBe(false);
  });

  it("turn start opens the gate", () => {
    const t = new RuntimeTurnState();
    t.markTurnStarted("turn-1");
    expect(t.canSteerBusy).toBe(true);
    expect(t.activeTurnId).toBe("turn-1");
  });

  it("tool boundary closes the gate; progress reopens it", () => {
    const t = new RuntimeTurnState();
    t.markTurnStarted("turn-1");
    t.markToolBoundary();
    expect(t.canSteerBusy).toBe(false);
    t.markProgress();
    expect(t.canSteerBusy).toBe(true);
  });

  it("turn completion goes idle (gate shut because no active turn)", () => {
    const t = new RuntimeTurnState();
    t.markTurnStarted("turn-1");
    t.markTurnCompleted();
    expect(t.canSteerBusy).toBe(false);
    expect(t.activeTurnId).toBeNull();
  });

  it("adoptTurnId learns the id without changing the gate", () => {
    const t = new RuntimeTurnState();
    t.markTurnStarted("turn-1");
    t.markToolBoundary(); // gate shut
    t.adoptTurnId("turn-2");
    expect(t.activeTurnId).toBe("turn-2");
    expect(t.canSteerBusy).toBe(false); // unchanged
  });

  it("reset clears everything", () => {
    const t = new RuntimeTurnState();
    t.markTurnStarted("turn-1");
    t.reset();
    expect(t.activeTurnId).toBeNull();
    expect(t.canSteerBusy).toBe(false);
  });
});

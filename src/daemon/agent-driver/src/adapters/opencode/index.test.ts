import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fakeLaunchContext } from "../../testing/adapter-fixture.js";
import { OpenCodeDriver } from "./index.js";

const spawnAgentProcess = vi.hoisted(() => vi.fn());
vi.mock("../../internal/killTree.js", async () => ({
  ...(await vi.importActual<typeof import("../../internal/killTree.js")>("../../internal/killTree.js")),
  spawnAgentProcess,
}));

describe("OpenCodeDriver.normalizeLine — step_finish turn-end timing", () => {
  let driver: OpenCodeDriver;

  beforeEach(() => {
    driver = new OpenCodeDriver();
  });

  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it("spawns one deferred turn and exposes its no-stdin continuation contract", async () => {
    const end = vi.fn();
    spawnAgentProcess.mockReturnValue(Object.assign(new EventEmitter(), { stdin: { end } }));
    const spawned = await driver.spawn(fakeLaunchContext("opencode", process.cwd(), { prompt: "hello" }));
    expect(spawned.process).toBeDefined();
    expect(end).toHaveBeenCalledOnce();
    expect(driver.encodeMessage()).toBeNull();
  });

  it("does NOT end the turn on an intermediate step_finish (reason: tool-calls)", () => {
    const events = driver.normalizeLine(
      line({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "tool-calls" } }),
    );
    expect(events.some((e) => e.kind === "turn_end")).toBe(false);
  });

  it("ends the turn on the final step_finish (reason: stop)", () => {
    const events = driver.normalizeLine(
      line({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "stop" } }),
    );
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
  });

  it("a multi-step turn (tool-calls step, then a stop step) emits turn_end exactly once, after the final step", () => {
    const afterToolCallStep = driver.normalizeLine(
      line({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "tool-calls" } }),
    );
    const afterFinalStep = driver.normalizeLine(
      line({ type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", reason: "stop" } }),
    );

    expect(afterToolCallStep.filter((e) => e.kind === "turn_end")).toHaveLength(0);
    expect(afterFinalStep.filter((e) => e.kind === "turn_end")).toHaveLength(1);
  });

  it("does not throw on a step_finish with no part (defensive)", () => {
    expect(() => driver.normalizeLine(line({ type: "step_finish", sessionID: "ses_1" }))).not.toThrow();
    // Missing `part.reason` is treated as "not tool-calls" -> turn ends, which
    // is the safe default (never getting stuck waiting for a turn_end that
    // never comes).
    const events = driver.normalizeLine(line({ type: "step_finish", sessionID: "ses_1" }));
    expect(events.some((e) => e.kind === "turn_end")).toBe(true);
  });
});

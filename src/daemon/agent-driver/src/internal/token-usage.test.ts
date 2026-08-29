import { describe, expect, it } from "vitest";
import { SettledUsageProjector } from "./token-usage.js";

const identity = {
  runtime: "codex",
  backendSessionId: "thread-1",
  providerRecordId: "response-1",
};

describe("SettledUsageProjector", () => {
  it("normalizes an inclusive input and cache read/write exactly once", () => {
    const projector = new SettledUsageProjector();
    const record = {
      ...identity,
      source: "fixture",
      input: 100,
      output: 7,
      cacheRead: 30,
      cacheWrite: 10,
      inputIncludesCache: true,
      outputIncludesReasoning: true,
    } as const;

    expect(projector.project(record)).toEqual({
      kind: "telemetry",
      name: "token_usage",
      source: "fixture",
      usage: { input: 60, output: 7, cache: 40 },
    });
    expect(projector.project(record)).toBeNull();
    expect(projector.activeCount).toBe(1);
  });

  it("keeps exclusive input separate from cache and preserves reported zero", () => {
    const projector = new SettledUsageProjector();
    expect(projector.project({
      ...identity,
      source: "fixture",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
    })).toMatchObject({ usage: { input: 0, output: 0, cache: 0 } });
  });

  it("maps missing, malformed, inconsistent, and overflowing metrics to null", () => {
    const projector = new SettledUsageProjector();
    expect(projector.project({
      ...identity,
      source: "fixture",
      input: 3,
      output: -1,
      cacheRead: 4,
      cacheWrite: 0,
      inputIncludesCache: true,
      outputIncludesReasoning: true,
    })).toMatchObject({ usage: { input: null, output: null, cache: 4 } });
    expect(projector.project({
      ...identity,
      providerRecordId: "overflow",
      source: "fixture",
      input: undefined,
      output: undefined,
      cacheRead: Number.MAX_SAFE_INTEGER,
      cacheWrite: 1,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
    })).toBeNull();
    expect(projector.activeCount).toBe(1);
    expect(projector.project({
      ...identity,
      providerRecordId: "overflow",
      source: "fixture",
      input: 1,
      output: 2,
      inputIncludesCache: false,
      outputIncludesReasoning: true,
    })).not.toBeNull();
  });

  it("adds provider-exclusive reasoning to output without guessing invalid totals", () => {
    const projector = new SettledUsageProjector();
    expect(projector.project({
      ...identity,
      source: "fixture",
      input: 1,
      output: 7,
      reasoning: 3,
      inputIncludesCache: false,
      outputIncludesReasoning: false,
    })).toMatchObject({ usage: { input: 1, output: 10, cache: null } });
    expect(projector.project({
      ...identity,
      providerRecordId: "missing-reasoning",
      source: "fixture",
      input: undefined,
      output: 7,
      reasoning: undefined,
      inputIncludesCache: false,
      outputIncludesReasoning: false,
    })).toBeNull();
  });

  it("requires the full runtime/session/provider identity and scopes equal ids by session", () => {
    const projector = new SettledUsageProjector();
    const base = { source: "fixture", input: 1, output: 1, inputIncludesCache: false, outputIncludesReasoning: true } as const;
    expect(projector.project({ ...base, ...identity, backendSessionId: "" })).toBeNull();
    expect(projector.project({ ...base, ...identity })).not.toBeNull();
    expect(projector.project({ ...base, ...identity, backendSessionId: "thread-2" })).not.toBeNull();
  });

  it("releases identities only when the adapter reaches its no-replay frontier", () => {
    const projector = new SettledUsageProjector();
    const record = { ...identity, source: "fixture", input: 1, output: 1, inputIncludesCache: false, outputIncludesReasoning: true } as const;
    expect(projector.project(record)).not.toBeNull();
    projector.release(identity);
    expect(projector.activeCount).toBe(0);
    expect(projector.project(record)).not.toBeNull();
    projector.reset();
    expect(projector.activeCount).toBe(0);
  });
});

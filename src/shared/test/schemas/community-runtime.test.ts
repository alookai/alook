import { describe, it, expect } from "vitest";
import {
  CommunityMachineRuntimeSchema,
  CommunityMachineRuntimeListSchema,
  HostReadyMessageSchema,
  SessionErrorFrameSchema,
  COMMUNITY_RUNTIME_ID_MAX,
  COMMUNITY_RUNTIME_LIST_MAX,
} from "../../src/schemas";

describe("CommunityMachineRuntimeSchema", () => {
  it("accepts a plain id", () => {
    expect(CommunityMachineRuntimeSchema.parse({ id: "claude" })).toEqual({
      id: "claude",
    });
  });

  it("accepts id + version", () => {
    expect(
      CommunityMachineRuntimeSchema.parse({ id: "claude", version: "1.0.0" })
    ).toEqual({ id: "claude", version: "1.0.0" });
  });

  it("rejects an empty id", () => {
    expect(() => CommunityMachineRuntimeSchema.parse({ id: "" })).toThrow();
  });

  it("rejects an id longer than the cap", () => {
    const tooLong = "a".repeat(COMMUNITY_RUNTIME_ID_MAX + 1);
    expect(() => CommunityMachineRuntimeSchema.parse({ id: tooLong })).toThrow();
  });

  it("rejects an id with disallowed characters (spaces)", () => {
    expect(() => CommunityMachineRuntimeSchema.parse({ id: "cool cli" })).toThrow();
  });

  it("rejects an id with a disallowed character (colon)", () => {
    expect(() => CommunityMachineRuntimeSchema.parse({ id: "kimi:sdk" })).toThrow();
  });

  it("accepts the full charset — alnum + `._@/-`", () => {
    for (const id of ["a", "A", "0", ".", "_", "@", "/", "-", "a.b_C@d/e-1"]) {
      expect(CommunityMachineRuntimeSchema.parse({ id })).toEqual({ id });
    }
  });
});

describe("CommunityMachineRuntimeListSchema", () => {
  it("dedupes by id (first-wins)", () => {
    const out = CommunityMachineRuntimeListSchema.parse([
      { id: "claude", version: "1" },
      { id: "codex" },
      { id: "claude", version: "2" },
    ]);
    expect(out).toEqual([{ id: "claude", version: "1" }, { id: "codex" }]);
  });

  it("rejects lists larger than the cap", () => {
    const too_many = Array.from(
      { length: COMMUNITY_RUNTIME_LIST_MAX + 1 },
      (_, i) => ({ id: `r${i}` })
    );
    expect(() => CommunityMachineRuntimeListSchema.parse(too_many)).toThrow();
  });

  it("accepts an empty list", () => {
    expect(CommunityMachineRuntimeListSchema.parse([])).toEqual([]);
  });

  it("rejects a list where any entry fails charset validation", () => {
    expect(() =>
      CommunityMachineRuntimeListSchema.parse([{ id: "claude" }, { id: "bad id" }])
    ).toThrow();
  });
});

describe("HostReadyMessageSchema", () => {
  it("accepts the canonical shape", () => {
    const parsed = HostReadyMessageSchema.parse({
      type: "ready",
      runtimeReport: [{ id: "claude", version: "1.0.0" }],
      runningAgents: ["agent_a"],
      hostname: "host",
      platform: "darwin",
      arch: "arm64",
      osRelease: "23.6.0",
      daemonVersion: "0.1.0",
    });
    expect(parsed.runtimeReport).toEqual([{ id: "claude", version: "1.0.0" }]);
    expect(parsed.runningAgents).toEqual(["agent_a"]);
  });

  it("defaults runningAgents to an empty array", () => {
    const parsed = HostReadyMessageSchema.parse({
      type: "ready",
      runtimeReport: [],
    });
    expect(parsed.runningAgents).toEqual([]);
  });

  it("rejects the legacy string-only `runtimes` field (no runtimeReport)", () => {
    expect(() =>
      HostReadyMessageSchema.parse({
        type: "ready",
        runtimes: ["claude", "codex"],
        runningAgents: [],
      } as any)
    ).toThrow();
  });

  it("rejects when type is not 'ready'", () => {
    expect(() =>
      HostReadyMessageSchema.parse({
        type: "hello",
        runtimeReport: [],
      } as any)
    ).toThrow();
  });

  it("dedupes runtimeReport entries via the list schema", () => {
    const parsed = HostReadyMessageSchema.parse({
      type: "ready",
      runtimeReport: [{ id: "claude" }, { id: "claude" }],
      runningAgents: [],
    });
    expect(parsed.runtimeReport).toEqual([{ id: "claude" }]);
  });
});

describe("SessionErrorFrameSchema", () => {
  it("accepts a runtime_not_available frame", () => {
    const parsed = SessionErrorFrameSchema.parse({
      type: "session.error",
      code: "runtime_not_available",
      agentId: "agent_a",
      payload: { requested: "cursor", available: ["claude"] },
    });
    expect(parsed.code).toBe("runtime_not_available");
  });

  it("rejects an unknown code", () => {
    expect(() =>
      SessionErrorFrameSchema.parse({
        type: "session.error",
        code: "bogus",
      } as any)
    ).toThrow();
  });
});

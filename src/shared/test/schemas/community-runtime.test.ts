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
  it("accepts a plain id and defaults status to 'healthy' (wire back-compat for older daemons)", () => {
    expect(CommunityMachineRuntimeSchema.parse({ id: "claude" })).toEqual({
      id: "claude",
      status: "healthy",
    });
  });

  it("accepts id + version + defaulted status", () => {
    expect(
      CommunityMachineRuntimeSchema.parse({ id: "claude", version: "1.0.0" })
    ).toEqual({ id: "claude", version: "1.0.0", status: "healthy" });
  });

  it("accepts explicit unhealthy + lastError", () => {
    expect(
      CommunityMachineRuntimeSchema.parse({
        id: "codex",
        status: "unhealthy",
        lastError: "version_probe_failed",
        lastErrorAt: "2026-07-06T00:00:00.000Z",
      })
    ).toEqual({
      id: "codex",
      status: "unhealthy",
      lastError: "version_probe_failed",
      lastErrorAt: "2026-07-06T00:00:00.000Z",
    });
  });

  it("catches null status and folds it to 'healthy' — fail-open so a bad daemon doesn't poison the whole ready frame", () => {
    // .catch("healthy") on the enum absorbs null / unknown values that would
    // otherwise fail the enum literal check.
    const parsed = CommunityMachineRuntimeSchema.parse({ id: "codex", status: null as unknown as "healthy" });
    expect(parsed.status).toBe("healthy");
  });

  it("catches an unknown-enum future value ('degraded') and folds it to 'healthy'", () => {
    const parsed = CommunityMachineRuntimeSchema.parse({
      id: "codex",
      status: "degraded" as unknown as "healthy",
    });
    expect(parsed.status).toBe("healthy");
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
      expect(CommunityMachineRuntimeSchema.parse({ id })).toEqual({ id, status: "healthy" });
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
    expect(out).toEqual([
      { id: "claude", version: "1", status: "healthy" },
      { id: "codex", status: "healthy" },
    ]);
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
    expect(parsed.runtimeReport).toEqual([
      { id: "claude", version: "1.0.0", status: "healthy" },
    ]);
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
    expect(parsed.runtimeReport).toEqual([{ id: "claude", status: "healthy" }]);
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

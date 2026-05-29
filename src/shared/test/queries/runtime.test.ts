import { describe, it, expect, vi } from "vitest";
import * as runtimeQueries from "../../src/db/queries/runtime";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("runtime query module exports", () => {
  it("exports getAgentRuntimesForWorkspace", () => {
    expect(typeof runtimeQueries.getAgentRuntimesForWorkspace).toBe("function");
  });

  it("exports getAgentRuntimeForWorkspace", () => {
    expect(typeof runtimeQueries.getAgentRuntimeForWorkspace).toBe("function");
  });

  it("exports upsertAgentRuntime", () => {
    expect(typeof runtimeQueries.upsertAgentRuntime).toBe("function");
  });

  it("exports listAgentRuntimes", () => {
    expect(typeof runtimeQueries.listAgentRuntimes).toBe("function");
  });

  it("exports getAgentRuntime", () => {
    expect(typeof runtimeQueries.getAgentRuntime).toBe("function");
  });
});

describe("getAgentRuntimesForWorkspace", () => {
  it("returns empty array for empty ids without querying DB", async () => {
    const result = await runtimeQueries.getAgentRuntimesForWorkspace(null as any, [], "ws1");
    expect(result).toEqual([]);
  });

  it("queries DB and returns runtimes when ids is non-empty", async () => {
    const mockRows = [
      { id: "rt1", workspaceId: "ws1", runtimeMode: "local", machineLastSeenAt: null },
      { id: "rt2", workspaceId: "ws1", runtimeMode: "cloud", machineLastSeenAt: "2026-01-01" },
    ];
    const mockDb = createMockDb(mockRows);

    const result = await runtimeQueries.getAgentRuntimesForWorkspace(mockDb, ["rt1", "rt2"], "ws1");

    expect(mockDb.select).toHaveBeenCalledOnce();
    expect(mockDb.from).toHaveBeenCalledOnce();
    expect(mockDb.leftJoin).toHaveBeenCalledOnce();
    expect(mockDb.where).toHaveBeenCalledOnce();
    expect(result).toEqual(mockRows);
  });

  it("returns single runtime for single id input", async () => {
    const mockRows = [{ id: "rt1", workspaceId: "ws1", runtimeMode: "local", machineLastSeenAt: null }];
    const mockDb = createMockDb(mockRows);

    const result = await runtimeQueries.getAgentRuntimesForWorkspace(mockDb, ["rt1"], "ws1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("rt1");
  });
});

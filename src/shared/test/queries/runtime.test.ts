import { describe, it, expect } from "vitest";
import * as runtimeQueries from "../../src/db/queries/runtime";

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

describe("runtime query function signatures", () => {
  it("getAgentRuntimesForWorkspace accepts (db, ids, workspaceId)", () => {
    expect(runtimeQueries.getAgentRuntimesForWorkspace.length).toBe(3);
  });

  it("getAgentRuntimeForWorkspace accepts (db, id, workspaceId)", () => {
    expect(runtimeQueries.getAgentRuntimeForWorkspace.length).toBe(3);
  });

  it("getAgentRuntimesForWorkspace returns empty array for empty ids", async () => {
    const result = await runtimeQueries.getAgentRuntimesForWorkspace(null as any, [], "ws1");
    expect(result).toEqual([]);
  });
});

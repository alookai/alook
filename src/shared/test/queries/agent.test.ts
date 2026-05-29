import { describe, it, expect, vi } from "vitest";
import * as agentQueries from "../../src/db/queries/agent";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("agent query module exports", () => {
  it("exports getExistingHandles", () => {
    expect(typeof agentQueries.getExistingHandles).toBe("function");
  });

  it("exports getAgentByHandle", () => {
    expect(typeof agentQueries.getAgentByHandle).toBe("function");
  });

  it("exports getAgentsByIds", () => {
    expect(typeof agentQueries.getAgentsByIds).toBe("function");
  });
});

describe("getExistingHandles", () => {
  it("returns empty array for empty input without querying DB", async () => {
    const result = await agentQueries.getExistingHandles(null as any, []);
    expect(result).toEqual([]);
  });

  it("queries DB and returns existing handles when input is non-empty", async () => {
    const mockDb = createMockDb([
      { emailHandle: "alice" },
      { emailHandle: "bob" },
    ]);

    const result = await agentQueries.getExistingHandles(mockDb, ["alice", "bob", "charlie"]);

    expect(mockDb.select).toHaveBeenCalledOnce();
    expect(mockDb.from).toHaveBeenCalledOnce();
    expect(mockDb.where).toHaveBeenCalledOnce();
    expect(result).toEqual(["alice", "bob"]);
  });

  it("filters out null emailHandle values from results", async () => {
    const mockDb = createMockDb([
      { emailHandle: "alice" },
      { emailHandle: null },
    ]);

    const result = await agentQueries.getExistingHandles(mockDb, ["alice", "ghost"]);
    expect(result).toEqual(["alice"]);
  });
});

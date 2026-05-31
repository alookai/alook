import { describe, it, expect, vi } from "vitest";
import * as agentAccessQueries from "../../src/db/queries/agent-access";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.delete = vi.fn(() => chain);
  return chain;
}

describe("agent-access query module exports", () => {
  it("exports listAgentAccess", () => {
    expect(typeof agentAccessQueries.listAgentAccess).toBe("function");
  });

  it("exports grantAgentAccess", () => {
    expect(typeof agentAccessQueries.grantAgentAccess).toBe("function");
  });

  it("exports revokeAgentAccess", () => {
    expect(typeof agentAccessQueries.revokeAgentAccess).toBe("function");
  });

  it("exports hasAgentAccess", () => {
    expect(typeof agentAccessQueries.hasAgentAccess).toBe("function");
  });

  it("exports getAllAgentAccessForWorkspace", () => {
    expect(typeof agentAccessQueries.getAllAgentAccessForWorkspace).toBe("function");
  });
});

describe("hasAgentAccess", () => {
  it("returns true when access row exists", async () => {
    const mockDb = createMockDb([{ id: "aa_1" }]);
    const result = await agentAccessQueries.hasAgentAccess(mockDb, "ag_1", "ws_1", "usr_1");
    expect(result).toBe(true);
  });

  it("returns false when no access row exists", async () => {
    const mockDb = createMockDb([]);
    const result = await agentAccessQueries.hasAgentAccess(mockDb, "ag_1", "ws_1", "usr_1");
    expect(result).toBe(false);
  });
});

describe("revokeAgentAccess", () => {
  it("returns null when no row deleted", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    const result = await agentAccessQueries.revokeAgentAccess(chain, "ag_1", "ws_1", "usr_1");
    expect(result).toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";
import * as agentLinkQueries from "../../src/db/queries/agent-link";

describe("agent-link query module exports", () => {
  it("exports listByWorkspace", () => { expect(typeof agentLinkQueries.listByWorkspace).toBe("function"); });
  it("exports listByAgent", () => { expect(typeof agentLinkQueries.listByAgent).toBe("function"); });
  it("exports create", () => { expect(typeof agentLinkQueries.create).toBe("function"); });
  it("exports update", () => { expect(typeof agentLinkQueries.update).toBe("function"); });
  it("exports remove", () => { expect(typeof agentLinkQueries.remove).toBe("function"); });
  it("exports getColleaguesForAgent", () => { expect(typeof agentLinkQueries.getColleaguesForAgent).toBe("function"); });
  it("exports getColleaguesForAgents", () => { expect(typeof agentLinkQueries.getColleaguesForAgents).toBe("function"); });
  it("exports getAllColleaguesForWorkspace", () => { expect(typeof agentLinkQueries.getAllColleaguesForWorkspace).toBe("function"); });
  it("exports getByPair", () => { expect(typeof agentLinkQueries.getByPair).toBe("function"); });
  it("exports upsertByPair", () => { expect(typeof agentLinkQueries.upsertByPair).toBe("function"); });
});

// Helper: a select().from().where() chain that resolves to `rows`.
function selectChain(rows: unknown[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("getByPair", () => {
  // TC4: returns the row for either input order; null when absent.
  it("queries canonical order (a < b) and returns the row", async () => {
    const link = { id: "link_1", sourceAgentId: "ag_a", targetAgentId: "ag_z" };
    const chain = selectChain([link]);
    const result = await agentLinkQueries.getByPair(chain, "ws_1", "ag_a", "ag_z");
    expect(result).toEqual(link);
  });

  it("returns the same row when input order is reversed (b, a)", async () => {
    const link = { id: "link_1", sourceAgentId: "ag_a", targetAgentId: "ag_z" };
    const chain = selectChain([link]);
    const result = await agentLinkQueries.getByPair(chain, "ws_1", "ag_z", "ag_a");
    expect(result).toEqual(link);
  });

  it("returns null when no row exists", async () => {
    const chain = selectChain([]);
    expect(await agentLinkQueries.getByPair(chain, "ws_1", "ag_a", "ag_z")).toBeNull();
  });
});

describe("upsertByPair", () => {
  // TC1: non-existent pair -> inserts 1 row, created:true, canonical order.
  it("creates a new row (created:true) when the pair does not exist", async () => {
    const created = { id: "link_new", sourceAgentId: "ag_a", targetAgentId: "ag_z" };
    const chain: any = {};
    // getByPair -> select().from().where() resolves empty
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    // create() -> insert().values().returning()
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([created]));

    const res = await agentLinkQueries.upsertByPair(chain, {
      workspaceId: "ws_1",
      sourceAgentId: "ag_z",
      targetAgentId: "ag_a",
      instruction: "hello",
    });
    expect(res).toEqual({ row: created, created: true });
    // create() canonicalizes ag_z/ag_a -> ag_a/ag_z
    expect(chain.values).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAgentId: "ag_a", targetAgentId: "ag_z", instruction: "hello" }),
    );
  });

  // TC2/TC3: existing pair (either input order) -> updates the SAME row,
  // created:false, no duplicate insert.
  it("updates the existing row (created:false) and does not insert", async () => {
    const existing = { id: "link_1", sourceAgentId: "ag_a", targetAgentId: "ag_z" };
    const updated = { ...existing, instruction: "new text" };
    // getByPair terminates on .where() (resolves rows); update() uses a longer
    // .update().set().where().returning() chain. Track each independently.
    const chain: any = {};
    let whereCall = 0;
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([updated]));
    chain.where = vi.fn(() => {
      whereCall++;
      // 1st where = getByPair lookup (returns existing); later wheres = update chain
      return whereCall === 1 ? Promise.resolve([existing]) : chain;
    });

    // reversed input order (ag_z, ag_a) still hits the same canonical row
    const res = await agentLinkQueries.upsertByPair(chain, {
      workspaceId: "ws_1",
      sourceAgentId: "ag_z",
      targetAgentId: "ag_a",
      instruction: "new text",
    });
    expect(res).toEqual({ row: updated, created: false });
    expect(chain.update).toHaveBeenCalled();
    expect(chain.insert).not.toHaveBeenCalled();
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ instruction: "new text" }));
  });
});

describe("create", () => {
  it("swaps source/target when source > target", async () => {
    const link = { id: "link_1" };
    const chain: any = {};
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([link]));
    await agentLinkQueries.create(chain, { workspaceId: "ws_1", sourceAgentId: "ag_z", targetAgentId: "ag_a" });
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ sourceAgentId: "ag_a", targetAgentId: "ag_z" }));
  });

  it("keeps order when source < target", async () => {
    const link = { id: "link_1" };
    const chain: any = {};
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([link]));
    await agentLinkQueries.create(chain, { workspaceId: "ws_1", sourceAgentId: "ag_a", targetAgentId: "ag_z" });
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({ sourceAgentId: "ag_a", targetAgentId: "ag_z" }));
  });
});

describe("update", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await agentLinkQueries.update(chain, "x", "w", { instruction: "x" })).toBeNull();
  });

  it("returns updated link", async () => {
    const link = { id: "link_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([link]));
    expect(await agentLinkQueries.update(chain, "link_1", "w", { instruction: "new" })).toEqual(link);
  });
});

describe("remove", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await agentLinkQueries.remove(chain, "x", "w")).toBeNull();
  });

  it("returns removed link", async () => {
    const link = { id: "link_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([link]));
    expect(await agentLinkQueries.remove(chain, "link_1", "w")).toEqual(link);
  });
});

describe("getColleaguesForAgents", () => {
  it("returns empty array for empty agentIds", async () => {
    expect(await agentLinkQueries.getColleaguesForAgents(null as any, [], "ws_1")).toEqual([]);
  });
});

describe("getColleaguesForAgent", () => {
  it("combines asSource and asTarget results", async () => {
    const c1 = { name: "Alice" };
    const c2 = { name: "Bob" };
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    let callCount = 0;
    chain.where = vi.fn(() => { callCount++; return Promise.resolve(callCount === 1 ? [c1] : [c2]); });
    const result = await agentLinkQueries.getColleaguesForAgent(chain, "ag_1", "ws_1");
    expect(result).toEqual([c1, c2]);
  });
});

describe("getAllColleaguesForWorkspace", () => {
  it("combines asSource and asTarget results", async () => {
    const c1 = { name: "Alice" };
    const c2 = { name: "Bob" };
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    let callCount = 0;
    chain.where = vi.fn(() => { callCount++; return Promise.resolve(callCount === 1 ? [c1] : [c2]); });
    const result = await agentLinkQueries.getAllColleaguesForWorkspace(chain, "ws_1");
    expect(result).toEqual([c1, c2]);
  });
});

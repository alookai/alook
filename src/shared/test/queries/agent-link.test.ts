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

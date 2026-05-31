import { describe, it, expect, vi } from "vitest";
import * as agentQueries from "../../src/db/queries/agent";

describe("getAgent", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await agentQueries.getAgent(chain, "x", "w")).toBeNull();
  });
  it("returns agent when found without userId", async () => {
    const a = { id: "ag_1", visibility: "public" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.getAgent(chain, "ag_1", "w")).toEqual(a);
  });
  it("returns public agent for any user", async () => {
    const a = { id: "ag_1", visibility: "public", ownerId: "other" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.getAgent(chain, "ag_1", "w", "usr_1")).toEqual(a);
  });
  it("returns agent when user is owner", async () => {
    const a = { id: "ag_1", visibility: "private", ownerId: "usr_1" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.getAgent(chain, "ag_1", "w", "usr_1")).toEqual(a);
  });
  it("returns null for private agent without access", async () => {
    const a = { id: "ag_1", visibility: "private", ownerId: "other" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    let callCount = 0;
    chain.where = vi.fn(() => { callCount++; return Promise.resolve(callCount === 1 ? [a] : []); });
    expect(await agentQueries.getAgent(chain, "ag_1", "w", "usr_1")).toBeNull();
  });
  it("returns private agent when user has access", async () => {
    const a = { id: "ag_1", visibility: "private", ownerId: "other" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    let callCount = 0;
    chain.where = vi.fn(() => { callCount++; return Promise.resolve(callCount === 1 ? [a] : [{ id: "access_1" }]); });
    expect(await agentQueries.getAgent(chain, "ag_1", "w", "usr_1")).toEqual(a);
  });
});

describe("createAgent", () => {
  it("creates with defaults", async () => {
    const a = { id: "ag_1" };
    const chain: any = {};
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([a]));
    const result = await agentQueries.createAgent(chain, { workspaceId: "w", name: "Bot" });
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      name: "Bot", runtimeMode: "local", visibility: "private", maxConcurrentTasks: 6,
    }));
    expect(result).toEqual(a);
  });
});

describe("deleteAgent", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await agentQueries.deleteAgent(chain, "x", "w")).toBeNull();
  });
  it("returns deleted agent", async () => {
    const a = { id: "ag_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.deleteAgent(chain, "ag_1", "w")).toEqual(a);
  });
  it("filters by ownerId when provided", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    await agentQueries.deleteAgent(chain, "ag_1", "w", "usr_1");
    expect(chain.where).toHaveBeenCalled();
  });
});

describe("updateAgent", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await agentQueries.updateAgent(chain, "x", "w", { name: "N" })).toBeNull();
  });
  it("returns updated agent", async () => {
    const a = { id: "ag_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.updateAgent(chain, "ag_1", "w", { name: "N" })).toEqual(a);
  });
});

describe("updateAgentStatus", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await agentQueries.updateAgentStatus(chain, "x", "w", "active")).toBeNull();
  });
  it("returns updated agent", async () => {
    const a = { id: "ag_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.updateAgentStatus(chain, "ag_1", "w", "active")).toEqual(a);
  });
});

describe("getAgentByHandle", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await agentQueries.getAgentByHandle(chain, "missing")).toBeNull();
  });
  it("returns agent", async () => {
    const a = { id: "ag_1", emailHandle: "bot" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([a]));
    expect(await agentQueries.getAgentByHandle(chain, "bot")).toEqual(a);
  });
});

describe("getAgentsByIds", () => {
  it("returns empty for empty ids", async () => {
    expect(await agentQueries.getAgentsByIds(null as any, [], "w")).toEqual([]);
  });
});

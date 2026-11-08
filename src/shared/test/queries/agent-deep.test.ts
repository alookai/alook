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

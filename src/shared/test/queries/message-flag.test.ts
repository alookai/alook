import { describe, it, expect, vi } from "vitest";
import * as mf from "../../src/db/queries/message-flag";

describe("message-flag exports", () => {
  it("exports getMessageWorkspaceId", () => { expect(typeof mf.getMessageWorkspaceId).toBe("function"); });
  it("exports flagMessage", () => { expect(typeof mf.flagMessage).toBe("function"); });
  it("exports unflagMessage", () => { expect(typeof mf.unflagMessage).toBe("function"); });
  it("exports listFlaggedMessages", () => { expect(typeof mf.listFlaggedMessages).toBe("function"); });
  it("exports getFlaggedCount", () => { expect(typeof mf.getFlaggedCount).toBe("function"); });
  it("exports listFlaggedMessageIds", () => { expect(typeof mf.listFlaggedMessageIds).toBe("function"); });
});

describe("getMessageWorkspaceId", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await mf.getMessageWorkspaceId(chain, "x")).toBeNull();
  });
  it("returns workspaceId", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([{ workspaceId: "ws_1" }]));
    expect(await mf.getMessageWorkspaceId(chain, "msg_1")).toBe("ws_1");
  });
});

describe("flagMessage", () => {
  it("returns null on conflict", async () => {
    const chain: any = {};
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await mf.flagMessage(chain, { messageId: "m", userId: "u", workspaceId: "w" })).toBeNull();
  });
  it("returns flag", async () => {
    const f = { id: "mf_1" };
    const chain: any = {};
    chain.insert = vi.fn(() => chain); chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([f]));
    expect(await mf.flagMessage(chain, { messageId: "m", userId: "u", workspaceId: "w" })).toEqual(f);
  });
});

describe("unflagMessage", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await mf.unflagMessage(chain, "m", "u", "w")).toBeNull();
  });
  it("returns removed flag", async () => {
    const f = { id: "mf_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([f]));
    expect(await mf.unflagMessage(chain, "m", "u", "w")).toEqual(f);
  });
});

describe("listFlaggedMessages", () => {
  it("returns items with hasMore=false", async () => {
    const rows = [{ id: "mf_1" }];
    const chain: any = {};
    chain.all = vi.fn(() => Promise.resolve(rows));
    const result = await mf.listFlaggedMessages(chain, "u", "w");
    expect(result.items).toEqual(rows);
    expect(result.hasMore).toBe(false);
  });
  it("returns hasMore=true when exceeding limit", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ id: `mf_${i}` }));
    const chain: any = {};
    chain.all = vi.fn(() => Promise.resolve(rows));
    const result = await mf.listFlaggedMessages(chain, "u", "w");
    expect(result.hasMore).toBe(true);
    expect(result.items.length).toBe(30);
  });
});

describe("getFlaggedCount", () => {
  it("returns 0 when empty", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    expect(await mf.getFlaggedCount(chain, "u", "w")).toBe(0);
  });
  it("returns count", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ count: 7 }]));
    expect(await mf.getFlaggedCount(chain, "u", "w")).toBe(7);
  });
});

describe("listFlaggedMessageIds", () => {
  it("returns message ids", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ messageId: "m1" }, { messageId: "m2" }]));
    expect(await mf.listFlaggedMessageIds(chain, "u", "w", "c")).toEqual(["m1", "m2"]);
  });
});

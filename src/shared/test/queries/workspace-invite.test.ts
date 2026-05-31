import { describe, it, expect, vi } from "vitest";
import * as wi from "../../src/db/queries/workspace-invite";

function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.innerJoin = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("workspace-invite exports", () => {
  it("exports createInvite", () => { expect(typeof wi.createInvite).toBe("function"); });
  it("exports getInviteByToken", () => { expect(typeof wi.getInviteByToken).toBe("function"); });
  it("exports listActiveInvites", () => { expect(typeof wi.listActiveInvites).toBe("function"); });
  it("exports redeemInvite", () => { expect(typeof wi.redeemInvite).toBe("function"); });
  it("exports deleteInvite", () => { expect(typeof wi.deleteInvite).toBe("function"); });
});

describe("createInvite", () => {
  it("creates invite", async () => {
    const inv = { id: "inv_1" };
    expect(await wi.createInvite(createSelectMock([inv]), { workspaceId: "w", createdBy: "u", expiresAt: "2026-12-31" })).toEqual(inv);
  });
});

describe("getInviteByToken", () => {
  it("returns null when not found", async () => { expect(await wi.getInviteByToken(createSelectMock([]), "x")).toBeNull(); });
  it("returns invite with joins", async () => {
    const inv = { id: "inv_1" };
    const mockDb = createSelectMock([inv]);
    expect(await wi.getInviteByToken(mockDb, "tok")).toEqual(inv);
    expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
  });
});

describe("redeemInvite", () => {
  it("returns null when expired", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await wi.redeemInvite(chain, "x", "u")).toBeNull();
  });
  it("returns redeemed invite", async () => {
    const inv = { id: "inv_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([inv]));
    expect(await wi.redeemInvite(chain, "tok", "u")).toEqual(inv);
  });
});

describe("deleteInvite", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await wi.deleteInvite(chain, "x", "w")).toBeNull();
  });
  it("returns deleted invite", async () => {
    const inv = { id: "inv_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([inv]));
    expect(await wi.deleteInvite(chain, "inv_1", "w")).toEqual(inv);
  });
});

import { describe, it, expect, vi } from "vitest";
import * as memberQueries from "../../src/db/queries/member";

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

describe("member exports", () => {
  it("exports getMemberByUserAndWorkspace", () => { expect(typeof memberQueries.getMemberByUserAndWorkspace).toBe("function"); });
  it("exports listMembers", () => { expect(typeof memberQueries.listMembers).toBe("function"); });
  it("exports updateMemberGlobalInstruction", () => { expect(typeof memberQueries.updateMemberGlobalInstruction).toBe("function"); });
  it("exports createMember", () => { expect(typeof memberQueries.createMember).toBe("function"); });
  it("exports getMember", () => { expect(typeof memberQueries.getMember).toBe("function"); });
  it("exports deleteMember", () => { expect(typeof memberQueries.deleteMember).toBe("function"); });
});

describe("getMemberByUserAndWorkspace", () => {
  it("returns null when not found", async () => { expect(await memberQueries.getMemberByUserAndWorkspace(createSelectMock([]), "u", "w")).toBeNull(); });
  it("returns member", async () => { const m = { id: "mem_1" }; expect(await memberQueries.getMemberByUserAndWorkspace(createSelectMock([m]), "u", "w")).toEqual(m); });
});

describe("listMembers", () => {
  it("joins user table", async () => {
    const mockDb = createSelectMock([]);
    await memberQueries.listMembers(mockDb, "ws_1");
    expect(mockDb.innerJoin).toHaveBeenCalled();
  });
});

describe("updateMemberGlobalInstruction", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await memberQueries.updateMemberGlobalInstruction(chain, "u", "w", "x")).toBeNull();
  });
  it("returns updated member", async () => {
    const m = { id: "mem_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([m]));
    expect(await memberQueries.updateMemberGlobalInstruction(chain, "u", "w", "x")).toEqual(m);
  });
});

describe("createMember", () => {
  it("creates and returns member", async () => {
    const m = { id: "mem_1" };
    const mockDb = createSelectMock([m]);
    expect(await memberQueries.createMember(mockDb, { workspaceId: "w", userId: "u", role: "admin" })).toEqual(m);
  });
});

describe("getMember", () => {
  it("returns null when not found", async () => { expect(await memberQueries.getMember(createSelectMock([]), "x", "w")).toBeNull(); });
  it("returns member", async () => { const m = { id: "mem_1" }; expect(await memberQueries.getMember(createSelectMock([m]), "mem_1", "w")).toEqual(m); });
});

describe("deleteMember", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await memberQueries.deleteMember(chain, "x", "w")).toBeNull();
  });
  it("returns deleted member", async () => {
    const m = { id: "mem_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([m]));
    expect(await memberQueries.deleteMember(chain, "mem_1", "w")).toEqual(m);
  });
});

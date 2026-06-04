import { describe, it, expect, vi } from "vitest";
import * as mt from "../../src/db/queries/machine-token";

function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.innerJoin = vi.fn(() => chain);
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.orderBy = vi.fn(() => chain);
  return chain;
}

describe("machine-token exports", () => {
  it("exports createMachineToken", () => { expect(typeof mt.createMachineToken).toBe("function"); });
  it("exports getMachineTokenByToken", () => { expect(typeof mt.getMachineTokenByToken).toBe("function"); });
  it("exports getPendingMachineToken", () => { expect(typeof mt.getPendingMachineToken).toBe("function"); });
  it("exports registerMachineToken", () => { expect(typeof mt.registerMachineToken).toBe("function"); });
  it("exports activateMachineToken", () => { expect(typeof mt.activateMachineToken).toBe("function"); });
  it("exports getRegisteredTokenForUser", () => { expect(typeof mt.getRegisteredTokenForUser).toBe("function"); });
  it("exports getLatestTokenForUser", () => { expect(typeof mt.getLatestTokenForUser).toBe("function"); });
  it("exports listMachineTokens", () => { expect(typeof mt.listMachineTokens).toBe("function"); });
  it("exports deleteMachineToken", () => { expect(typeof mt.deleteMachineToken).toBe("function"); });
  it("exports updateMachineTokenLastUsed", () => { expect(typeof mt.updateMachineTokenLastUsed).toBe("function"); });
});

describe("createMachineToken", () => {
  it("creates token with defaults", async () => {
    const t = { id: "mt_1" };
    const mockDb = createSelectMock([t]);
    const result = await mt.createMachineToken(mockDb, { userId: "u", token: "tok", name: "T" });
    expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({ status: "active", workspaceId: null }));
    expect(result).toEqual(t);
  });
  it("uses custom status", async () => {
    const mockDb = createSelectMock([{ id: "mt_1" }]);
    await mt.createMachineToken(mockDb, { userId: "u", token: "tok", name: "T", status: "pending" });
    expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({ status: "pending" }));
  });
});

describe("getMachineTokenByToken", () => {
  it("returns null when not found", async () => { expect(await mt.getMachineTokenByToken(createSelectMock([]), "x")).toBeNull(); });
  it("returns token with join", async () => {
    const t = { id: "mt_1" };
    const mockDb = createSelectMock([t]);
    expect(await mt.getMachineTokenByToken(mockDb, "tok")).toEqual(t);
    expect(mockDb.innerJoin).toHaveBeenCalled();
  });
});

describe("getPendingMachineToken", () => {
  it("returns null when none", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await mt.getPendingMachineToken(chain, "u")).toBeNull();
  });
  it("returns pending token", async () => {
    const t = { id: "mt_1" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.limit = vi.fn(() => Promise.resolve([t]));
    expect(await mt.getPendingMachineToken(chain, "u")).toEqual(t);
  });
  it("handles workspaceId", async () => {
    const t = { id: "mt_1" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.limit = vi.fn(() => Promise.resolve([t]));
    expect(await mt.getPendingMachineToken(chain, "u", "ws_1")).toEqual(t);
  });
});

describe("registerMachineToken", () => {
  it("sets registered status with hostname and runtimes", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve());
    await mt.registerMachineToken(chain, "mt_1", "host.local", '[{"type":"claude"}]');
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      status: "registered",
      hostname: "host.local",
      runtimesJson: '[{"type":"claude"}]',
    }));
  });
});

describe("activateMachineToken", () => {
  it("sets active", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve());
    await mt.activateMachineToken(chain, "mt_1");
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: "active" }));
  });
  it("sets workspaceId when provided", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve());
    await mt.activateMachineToken(chain, "mt_1", "ws_1");
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_1" }));
  });
});

describe("getRegisteredTokenForUser", () => {
  it("returns null when none", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await mt.getRegisteredTokenForUser(chain, "u")).toBeNull();
  });
  it("returns registered token ordered by createdAt ASC", async () => {
    const t = { id: "mt_1", status: "registered" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([t]));
    expect(await mt.getRegisteredTokenForUser(chain, "u")).toEqual(t);
    expect(chain.orderBy).toHaveBeenCalled();
  });
});

describe("getLatestTokenForUser", () => {
  it("returns null when no tokens exist", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([]));
    expect(await mt.getLatestTokenForUser(chain, "u")).toBeNull();
  });
  it("returns latest token with status", async () => {
    const t = { id: "mt_1", status: "active" };
    const chain: any = {};
    chain.select = vi.fn(() => chain); chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve([t]));
    expect(await mt.getLatestTokenForUser(chain, "u")).toEqual(t);
  });
});

describe("deleteMachineToken", () => {
  it("deletes by id and userId", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve());
    await mt.deleteMachineToken(chain, "mt_1", "u");
    expect(chain.delete).toHaveBeenCalled();
  });
});

describe("updateMachineTokenLastUsed", () => {
  it("updates lastUsedAt", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve());
    await mt.updateMachineTokenLastUsed(chain, "mt_1");
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ lastUsedAt: expect.any(String) }));
  });
});

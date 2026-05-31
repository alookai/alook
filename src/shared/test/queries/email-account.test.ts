import { describe, it, expect, vi } from "vitest";
import * as ea from "../../src/db/queries/email-account";

function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("email-account exports", () => {
  it("exports createEmailAccount", () => { expect(typeof ea.createEmailAccount).toBe("function"); });
  it("exports getEmailAccount", () => { expect(typeof ea.getEmailAccount).toBe("function"); });
  it("exports getEmailAccountScoped", () => { expect(typeof ea.getEmailAccountScoped).toBe("function"); });
  it("exports getEmailAccountById", () => { expect(typeof ea.getEmailAccountById).toBe("function"); });
  it("exports getEmailAccountsByAgent", () => { expect(typeof ea.getEmailAccountsByAgent).toBe("function"); });
  it("exports updateEmailAccount", () => { expect(typeof ea.updateEmailAccount).toBe("function"); });
  it("exports deleteEmailAccount", () => { expect(typeof ea.deleteEmailAccount).toBe("function"); });
  it("exports getEmailAccountsByAgents", () => { expect(typeof ea.getEmailAccountsByAgents).toBe("function"); });
  it("exports getAllEmailAccountsForWorkspace", () => { expect(typeof ea.getAllEmailAccountsForWorkspace).toBe("function"); });
});

describe("createEmailAccount", () => {
  it("creates and returns account", async () => {
    const acc = { id: "ea_1" };
    const mockDb = createSelectMock([acc]);
    const result = await ea.createEmailAccount(mockDb, { agentId: "ag_1", workspaceId: "ws_1", emailAddress: "a@b.com", imapHost: "imap", imapUsername: "u", imapPassword: "p", smtpHost: "smtp", smtpUsername: "u", smtpPassword: "p" });
    expect(result).toEqual(acc);
  });
});

describe("getEmailAccount", () => {
  it("returns null when not found", async () => { expect(await ea.getEmailAccount(createSelectMock([]), "x", "w")).toBeNull(); });
  it("returns account", async () => { const a = { id: "ea_1" }; expect(await ea.getEmailAccount(createSelectMock([a]), "ea_1", "w")).toEqual(a); });
});

describe("getEmailAccountScoped", () => {
  it("returns null when not found", async () => { expect(await ea.getEmailAccountScoped(createSelectMock([]), "x", "a", "w")).toBeNull(); });
  it("returns account", async () => { const a = { id: "ea_1" }; expect(await ea.getEmailAccountScoped(createSelectMock([a]), "ea_1", "a", "w")).toEqual(a); });
});

describe("getEmailAccountById", () => {
  it("returns null when not found", async () => { expect(await ea.getEmailAccountById(createSelectMock([]), "x")).toBeNull(); });
  it("returns account", async () => { const a = { id: "ea_1" }; expect(await ea.getEmailAccountById(createSelectMock([a]), "ea_1")).toEqual(a); });
});

describe("updateEmailAccount", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await ea.updateEmailAccount(chain, "x", "w", { emailAddress: "a" })).toBeNull();
  });
  it("returns updated account", async () => {
    const a = { id: "ea_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([a]));
    expect(await ea.updateEmailAccount(chain, "ea_1", "w", { emailAddress: "a" })).toEqual(a);
  });
});

describe("deleteEmailAccount", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await ea.deleteEmailAccount(chain, "x", "w")).toBeNull();
  });
  it("returns deleted account", async () => {
    const a = { id: "ea_1" };
    const chain: any = {};
    chain.delete = vi.fn(() => chain); chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve([a]));
    expect(await ea.deleteEmailAccount(chain, "ea_1", "w")).toEqual(a);
  });
});

describe("getEmailAccountsByAgents", () => {
  it("returns empty for empty ids", async () => { expect(await ea.getEmailAccountsByAgents(null as any, [], "w")).toEqual([]); });
  it("returns accounts for agents", async () => {
    const mockDb = createSelectMock([{ id: "ea_1" }]);
    await ea.getEmailAccountsByAgents(mockDb, ["ag_1"], "w");
    expect(mockDb.where).toHaveBeenCalled();
  });
});

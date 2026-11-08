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

describe("getEmailAccount", () => {
  it("returns null when not found", async () => { expect(await ea.getEmailAccount(createSelectMock([]), "x", "w")).toBeNull(); });
  it("returns account", async () => { const a = { id: "ea_1" }; expect(await ea.getEmailAccount(createSelectMock([a]), "ea_1", "w")).toEqual(a); });
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

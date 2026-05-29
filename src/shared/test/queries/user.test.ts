import { describe, it, expect, vi } from "vitest";
import * as userQueries from "../../src/db/queries/user";

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

describe("user exports", () => {
  it("exports getUser", () => { expect(typeof userQueries.getUser).toBe("function"); });
  it("exports getUserByEmail", () => { expect(typeof userQueries.getUserByEmail).toBe("function"); });
  it("exports createUser", () => { expect(typeof userQueries.createUser).toBe("function"); });
  it("exports updateUser", () => { expect(typeof userQueries.updateUser).toBe("function"); });
});

describe("getUser", () => {
  it("returns null when not found", async () => { expect(await userQueries.getUser(createSelectMock([]), "x")).toBeNull(); });
  it("returns user", async () => { const u = { id: "u_1" }; expect(await userQueries.getUser(createSelectMock([u]), "u_1")).toEqual(u); });
});

describe("getUserByEmail", () => {
  it("returns null when not found", async () => { expect(await userQueries.getUserByEmail(createSelectMock([]), "x@x.com")).toBeNull(); });
  it("returns user", async () => { const u = { id: "u_1" }; expect(await userQueries.getUserByEmail(createSelectMock([u]), "a@b.com")).toEqual(u); });
});

describe("createUser", () => {
  it("creates user", async () => {
    const u = { id: "u_1" };
    expect(await userQueries.createUser(createSelectMock([u]), { name: "A", email: "a@b.com" })).toEqual(u);
  });
});

describe("updateUser", () => {
  it("returns null when not found", async () => {
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([]));
    expect(await userQueries.updateUser(chain, "x", { name: "B", image: null })).toBeNull();
  });
  it("returns updated user", async () => {
    const u = { id: "u_1" };
    const chain: any = {};
    chain.update = vi.fn(() => chain); chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain); chain.returning = vi.fn(() => Promise.resolve([u]));
    expect(await userQueries.updateUser(chain, "u_1", { name: "B", image: null })).toEqual(u);
  });
});

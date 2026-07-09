import { describe, it, expect, vi } from "vitest";
import * as userQueries from "../../src/db/queries/user";
import { computeDiscriminator } from "../../src/lib/discriminator";

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
  it("writes a generated discriminator instead of relying on the schema default", async () => {
    const chain = createSelectMock([{ id: "u_1" }]);
    await userQueries.createUser(chain, { name: "A", email: "a@b.com" });
    const values = chain.values.mock.calls[0][0];
    expect(values.id).toEqual(expect.any(String));
    expect(values.discriminator).toBe(computeDiscriminator(values.id));
    expect(values.discriminator).toMatch(/^\d{4}$/);
  });
  it("rejects empty name", async () => {
    await expect(
      userQueries.createUser(createSelectMock([{ id: "u_x" }]), { name: "", email: "a@b.com" }),
    ).rejects.toThrow(/user\.name cannot be empty/);
  });
  it("rejects whitespace-only name", async () => {
    await expect(
      userQueries.createUser(createSelectMock([{ id: "u_x" }]), { name: "   ", email: "a@b.com" }),
    ).rejects.toThrow(/user\.name cannot be empty/);
  });
});

describe("updateUser", () => {
  function createUpdateMock(rows: any[]) {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns null when not found", async () => {
    expect(await userQueries.updateUser(createUpdateMock([]), "x", { name: "B", image: null })).toBeNull();
  });
  it("returns updated user", async () => {
    const u = { id: "u_1" };
    expect(await userQueries.updateUser(createUpdateMock([u]), "u_1", { name: "B", image: null })).toEqual(u);
  });

  it("only name provided → set contains name and updatedAt, no image key", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    await userQueries.updateUser(chain, "u_1", { name: "B" });
    const arg = chain.set.mock.calls[0][0];
    expect(arg).toHaveProperty("name", "B");
    expect(arg).toHaveProperty("updatedAt");
    expect(arg).not.toHaveProperty("image");
  });

  it("only image (string) provided → set contains image and updatedAt, no name key", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    await userQueries.updateUser(chain, "u_1", { image: "https://example.com/a.png" });
    const arg = chain.set.mock.calls[0][0];
    expect(arg).toHaveProperty("image", "https://example.com/a.png");
    expect(arg).toHaveProperty("updatedAt");
    expect(arg).not.toHaveProperty("name");
  });

  it("image: null provided → set includes image: null (explicit clear)", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    await userQueries.updateUser(chain, "u_1", { image: null });
    const arg = chain.set.mock.calls[0][0];
    expect(arg).toHaveProperty("image", null);
    expect("image" in arg).toBe(true);
    expect(arg).not.toHaveProperty("name");
  });

  it("empty data {} → set contains only updatedAt", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    await userQueries.updateUser(chain, "u_1", {});
    const arg = chain.set.mock.calls[0][0];
    expect(Object.keys(arg)).toEqual(["updatedAt"]);
  });

  it("both provided → set contains name, image, and updatedAt", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    await userQueries.updateUser(chain, "u_1", { name: "B", image: null });
    const arg = chain.set.mock.calls[0][0];
    expect(arg).toHaveProperty("name", "B");
    expect(arg).toHaveProperty("image", null);
    expect(arg).toHaveProperty("updatedAt");
  });

  it("rejects whitespace-only name when explicitly provided", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    await expect(userQueries.updateUser(chain, "u_1", { name: "   " })).rejects.toThrow(
      /user\.name cannot be empty/,
    );
  });

  it("succeeds when name is a valid non-empty string", async () => {
    const chain = createUpdateMock([{ id: "u_1" }]);
    const result = await userQueries.updateUser(chain, "u_1", { name: "Alice" });
    expect(result).toEqual({ id: "u_1" });
    const arg = chain.set.mock.calls[0][0];
    expect(arg).toHaveProperty("name", "Alice");
  });
});

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

/** Like `createSelectMock`, but `.where(...)` returns a chainable (for the `.limit(1)` callers, e.g. `getUserByNameAndDiscriminator`). */
function createSelectLimitMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/**
 * Drizzle's built SQL condition objects are self-referencing (a column's
 * `.table` points back at the table, which lists every other column again —
 * including ones the condition never touches), so `JSON.stringify` throws,
 * and a naive walk would false-positive on any column purely because it's a
 * sibling on the same table. Walk the object graph by hand, tracking
 * visited nodes and skipping `.table` back-references, looking for a
 * drizzle column/field whose `name` is `columnName` — reachable only via an
 * actual queryChunks entry the condition builder produced.
 */
function conditionReferencesColumn(node: unknown, columnName: string, seen = new Set<unknown>()): boolean {
  if (node === null || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);
  if ((node as { name?: unknown }).name === columnName) return true;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "table") continue;
    if (Array.isArray(value)) {
      if (value.some((v) => conditionReferencesColumn(v, columnName, seen))) return true;
    } else if (conditionReferencesColumn(value, columnName, seen)) {
      return true;
    }
  }
  return false;
}

describe("user exports", () => {
  it("exports getUserPublic", () => { expect(typeof userQueries.getUserPublic).toBe("function"); });
  it("exports getUserSelf", () => { expect(typeof userQueries.getUserSelf).toBe("function"); });
  it("exports getUserByEmail", () => { expect(typeof userQueries.getUserByEmail).toBe("function"); });
  it("exports createUser", () => { expect(typeof userQueries.createUser).toBe("function"); });
  it("exports updateUser", () => { expect(typeof userQueries.updateUser).toBe("function"); });
});

describe("getUserPublic", () => {
  it("returns null when not found", async () => { expect(await userQueries.getUserPublic(createSelectMock([]), "x")).toBeNull(); });
  it("returns user", async () => { const u = { id: "u_1" }; expect(await userQueries.getUserPublic(createSelectMock([u]), "u_1")).toEqual(u); });
  it("filters on deletedAt unconditionally — no option can disable it", async () => {
    const chain = createSelectMock([{ id: "u_1" }]);
    await userQueries.getUserPublic(chain, "u_1");
    expect(conditionReferencesColumn(chain.where.mock.calls[0][0], "deletedAt")).toBe(true);
  });
});

describe("getUserSelf", () => {
  it("returns null when not found", async () => { expect(await userQueries.getUserSelf(createSelectMock([]), "x")).toBeNull(); });
  it("returns user", async () => { const u = { id: "u_1" }; expect(await userQueries.getUserSelf(createSelectMock([u]), "u_1")).toEqual(u); });
  it("never filters on deletedAt — self lookups see soft-deleted rows too", async () => {
    const chain = createSelectMock([{ id: "u_1" }]);
    await userQueries.getUserSelf(chain, "u_1");
    expect(conditionReferencesColumn(chain.where.mock.calls[0][0], "deletedAt")).toBe(false);
  });
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

describe("getUserByNameAndDiscriminator", () => {
  it("returns the exact match case-insensitively on name", async () => {
    const u = { id: "u_1", name: "Alice", discriminator: "1234" };
    const chain = createSelectLimitMock([u]);
    const result = await userQueries.getUserByNameAndDiscriminator(chain, "alice", "1234");
    expect(result).toEqual(u);
  });

  it("returns null on no match", async () => {
    const chain = createSelectLimitMock([]);
    const result = await userQueries.getUserByNameAndDiscriminator(chain, "nobody", "0000");
    expect(result).toBeNull();
  });

  it("filters on deletedAt unconditionally — public lookup, no option to disable it", async () => {
    const chain = createSelectLimitMock([{ id: "u_1" }]);
    await userQueries.getUserByNameAndDiscriminator(chain, "alice", "1234");
    expect(conditionReferencesColumn(chain.where.mock.calls[0][0], "deletedAt")).toBe(true);
  });
});

describe("getUserByNameCaseInsensitive", () => {
  it("returns the match case-insensitively on name", async () => {
    const u = { id: "u_1", name: "Alice" };
    const chain = createSelectMock([u]);
    const result = await userQueries.getUserByNameCaseInsensitive(chain, "alice");
    expect(result).toEqual(u);
  });

  it("returns null on no match", async () => {
    const result = await userQueries.getUserByNameCaseInsensitive(createSelectMock([]), "nobody");
    expect(result).toBeNull();
  });

  it("filters on deletedAt unconditionally — public lookup, no option to disable it", async () => {
    const chain = createSelectMock([{ id: "u_1" }]);
    await userQueries.getUserByNameCaseInsensitive(chain, "alice");
    expect(conditionReferencesColumn(chain.where.mock.calls[0][0], "deletedAt")).toBe(true);
  });
});

describe("searchUsersByName", () => {
  it("always filters out soft-deleted rows — isNull(deletedAt) is unconditional, not opt-in", async () => {
    const chain = createSelectLimitMock([{ id: "u_1", name: "Alice" }]);
    await userQueries.searchUsersByName(chain, "ali");
    const whereArg = chain.where.mock.calls[0][0];
    // drizzle's `and(...)` keeps every condition as a queryChunks entry —
    // there is no code path left that can build a call without the
    // deletedAt filter, unlike the old `opts?.excludeDeleted` flag.
    expect(conditionReferencesColumn(whereArg, "deletedAt")).toBe(true);
  });

  it("returns matches for a bare-name substring search", async () => {
    const u = { id: "u_1", name: "Alice" };
    const result = await userQueries.searchUsersByName(createSelectLimitMock([u]), "ali");
    expect(result).toEqual([u]);
  });

  it("exact (name, discriminator) match when discriminator is provided", async () => {
    const chain = createSelectLimitMock([{ id: "u_1", name: "Alice", discriminator: "1234" }]);
    await userQueries.searchUsersByName(chain, "Alice", { discriminator: "1234" });
    expect(chain.limit).toHaveBeenCalledWith(20);
  });

  it("excludeUserId narrows the query without changing the result shape", async () => {
    const u = { id: "u_2", name: "Bob" };
    const result = await userQueries.searchUsersByName(createSelectLimitMock([u]), "bob", {
      excludeUserId: "u_1",
    });
    expect(result).toEqual([u]);
  });

  it("respects a custom limit", async () => {
    const chain = createSelectLimitMock([]);
    await userQueries.searchUsersByName(chain, "x", { limit: 5 });
    expect(chain.limit).toHaveBeenCalledWith(5);
  });
});

describe("withUniqueDiscriminator", () => {
  it("happy path — never retries when insertFn succeeds on the first (unsalted) attempt", async () => {
    const insertFn = vi.fn(async (discriminator: string) => ({ discriminator }));
    const result = await userQueries.withUniqueDiscriminator(
      {} as any,
      { id: "u_fixed", name: "Alice" },
      insertFn,
    );
    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(insertFn).toHaveBeenCalledWith(computeDiscriminator("u_fixed"));
    expect(result).toEqual({ discriminator: computeDiscriminator("u_fixed") });
  });

  it("retries with a salted discriminator on isUniqueConstraintError, then succeeds", async () => {
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const insertFn = vi
      .fn<(discriminator: string) => Promise<{ discriminator: string }>>()
      .mockRejectedValueOnce(uniqueErr)
      .mockImplementationOnce(async (discriminator: string) => ({ discriminator }));

    const result = await userQueries.withUniqueDiscriminator(
      {} as any,
      { id: "u_collide", name: "Alice" },
      insertFn,
    );

    expect(insertFn).toHaveBeenCalledTimes(2);
    expect(insertFn).toHaveBeenNthCalledWith(1, computeDiscriminator("u_collide"));
    expect(insertFn).toHaveBeenNthCalledWith(2, computeDiscriminator("u_collide:1"));
    expect(result).toEqual({ discriminator: computeDiscriminator("u_collide:1") });
  });

  it("throws past the bounded attempt ceiling instead of looping forever", async () => {
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const insertFn = vi.fn(async () => {
      throw uniqueErr;
    });

    await expect(
      userQueries.withUniqueDiscriminator({} as any, { id: "u_always_collides", name: "Alice" }, insertFn),
    ).rejects.toBe(uniqueErr);
    // Bounded — doesn't retry forever.
    expect(insertFn.mock.calls.length).toBeGreaterThan(0);
    expect(insertFn.mock.calls.length).toBeLessThan(20);
  });

  it("rethrows immediately on a non-unique-constraint error (no retry)", async () => {
    const otherErr = new Error("D1_ERROR: something else broke");
    const insertFn = vi.fn(async () => {
      throw otherErr;
    });

    await expect(
      userQueries.withUniqueDiscriminator({} as any, { id: "u_x", name: "Alice" }, insertFn),
    ).rejects.toBe(otherErr);
    expect(insertFn).toHaveBeenCalledTimes(1);
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

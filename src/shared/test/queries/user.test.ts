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

function conditionContainsString(node: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (typeof node === "string") return node.includes(needle);
  if (node === null || typeof node !== "object") return false;
  if (seen.has(node)) return false;
  seen.add(node);
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "table") continue;
    if (Array.isArray(value)) {
      if (value.some((v) => conditionContainsString(v, needle, seen))) return true;
    } else if (conditionContainsString(value, needle, seen)) {
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

  it("escapes SQL LIKE metacharacters in name — `_` in input is a literal, not a wildcard", async () => {
    const chain = createSelectLimitMock([]);
    await userQueries.getUserByNameAndDiscriminator(chain, "A_ex", "0001");
    const where = chain.where.mock.calls[0][0];
    // Fragment must include an ESCAPE clause so the `\_` produced by
    // escapeLikePattern is honored (without it, SQLite ignores the
    // backslash and `_` remains a wildcard).
    expect(conditionContainsString(where, "ESCAPE")).toBe(true);
    // Escaped pattern (`A\_ex`) must be a parameter of the fragment.
    expect(conditionContainsString(where, "A\\_ex")).toBe(true);
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

  it("escapes SQL LIKE metacharacters in name — `%` in input is a literal, not a wildcard", async () => {
    const chain = createSelectMock([]);
    await userQueries.getUserByNameCaseInsensitive(chain, "admin%");
    const where = chain.where.mock.calls[0][0];
    expect(conditionContainsString(where, "ESCAPE")).toBe(true);
    expect(conditionContainsString(where, "admin\\%")).toBe(true);
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
    // Salt scheme is now `id:width:attempt`; first retry stays at width 4, attempt 1.
    expect(insertFn).toHaveBeenNthCalledWith(2, computeDiscriminator("u_collide:4:1", 4));
    expect(result).toEqual({ discriminator: computeDiscriminator("u_collide:4:1", 4) });
  });

  it("WIDENS by a digit after the per-width salt budget, never caps (A: variable-width)", async () => {
    // Every insert at width 4 collides; the allocator must exhaust the 5-try
    // width-4 budget then WIDEN to width 5 and keep going — the (A)-vs-(B)
    // behavior reversal (B threw at the cap; A never caps under real contention).
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const seen: string[] = [];
    const insertFn = vi.fn(async (discriminator: string) => {
      seen.push(discriminator);
      // Fail every width-4 (4-digit) attempt; succeed once a wider disc arrives.
      if (discriminator.length <= 4) throw uniqueErr;
      return { discriminator };
    });

    const result = await userQueries.withUniqueDiscriminator(
      {} as any,
      { id: "u_saturated", name: "Alice" },
      insertFn,
    );

    // All width-4 tries happened (bare + 4 salted), then a width-5 disc won.
    const width4 = seen.filter((d) => d.length === 4);
    const width5 = seen.filter((d) => d.length === 5);
    expect(width4.length).toBe(5); // MAX_DISCRIMINATOR_ATTEMPTS at width 4
    expect(width5.length).toBeGreaterThanOrEqual(1);
    expect(result.discriminator.length).toBe(5); // widened, not capped/thrown
  });

  it("stays loud — a widened insert failure still surfaces, never a silent dup", async () => {
    // A non-unique error mid-widen must rethrow immediately (loud), not be
    // swallowed as if it were a collision to retry past.
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const fatalErr = new Error("D1_ERROR: disk full");
    let n = 0;
    const insertFn = vi.fn(async () => {
      n += 1;
      throw n === 1 ? uniqueErr : fatalErr; // collide once, then a real fault
    });

    await expect(
      userQueries.withUniqueDiscriminator({} as any, { id: "u_loud", name: "Alice" }, insertFn),
    ).rejects.toBe(fatalErr);
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

describe("probeAvailableDiscriminator", () => {
  it("WIDENS the probe space instead of capping at 4 digits when width-4 is saturated", async () => {
    // The first 5 probes (the width-4 salt budget: bare id + :4:1..:4:4) come
    // back taken → the probe must WIDEN to 5 digits and return a wider disc,
    // NOT hand back a capped 4-digit salt. This is the ★ catch: the email-signup
    // probe path must never cap at 4 either.
    let probeIdx = 0;
    const stub: any = {
      select: () => stub,
      from: () => stub,
      where: () => stub,
      limit: () => {
        const taken = probeIdx < 5; // 5 width-4 probes taken, then free
        probeIdx += 1;
        return Promise.resolve(taken ? [{ id: "u_other" }] : []);
      },
    };

    const returned = await userQueries.probeAvailableDiscriminator(stub, {
      id: "u_collide",
      name: "Alice",
    });

    // 5 width-4 probes were taken, so the winner is the first width-5 disc.
    expect(returned.length).toBe(5);
    expect(returned).toBe(computeDiscriminator("u_collide:5:0", 5));
  });

  it("returns the first free salt on the happy path (still width 4)", async () => {
    // First probe (bare id) taken, second (id:4:1) free → second salt returned.
    const stub: any = {
      select: () => stub,
      from: () => stub,
      where: () => stub,
    };
    let calls = 0;
    stub.limit = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? [{ id: "u_other" }] : []);
    };

    const returned = await userQueries.probeAvailableDiscriminator(stub, {
      id: "u_ok",
      name: "Alice",
    });
    expect(returned).toBe(computeDiscriminator("u_ok:4:1", 4));
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

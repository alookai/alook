import { readFileSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/d1";
import { describe, it, expect, vi } from "vitest";
import * as userQueries from "../../src/db/queries/user";
import { computeDiscriminator } from "../../src/lib/discriminator";
import type { Database } from "../../src/db";

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-11-05T01:02:03.000Z";
type StoredUser = Record<string, unknown>;
type SeedUser = {
  id: string; name: string; discriminator: string; email?: string;
  image?: string | null; avatarVersion?: number; deletedAt?: string | null;
};

function publicUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "target", name: "Alice", email: "alice@fixture.test", emailVerified: true,
    image: "target.png", avatarVersion: 9, createdAt: OLD, updatedAt: OLD,
    discriminator: "0001", ...overrides,
  };
}

function createDatabase() {
  const sqlite = new Sqlite(":memory:");
  try {
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE user (
        id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL UNIQUE, emailVerified INTEGER, image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0, avatarObjectKey TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        isBot INTEGER NOT NULL DEFAULT 0, ownerUserId TEXT REFERENCES user(id),
        deletedAt TEXT, discriminator TEXT NOT NULL DEFAULT '0000', lastRefreshContextAt TEXT
      );
      CREATE TABLE account (
        id TEXT PRIMARY KEY NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
        accountId TEXT NOT NULL, providerId TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
    `);
    sqlite.exec(readFileSync(new URL("../../../web/migrations/0055_user_discriminator_unique.sql", import.meta.url), "utf8"));
    const queries: Array<{ params: unknown[]; rows: unknown[][] }> = [];
    const client = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              raw: async () => {
                const rows = sqlite.prepare(sql).raw(true).all(...params) as unknown[][];
                queries.push({ params: [...params], rows: rows.map(row => [...row]) });
                return rows;
              },
              all: async () => {
                const rows = sqlite.prepare(sql).all(...params) as StoredUser[];
                queries.push({ params: [...params], rows: rows.map(row => Object.values(row)) });
                return { success: true, results: rows };
              },
              run: async () => {
                const result = sqlite.prepare(sql).run(...params);
                queries.push({ params: [...params], rows: [] });
                return { success: true, results: [], meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) } };
              },
            };
          },
        };
      },
    };
    const db = drizzle(client as never) as unknown as Database;
    const insert = sqlite.prepare(`
      INSERT INTO user
        (id,name,email,emailVerified,image,avatarVersion,avatarObjectKey,createdAt,updatedAt,isBot,ownerUserId,deletedAt,discriminator)
      VALUES (?,?,?,1,?,?,?, ?,?,0,NULL,?,?)
    `);
    const seed = (value: SeedUser) => insert.run(
      value.id, value.name, value.email ?? `${value.id}@fixture.test`,
      value.image ?? null, value.avatarVersion ?? 0, `private-${value.id}`,
      OLD, OLD, value.deletedAt ?? null, value.discriminator,
    );
    seed({ id: "target", name: "Alice", email: "alice@fixture.test", image: "target.png", avatarVersion: 9, discriminator: "0001" });
    seed({ id: "other", name: "Other", image: "other.png", avatarVersion: 7, discriminator: "0002" });
    seed({ id: "gone", name: "Gone", image: "gone.png", avatarVersion: 5, discriminator: "0003", deletedAt: OLD });
    const seedAccount = (id: string, userId: string, providerId: string, accountId: string) => sqlite.prepare(
      "INSERT INTO account (id,userId,providerId,accountId,createdAt,updatedAt) VALUES (?,?,?,?,?,?)",
    ).run(id, userId, providerId, accountId, OLD, OLD);
    return { sqlite, db, queries, seed, seedAccount };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

type Store = ReturnType<typeof createDatabase>;
async function withDatabase(run: (store: Store) => Promise<void> | void) {
  let store: Store | undefined;
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  try {
    store = createDatabase();
    await run(store);
  } finally {
    try { store?.sqlite.close(); } finally { vi.useRealTimers(); }
  }
}

function snapshot(sqlite: Sqlite.Database) {
  return sqlite.prepare("SELECT * FROM user ORDER BY id").all() as StoredUser[];
}

function expectOnlyTargetChange(sqlite: Sqlite.Database, before: StoredUser[], changes: StoredUser) {
  expect(snapshot(sqlite)).toEqual(before.map(row => row.id === "target" ? { ...row, ...changes } : row));
}

function expectNoDriverIdentities(store: Store, forbidden: string[]) {
  const values = new Set(store.queries.flatMap(query => query.rows.flat()));
  for (const id of forbidden) expect(values.has(id)).toBe(false);
}

function expectUsers(actual: unknown[], expected: ReturnType<typeof publicUser>[]) {
  const ordered = (rows: unknown[]) => [...rows].sort((a, b) => String((a as StoredUser).id).localeCompare(String((b as StoredUser).id)));
  expect(actual).toHaveLength(expected.length);
  expect(ordered(actual)).toEqual(ordered(expected));
}

describe("getUserPublic", () => {
  it("returns null when not found", async () => {
    await withDatabase(async store => {
      await expect(userQueries.getUserPublic(store.db, "missing")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("reads the live public user and excludes a deleted target without leaking internal columns", async () => {
    await withDatabase(async store => {
      await expect(userQueries.getUserPublic(store.db, "target")).resolves.toEqual(publicUser());
      expectNoDriverIdentities(store, ["other", "gone"]);
      store.queries.length = 0;
      store.sqlite.prepare("UPDATE user SET deletedAt=? WHERE id=?").run(NOW, "target");
      await expect(userQueries.getUserPublic(store.db, "target")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });
});

describe("getUserSelf", () => {
  it("returns null when not found", async () => {
    await withDatabase(async store => {
      await expect(userQueries.getUserSelf(store.db, "missing")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("resolves the same exact self identity before and after soft deletion", async () => {
    await withDatabase(async store => {
      await expect(userQueries.getUserSelf(store.db, "target")).resolves.toEqual(publicUser());
      store.sqlite.prepare("UPDATE user SET deletedAt=? WHERE id=?").run(NOW, "target");
      await expect(userQueries.getUserSelf(store.db, "target")).resolves.toEqual(publicUser());
      expectNoDriverIdentities(store, ["other", "gone"]);
    });
  });
});

describe("getUsersByIds", () => {
  it("does not query for an empty input", async () => {
    const db = { select: vi.fn() };
    await expect(userQueries.getUsersByIds(db as never, [])).resolves.toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns requested existing users across chunks without inventing a missing identity", async () => {
    await withDatabase(async store => {
      const ids = Array.from({ length: 105 }, (_, index) => `requested-${index}`);
      const expected = ids.map((id, index) => publicUser({ id, name: `Requested ${index}`, email: `${id}@fixture.test`, image: null, avatarVersion: 0, discriminator: "0042" }));
      store.sqlite.transaction(() => {
        for (const [index, id] of ids.entries()) store.seed({ id, name: `Requested ${index}`, discriminator: "0042" });
      })();
      const input = [...ids, "missing", ids[0]!, ids[100]!];
      const before = [...input];
      const rows = await userQueries.getUsersByIds(store.db, input);
      expectUsers(rows, expected);
      expect(input).toEqual(before);
      expectNoDriverIdentities(store, ["target", "other", "gone"]);
      expect(store.queries.length).toBeGreaterThan(0);
      for (const query of store.queries) expect(query.params.length).toBeLessThanOrEqual(100);
    });
  });

  it("returns the public historical projection for requested live and tombstone identities", async () => {
    await withDatabase(async store => {
      const rows = await userQueries.getUsersByIds(store.db, ["gone", "target"]);
      expectUsers(rows, [publicUser(), publicUser({ id: "gone", name: "Gone", email: "gone@fixture.test", image: "gone.png", avatarVersion: 5, discriminator: "0003" })]);
      expectNoDriverIdentities(store, ["other"]);
    });
  });
});

describe("getUserByEmail", () => {
  it("resolves the exact internal email including tombstones and returns null for an absent address", async () => {
    await withDatabase(async store => {
      await expect(userQueries.getUserByEmail(store.db, "alice@fixture.test")).resolves.toEqual(publicUser());
      store.sqlite.prepare("UPDATE user SET deletedAt=? WHERE id=?").run(NOW, "target");
      await expect(userQueries.getUserByEmail(store.db, "alice@fixture.test")).resolves.toEqual(publicUser());
      expectNoDriverIdentities(store, ["other", "gone"]);
      store.queries.length = 0;
      await expect(userQueries.getUserByEmail(store.db, "absent@fixture.test")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });
});

describe("getUserByProviderAccount", () => {
  it("resolves only the exact provider and subject pair despite neighboring identities", async () => {
    await withDatabase(async store => {
      store.seedAccount("correct", "target", "apple", "stable-sub");
      store.seedAccount("other-provider", "other", "google", "stable-sub");
      store.seedAccount("other-subject", "gone", "apple", "different-sub");
      await expect(userQueries.getUserByProviderAccount(store.db, "apple", "stable-sub")).resolves.toEqual(publicUser());
      expectNoDriverIdentities(store, ["other", "gone"]);
    });
  });

  it("returns null when the identity has never been seen", async () => {
    await withDatabase(async store => {
      store.seedAccount("other-subject", "target", "apple", "different-sub");
      store.seedAccount("other-provider", "other", "google", "new-sub");
      await expect(userQueries.getUserByProviderAccount(store.db, "apple", "new-sub")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("fails closed when two valid stored users share the same provider identity", async () => {
    await withDatabase(async store => {
      store.seedAccount("first", "target", "apple", "duplicate-sub");
      await expect(userQueries.getUserByProviderAccount(store.db, "apple", "duplicate-sub")).resolves.toEqual(publicUser());
      store.seedAccount("second", "other", "apple", "duplicate-sub");
      const before = snapshot(store.sqlite);
      await expect(userQueries.getUserByProviderAccount(store.db, "apple", "duplicate-sub")).rejects.toThrow();
      expect(snapshot(store.sqlite)).toEqual(before);
    });
  });
});

describe("createUser", () => {
  it("creates and returns the stored public user", async () => {
    await withDatabase(async store => {
      const result = await userQueries.createUser(store.db, { name: "Created", email: "created@fixture.test" });
      expect(result.id).toEqual(expect.any(String));
      expect(result.id.length).toBeGreaterThan(0);
      expect(result.discriminator).toMatch(/^\d{4}$/);
      expect(result).toEqual(publicUser({ id: result.id, name: "Created", email: "created@fixture.test", emailVerified: null, image: null, avatarVersion: 0, createdAt: NOW, updatedAt: NOW, discriminator: result.discriminator }));
      expect(store.sqlite.prepare("SELECT id,name,email,discriminator FROM user WHERE id=?").get(result.id)).toEqual({ id: result.id, name: "Created", email: "created@fixture.test", discriminator: result.discriminator });
    });
  });

  it("stores an available generated discriminator instead of the occupied schema default", async () => {
    await withDatabase(async store => {
      store.seed({ id: "default-occupied", name: "Created", discriminator: "0000" });
      const result = await userQueries.createUser(store.db, { name: "Created", email: "created@fixture.test" });
      expect(result.discriminator).toMatch(/^\d{4,18}$/);
      expect(result.discriminator).not.toBe("0000");
      expect(store.sqlite.prepare("SELECT id,discriminator FROM user WHERE name='Created' ORDER BY id").all())
        .toEqual([{ id: "default-occupied", discriminator: "0000" }, { id: result.id, discriminator: result.discriminator }].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      expect(store.sqlite.prepare("SELECT count(*) AS count FROM user WHERE name=? AND discriminator=?").get("Created", result.discriminator)).toEqual({ count: 1 });
    });
  });

  it("rejects empty name without a durable write", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.createUser(store.db, { name: "", email: "created@fixture.test" })).rejects.toThrow();
      expect(snapshot(store.sqlite)).toEqual(before);
    });
  });

  it("rejects whitespace-only name without a durable write", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.createUser(store.db, { name: "   ", email: "created@fixture.test" })).rejects.toThrow();
      expect(snapshot(store.sqlite)).toEqual(before);
    });
  });
});

describe("getUserByNameAndDiscriminator", () => {
  it("returns the case-insensitive name and exact discriminator match", async () => {
    await withDatabase(async store => {
      store.seed({ id: "other-number", name: "Alice", discriminator: "0009" });
      store.seed({ id: "other-name", name: "Alicia", discriminator: "0001" });
      await expect(userQueries.getUserByNameAndDiscriminator(store.db, "aLiCe", "0001")).resolves.toEqual(publicUser());
      expectNoDriverIdentities(store, ["other-number", "other-name", "other", "gone"]);
    });
  });

  it("returns null when neither nearby handle is the requested pair", async () => {
    await withDatabase(async store => {
      store.seed({ id: "other-number", name: "Alice", discriminator: "0009" });
      await expect(userQueries.getUserByNameAndDiscriminator(store.db, "Alice", "0042")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("excludes a soft-deleted exact handle", async () => {
    await withDatabase(async store => {
      store.sqlite.prepare("UPDATE user SET deletedAt=? WHERE id=?").run(NOW, "target");
      await expect(userQueries.getUserByNameAndDiscriminator(store.db, "Alice", "0001")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("matches literal handle metacharacters without admitting wildcard neighbors", async () => {
    await withDatabase(async store => {
      const cases = [{ name: "A_ex", decoy: "Abex" }, { name: "B%ex", decoy: "Blongex" }, { name: "C\\ex", decoy: "Cex" }];
      for (const [index, value] of cases.entries()) {
        const id = `literal-${index}`;
        store.seed({ id: `wildcard-${index}`, name: value.decoy, discriminator: "0042" });
        store.seed({ id, name: value.name, discriminator: "0042" });
        const result = await userQueries.getUserByNameAndDiscriminator(store.db, value.name, "0042");
        expect(result).toEqual(publicUser({ id, name: value.name, email: `${id}@fixture.test`, image: null, avatarVersion: 0, discriminator: "0042" }));
        store.queries.length = 0;
        store.sqlite.prepare("DELETE FROM user WHERE id=?").run(id);
        await expect(userQueries.getUserByNameAndDiscriminator(store.db, value.name, "0042")).resolves.toBeNull();
        expect(store.queries.flatMap(query => query.rows)).toEqual([]);
      }
    });
  });
});

describe("getUserByNameCaseInsensitive", () => {
  it("returns the literal case-insensitive name match", async () => {
    await withDatabase(async store => {
      store.seed({ id: "prefix-only", name: "Alicia", discriminator: "0001" });
      await expect(userQueries.getUserByNameCaseInsensitive(store.db, "aLiCe")).resolves.toEqual(publicUser());
      expectNoDriverIdentities(store, ["prefix-only", "other", "gone"]);
    });
  });

  it("returns null on no match", async () => {
    await withDatabase(async store => {
      await expect(userQueries.getUserByNameCaseInsensitive(store.db, "Nobody")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("excludes soft-deleted bare-name matches", async () => {
    await withDatabase(async store => {
      store.sqlite.prepare("UPDATE user SET deletedAt=? WHERE id=?").run(NOW, "target");
      await expect(userQueries.getUserByNameCaseInsensitive(store.db, "alice")).resolves.toBeNull();
      expect(store.queries.flatMap(query => query.rows)).toEqual([]);
    });
  });

  it("matches literal bare-name metacharacters without wildcard expansion", async () => {
    await withDatabase(async store => {
      for (const [index, value] of [{ name: "A%ex", decoy: "Alongex" }, { name: "B_ex", decoy: "Bbex" }, { name: "C\\ex", decoy: "Cex" }].entries()) {
        const id = `literal-${index}`;
        store.seed({ id: `wildcard-${index}`, name: value.decoy, discriminator: "0042" });
        store.seed({ id, name: value.name, discriminator: "0042" });
        await expect(userQueries.getUserByNameCaseInsensitive(store.db, value.name)).resolves.toEqual(publicUser({ id, name: value.name, email: `${id}@fixture.test`, image: null, avatarVersion: 0, discriminator: "0042" }));
        store.queries.length = 0;
        store.sqlite.prepare("DELETE FROM user WHERE id=?").run(id);
        await expect(userQueries.getUserByNameCaseInsensitive(store.db, value.name)).resolves.toBeNull();
        expect(store.queries.flatMap(query => query.rows)).toEqual([]);
      }
    });
  });
});

describe("searchUsersByName", () => {
  it("excludes deleted matches before returning public search results", async () => {
    await withDatabase(async store => {
      store.sqlite.prepare("UPDATE user SET name='Alina' WHERE id='gone'").run();
      expectUsers(await userQueries.searchUsersByName(store.db, "ali"), [publicUser()]);
      expectNoDriverIdentities(store, ["other", "gone"]);
    });
  });

  it("returns actual substring matches without unrequested identities", async () => {
    await withDatabase(async store => {
      store.seed({ id: "inside", name: "Malice", discriminator: "0042" });
      expectUsers(await userQueries.searchUsersByName(store.db, "ali"), [publicUser(), publicUser({ id: "inside", name: "Malice", email: "inside@fixture.test", image: null, avatarVersion: 0, discriminator: "0042" })]);
      expectNoDriverIdentities(store, ["other", "gone"]);
    });
  });

  it("narrows an exact name search to the requested discriminator", async () => {
    await withDatabase(async store => {
      store.seed({ id: "other-number", name: "Alice", discriminator: "0009" });
      store.seed({ id: "prefix-only", name: "Alicia", discriminator: "0001" });
      expectUsers(await userQueries.searchUsersByName(store.db, "Alice", { discriminator: "0001" }), [publicUser()]);
      expectNoDriverIdentities(store, ["other-number", "prefix-only", "other", "gone"]);
    });
  });

  it("excludes an otherwise matching user without removing another valid match", async () => {
    await withDatabase(async store => {
      store.sqlite.prepare("UPDATE user SET name='Bob' WHERE id='target'").run();
      store.sqlite.prepare("UPDATE user SET name='Bobby' WHERE id='other'").run();
      expectUsers(await userQueries.searchUsersByName(store.db, "bob", { excludeUserId: "target" }), [publicUser({ id: "other", name: "Bobby", email: "other@fixture.test", image: "other.png", avatarVersion: 7, discriminator: "0002" })]);
      expectNoDriverIdentities(store, ["target", "gone"]);
    });
  });

  it("applies a positive custom limit to more eligible rows than the limit", async () => {
    await withDatabase(async store => {
      const allowed = new Map<string, ReturnType<typeof publicUser>>();
      for (let index = 0; index < 6; index++) {
        const id = `match-${index}`;
        store.seed({ id, name: `Limit Match ${index}`, discriminator: "0042" });
        allowed.set(id, publicUser({ id, name: `Limit Match ${index}`, email: `${id}@fixture.test`, image: null, avatarVersion: 0, discriminator: "0042" }));
      }
      const rows = await userQueries.searchUsersByName(store.db, "Limit Match", { limit: 5 });
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map(row => row.id)).size).toBe(5);
      for (const row of rows) expect(row).toEqual(allowed.get(row.id));
      expectNoDriverIdentities(store, ["target", "other", "gone"]);
    });
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

  it("retries a persistent collision and returns the actual successful callback value", async () => {
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    let occupied: string | undefined;
    let committed: { discriminator: string; marker: string } | undefined;
    const insertFn = vi.fn(async (discriminator: string) => {
      occupied ??= discriminator;
      if (discriminator === occupied) throw uniqueErr;
      committed = { discriminator, marker: "committed" };
      return committed;
    });
    const result = await userQueries.withUniqueDiscriminator({} as never, { id: "u_collide", name: "Alice" }, insertFn);
    expect(insertFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(result).toBe(committed);
    expect(result.discriminator).not.toBe(occupied);
    expect(result.discriminator).toMatch(/^\d{4,18}$/);
  });

  it("widens when every four-digit callback candidate remains occupied", async () => {
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const seen: string[] = [];
    const insertFn = vi.fn(async (discriminator: string) => {
      seen.push(discriminator);
      if (discriminator.length === 4) throw uniqueErr;
      return { discriminator };
    });
    const result = await userQueries.withUniqueDiscriminator({} as never, { id: "u_saturated", name: "Alice" }, insertFn);
    expect(seen.filter(value => value.length === 4).length).toBeGreaterThan(0);
    expect(result.discriminator).toMatch(/^\d{5}$/);
    expect(seen.at(-1)).toBe(result.discriminator);
  });

  it("rethrows the same fatal error after the allocator reaches a wider discriminator", async () => {
    const uniqueErr = Object.assign(new Error("UNIQUE constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    const fatalErr = new Error("D1_ERROR: disk full");
    const widths: number[] = [];
    const insertFn = vi.fn(async (discriminator: string): Promise<never> => {
      widths.push(discriminator.length);
      throw discriminator.length === 4 ? uniqueErr : fatalErr;
    });
    await expect(userQueries.withUniqueDiscriminator({} as never, { id: "u_loud", name: "Alice" }, insertFn)).rejects.toBe(fatalErr);
    expect(widths.some(width => width === 4)).toBe(true);
    expect(widths.some(width => width > 4)).toBe(true);
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

  it("retries only the selected signature and returns the successful callback winner", async () => {
    const columns = ["community_server.name", "community_server.discriminator"];
    const error = new Error("Driver error", { cause: new Error("UNIQUE constraint failed: community_server.name, community_server.discriminator") });
    const seen: string[] = [];
    const insertFn = vi.fn(async (discriminator: string) => {
      seen.push(discriminator);
      if (seen.length === 1) throw error;
      return discriminator;
    });
    const result = await userQueries.withUniqueDiscriminator({} as never, { id: "selected", name: "Server" }, insertFn, columns);
    expect(insertFn).toHaveBeenCalledTimes(2);
    expect(result).toBe(seen[1]);
    expect(result).toMatch(/^\d{4,18}$/);
  });

  it.each([
    new Error("UNIQUE constraint failed: community_category.server_id, community_category.name"),
    Object.assign(new Error("constraint failed"), { code: "SQLITE_CONSTRAINT_UNIQUE" }),
    new Error("FOREIGN KEY constraint failed"),
    new Error("injected abort"),
  ])("preserves a nonmatching batch error without salt retry: %s", async (error) => {
    const insertFn = vi.fn(async () => { throw error; });
    await expect(userQueries.withUniqueDiscriminator({} as any, { id: "selected", name: "Server" }, insertFn,
      ["community_server.name", "community_server.discriminator"]))
      .rejects.toBe(error);
    expect(insertFn).toHaveBeenCalledTimes(1);
  });
});

describe("probeAvailableDiscriminator", () => {
  it("widens only after the actual four-digit name namespace is occupied", async () => {
    await withDatabase(async store => {
      store.sqlite.transaction(() => {
        for (let value = 0; value < 10000; value++) {
          const discriminator = String(value).padStart(4, "0");
          store.seed({ id: `occupied-${discriminator}`, name: "ProbeScope", discriminator });
        }
      })();
      expect(store.sqlite.prepare("SELECT count(*) AS count FROM user WHERE name='ProbeScope'").get()).toEqual({ count: 10000 });
      const result = await userQueries.probeAvailableDiscriminator(store.db, { id: "u_collide", name: "ProbeScope" });
      expect(result).toMatch(/^\d{5}$/);
      expect(store.sqlite.prepare("SELECT count(*) AS count FROM user WHERE name=? AND discriminator=? AND deletedAt IS NULL").get("ProbeScope", result)).toEqual({ count: 0 });
    });
  });

  it("returns an actually available four-digit candidate after the initial occupied value", async () => {
    await withDatabase(async store => {
      const occupied = computeDiscriminator("u_ok");
      store.seed({ id: "initial-occupied", name: "ProbeScope", discriminator: occupied });
      const result = await userQueries.probeAvailableDiscriminator(store.db, { id: "u_ok", name: "ProbeScope" });
      expect(result).toMatch(/^\d{4}$/);
      expect(result).not.toBe(occupied);
      expect(store.sqlite.prepare("SELECT count(*) AS count FROM user WHERE name=? AND discriminator=? AND deletedAt IS NULL").get("ProbeScope", result)).toEqual({ count: 0 });
      expect(store.sqlite.prepare("SELECT discriminator FROM user WHERE id='initial-occupied'").get()).toEqual({ discriminator: occupied });
    });
  });
});

describe("updateUser", () => {
  it("returns null for an absent target without changing other stored users", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "missing", { name: "New", image: null })).resolves.toBeNull();
      expect(snapshot(store.sqlite)).toEqual(before);
    });
  });

  it("updates a valid name while preserving the target image and every other user's state", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "target", { name: "New" })).resolves.toEqual(publicUser({ name: "New", updatedAt: NOW }));
      expectOnlyTargetChange(store.sqlite, before, { name: "New", updatedAt: NOW });
      expectNoDriverIdentities(store, ["other", "gone"]);
    });
  });

  it("updates only the image while preserving the target name and foreign users", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "target", { image: "https://example.test/new.png" })).resolves.toEqual(publicUser({ image: "https://example.test/new.png", updatedAt: NOW }));
      expectOnlyTargetChange(store.sqlite, before, { image: "https://example.test/new.png", updatedAt: NOW });
    });
  });

  it("clears a nonnull image without clearing the name or changing other users", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "target", { image: null })).resolves.toEqual(publicUser({ image: null, updatedAt: NOW }));
      expectOnlyTargetChange(store.sqlite, before, { image: null, updatedAt: NOW });
    });
  });

  it("touches only the target timestamp for an empty update payload", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "target", {})).resolves.toEqual(publicUser({ updatedAt: NOW }));
      expectOnlyTargetChange(store.sqlite, before, { updatedAt: NOW });
    });
  });

  it("persists both fields for only the target and returns the stored public user", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "target", { name: "New", image: null })).resolves.toEqual(publicUser({ name: "New", image: null, updatedAt: NOW }));
      expectOnlyTargetChange(store.sqlite, before, { name: "New", image: null, updatedAt: NOW });
    });
  });

  it("rejects a whitespace-only name without changing the target or neighbors", async () => {
    await withDatabase(async store => {
      const before = snapshot(store.sqlite);
      await expect(userQueries.updateUser(store.db, "target", { name: "   " })).rejects.toThrow();
      expect(snapshot(store.sqlite)).toEqual(before);
    });
  });
});

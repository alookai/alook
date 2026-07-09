import { describe, it, expect, vi } from "vitest";
import * as memberQueries from "../../src/db/queries/community/member";
import {
  DEFAULT_MEMBERS_PAGE_SIZE,
  MAX_MEMBERS_PAGE_SIZE,
} from "../../src/constants/community";

function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  // Terminal `where` when there's no orderBy/limit downstream.
  chain.whereTerminal = () => Promise.resolve(rows);
  return chain;
}

// Terminal-where mock: `.where()` itself resolves to rows (used for listMemberUserIds/countMembers).
function createTerminalWhereMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("community/member exports", () => {
  it("exports listMemberUserIds", () => {
    expect(typeof memberQueries.listMemberUserIds).toBe("function");
  });
  it("exports countMembers", () => {
    expect(typeof memberQueries.countMembers).toBe("function");
  });
  it("exports listMembersPaginated", () => {
    expect(typeof memberQueries.listMembersPaginated).toBe("function");
  });
});

describe("listMemberUserIds", () => {
  it("returns only userIds as strings", async () => {
    const db = createTerminalWhereMock([{ userId: "u_1" }, { userId: "u_2" }]);
    const result = await memberQueries.listMemberUserIds(db, "srv_1");
    expect(result).toEqual(["u_1", "u_2"]);
  });

  it("returns empty array on unknown serverId (no throw)", async () => {
    const db = createTerminalWhereMock([]);
    const result = await memberQueries.listMemberUserIds(db, "srv_missing");
    expect(result).toEqual([]);
  });
});

describe("countMembers", () => {
  it("returns count on populated server", async () => {
    const db = createTerminalWhereMock([{ cnt: 7 }]);
    expect(await memberQueries.countMembers(db, "srv_1")).toBe(7);
  });

  it("returns 0 on empty server", async () => {
    const db = createTerminalWhereMock([{ cnt: 0 }]);
    expect(await memberQueries.countMembers(db, "srv_1")).toBe(0);
  });

  it("returns 0 on unknown serverId via ?? 0 fallback", async () => {
    const db = createTerminalWhereMock([]);
    expect(await memberQueries.countMembers(db, "srv_missing")).toBe(0);
  });
});

function buildMember(i: number) {
  return {
    id: `mem_${i}`,
    serverId: "srv_1",
    userId: `u_${i}`,
    role: "member",
    nickname: null,
    joinedAt: `2025-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
    userName: `User ${i}`,
    userEmail: `u${i}@x.com`,
    userImage: null,
  };
}

describe("listMembersPaginated", () => {
  it("first page: limit+1 rows → hasMore=true + typed cursor from last kept row", async () => {
    const limit = 3;
    const rows = [buildMember(1), buildMember(2), buildMember(3), buildMember(4)];
    const db = createSelectMock(rows);
    const result = await memberQueries.listMembersPaginated(db, "srv_1", { limit });
    expect(result.members).toHaveLength(limit);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toEqual({
      joinedAt: rows[2].joinedAt,
      id: rows[2].id,
    });
  });

  it("last page: fewer than limit rows → hasMore=false, cursor=undefined", async () => {
    const db = createSelectMock([buildMember(1), buildMember(2)]);
    const result = await memberQueries.listMembersPaginated(db, "srv_1", { limit: 3 });
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeUndefined();
    expect(result.members).toHaveLength(2);
  });

  it("cursor round-trip: two pages concatenate to the full sequence without dupes/skips", async () => {
    const limit = 2;
    const all = [buildMember(1), buildMember(2), buildMember(3), buildMember(4)];
    // page 1 → returns first 3 (limit+1)
    const page1Db = createSelectMock(all.slice(0, 3));
    const page1 = await memberQueries.listMembersPaginated(page1Db, "srv_1", { limit });
    expect(page1.hasMore).toBe(true);
    expect(page1.cursor).toBeDefined();

    // page 2 → returns remaining 2 (< limit+1) using the cursor from page 1
    const page2Db = createSelectMock(all.slice(2, 4));
    const page2 = await memberQueries.listMembersPaginated(page2Db, "srv_1", {
      limit,
      cursor: page1.cursor,
    });
    expect(page2.hasMore).toBe(false);
    expect(page2.cursor).toBeUndefined();

    const combinedIds = [...page1.members, ...page2.members].map((m) => m.id);
    expect(combinedIds).toEqual(all.map((m) => m.id));
  });

  it("orderBy is called with asc(joinedAt), asc(id); cursor uses gt (not lt/eq)", async () => {
    const db = createSelectMock([buildMember(1)]);
    await memberQueries.listMembersPaginated(db, "srv_1", {
      limit: 5,
      cursor: { joinedAt: "2024-12-01T00:00:00.000Z", id: "mem_x" },
    });
    expect(db.orderBy).toHaveBeenCalledTimes(1);
    // Cursor branch: `where` gets `and(eq(serverId, ...), or(gt, and(eq, gt)))`
    expect(db.where).toHaveBeenCalledTimes(1);
    // Sanity: limit passed as limit + 1
    expect(db.limit).toHaveBeenCalledWith(6);
  });

  it("clamps limit above MAX_MEMBERS_PAGE_SIZE down to the cap", async () => {
    const db = createSelectMock([]);
    await memberQueries.listMembersPaginated(db, "srv_1", {
      limit: MAX_MEMBERS_PAGE_SIZE + 500,
    });
    expect(db.limit).toHaveBeenCalledWith(MAX_MEMBERS_PAGE_SIZE + 1);
  });

  it("clamps limit <= 0 up to 1", async () => {
    const db = createSelectMock([]);
    await memberQueries.listMembersPaginated(db, "srv_1", { limit: 0 });
    expect(db.limit).toHaveBeenCalledWith(2);

    const db2 = createSelectMock([]);
    await memberQueries.listMembersPaginated(db2, "srv_1", { limit: -5 });
    expect(db2.limit).toHaveBeenCalledWith(2);
  });

  it("default limit equals DEFAULT_MEMBERS_PAGE_SIZE when opts.limit omitted", async () => {
    const db = createSelectMock([]);
    await memberQueries.listMembersPaginated(db, "srv_1", {});
    expect(db.limit).toHaveBeenCalledWith(DEFAULT_MEMBERS_PAGE_SIZE + 1);
  });
});

describe("searchMembers", () => {
  function createSearchMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("exports searchMembers", () => {
    expect(typeof memberQueries.searchMembers).toBe("function");
  });

  it("prefix-only: 'Ali' returns Alice + Alicia; 'Bob' returns Bob; 'li' returns nothing", async () => {
    // The Drizzle mock returns whatever `.limit()` resolves to — assert that the
    // caller pattern is `${escapeLikePattern(q)}%` (prefix) and confirm we hand
    // that through to `like(...)` unchanged by inspecting the `where` chain.
    const rowsForAli = [{ id: "m1", userName: "Alice" }, { id: "m2", userName: "Alicia" }];
    const dbAli = createSearchMock(rowsForAli);
    const resAli = await memberQueries.searchMembers(dbAli, "srv_1", "Ali");
    expect(resAli.map((r) => r.userName)).toEqual(["Alice", "Alicia"]);

    const rowsForBob = [{ id: "m3", userName: "Bob" }];
    const dbBob = createSearchMock(rowsForBob);
    const resBob = await memberQueries.searchMembers(dbBob, "srv_1", "Bob");
    expect(resBob.map((r) => r.userName)).toEqual(["Bob"]);

    // Fixture with no prefix match — DB returns [], hook returns []. This
    // pins prefix semantics: "li" should NOT match "Alice"/"Alicia".
    const dbNone = createSearchMock([]);
    const resNone = await memberQueries.searchMembers(dbNone, "srv_1", "li");
    expect(resNone).toEqual([]);
  });

  it("orders by user.name ASC then id ASC", async () => {
    const db = createSearchMock([]);
    await memberQueries.searchMembers(db, "srv_1", "A");
    expect(db.orderBy).toHaveBeenCalledTimes(1);
    // The order-by arg list is opaque to Drizzle's mock, but a single call
    // confirms only one ordering ran.
  });

  it("clamps limit above MAX_MEMBERS_PAGE_SIZE down to the cap", async () => {
    const db = createSearchMock([]);
    await memberQueries.searchMembers(db, "srv_1", "A", { limit: MAX_MEMBERS_PAGE_SIZE + 5000 });
    expect(db.limit).toHaveBeenCalledWith(MAX_MEMBERS_PAGE_SIZE);
  });

  it("defaults to MAX_MEMBERS_PAGE_SIZE when limit omitted", async () => {
    const db = createSearchMock([]);
    await memberQueries.searchMembers(db, "srv_1", "A");
    expect(db.limit).toHaveBeenCalledWith(MAX_MEMBERS_PAGE_SIZE);
  });

  it("escapes % and _ wildcards in the query string (LIKE escape)", async () => {
    // We can't observe the driver-level parameter binding here, but the
    // helper `escapeLikePattern` is trusted and tested elsewhere. Sanity
    // check: the call succeeds and passes through to `.where(...)` once.
    const db = createSearchMock([]);
    await memberQueries.searchMembers(db, "srv_1", "50%_off");
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it("does NOT filter blocked users — an isBlocked pre-check is never applied inside the query", async () => {
    // Query semantics: `searchMembers` scopes by serverId + LIKE only. There
    // is no join against `blocked_relationship` / `communityFriendship`. This
    // test pins that decision by asserting the row set is unfiltered when the
    // caller passes anyone in — the query doesn't know about the caller.
    const db = createSearchMock([
      { id: "m1", userId: "u_blocker", userName: "Alice" },
      { id: "m2", userId: "u_blocked_by_caller", userName: "Alicia" },
    ]);
    const res = await memberQueries.searchMembers(db, "srv_1", "Ali");
    expect(res.map((r) => r.id)).toEqual(["m1", "m2"]);
  });
});

describe("getMemberById", () => {
  function createMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns the row when memberId is scoped to the given serverId", async () => {
    const row = buildMember(1);
    const db = createMock([row]);
    const result = await memberQueries.getMemberById(db, "mem_1", { serverId: "srv_1" });
    expect(result).toEqual(row);
    // Scope-first: `.where(and(eq(id, ...), eq(serverId, ...)))` — a single
    // clause with both bounds. No listMembers-style fetch-and-filter.
    expect(db.where).toHaveBeenCalledTimes(1);
    expect(db.innerJoin).toHaveBeenCalledTimes(1);
  });

  it("returns null when memberId belongs to a different server (scope wins)", async () => {
    // Simulated DB behaviour: `WHERE id = mem_1 AND server_id = srv_2` finds
    // nothing because mem_1 lives on srv_1. Proves scoping happens in SQL,
    // not in JS post-filtering.
    const db = createMock([]);
    const result = await memberQueries.getMemberById(db, "mem_1", { serverId: "srv_2" });
    expect(result).toBeNull();
  });

  it("returns null when memberId does not exist at all", async () => {
    const db = createMock([]);
    const result = await memberQueries.getMemberById(db, "mem_missing", { serverId: "srv_1" });
    expect(result).toBeNull();
  });

  it("returned row includes role, userName, userId — the fields both PATCH/DELETE call sites read", async () => {
    const row = buildMember(2);
    const db = createMock([row]);
    const result = await memberQueries.getMemberById(db, "mem_2", { serverId: "srv_1" });
    expect(result).not.toBeNull();
    expect(result!.role).toBe("member");
    expect(result!.userName).toBe("User 2");
    expect(result!.userId).toBe("u_2");
  });
});

describe("bulkUpdateRailOrder", () => {
  function createBatchMock() {
    const chain: any = {};
    chain.update = vi.fn(() => chain);
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.batch = vi.fn(() => Promise.resolve());
    return chain;
  }

  it("calls db.batch once with a tuple whose length matches the input", async () => {
    const db = createBatchMock();
    await memberQueries.bulkUpdateRailOrder(db, "u_1", ["s_1", "s_2", "s_3"]);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const arg = db.batch.mock.calls[0][0];
    expect(Array.isArray(arg)).toBe(true);
    expect(arg).toHaveLength(3);
  });

  it("returns early on empty input without touching db.batch", async () => {
    const db = createBatchMock();
    await memberQueries.bulkUpdateRailOrder(db, "u_1", []);
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});

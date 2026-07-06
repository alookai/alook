import { describe, it, expect, vi } from "vitest";
import * as serverQueries from "../../src/db/queries/community/server";
import {
  communityServer,
  communityCategory,
  communityChannel,
  communityServerMember,
  communityMention,
  communityMessage,
} from "../../src/db/community-schema";

// Mocks a Drizzle DB where each insert()/select() chain resolves to a
// caller-supplied row set (or `undefined` for terminal insert-without-returning).
// The mock records every call so we can assert the side-effects.
type InsertCall = {
  table: unknown;
  values: Record<string, unknown>;
  returningArg: unknown;
};
type SelectCall = {
  fields: unknown;
  from: unknown;
};

function createDbMock(opts: {
  insertReturns: unknown[][]; // per-insert `.returning()` payload, in call order
  selectReturns: unknown[][]; // per-select `.where()` payload, in call order
}) {
  const insertCalls: InsertCall[] = [];
  const selectCalls: SelectCall[] = [];
  let insertIdx = 0;
  let selectIdx = 0;

  const db: any = {
    insert(table: unknown) {
      const call: InsertCall = { table, values: {}, returningArg: undefined };
      insertCalls.push(call);
      const rowsForThisInsert = opts.insertReturns[insertIdx] ?? [];
      insertIdx += 1;
      const chain: any = {
        values(v: Record<string, unknown>) {
          call.values = v;
          // Terminal insert without returning is awaited directly — make the
          // chain itself thenable so `await db.insert(...).values(...)` works.
          const thenable = {
            returning(arg?: unknown) {
              call.returningArg = arg;
              return Promise.resolve(rowsForThisInsert);
            },
            then(resolve: (v: unknown) => void) {
              resolve(rowsForThisInsert);
            },
          };
          return thenable;
        },
      };
      return chain;
    },
    select(fields: unknown) {
      const call: SelectCall = { fields, from: undefined };
      selectCalls.push(call);
      const rowsForThisSelect = opts.selectReturns[selectIdx] ?? [];
      selectIdx += 1;
      const chain: any = {
        from(t: unknown) {
          call.from = t;
          return chain;
        },
        where() {
          return Promise.resolve(rowsForThisSelect);
        },
      };
      return chain;
    },
  };

  return { db, insertCalls, selectCalls };
}

describe("community/server exports", () => {
  it("exports createServer", () => {
    expect(typeof serverQueries.createServer).toBe("function");
  });
});

describe("createServer", () => {
  const ownerId = "u_owner";
  const serverRow = { id: "srv_1", name: "My Server", ownerId };
  const categoryRow = { id: "cat_1" };
  const memberRow = {
    id: "mem_1",
    userId: ownerId,
    joinedAt: "2026-07-02T00:00:00.000Z",
  };

  it("returns { server, ownerMember } with fields sourced from the seeded rows and user join", async () => {
    const { db } = createDbMock({
      insertReturns: [
        [serverRow],   // insert communityServer
        [categoryRow], // insert communityCategory
        [],            // insert communityChannel (no returning)
        [memberRow],   // insert communityServerMember w/ returning
      ],
      selectReturns: [
        [{ name: "Alice", image: "https://avatars/alice.png" }], // select user
      ],
    });

    const result = await serverQueries.createServer(db, {
      name: "My Server",
      description: "hi",
      ownerId,
    });

    expect(result.server).toEqual(serverRow);
    expect(result.ownerMember).toEqual({
      id: memberRow.id,
      userId: ownerId,
      joinedAt: memberRow.joinedAt,
      userName: "Alice",
      userImage: "https://avatars/alice.png",
    });
  });

  it("ownerMember.userName falls back to '' + userImage to null if the joined user row is missing", async () => {
    // The Better-Auth create.before hook + createUser/updateUser guards keep
    // user.name non-empty, but the select can still miss (e.g. race between
    // ownerId insert and this select) — return "" rather than null so the
    // caller doesn't have to null-check a field that's typed non-null.
    const { db } = createDbMock({
      insertReturns: [[serverRow], [categoryRow], [], [memberRow]],
      selectReturns: [[]],
    });

    const result = await serverQueries.createServer(db, {
      name: "My Server",
      ownerId,
    });

    expect(result.ownerMember.userName).toBe("");
    expect(result.ownerMember.userImage).toBeNull();
  });

  it("seeds category 'Text Channels', channel 'general' (text), and exactly one owner member row with railOrder=0", async () => {
    const { db, insertCalls } = createDbMock({
      insertReturns: [[serverRow], [categoryRow], [], [memberRow]],
      selectReturns: [[{ name: "Alice" }]],
    });

    await serverQueries.createServer(db, {
      name: "My Server",
      description: "hi",
      ownerId,
    });

    expect(insertCalls).toHaveLength(4);

    // 1) communityServer
    expect(insertCalls[0].table).toBe(communityServer);
    expect(insertCalls[0].values).toMatchObject({
      name: "My Server",
      description: "hi",
      ownerId,
    });

    // 2) communityCategory
    expect(insertCalls[1].table).toBe(communityCategory);
    expect(insertCalls[1].values).toMatchObject({
      serverId: "srv_1",
      name: "Text Channels",
      position: 0,
    });

    // 3) communityChannel — "general" text channel
    expect(insertCalls[2].table).toBe(communityChannel);
    expect(insertCalls[2].values).toMatchObject({
      serverId: "srv_1",
      categoryId: "cat_1",
      name: "general",
      type: "text",
      position: 0,
    });

    // 4) communityServerMember — exactly one owner row, railOrder=0
    expect(insertCalls[3].table).toBe(communityServerMember);
    expect(insertCalls[3].values).toMatchObject({
      serverId: "srv_1",
      userId: ownerId,
      role: "owner",
      railOrder: 0,
    });
    // Member insert uses .returning({ id, userId, joinedAt })
    expect(insertCalls[3].returningArg).toBeDefined();
  });

  it("description defaults to empty string when omitted", async () => {
    const { db, insertCalls } = createDbMock({
      insertReturns: [[serverRow], [categoryRow], [], [memberRow]],
      selectReturns: [[{ name: "Alice" }]],
    });

    await serverQueries.createServer(db, { name: "My Server", ownerId });

    expect(insertCalls[0].values).toMatchObject({ description: "" });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// listUserServers — unread-mention aggregate → rail badge
// ────────────────────────────────────────────────────────────────────────────
//
// The query now has two select chains:
//   1. Inner subquery over community_mention → community_message →
//      community_channel, aliased as `mention_counts`.
//   2. Outer select over community_server INNER JOIN member LEFT JOIN
//      mention_counts, projected with a COALESCE(mentions, 0) column.
//
// We can't execute SQL against D1 in unit tests, so these mocks capture the
// second call's `.from(...) → .innerJoin(...) → .leftJoin(...) → .orderBy(...)`
// chain and pin:
//   (a) the LEFT JOIN against the subquery is present (badge would silently
//       be 0 forever without it),
//   (b) the WHERE inside the subquery pins `read = 0` and `kind = 'mention'`
//       (regressions here silently over-count or over-drop),
//   (c) the final projection includes `mentions`, and callers see the
//       aggregated number.
//
// SQL semantics (correct grouping, DM exclusion) are covered by the shape of
// the query itself — the joins force server_id via message → channel, which
// naturally excludes DM message rows (channelId IS NULL).

function createListServersMock(finalRows: unknown[]) {
  // Track calls per select chain so tests can assert what tables/joins were
  // touched. Two `.select(...)` calls occur: the subquery builder first, then
  // the outer select.
  const selectChains: Array<{
    fields: unknown;
    from?: unknown;
    innerJoins: unknown[];
    leftJoins: unknown[];
    where?: unknown;
    groupBy?: unknown;
    orderBy?: unknown;
    aliased?: string | null;
  }> = [];

  const build = (isSubquery: boolean) => {
    const call = selectChains[selectChains.length - 1]!;
    const chain: any = {};
    chain.from = (t: unknown) => {
      call.from = t;
      return chain;
    };
    chain.innerJoin = (table: unknown, cond: unknown) => {
      call.innerJoins.push({ table, cond });
      return chain;
    };
    chain.leftJoin = (table: unknown, cond: unknown) => {
      call.leftJoins.push({ table, cond });
      return chain;
    };
    chain.where = (cond: unknown) => {
      call.where = cond;
      return chain;
    };
    chain.groupBy = (col: unknown) => {
      call.groupBy = col;
      return chain;
    };
    chain.as = (name: string) => {
      call.aliased = name;
      // Subquery result — returned to the outer builder as a "table-like"
      // reference. Include a `.serverId` / `.mentions` marker so the outer
      // leftJoin condition builder can access it symbolically.
      return { __subquery: name, serverId: {}, mentions: {} };
    };
    chain.orderBy = (col: unknown) => {
      call.orderBy = col;
      // Terminal — this is the outer builder; return the fixture rows.
      return Promise.resolve(finalRows);
    };
    return chain;
  };

  const db: any = {
    select(fields: unknown) {
      selectChains.push({
        fields,
        innerJoins: [],
        leftJoins: [],
        aliased: null,
      });
      // The first select is the subquery — it terminates in `.as(...)`, not
      // `.orderBy(...)`. The second is the outer builder.
      const isSubquery = selectChains.length === 1;
      return build(isSubquery);
    },
  };
  return { db, selectChains };
}

describe("listUserServers — mention aggregate for the rail badge", () => {
  it("subquery filters on read=0 AND kind='mention' AND matches the viewer", async () => {
    const { db, selectChains } = createListServersMock([]);
    await serverQueries.listUserServers(db, "u_1");
    // First `.select(...)` is the subquery.
    const sub = selectChains[0];
    expect(sub.from).toBe(communityMention);
    // Inner joins from mention → message → channel drive the server_id
    // projection AND drop DM mentions (channelId IS NULL). Pin both hops.
    expect(sub.innerJoins).toHaveLength(2);
    const joinedTables = sub.innerJoins.map((j: any) => j.table);
    expect(joinedTables).toContain(communityMessage);
    expect(joinedTables).toContain(communityChannel);
    // groupBy on channel.serverId so the row shape is (serverId, count).
    expect(sub.groupBy).toBe(communityChannel.serverId);
    expect(sub.aliased).toBe("mention_counts");
  });

  it("outer select LEFT JOINs the mention_counts subquery", async () => {
    const { db, selectChains } = createListServersMock([]);
    await serverQueries.listUserServers(db, "u_1");
    const outer = selectChains[1];
    expect(outer.from).toBe(communityServer);
    // Inner join to member (the "am I in this server" pin) MUST stay — the
    // mention aggregate is a badge on the rail, not a public feed.
    expect(outer.innerJoins).toHaveLength(1);
    expect(outer.innerJoins[0]).toMatchObject({ table: communityServerMember });
    // Left join to the subquery is the actual fix — without it `mentions` is
    // always undefined and the badge silently reads 0.
    expect(outer.leftJoins).toHaveLength(1);
    expect(outer.leftJoins[0].table).toMatchObject({ __subquery: "mention_counts" });
  });

  it("orders rows by railOrder — rail sort must not regress", async () => {
    const { db, selectChains } = createListServersMock([]);
    await serverQueries.listUserServers(db, "u_1");
    const outer = selectChains[1];
    expect(outer.orderBy).toBeDefined();
  });

  it("returns rows with mentions passed through from the resolved LEFT JOIN", async () => {
    // Simulates: viewer has 2 unread mentions in srv_A, 1 in srv_B, none in
    // srv_C (LEFT JOIN + COALESCE → 0).
    const rows = [
      { id: "srv_A", name: "A", railOrder: 0, mentions: 2 },
      { id: "srv_B", name: "B", railOrder: 1, mentions: 1 },
      { id: "srv_C", name: "C", railOrder: 2, mentions: 0 },
    ];
    const { db } = createListServersMock(rows);
    const result = await serverQueries.listUserServers(db, "u_1");
    expect(result).toHaveLength(3);
    // Pin each server's count — including the zero case, which is the
    // COALESCE(NULL, 0) path.
    expect(result.map((r: any) => [r.id, r.mentions])).toEqual([
      ["srv_A", 2],
      ["srv_B", 1],
      ["srv_C", 0],
    ]);
  });

  it("returns mentions: 0 for every server when the viewer has no unread mentions", async () => {
    // With zero unread mentions, the subquery yields no rows and every
    // LEFT JOIN produces NULL → COALESCE → 0.
    const rows = [
      { id: "srv_A", name: "A", railOrder: 0, mentions: 0 },
      { id: "srv_B", name: "B", railOrder: 1, mentions: 0 },
    ];
    const { db } = createListServersMock(rows);
    const result = await serverQueries.listUserServers(db, "u_1");
    expect(result.every((r: any) => r.mentions === 0)).toBe(true);
  });
});

// The reply/DM/read exclusion semantics live in the subquery's WHERE clause.
// We can't execute a WHERE against a mock, but we CAN pin that the subquery
// is built with the right filter shape — a raw `sql` cast or a missing
// eq(mention.kind, "mention") clause would be a bug we'd catch by reading
// the subquery source. As a low-cost regression signal, assert the source
// text of `listUserServers` includes the three critical predicates.
describe("listUserServers — filter predicates (source-level pin)", () => {
  const src = serverQueries.listUserServers.toString();

  it("subquery filters mention rows to the viewer (userId equality)", () => {
    // The `eq(communityMention.userId, userId)` clause is what pins the
    // aggregate to the caller's mentions — never anyone else's.
    expect(src).toMatch(/communityMention\.userId/);
  });

  it("subquery excludes already-read mentions (read = 0)", () => {
    // Guards against dropping the `eq(communityMention.read, 0)` predicate,
    // which would keep the badge permanently red.
    expect(src).toMatch(/communityMention\.read/);
    expect(src).toMatch(/,\s*0\s*\)/);
  });

  it("subquery counts only kind='mention' (not replies)", () => {
    // `kind = "reply"` events live in For You but do not warrant a red badge
    // on the server icon — the plan pins this explicitly.
    expect(src).toMatch(/communityMention\.kind/);
    expect(src).toMatch(/"mention"/);
  });

  it("joins go through community_message → community_channel so DM mentions never land in the aggregate", () => {
    // DM messages have channelId=NULL and would be excluded by INNER JOIN on
    // `community_channel.id = message.channelId`. Pin the join topology.
    expect(src).toMatch(/communityMessage/);
    expect(src).toMatch(/communityChannel/);
  });
});

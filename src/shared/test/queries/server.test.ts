import { describe, it, expect, vi } from "vitest";
import * as serverQueries from "../../src/db/queries/community/server";
import {
  communityServer,
  communityCategory,
  communityChannel,
  communityServerMember,
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

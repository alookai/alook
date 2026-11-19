import { describe, it, expect, vi } from "vitest";
import * as tagQueries from "../../src/db/queries/community/message-tag";
import { communityChannel, communityMessage, communityServer } from "../../src/db/community-schema";
import { user } from "../../src/db/schema";
import { createMigratedDb } from "../helpers/migrated-db";

it("keeps real tag changes and hydration within the requested messages", async () => {
  const { db, sqlite } = createMigratedDb();
  try {
    await db.insert(user).values({ id: "author", name: "Author", email: "author@example.test" }).run();
    await db.insert(communityServer).values({ id: "server", name: "Server", ownerId: "author" }).run();
    await db.insert(communityChannel).values([
      { id: "forum", name: "Forum", type: "forum", serverId: "server" },
      { id: "elsewhere", name: "Elsewhere", type: "forum", serverId: "server" },
    ]).run();
    await db.insert(communityMessage).values([
      { id: "target", authorId: "author", channelId: "forum", seq: 1 },
      { id: "neighbor", authorId: "author", channelId: "forum", seq: 2 },
      { id: "foreign", authorId: "author", channelId: "elsewhere", seq: 1 },
    ]).run();

    await tagQueries.addMessageTag(db, { messageId: "target", tag: "old" });
    await tagQueries.addMessageTag(db, { messageId: "target", tag: "old" });
    await tagQueries.addMessageTag(db, { messageId: "neighbor", tag: "keep" });
    await tagQueries.addMessageTag(db, { messageId: "foreign", tag: "bug" });
    await expect(tagQueries.listTagsForMessage(db, "target")).resolves.toEqual(["old"]);
    await tagQueries.replaceMessageTags(db, { messageId: "target", tags: ["bug", "urgent"] });
    await expect(tagQueries.filterMessageIdsByTag(db, ["target", "neighbor"], "bug")).resolves.toEqual(["target"]);
    await expect(tagQueries.removeMessageTag(db, { messageId: "target", tag: "urgent" })).resolves.toMatchObject({ messageId: "target", tag: "urgent" });
    await expect(tagQueries.removeMessageTag(db, { messageId: "target", tag: "urgent" })).resolves.toBeNull();
    const tags = await tagQueries.listTagsForMessages(db, ["target", "neighbor"]);
    expect(tags.toSorted((a, b) => a.messageId.localeCompare(b.messageId))).toEqual([
      { messageId: "neighbor", tag: "keep" }, { messageId: "target", tag: "bug" },
    ]);
    await tagQueries.replaceMessageTags(db, { messageId: "target", tags: [] });
    await expect(tagQueries.listTagsForMessage(db, "target")).resolves.toEqual([]);
    await expect(tagQueries.listTagsForMessage(db, "neighbor")).resolves.toEqual(["keep"]);
  } finally {
    sqlite.close();
  }
});

describe("community/message-tag exports", () => {
  it("exports the tag CRUD + filter", () => {
    expect(typeof tagQueries.listDistinctTagsForChannel).toBe("function");
  });
});

describe("replaceMessageTags", () => {
  function batchMock() {
    const deleteStatement = { kind: "delete" };
    const deleteChain = { where: vi.fn(() => deleteStatement) };
    const inserts: Array<{ kind: "insert"; data: unknown }> = [];
    const db: any = {
      delete: vi.fn(() => deleteChain),
      insert: vi.fn(() => ({ values: vi.fn((data) => {
        const statement = { kind: "insert", data };
        inserts.push(statement);
        return statement;
      }) })),
      batch: vi.fn(() => Promise.resolve()),
    };
    return { db, deleteStatement, inserts };
  }

  it("batches only the unconditional delete for an empty replacement", async () => {
    const { db, deleteStatement } = batchMock();
    await tagQueries.replaceMessageTags(db, { messageId: "m1", tags: [] });
    expect(db.batch).toHaveBeenCalledWith([deleteStatement]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("batches delete plus every wanted insert in one atomic call", async () => {
    const { db, deleteStatement, inserts } = batchMock();
    await tagQueries.replaceMessageTags(db, { messageId: "m1", tags: ["bug", "p0"] });
    expect(inserts.map((statement) => statement.data)).toEqual([
      { messageId: "m1", tag: "bug" },
      { messageId: "m1", tag: "p0" },
    ]);
    expect(db.batch).toHaveBeenCalledWith([deleteStatement, ...inserts]);
  });
});

describe("addMessageTag", () => {
  it("inserts with onConflictDoNothing (idempotent re-add)", async () => {
    const values = vi.fn(() => ({ onConflictDoNothing: vi.fn(() => Promise.resolve()) }));
    const db: any = { insert: vi.fn(() => ({ values })) };
    await tagQueries.addMessageTag(db, { messageId: "m1", tag: "bug" });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledWith({ messageId: "m1", tag: "bug" });
  });
});

describe("removeMessageTag", () => {
  function deleteMock(returned: any[]) {
    const chain: any = {};
    chain.delete = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(returned));
    return chain;
  }

  it("returns the deleted row when present", async () => {
    const db = deleteMock([{ id: "t1", messageId: "m1", tag: "bug" }]);
    const res = await tagQueries.removeMessageTag(db, { messageId: "m1", tag: "bug" });
    expect(res).toMatchObject({ tag: "bug" });
  });

  it("returns null when the (messageId, tag) pair doesn't exist", async () => {
    const db = deleteMock([]);
    const res = await tagQueries.removeMessageTag(db, { messageId: "m1", tag: "missing" });
    expect(res).toBeNull();
  });
});

describe("listTagsForMessage", () => {
  it("returns the plain tag strings, not the row shape", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ tag: "bug" }, { tag: "q&a" }]));
    const res = await tagQueries.listTagsForMessage(chain, "m1");
    expect(res).toEqual(["bug", "q&a"]);
  });
});

describe("listTagsForMessages — batch (avoid N+1)", () => {
  it("skips the query entirely for an empty id list", async () => {
    const db: any = { select: vi.fn() };
    const res = await tagQueries.listTagsForMessages(db, []);
    expect(res).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns one row per (messageId, tag) pair for the caller to group", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([
      { messageId: "m1", tag: "bug" },
      { messageId: "m2", tag: "feature" },
    ]));
    const db: any = { select: chain.select };
    const res = await tagQueries.listTagsForMessages(db, ["m1", "m2"]);
    expect(res).toEqual([
      { messageId: "m1", tag: "bug" },
      { messageId: "m2", tag: "feature" },
    ]);
  });
});

describe("filterMessageIdsByTag — the forum ?tag= filter's data access", () => {
  it("skips the query entirely for an empty candidate list (never a bare cross-channel tag scan)", async () => {
    const db: any = { select: vi.fn() };
    const res = await tagQueries.filterMessageIdsByTag(db, [], "bug");
    expect(res).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("narrows the CALLER-SUPPLIED candidate set to those carrying the tag — never queries by tag alone", async () => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([{ messageId: "m1" }]));
    const db: any = { select: chain.select };
    const res = await tagQueries.filterMessageIdsByTag(db, ["m1", "m2", "m3"], "bug");
    expect(res).toEqual(["m1"]);
    // The where() call must be reachable only via a candidate-scoped select —
    // this test can't inspect the SQL directly with this mock shape, but the
    // empty-candidate-list short-circuit above is what structurally prevents
    // a bare tag-only query from ever being issued.
    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});

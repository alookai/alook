import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleProxy } from "drizzle-orm/sqlite-proxy";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as threadQueries from "../../src/db/queries/community/thread";
import { D1_MAX_BIND_PARAMS } from "../../src/db/queries/_chunk";

describe("community/thread exports", () => {
  it("exports the participant CRUD", () => {
    expect(typeof threadQueries.addThreadParticipant).toBe("function");
    expect(typeof threadQueries.listThreadParticipantUserIds).toBe("function");
    expect(typeof threadQueries.listThreadParticipants).toBe("function");
    expect(typeof threadQueries.removeThreadParticipant).toBe("function");
    expect(typeof threadQueries.listParticipatingThreadIds).toBe("function");
  });
});

describe("listForumThreadsByActivity against real SQLite", () => {
  let sqlite: Sqlite.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Sqlite(":memory:");
    sqlite.exec(`
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        category_id TEXT,
        name TEXT,
        type TEXT NOT NULL DEFAULT 'text',
        topic TEXT DEFAULT '',
        position INTEGER DEFAULT 0,
        parent_channel_id TEXT,
        creator_id TEXT,
        message_count INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        parent_message_id TEXT,
        last_message_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_message_tag (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        UNIQUE(message_id, tag)
      );
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image TEXT
      );
      CREATE TABLE community_channel_member (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        source TEXT NOT NULL,
        added_by TEXT,
        added_at TEXT NOT NULL
      );
    `);
    const insertChannel = sqlite.prepare(`
      INSERT INTO community_channel
        (id, name, type, parent_channel_id, parent_message_id, archived, last_message_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertChannel.run("t_new", "new activity", "thread", "forum_1", "m_new", 0, "2026-08-08T05:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertChannel.run("t_tie_b", "tie b", "thread", "forum_1", "m_tie_b", 0, "2026-08-08T04:00:00.000Z", "2026-01-02T00:00:00.000Z");
    insertChannel.run("t_tie_a", "tie a", "thread", "forum_1", "m_tie_a", 0, "2026-08-08T04:00:00.000Z", "2026-01-03T00:00:00.000Z");
    insertChannel.run("t_created", "created fallback", "thread", "forum_1", "m_created", 0, null, "2026-08-08T02:00:00.000Z");
    insertChannel.run("t_archived", "archived", "thread", "forum_1", "m_archived", 1, "2026-08-09T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertChannel.run("t_rootless", "rootless", "thread", "forum_1", null, 0, "2026-08-09T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertChannel.run("not_thread", "text child", "text", "forum_1", "m_text", 0, "2026-08-09T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insertChannel.run("foreign", "foreign", "thread", "forum_2", "m_foreign", 0, "2026-08-10T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const insertTag = sqlite.prepare("INSERT INTO community_message_tag (id, message_id, tag) VALUES (?, ?, ?)");
    insertTag.run("tag_tie", "m_tie_a", "bug");
    insertTag.run("tag_created", "m_created", "bug");
    insertTag.run("tag_foreign", "m_foreign", "bug");
    db = drizzle(sqlite);
  });

  afterEach(() => sqlite.close());

  it("orders by activity and pages stable timestamp ties without overlap", async () => {
    const first = await threadQueries.listForumThreadsByActivity(db as never, {
      parentChannelId: "forum_1",
      limit: 2,
    });
    const second = await threadQueries.listForumThreadsByActivity(db as never, {
      parentChannelId: "forum_1",
      cursor: { activityAt: first[1]!.activityAt, id: first[1]!.id },
      limit: 3,
    });

    expect(first.map((row) => row.id)).toEqual(["t_new", "t_tie_b"]);
    expect(second.map((row) => row.id)).toEqual(["t_tie_a", "t_created"]);
    expect(second[1]!.activityAt).toBe("2026-08-08T02:00:00.000Z");
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(4);
  });

  it("applies the tag and forum scope before the activity limit", async () => {
    const rows = await threadQueries.listForumThreadsByActivity(db as never, {
      parentChannelId: "forum_1",
      tag: "bug",
      limit: 5,
    });
    expect(rows.map((row) => row.id)).toEqual(["t_tie_a", "t_created"]);
  });

  it("preserves SQLite BINARY participant tie ordering for case-sensitive ids", async () => {
    sqlite.prepare("INSERT INTO user (id, name) VALUES (?, ?)").run("A", "upper");
    sqlite.prepare("INSERT INTO user (id, name) VALUES (?, ?)").run("a", "lower");
    const insertMember = sqlite.prepare(`
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, source, added_at)
      VALUES (?, ?, ?, 'notify', 'added', ?)
    `);
    const tiedAt = "2026-08-08T06:00:00.000Z";
    insertMember.run("member_a", "t_new", "a", tiedAt);
    insertMember.run("member_A", "t_new", "A", tiedAt);

    const rows = await threadQueries.listParticipantsForChannels(
      db as never,
      ["t_new"],
      5,
    );

    expect(rows.map((row) => row.userId)).toEqual(["A", "a"]);
  });

  it("returns per-forum recent notify rows and retains an older open post", async () => {
    sqlite.prepare("INSERT INTO user (id, name) VALUES (?, ?)").run("viewer", "Viewer");
    const insertMember = sqlite.prepare(`
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, source, added_at)
      VALUES (?, ?, 'viewer', 'notify', 'spoke', '2026-08-08T00:00:00.000Z')
    `);
    for (const id of ["t_new", "t_tie_b", "t_tie_a", "t_created", "t_archived", "foreign"]) {
      insertMember.run(`member_${id}`, id);
    }

    const recent = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1", "forum_2"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
    });
    expect(recent.canonical.map((row) => row.id)).toEqual(["t_new", "t_tie_b", "foreign"]);
    expect(recent.retained).toBeNull();

    const retained = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1", "forum_2"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "t_created",
    });
    expect(retained.canonical.map((row) => row.id)).toEqual(["t_new", "t_tie_b", "foreign"]);
    expect(retained.retained?.id).toBe("t_created");

    const outOfScopeRetained = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "foreign",
    });
    expect(outOfScopeRetained.canonical.map((row) => row.id)).toEqual(["t_new", "t_tie_b"]);
    expect(outOfScopeRetained.retained).toBeNull();
  });
});

describe("addThreadParticipant", () => {
  function insertMock(returned: any[]) {
    const chain: any = {};
    chain.insert = vi.fn(() => chain);
    chain.values = vi.fn(() => chain);
    chain.onConflictDoNothing = vi.fn(() => chain);
    chain.returning = vi.fn(() => Promise.resolve(returned));
    return chain;
  }

  it("returns the inserted row for a new participant", async () => {
    const db = insertMock([{ id: "tp1", threadChannelId: "t1", userId: "u1" }]);
    const res = await threadQueries.addThreadParticipant(db, {
      threadChannelId: "t1",
      userId: "u1",
      source: "spoke",
    });
    expect(res).toMatchObject({ id: "tp1" });
  });

  it("returns null on conflict (already a participant)", async () => {
    const db = insertMock([]);
    const res = await threadQueries.addThreadParticipant(db, {
      threadChannelId: "t1",
      userId: "u1",
      source: "mention",
    });
    expect(res).toBeNull();
  });
});

describe("addThreadParticipants — bulk", () => {
  it("skips the query entirely for an empty rows list", async () => {
    const chain: any = { insert: vi.fn() };
    await threadQueries.addThreadParticipants(chain, "t1", []);
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it("inserts one row per (userId, source) pair with onConflictDoNothing", async () => {
    const returning = vi.fn(() => Promise.resolve([{ userId: "u1" }, { userId: "u2" }]));
    const values = vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({ returning })),
    }));
    const chain: any = { insert: vi.fn(() => ({ values })) };
    await expect(threadQueries.addThreadParticipants(chain, "t1", [
      { userId: "u1", source: "spoke" },
      { userId: "u2", source: "mention" },
    ])).resolves.toEqual(["u1", "u2"]);
    expect(chain.insert).toHaveBeenCalledTimes(1); // single bulk insert, not N
    expect(values).toHaveBeenCalledWith([
      { channelId: "t1", userId: "u1", relation: "notify", source: "spoke" },
      { channelId: "t1", userId: "u2", relation: "notify", source: "mention" },
    ]);
    expect(returning).toHaveBeenCalledTimes(1);
  });
});

describe("listThreadParticipantUserIds — notify set", () => {
  function whereMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns every participant's userId", async () => {
    const db = whereMock([{ userId: "u1" }, { userId: "u2" }]);
    const res = await threadQueries.listThreadParticipantUserIds(db, "t1");
    expect(res).toEqual(["u1", "u2"]);
  });
});

describe("listParticipantsForChannels — D1 bind cap", () => {
  it("chunks 100 channel ids so every ranked statement stays within 100 binds", async () => {
    const paramCounts: number[] = [];
    const db = drizzleProxy(async (_sql, params) => {
      paramCounts.push(params.length);
      return { rows: [] };
    });

    await threadQueries.listParticipantsForChannels(
      db as never,
      Array.from({ length: 100 }, (_, i) => `thread_${i}`),
      5,
    );

    expect(paramCounts).toHaveLength(2);
    expect(Math.max(...paramCounts)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
  });
});

describe("listParticipatingForumThreads — D1 bind cap", () => {
  it("chunks 100 visible forum ids so ranked and retained statements stay within 100 binds", async () => {
    const paramCounts: number[] = [];
    const db = drizzleProxy(async (_sql, params) => {
      paramCounts.push(params.length);
      return { rows: [] };
    });

    await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: Array.from({ length: 100 }, (_, i) => `forum_${i}`),
      userId: "viewer_1",
      activeAfter: "2026-08-05T00:00:00.000Z",
      limitPerParent: 5,
      retainId: "thread_1",
    });

    expect(paramCounts).toHaveLength(4);
    expect(Math.max(...paramCounts)).toBeLessThanOrEqual(D1_MAX_BIND_PARAMS);
  });
});

describe("listParticipatingThreadIds", () => {
  function whereMock(rows: any[]) {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve(rows));
    return chain;
  }

  it("returns [] without querying for an empty id list", async () => {
    const db = whereMock([{ channelId: "should_not_be_used" }]);
    const res = await threadQueries.listParticipatingThreadIds(db, [], "u1");
    expect(res).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("returns the participating thread ids", async () => {
    const db = whereMock([{ channelId: "t1" }, { channelId: "t3" }]);
    const res = await threadQueries.listParticipatingThreadIds(db, ["t1", "t2", "t3"], "u1");
    expect(res).toEqual(["t1", "t3"]);
  });
});

describe("removeParticipantFromChildChannels — member-remove notify cascade", () => {
  function makeDb(postRows: any[], deletedRows: any[]) {
    const selectChain: any = {};
    selectChain.select = vi.fn(() => selectChain);
    selectChain.from = vi.fn(() => selectChain);
    selectChain.where = vi.fn(() => Promise.resolve(postRows));
    const deleteChain: any = {};
    deleteChain.delete = vi.fn(() => deleteChain);
    deleteChain.where = vi.fn(() => deleteChain);
    deleteChain.returning = vi.fn(() => Promise.resolve(deletedRows));
    return {
      select: selectChain.select,
      from: selectChain.from,
      where: selectChain.where,
      delete: deleteChain.delete,
    } as any;
  }

  it("skips the delete when the parent has no children", async () => {
    const db = makeDb([], []);
    const n = await threadQueries.removeParticipantFromChildChannels(db, "forum_1", "u_removed");
    expect(n).toBe(0);
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("deletes the user's participant rows across the parent's children", async () => {
    const db = makeDb([{ id: "p1" }, { id: "p2" }], [{ id: "tp1" }, { id: "tp2" }]);
    const n = await threadQueries.removeParticipantFromChildChannels(db, "forum_1", "u_removed");
    expect(n).toBe(2);
    expect(db.delete).toHaveBeenCalled();
  });
});

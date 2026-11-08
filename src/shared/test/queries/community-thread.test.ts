import { readFileSync, readdirSync } from "node:fs";
import Sqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import * as threadQueries from "../../src/db/queries/community/thread";
import { FORUM_ARCHIVE_TAG, type ParticipantSource } from "../../src/constants/community";
import { communityChannel, communityChannelMember, communityMessage, communityMessageTag, communityServer } from "../../src/db/community-schema";
import { user } from "../../src/db/schema";
import type { Database } from "../../src/db";

const openedDatabases = new Set<Sqlite.Database>();
const createdAt = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const sqlite of openedDatabases) sqlite.close();
  openedDatabases.clear();
});

function createForumFixture() {
  const sqlite = new Sqlite(":memory:");
  openedDatabases.add(sqlite);
  sqlite.pragma("foreign_keys = ON");
  const migrations = new URL("../../../web/migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const orm = drizzle(sqlite, { logger: { logQuery(sql, params) { queries.push({ sql, params: [...params] }); } } });
  const seed = drizzle(sqlite);
  let userSequence = 0;
  const forums = new Set<string>();
  const sequences = new Map<string, number>();
  const addUser = (id: string, name = id, discriminator = "0001") => {
    seed.insert(user).values({ id, name, discriminator, email: `fixture-${userSequence++}@thread.test`, createdAt, updatedAt: createdAt }).run();
  };
  addUser("fixture-owner");
  seed.insert(communityServer).values({ id: "fixture-server", name: "Fixture server", discriminator: "0001", ownerId: "fixture-owner", createdAt }).run();
  const forum = (id: string) => {
    if (forums.has(id)) return;
    seed.insert(communityChannel).values({ id, serverId: "fixture-server", name: id, type: "forum", createdAt }).run();
    forums.add(id);
  };
  const thread = (row: { id: string; parentChannelId?: string; name?: string; type?: string; parentMessageId?: string | null; archived?: number; lastMessageAt?: string | null; createdAt?: string }) => {
    const parentChannelId = row.parentChannelId ?? "forum_1";
    forum(parentChannelId);
    const parentMessageId = row.parentMessageId === undefined ? `opener-${row.id}` : row.parentMessageId;
    if (parentMessageId !== null) {
      const seq = (sequences.get(parentChannelId) ?? 0) + 1;
      sequences.set(parentChannelId, seq);
      seed.insert(communityMessage).values({ id: parentMessageId, channelId: parentChannelId, authorId: "fixture-owner", content: row.id, seq, createdAt: row.createdAt ?? createdAt }).run();
    }
    seed.insert(communityChannel).values({ id: row.id, serverId: "fixture-server", name: row.name ?? row.id, type: row.type ?? "thread", parentChannelId, parentMessageId, archived: row.archived ?? 0, lastMessageAt: row.lastMessageAt ?? null, createdAt: row.createdAt ?? createdAt }).run();
  };
  const member = (channelId: string, userId: string, relation: "access" | "notify" = "notify", source: ParticipantSource = "spoke", addedAt = "2026-08-08T00:00:00.000Z") => {
    seed.insert(communityChannelMember).values({ channelId, userId, relation, source, addedAt }).run();
  };
  const tag = (id: string, messageId: string, value: string) => {
    seed.insert(communityMessageTag).values({ id, messageId, tag: value }).run();
  };
  const baseline = () => {
    thread({ id: "t_new", name: "new activity", parentMessageId: "m_new", lastMessageAt: "2026-08-08T05:00:00.000Z" });
    thread({ id: "t_tie_b", name: "tie b", parentMessageId: "m_tie_b", lastMessageAt: "2026-08-08T04:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" });
    thread({ id: "t_tie_a", name: "tie a", parentMessageId: "m_tie_a", lastMessageAt: "2026-08-08T04:00:00.000Z", createdAt: "2026-01-02T00:00:00.000Z" });
    thread({ id: "t_created", name: "created fallback", parentMessageId: "m_created", createdAt: "2026-08-08T02:00:00.000Z" });
    thread({ id: "t_tag_archived", name: "tag archived", parentMessageId: "m_tag_archived", createdAt: "2026-08-09T02:00:00.000Z" });
    thread({ id: "t_archived", name: "archived", parentMessageId: "m_archived", archived: 1, lastMessageAt: "2026-08-09T00:00:00.000Z" });
    thread({ id: "t_rootless", name: "rootless", parentMessageId: null, lastMessageAt: "2026-08-09T00:00:00.000Z" });
    thread({ id: "not_thread", name: "text child", type: "text", parentMessageId: "m_text", lastMessageAt: "2026-08-09T00:00:00.000Z" });
    thread({ id: "foreign", name: "foreign", parentChannelId: "forum_2", parentMessageId: "m_foreign", lastMessageAt: "2026-08-10T00:00:00.000Z" });
    tag("tag_tie", "m_tie_a", "bug"); tag("tag_created", "m_created", "bug");
    tag("tag_archive", "m_tag_archived", FORUM_ARCHIVE_TAG); tag("tag_archive_bug", "m_tag_archived", "bug"); tag("tag_foreign", "m_foreign", "bug");
  };
  const members = () => sqlite.prepare("SELECT id, channel_id, user_id, relation, source, added_at FROM community_channel_member ORDER BY channel_id, user_id, relation").all() as Array<{ id: string; channel_id: string; user_id: string; relation: string; source: string; added_at: string }>;
  return { sqlite, orm, db: orm as unknown as Database, queries, user: addUser, forum, thread, member, tag, baseline, members };
}

function expectD1Budget(queries: Array<{ sql: string; params: unknown[] }>) {
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) expect(query.params.length).toBeLessThanOrEqual(100);
}

describe("listForumThreadsByCreatedAt against real SQLite", () => {
  let sqlite: Sqlite.Database;
  let db: ReturnType<typeof drizzle>;

  let fixture: ReturnType<typeof createForumFixture>;
  beforeEach(() => {
    fixture = createForumFixture();
    sqlite = fixture.sqlite;
    db = fixture.orm;
    fixture.baseline();
  });

  it("keeps creation order when an older post has newer activity and pages ties without overlap", async () => {
    const first = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1",
      limit: 2,
    });
    const second = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1",
      cursor: { createdAt: first[1]!.createdAt, id: first[1]!.id },
      limit: 3,
    });

    expect(first.map((row) => row.id)).toEqual(["t_created", "t_tie_b"]);
    expect(second.map((row) => row.id)).toEqual(["t_tie_a", "t_new"]);
    expect(second[1]!.activityAt).toBe("2026-08-08T05:00:00.000Z");
  });

  it("applies the tag and forum scope before the creation limit", async () => {
    fixture.thread({ id: "t_untagged_front", createdAt: "2026-08-11T00:00:00.000Z" });
    const rows = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1",
      tag: "bug",
      limit: 5,
    });
    expect(rows.map((row) => row.id)).toEqual(["t_created", "t_tie_a"]);
    const first = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1", tag: "bug", limit: 1,
    });
    expect(first.map(row => row.id)).toEqual(["t_created"]);
  });

  it("treats the archive tag as an exclusive feed before pagination", async () => {
    const all = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1",
      limit: 1,
    });
    const ordinary = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1",
      tag: "bug",
      limit: 5,
    });
    const archived = await threadQueries.listForumThreadsByCreatedAt(db as never, {
      parentChannelId: "forum_1",
      tag: FORUM_ARCHIVE_TAG,
      limit: 5,
    });

    expect(all.map((row) => row.id)).toEqual(["t_created"]);
    expect(ordinary.map((row) => row.id)).toEqual(["t_created", "t_tie_a"]);
    expect(archived.map((row) => row.id)).toEqual(["t_tag_archived"]);
  });

  it("keeps the actual untagged feed ordered without a temporary sort under equivalent indexes", async () => {
    const expected = ["t_created", "t_tie_b", "t_tie_a", "t_new"];
    const plans = async () => {
      fixture.queries.length = 0;
      const rows = await threadQueries.listForumThreadsByCreatedAt(db as never, { parentChannelId: "forum_1", limit: 50 });
      expect(rows.map(row => row.id)).toEqual(expected);
      expect(fixture.queries.length).toBeGreaterThan(0);
      return fixture.queries.flatMap(query => sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>);
    };
    const sorts = (plan: Array<{ detail: string }>) => plan.some(row => row.detail.includes("USE TEMP B-TREE"));
    expect(sorts(await plans())).toBe(false);
    const indexes = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'community_channel' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
    expect(indexes.length).toBeGreaterThan(0);
    for (const index of indexes) sqlite.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
    expect(sorts(await plans())).toBe(true);
    for (const index of indexes) sqlite.exec(index.sql.replace(index.name, `equivalent_${index.name}`));
    expect(sorts(await plans())).toBe(false);
  });
  it("preserves SQLite BINARY participant tie ordering for case-sensitive ids", async () => {
    fixture.user("A", "upper");
    fixture.user("a", "lower");
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

  it.each([undefined, 1])("retains real participant numbers across chunks and duplicate channel ids (limit %s)", async (limit) => {
    fixture.user("numbered", "Numbered", "123456");
    fixture.user("later", "Later", "0042");
    const insert = sqlite.prepare("INSERT INTO community_channel_member (id, channel_id, user_id, relation, source, added_at) VALUES (?, ?, ?, 'notify', 'added', ?)");
    const channelIds = Array.from({ length: 100 }, (_, index) => `numbered_thread_${index}`);
    for (const channelId of channelIds) {
      fixture.thread({ id: channelId });
      insert.run(`${channelId}:first`, channelId, "numbered", "2026-10-11T01:00:00Z");
      insert.run(`${channelId}:second`, channelId, "later", "2026-10-11T02:00:00Z");
    }
    const rows = await threadQueries.listParticipantsForChannels(db as never, [...channelIds, ...channelIds], limit);
    expect(rows).toHaveLength(limit === undefined ? 200 : 100);
    expect(rows.filter((row) => row.userId === "numbered")).toHaveLength(100);
    expect(rows.filter((row) => row.userId === "numbered").every((row) => row.discriminator === "123456")).toBe(true);
    expect(new Set(rows.map((row) => `${row.channelId}:${row.userId}`)).size).toBe(rows.length);
    if (limit !== undefined) expect(rows.every((row) => "participantCount" in row && row.participantCount === 2)).toBe(true);
    else expect(rows.filter((row) => row.userId === "later").every((row) => row.discriminator === "0042")).toBe(true);
  });

  it("keeps retained disposition explicit when the participating query is disabled", async () => {
    for (const params of [
      { parentChannelIds: [] as string[], limitPerParent: 5 },
      { parentChannelIds: ["forum_1"], limitPerParent: 0 },
    ]) {
      const result = await threadQueries.listParticipatingForumThreads(db as never, {
        ...params,
        userId: "viewer",
        activeAfter: "2026-08-08T03:00:00.000Z",
        retainId: "t_created",
      });

      expect(result).toEqual({
        canonical: [],
        retained: null,
        retainedDisposition: "genuine-negative",
      });
    }
  });

  it("returns per-forum recent notify rows and retains an older open post", async () => {
    fixture.user("viewer", "Viewer");
    const insertMember = sqlite.prepare(`
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, source, added_at)
      VALUES (?, ?, 'viewer', 'notify', 'spoke', '2026-08-08T00:00:00.000Z')
    `);
    for (const id of ["t_new", "t_tie_b", "t_tie_a", "t_created", "t_tag_archived", "t_archived", "foreign"]) {
      insertMember.run(`member_${id}`, id);
    }
    sqlite.prepare(
      "INSERT INTO community_message_tag (id, message_id, tag) VALUES (?, ?, ?)",
    ).run("tag_channel_archive", "m_archived", FORUM_ARCHIVE_TAG);

    const recent = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1", "forum_2"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
    });
    expect(recent.canonical.map((row) => row.id)).toEqual(["t_new", "t_tie_b", "foreign"]);
    expect(recent.retained).toBeNull();
    expect(recent.retainedDisposition).toBeNull();

    const retained = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1", "forum_2"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "t_created",
    });
    expect(retained.canonical.map((row) => row.id)).toEqual(["t_new", "t_tie_b", "foreign"]);
    expect(retained.retained?.id).toBe("t_created");
    expect(retained.retainedDisposition).toBe("eligible");

    const openerArchived = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "t_tag_archived",
    });
    expect(openerArchived.retained).toBeNull();
    expect(openerArchived.retainedDisposition).toBe("opener-archived");

    const channelArchived = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "t_archived",
    });
    expect(channelArchived.retained).toBeNull();
    expect(channelArchived.retainedDisposition).toBe("genuine-negative");

    fixture.user("outsider", "Outsider");
    const nonparticipantArchived = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "outsider",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "t_tag_archived",
    });
    expect(nonparticipantArchived.retained).toBeNull();
    expect(nonparticipantArchived.retainedDisposition).toBe("genuine-negative");

    const outOfScopeRetained = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T03:00:00.000Z",
      limitPerParent: 2,
      retainId: "foreign",
    });
    expect(outOfScopeRetained.canonical.map((row) => row.id)).toEqual(["t_new", "t_tie_b"]);
    expect(outOfScopeRetained.retained).toBeNull();
    expect(outOfScopeRetained.retainedDisposition).toBe("genuine-negative");
  });

  it("filters archived openers before top-five ranking and refills from the sixth active post", async () => {
    fixture.user("viewer", "Viewer");
    fixture.thread({ id: "t_fifth", name: "fifth", parentMessageId: "m_fifth", lastMessageAt: "2026-08-08T03:30:00.000Z" });
    fixture.thread({ id: "t_sixth", name: "sixth", parentMessageId: "m_sixth", lastMessageAt: "2026-08-08T03:00:00.000Z" });
    const insertMember = sqlite.prepare(`
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, source, added_at)
      VALUES (?, ?, 'viewer', 'notify', 'spoke', '2026-08-08T00:00:00.000Z')
    `);
    for (const id of [
      "t_tag_archived",
      "t_new",
      "t_tie_b",
      "t_tie_a",
      "t_fifth",
      "t_sixth",
      "t_created",
    ]) {
      insertMember.run(`member_${id}`, id);
    }
    sqlite.prepare("DELETE FROM community_message_tag WHERE id = 'tag_archive'").run();

    const before = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T00:00:00.000Z",
      limitPerParent: 5,
    });
    expect(before.canonical.map((row) => row.id)).toEqual([
      "t_tag_archived",
      "t_new",
      "t_tie_b",
      "t_tie_a",
      "t_fifth",
    ]);

    sqlite.prepare(
      "INSERT INTO community_message_tag (id, message_id, tag) VALUES (?, ?, ?)",
    ).run("tag_archive_again", "m_tag_archived", FORUM_ARCHIVE_TAG);
    const archived = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T00:00:00.000Z",
      limitPerParent: 5,
    });
    expect(archived.canonical.map((row) => row.id)).toEqual([
      "t_new",
      "t_tie_b",
      "t_tie_a",
      "t_fifth",
      "t_sixth",
    ]);

    sqlite.prepare("DELETE FROM community_message_tag WHERE id = 'tag_archive_again'").run();
    const unarchived = await threadQueries.listParticipatingForumThreads(db as never, {
      parentChannelIds: ["forum_1"],
      userId: "viewer",
      activeAfter: "2026-08-08T00:00:00.000Z",
      limitPerParent: 5,
    });
    expect(unarchived.canonical.map((row) => row.id)).toEqual(before.canonical.map((row) => row.id));
  });
});

describe("addThreadParticipant", () => {
  it("returns and persists a new notify participant alongside existing access", async () => {
    const f = createForumFixture(); f.user("u1"); f.thread({ id: "t1" }); f.thread({ id: "t2" });
    f.member("t1", "u1", "access", "added"); f.member("t2", "u1");
    const before = f.members();
    const result = await threadQueries.addThreadParticipant(f.db, { threadChannelId: "t1", userId: "u1", source: "spoke" });
    expect(result).toMatchObject({ channelId: "t1", userId: "u1", relation: "notify", source: "spoke" });
    expect(result!.id.length).toBeGreaterThan(0);
    expect(f.members()).toEqual(expect.arrayContaining(before));
    expect(f.members().filter(row => row.channel_id === "t1" && row.relation === "notify"))
      .toEqual([expect.objectContaining({ id: result!.id, user_id: "u1", source: "spoke" })]);
    expect(f.members()).toHaveLength(before.length + 1);
  });

  it("returns null on a real duplicate without replacing its original source", async () => {
    const f = createForumFixture(); f.user("u1"); f.thread({ id: "t1" });
    f.member("t1", "u1", "access", "added"); f.member("t1", "u1", "notify", "spoke");
    const before = f.members();
    const result = await threadQueries.addThreadParticipant(f.db, { threadChannelId: "t1", userId: "u1", source: "mention" });
    expect(result).toBeNull();
    expect(f.members()).toEqual(before);
  });
});

describe("listThreadParticipantUserIds — notify set", () => {
  it("returns the channel's complete notify set without foreign or access-only users", async () => {
    const f = createForumFixture(); f.thread({ id: "t1" }); f.thread({ id: "t2" });
    for (const id of ["u1", "u2", "u3", "u4"]) f.user(id);
    f.member("t1", "u1"); f.member("t1", "u2"); f.member("t1", "u3", "access", "added"); f.member("t2", "u4");
    expect((await threadQueries.listThreadParticipantUserIds(f.db, "t1")).sort()).toEqual(["u1", "u2"]);
  });
});

describe("listParticipantsForChannels — D1 bind cap", () => {
  it("chunks 100 channel ids so every ranked statement stays within 100 binds", async () => {
    const f = createForumFixture(); f.user("viewer"); f.user("access-only");
    const channelIds = Array.from({ length: 100 }, (_, index) => `thread_${index}`);
    for (const id of channelIds) { f.thread({ id }); f.member(id, "viewer"); f.member(id, "access-only", "access", "added"); }
    f.thread({ id: "foreign" }); f.member("foreign", "viewer");
    const input = [...channelIds, channelIds[0]!];
    const snapshot = [...input];
    const rows = await threadQueries.listParticipantsForChannels(f.db, input, 5);
    expect(rows.map(row => row.channelId).sort()).toEqual([...channelIds].sort());
    expect(rows.every(row => row.userId === "viewer" && row.participantCount === 1)).toBe(true);
    expect(input).toEqual(snapshot);
    expectD1Budget(f.queries);
  });
});

describe("listParticipatingForumThreads — D1 bind cap", () => {
  it("chunks 100 visible forum ids so ranked and retained statements stay within 100 binds", async () => {
    const f = createForumFixture(); f.user("viewer_1"); f.user("other");
    const parentChannelIds = Array.from({ length: 100 }, (_, index) => `forum_${index}`);
    const expected: string[] = [];
    for (const parentChannelId of parentChannelIds) {
      for (let index = 0; index < 6; index++) {
        const id = `${parentChannelId}:post-${index}`;
        f.thread({ id, parentChannelId, lastMessageAt: `2026-08-08T0${index}:00:00.000Z` });
        f.member(id, "viewer_1");
        if (index > 0) expected.push(id);
      }
    }
    f.thread({ id: "thread_1", parentChannelId: parentChannelIds[99]!, lastMessageAt: "2026-08-01T00:00:00.000Z" });
    f.member("thread_1", "viewer_1");
    f.thread({ id: "foreign", parentChannelId: "foreign-forum", lastMessageAt: "2026-08-09T00:00:00.000Z" }); f.member("foreign", "viewer_1");
    f.thread({ id: "access-only", parentChannelId: parentChannelIds[0]!, lastMessageAt: "2026-08-09T00:00:00.000Z" }); f.member("access-only", "viewer_1", "access", "added");
    f.thread({ id: "other-viewer", parentChannelId: parentChannelIds[0]!, lastMessageAt: "2026-08-09T00:00:00.000Z" }); f.member("other-viewer", "other");
    const input = { parentChannelIds: [...parentChannelIds, parentChannelIds[0]!], userId: "viewer_1", activeAfter: "2026-08-05T00:00:00.000Z", limitPerParent: 5, retainId: "thread_1" };
    const snapshot = structuredClone(input);
    const result = await threadQueries.listParticipatingForumThreads(f.db, input);
    expect(result.canonical.map(row => row.id).sort()).toEqual(expected.sort());
    expect(result.retained).toMatchObject({ id: "thread_1", parentChannelId: parentChannelIds[99] });
    expect(result.retainedDisposition).toBe("eligible");
    expect(input).toEqual(snapshot);
    expectD1Budget(f.queries);
    f.tag("retained-archived", "opener-thread_1", FORUM_ARCHIVE_TAG);
    f.queries.length = 0;
    const archived = await threadQueries.listParticipatingForumThreads(f.db, input);
    expect(archived.canonical.map(row => row.id).sort()).toEqual(expected);
    expect(archived.retained).toBeNull();
    expect(archived.retainedDisposition).toBe("opener-archived");
    expectD1Budget(f.queries);
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

  it("returns only requested notify channels for the selected user", async () => {
    const f = createForumFixture(); f.user("u1"); f.user("u2");
    for (const id of ["t1", "t2", "t3", "t4"]) f.thread({ id });
    f.member("t1", "u1"); f.member("t3", "u1"); f.member("t2", "u2"); f.member("t2", "u1", "access", "added"); f.member("t4", "u1");
    expect((await threadQueries.listParticipatingThreadIds(f.db, ["t1", "t2", "t3"], "u1")).sort()).toEqual(["t1", "t3"]);
  });
});

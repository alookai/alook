import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import {
  markForumOpenerReadBuilder,
  hasForumOpenerReadCondition,
  pruneCoveredForumOpenerReadsBuilder,
} from "../../src/db/queries/community/forum-opener-read"
import { user } from "../../src/db/schema"

describe("community forum opener sparse reads", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        parent_channel_id TEXT,
        type TEXT NOT NULL
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        joined_at TEXT NOT NULL
      );
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE community_read_state (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL
      );
      CREATE TABLE community_forum_opener_read (
        user_id TEXT NOT NULL,
        opener_message_id TEXT NOT NULL,
        read_at TEXT NOT NULL,
        PRIMARY KEY (user_id, opener_message_id)
      );
      INSERT INTO user (id) VALUES ('u1');
      INSERT INTO community_channel (id, server_id, parent_channel_id, type)
        VALUES ('forum', 's1', NULL, 'forum');
      INSERT INTO community_server_member (id, server_id, user_id, joined_at)
        VALUES ('membership', 's1', 'u1', '2026-08-24T00:00:00.000Z');
      INSERT INTO community_message (id, channel_id, created_at, seq) VALUES
        ('before-join', 'forum', '2026-08-23T23:59:00.000Z', 1),
        ('baseline', 'forum', '2026-08-24T00:01:00.000Z', 2),
        ('unread', 'forum', '2026-08-24T00:02:00.000Z', 3);
    `)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  function mark(openerMessageId: string) {
    ;(markForumOpenerReadBuilder(db, {
      userId: "u1",
      openerMessageId,
      readAt: "2026-08-24T00:03:00.000Z",
    }) as any).run()
  }

  function sparseIds() {
    return sqlite
      .prepare(`
        SELECT opener_message_id AS id
        FROM community_forum_opener_read
        WHERE user_id = 'u1'
        ORDER BY opener_message_id
      `)
      .all()
  }

  it("uses joined_at as the legacy baseline until a parent cursor exists", () => {
    mark("before-join")
    mark("baseline")

    expect(sparseIds()).toEqual([{ id: "baseline" }])
  })

  it("uses the parent cursor as the baseline and prunes sparse rows it covers", () => {
    sqlite.prepare(`
      INSERT INTO community_read_state
        (id, user_id, channel_id, last_read_seq)
      VALUES ('read', 'u1', 'forum', 2)
    `).run()

    mark("baseline")
    mark("unread")
    sqlite.prepare(`
      INSERT INTO community_forum_opener_read
        (user_id, opener_message_id, read_at)
      VALUES ('u1', 'baseline', '2026-08-24T00:03:00.000Z')
    `).run()

    expect(sparseIds()).toEqual([{ id: "baseline" }, { id: "unread" }])

    ;(pruneCoveredForumOpenerReadsBuilder(db, {
      userId: "u1",
      channelId: "forum",
      targetSeq: 2,
    }) as any).run()

    expect(sparseIds()).toEqual([{ id: "unread" }])
  })

  it("exposes an exact sparse-row predicate for atomic effect guards", () => {
    mark("unread")

    const row = (db as any)
      .select({
        present: hasForumOpenerReadCondition(db, "u1", "unread"),
        absent: hasForumOpenerReadCondition(db, "u1", "missing"),
      })
      .from(user)
      .where(eq(user.id, "u1"))
      .get()

    expect(row).toEqual({ present: 1, absent: 0 })
  })
})

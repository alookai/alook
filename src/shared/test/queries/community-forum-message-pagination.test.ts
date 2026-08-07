import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import * as messageQueries from "../../src/db/queries/community/message"
import * as tagQueries from "../../src/db/queries/community/message-tag"

describe("forum opener message pagination against real SQLite", () => {
  let sqlite: Sqlite.Database
  let db: ReturnType<typeof drizzle>

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        image TEXT
      );
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'default',
        mention_type TEXT,
        reply_to_id TEXT,
        embeds TEXT,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL DEFAULT 0,
        friendship_id TEXT,
        client_nonce TEXT
      );
      CREATE TABLE community_message_tag (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        UNIQUE(message_id, tag)
      );
    `)
    sqlite.prepare("INSERT INTO user (id, name, email, image) VALUES (?, ?, ?, ?)")
      .run("u1", "Alice", "alice@example.com", null)
    const insertMessage = sqlite.prepare(`
      INSERT INTO community_message
        (id, author_id, content, created_at, channel_id, seq)
      VALUES (?, 'u1', ?, ?, ?, ?)
    `)
    for (let n = 1; n <= 6; n++) {
      insertMessage.run(`m${n}`, `message ${n}`, `2026-01-01T00:00:0${n}.000Z`, "c1", n)
    }
    insertMessage.run("x1", "foreign", "2026-01-01T00:00:09.000Z", "c2", 1)
    const insertTag = sqlite.prepare("INSERT INTO community_message_tag (id, message_id, tag) VALUES (?, ?, ?)")
    for (const messageId of ["m2", "m4", "m6", "x1"]) insertTag.run(`tag-${messageId}-bug`, messageId, "bug")
    insertTag.run("tag-m1-feature", "m1", "feature")
    insertTag.run("tag-x1-secret", "x1", "secret")
    db = drizzle(sqlite)
  })

  afterEach(() => sqlite.close())

  it("filters by channel and tag before LIMIT, yielding a full page with no cross-channel leak", async () => {
    const rows = await messageQueries.listMessages(db as never, { channelId: "c1", tag: "bug", limit: 3 })
    expect(rows.map((row) => row.id)).toEqual(["m6", "m4", "m2"])
  })

  it("pages the tagged tuple cursor without overlap or omission", async () => {
    const first = await messageQueries.listMessages(db as never, { channelId: "c1", tag: "bug", limit: 2 })
    const second = await messageQueries.listMessages(db as never, {
      channelId: "c1",
      tag: "bug",
      limit: 2,
      cursor: { createdAt: first[1]!.createdAt, id: first[1]!.id },
    })
    expect(first.map((row) => row.id)).toEqual(["m6", "m4"])
    expect(second.map((row) => row.id)).toEqual(["m2"])
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(3)
  })

  it("applies the same tagged set to anchor and since windows", async () => {
    const around = await messageQueries.listMessagesAround(db as never, {
      channelId: "c1",
      tag: "bug",
      anchor: { createdAt: "2026-01-01T00:00:04.000Z", id: "m4" },
      limit: 4,
    })
    const since = await messageQueries.listMessagesSince(db as never, {
      channelId: "c1",
      tag: "bug",
      since: { createdAt: "2026-01-01T00:00:02.000Z", id: "m2" },
      limit: 4,
    })
    expect(around.older.map((row) => row.id)).toEqual(["m2"])
    expect(around.newer.map((row) => row.id)).toEqual(["m4", "m6"])
    expect(since.map((row) => row.id)).toEqual(["m4", "m6"])
  })

  it("lists only the current channel's distinct opener-message tags", async () => {
    await expect(tagQueries.listDistinctTagsForChannel(db as never, "c1"))
      .resolves.toEqual(["bug", "feature"])
  })
})

import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { listDMs } from "../../src/db/queries/community/dm"

describe("listDMs ordering", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        last_message_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_channel_member (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relation TEXT NOT NULL
      );
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0,
        discriminator TEXT NOT NULL DEFAULT '0000',
        deletedAt TEXT
      );
    `)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("preserves SQLite BINARY ordering for equal-activity mixed-case nanoids", async () => {
    const channelIds = [
      "kMRip4KDm4Ki2HU8vQ2qd",
      "bc02tEwQaazjdPwrMuNih",
      "XzKeKetmiRMJ16hwOrhSl",
      "3kY1MAppCm6RYM4IvnXPN",
    ]
    const activityAt = "2026-09-27T03:00:00.000Z"
    sqlite.prepare(
      "INSERT INTO user (id, name, email) VALUES (?, ?, ?)",
    ).run("viewer", "Viewer", "viewer@example.com")
    const insertChannel = sqlite.prepare(`
      INSERT INTO community_channel (id, type, last_message_at, created_at)
      VALUES (?, 'dm', ?, ?)
    `)
    const insertUser = sqlite.prepare(
      "INSERT INTO user (id, name, email) VALUES (?, ?, ?)",
    )
    const insertMember = sqlite.prepare(`
      INSERT INTO community_channel_member (channel_id, user_id, relation)
      VALUES (?, ?, 'access')
    `)

    channelIds.forEach((channelId, index) => {
      const peerId = `peer-${index}`
      insertChannel.run(channelId, activityAt, activityAt)
      insertUser.run(peerId, peerId, `${peerId}@example.com`)
      insertMember.run(channelId, "viewer")
      insertMember.run(channelId, peerId)
    })

    const rows = await listDMs(db, "viewer")

    expect(rows.map((row) => row.id)).toEqual([
      "3kY1MAppCm6RYM4IvnXPN",
      "XzKeKetmiRMJ16hwOrhSl",
      "bc02tEwQaazjdPwrMuNih",
      "kMRip4KDm4Ki2HU8vQ2qd",
    ])
  })
})

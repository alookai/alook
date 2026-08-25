import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import {
  advanceReadStateRevisionBuilder,
  markReadToMessageBuilder,
} from "../../src/db/queries/community/read-state"

describe("community read-state SQLite monotonicity", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE community_read_state (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        last_read_at TEXT NOT NULL,
        last_read_message_id TEXT,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, channel_id)
      );
      CREATE TABLE community_read_state_revision (
        user_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      );
    `)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("orders equal-timestamp messages by seq and never regresses the aligned triple", () => {
    ;(markReadToMessageBuilder(db, {
      userId: "u1",
      channelId: "c1",
      message: { id: "m5", createdAt: "2026-08-24T00:00:00.000Z", seq: 5 },
    }) as any).run()
    ;(markReadToMessageBuilder(db, {
      userId: "u1",
      channelId: "c1",
      message: { id: "m6", createdAt: "2026-08-24T00:00:00.000Z", seq: 6 },
    }) as any).run()
    ;(markReadToMessageBuilder(db, {
      userId: "u1",
      channelId: "c1",
      message: { id: "m4", createdAt: "2026-08-24T00:01:00.000Z", seq: 4 },
    }) as any).run()

    expect(sqlite.prepare(`
      SELECT last_read_message_id AS id, last_read_at AS at, last_read_seq AS seq
      FROM community_read_state WHERE user_id = 'u1' AND channel_id = 'c1'
    `).get()).toEqual({
      id: "m6",
      at: "2026-08-24T00:00:00.000Z",
      seq: 6,
    })
  })

  it("upserts one durable account revision and increments it atomically", () => {
    const first = (advanceReadStateRevisionBuilder(db, "u1") as any).all()
    const second = (advanceReadStateRevisionBuilder(db, "u1") as any).all()
    expect(first).toEqual([{ revision: 1 }])
    expect(second).toEqual([{ revision: 2 }])
    expect(sqlite.prepare(`
      SELECT user_id AS userId, revision FROM community_read_state_revision
    `).all()).toEqual([{ userId: "u1", revision: 2 }])
  })
})

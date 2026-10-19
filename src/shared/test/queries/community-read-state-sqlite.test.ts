import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import {
  advanceReadStateRevisionBuilder,
  markReadToMessageBuilder,
  getChannelReadStateSnapshot,
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

  it("reads one viewer and channel with its account revision in one snapshot batch", async () => {
    sqlite.prepare("INSERT INTO community_read_state VALUES (?, ?, ?, ?, ?, ?)").run("r1", "viewer", "c1", "at1", "m1", 1)
    sqlite.prepare("INSERT INTO community_read_state VALUES (?, ?, ?, ?, ?, ?)").run("r2", "viewer", "c2", "at2", "m2", 2)
    sqlite.prepare("INSERT INTO community_read_state VALUES (?, ?, ?, ?, ?, ?)").run("r3", "other", "c1", "private", "private", 9)
    sqlite.prepare("INSERT INTO community_read_state_revision VALUES (?, ?)").run("viewer", 4)
    sqlite.prepare("INSERT INTO community_read_state_revision VALUES (?, ?)").run("other", 9)
    Object.assign(db, { batch: async (statements: Array<{ all: () => unknown }>) => sqlite.transaction(() => statements.map((statement) => statement.all()))() })
    await expect(getChannelReadStateSnapshot(db, { userId: "viewer", channelId: "c1" })).resolves.toEqual({
      revision: 4, readState: { channelId: "c1", lastReadMessageId: "m1", lastReadAt: "at1", lastReadSeq: 1 },
    })
    await expect(getChannelReadStateSnapshot(db, { userId: "viewer", channelId: "missing" })).resolves.toEqual({ revision: 4, readState: null })
    await expect(getChannelReadStateSnapshot(db, { userId: "missing", channelId: "c1" })).resolves.toEqual({ revision: 0, readState: null })
  })
})

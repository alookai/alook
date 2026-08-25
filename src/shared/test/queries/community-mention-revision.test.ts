import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { user } from "../../src/db/schema"
import {
  dismissMentionWithRevision,
  markAllMentionsReadWithRevision,
  markMessageMentionsReadBuilder,
  unreadChannelMentionThroughSeqCondition,
  unreadMessageMentionCondition,
} from "../../src/db/queries/community/mention"

describe("community mention revision effects", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY);
      CREATE TABLE community_message (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL
      );
      CREATE TABLE community_mention (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        read INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE community_read_state_revision (
        user_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO user (id) VALUES ('u1');
      INSERT INTO community_message (id, channel_id, seq) VALUES
        ('m1', 'c1', 1),
        ('m5', 'c1', 5);
      INSERT INTO community_mention (id, message_id, user_id, read) VALUES
        ('mention-1', 'm1', 'u1', 0),
        ('mention-5', 'm5', 'u1', 0);
    `)
    const betterDb = drizzle(sqlite)
    ;(betterDb as any).batch = async (statements: any[]) =>
      sqlite.transaction(() => statements.map((statement) => {
        try {
          return statement.all()
        } catch (error) {
          if (error instanceof TypeError && error.message.includes("does not return data")) {
            return statement.run()
          }
          throw error
        }
      }))()
    db = betterDb as unknown as Database
  })

  afterEach(() => sqlite.close())

  function conditions() {
    return (db as any)
      .select({
        throughOne: unreadChannelMentionThroughSeqCondition(db, "u1", "c1", 1),
        exactFive: unreadMessageMentionCondition(db, "u1", "m5"),
      })
      .from(user)
      .where(eq(user.id, "u1"))
      .get()
  }

  it("guards bounded mention repairs and versions only real mark-all or dismiss effects", async () => {
    expect(conditions()).toEqual({ throughOne: 1, exactFive: 1 })

    ;(markMessageMentionsReadBuilder(db, "u1", "m5") as any).run()
    expect(conditions()).toEqual({ throughOne: 1, exactFive: 0 })

    await expect(markAllMentionsReadWithRevision(db, "u1"))
      .resolves.toEqual({ changed: true, revision: 1 })
    await expect(markAllMentionsReadWithRevision(db, "u1"))
      .resolves.toEqual({ changed: false, revision: 1 })

    sqlite.prepare("UPDATE community_mention SET read = 0 WHERE id = 'mention-1'").run()
    await expect(dismissMentionWithRevision(db, "u1", "mention-1"))
      .resolves.toEqual({ changed: true, revision: 2 })
    await expect(dismissMentionWithRevision(db, "u1", "mention-1"))
      .resolves.toEqual({ changed: false, revision: 2 })
  })
})

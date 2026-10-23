import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { communityWriteDb } from "../helpers/community-write-db"
import { createMessage } from "../../src/db/queries/community/message"
import { listEligibleUnreadDms } from "../../src/db/queries/community/inbox"
import { markReadToMessageBuilder } from "../../src/db/queries/community/read-state"

describe("DM unread counts against real SQLite", () => {
  let fixture: ReturnType<typeof communityWriteDb>
  beforeEach(() => {
    fixture = communityWriteDb()
    fixture.sqlite.exec(`
      ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT 'Peer';
      ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '0042';
      ALTER TABLE user ADD COLUMN image TEXT;
      ALTER TABLE user ADD COLUMN avatarVersion INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE community_notification_setting (user_id TEXT, server_id TEXT, channel_id TEXT, level TEXT);
      UPDATE community_channel SET type = 'dm' WHERE id = 'channel';
      INSERT INTO community_channel_member VALUES
        ('viewer', 'channel', 'author', 'access', 'added', NULL, 'now'),
        ('peer', 'channel', 'peer', 'access', 'added', NULL, 'now');
    `)
  })
  afterEach(() => fixture.sqlite.close())

  it("counts existing unread messages across seq holes and shrinks with the read cursor", async () => {
    const sent = []
    for (let index = 0; index < 3; index++) {
      sent.push((await createMessage(fixture.db, { channelId: "channel", authorId: "peer", authorKind: "human", content: `message ${index}` }))!)
    }
    fixture.sqlite.prepare("DELETE FROM community_message WHERE seq = 2").run()
    await expect(listEligibleUnreadDms(fixture.db, "author")).resolves.toEqual([
      expect.objectContaining({ channelId: "channel", lastUnreadSeq: 3, unreadCount: 2 }),
    ])
    ;(markReadToMessageBuilder(fixture.db, { userId: "author", channelId: "channel", message: sent[0]! }) as any).run()
    await expect(listEligibleUnreadDms(fixture.db, "author")).resolves.toEqual([
      expect.objectContaining({ lastUnreadSeq: 3, unreadCount: 1 }),
    ])
    ;(markReadToMessageBuilder(fixture.db, { userId: "author", channelId: "channel", message: sent[2]! }) as any).run()
    await expect(listEligibleUnreadDms(fixture.db, "author")).resolves.toEqual([])
    await expect(listEligibleUnreadDms(fixture.db, "outsider")).resolves.toEqual([])
  })
})

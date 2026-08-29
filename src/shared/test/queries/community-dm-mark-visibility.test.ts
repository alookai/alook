import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import {
  listDmChannelIdsForUser,
  listDmPeerUserIds,
} from "../../src/db/queries/community/dm"

describe("listDmChannelIdsForUser — readable mark scope", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE community_channel (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL
      );
      CREATE TABLE community_channel_member (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relation TEXT NOT NULL
      );
      CREATE TABLE community_friendship (
        requester_id TEXT NOT NULL,
        addressee_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        deletedAt TEXT
      );
      INSERT INTO community_channel (id, type) VALUES
        ('dm_open', 'dm'),
        ('dm_peer_blocked_me', 'dm'),
        ('dm_me_blocked_peer', 'dm');
      INSERT INTO community_channel_member (channel_id, user_id, relation) VALUES
        ('dm_open', 'me', 'access'),
        ('dm_open', 'open_peer', 'access'),
        ('dm_peer_blocked_me', 'me', 'access'),
        ('dm_peer_blocked_me', 'peer_blocker', 'access'),
        ('dm_me_blocked_peer', 'me', 'access'),
        ('dm_me_blocked_peer', 'peer_blocked', 'access');
      INSERT INTO community_friendship (requester_id, addressee_id, status) VALUES
        ('peer_blocker', 'me', 'blocked'),
        ('me', 'peer_blocked', 'blocked');
      INSERT INTO user (id, deletedAt) VALUES
        ('me', NULL),
        ('open_peer', NULL),
        ('peer_blocker', NULL),
        ('peer_blocked', NULL);
    `)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("excludes both peer-to-viewer and viewer-to-peer blocks with one batched anti-join", async () => {
    await expect(listDmChannelIdsForUser(db, "me")).resolves.toEqual(["dm_open"])
  })

  it("uses the same readable-DM boundary for identity fanout peers", async () => {
    await expect(listDmPeerUserIds(db, "me")).resolves.toEqual(["open_peer"])
  })
})

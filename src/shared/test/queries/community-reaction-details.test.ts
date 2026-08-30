import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { getReactionDetailsActors } from "../../src/db/queries/community/reaction"

describe("getReactionDetailsActors against real SQLite", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0,
        isBot INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        deletedAt TEXT,
        discriminator TEXT NOT NULL DEFAULT '0000'
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        rail_order INTEGER DEFAULT 0,
        joined_at TEXT NOT NULL
      );
      CREATE TABLE community_channel_member (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'added',
        added_by TEXT,
        added_at TEXT NOT NULL
      );
      CREATE TABLE community_reaction (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  function user(
    id: string,
    options: { deleted?: boolean; bot?: boolean; owner?: string } = {},
  ) {
    sqlite.prepare(`
      INSERT INTO user
        (id, name, email, image, avatarVersion, isBot, ownerUserId, deletedAt, discriminator)
      VALUES (?, ?, ?, ?, 3, ?, ?, ?, ?)
    `).run(
      id,
      `Name ${id}`,
      `${id}@example.com`,
      `/avatar/${id}`,
      options.bot ? 1 : 0,
      options.owner ?? null,
      options.deleted ? "2026-01-01T00:00:00.000Z" : null,
      id.slice(-4).padStart(4, "0"),
    )
  }

  function member(serverId: string, userId: string) {
    sqlite.prepare(`
      INSERT INTO community_server_member (id, server_id, user_id, joined_at)
      VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')
    `).run(`member-${serverId}-${userId}`, serverId, userId)
  }

  function participant(channelId: string, userId: string, relation = "access") {
    sqlite.prepare(`
      INSERT INTO community_channel_member
        (id, channel_id, user_id, relation, added_at)
      VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
    `).run(`participant-${channelId}-${userId}-${relation}`, channelId, userId, relation)
  }

  function reaction(messageId: string, userId: string, emoji: string) {
    sqlite.prepare(`
      INSERT INTO community_reaction (id, message_id, user_id, emoji, created_at)
      VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z')
    `).run(`reaction-${messageId}-${userId}-${emoji}`, messageId, userId, emoji)
  }

  it("scopes server identities before the join and returns unique sorted nullable actors", async () => {
    user("active")
    user("departed")
    user("deleted", { deleted: true })
    user("owner-live")
    user("owner-gone", { deleted: true })
    user("bot-live", { bot: true, owner: "owner-live" })
    user("bot-orphan", { bot: true, owner: "owner-gone" })
    user("outsider")
    for (const id of ["active", "deleted", "bot-live", "bot-orphan"]) member("server-1", id)
    member("server-2", "outsider")
    for (const id of ["active", "departed", "deleted", "bot-live", "bot-orphan", "outsider"]) {
      reaction("message-1", id, "👍")
    }
    reaction("message-1", "active", "🔥")
    reaction("message-2", "outsider", "🎉")

    const actors = await getReactionDetailsActors(db, "message-1", {
      kind: "server",
      serverId: "server-1",
      channelId: "channel-1",
    })
    expect(actors.map((actor) => actor.userId)).toEqual([
      "active",
      "bot-live",
      "bot-orphan",
      "deleted",
      "departed",
      "outsider",
    ])
    expect(actors.filter((actor) => actor.profile).map((actor) => actor.userId))
      .toEqual(["active", "bot-live"])
    expect(actors.find((actor) => actor.userId === "departed")?.profile).toBeNull()
    expect(actors.find((actor) => actor.userId === "deleted")?.profile).toBeNull()
    expect(actors.find((actor) => actor.userId === "bot-orphan")?.profile).toBeNull()
    expect(actors.find((actor) => actor.userId === "outsider")?.profile).toBeNull()
  })

  it("exposes only exact-DM access participants", async () => {
    for (const id of ["access", "notify", "other-dm", "deleted-dm"]) {
      user(id, { deleted: id === "deleted-dm" })
      reaction("message-dm", id, "👍")
    }
    participant("dm-1", "access")
    participant("dm-1", "notify", "notify")
    participant("dm-2", "other-dm")
    participant("dm-1", "deleted-dm")

    const actors = await getReactionDetailsActors(db, "message-dm", {
      kind: "dm",
      channelId: "dm-1",
    })
    expect(actors.map((actor) => actor.userId)).toEqual([
      "access",
      "deleted-dm",
      "notify",
      "other-dm",
    ])
    expect(actors.find((actor) => actor.userId === "access")?.profile).not.toBeNull()
    expect(actors.filter((actor) => actor.userId !== "access").every((actor) => actor.profile === null))
      .toBe(true)
  })
})

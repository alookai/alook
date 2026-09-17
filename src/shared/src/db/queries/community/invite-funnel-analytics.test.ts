import Sqlite from "better-sqlite3"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as communityFunnelAnalyticsSchema from "../../community-funnel-analytics-schema"
import * as communitySchema from "../../community-schema"
import * as userSchema from "../../schema"
import type { Database } from "../../index"
import { claimPendingEvents } from "./funnel-analytics"
import { useInvite } from "./invite"

const migrationPath = resolve(
  import.meta.dirname,
  "../../../../../web/migrations/0103_community_funnel_analytics_event.sql",
)

type BatchStatement = { all(): unknown; run(): unknown }

function createTestDb(sqlite: Sqlite.Database): Database {
  const db = drizzle(sqlite, {
    schema: {
      ...userSchema,
      ...communitySchema,
      ...communityFunnelAnalyticsSchema,
    },
  })
  Object.assign(db, {
    batch: async (statements: BatchStatement[]) => sqlite.transaction(() =>
      statements.map((statement, index) => index === 0 ? statement.all() : statement.run()),
    )(),
  })
  return db as unknown as Database
}

describe("invite membership funnel boundary", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0,
        discriminator TEXT NOT NULL DEFAULT '0000',
        isBot INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        deletedAt TEXT
      );
      CREATE TABLE community_server_invite (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL,
        created_by TEXT,
        token TEXT NOT NULL,
        max_uses INTEGER,
        uses INTEGER DEFAULT 0,
        expires_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        rail_order INTEGER DEFAULT 0,
        joined_at TEXT NOT NULL,
        UNIQUE(server_id, user_id)
      );
    `)
    sqlite.exec(readFileSync(migrationPath, "utf8"))
    sqlite.prepare("INSERT INTO user (id, name, email, isBot, ownerUserId) VALUES (?, ?, ?, ?, ?)")
      .run("owner", "Owner", "owner@example.test", 0, null)
    sqlite.prepare("INSERT INTO user (id, name, email, isBot, ownerUserId) VALUES (?, ?, ?, ?, ?)")
      .run("human", "Human", "human@example.test", 0, null)
    sqlite.prepare("INSERT INTO user (id, name, email, isBot, ownerUserId) VALUES (?, ?, ?, ?, ?)")
      .run("bot", "Bot", "bot@example.test", 1, "owner")
    db = createTestDb(sqlite)
  })

  afterEach(() => sqlite.close())

  function insertInvite(id: string, token: string) {
    sqlite.prepare(`
      INSERT INTO community_server_invite
        (id, server_id, created_by, token, max_uses, uses, created_at)
      VALUES (?, 'server', 'owner', ?, 10, 0, '2026-09-14T00:00:00.000Z')
    `).run(id, token)
  }

  it("commits one inviter-owned event with a fresh human membership", async () => {
    insertInvite("invite-human", "token-human")

    await expect(useInvite(db, "token-human", "human")).resolves.toMatchObject({
      invite: { id: "invite-human", createdBy: "owner" },
      member: { userId: "human", userName: "Human" },
    })
    await expect(claimPendingEvents(db, "owner")).resolves.toEqual([
      { event: "invited_human_joined", surface: "community" },
    ])
    expect(sqlite.prepare("SELECT uses FROM community_server_invite WHERE id = ?").get("invite-human"))
      .toEqual({ uses: 1 })
  })

  it("commits a bot membership without manufacturing a human-join event", async () => {
    insertInvite("invite-bot", "token-bot")

    await expect(useInvite(db, "token-bot", "bot")).resolves.toMatchObject({
      member: { userId: "bot" },
    })
    await expect(claimPendingEvents(db, "owner")).resolves.toEqual([])
  })
})

import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { Database } from "../../src/db"
import { searchMembers } from "../../src/db/queries/community/member"

describe("searchMembers literal prefixes against real SQLite", () => {
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
        avatarObjectKey TEXT,
        isBot INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        discriminator TEXT NOT NULL DEFAULT '0000'
      );
      CREATE TABLE community_server_member (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT DEFAULT 'member',
        joined_at TEXT NOT NULL
      );
      CREATE TABLE community_user_profile (
        user_id TEXT PRIMARY KEY,
        status_emoji TEXT,
        status_text TEXT DEFAULT ''
      );
    `)
    db = drizzle(sqlite) as unknown as Database

    const insertUser = sqlite.prepare(`
      INSERT INTO user (id, name, email, discriminator)
      VALUES (?, ?, ?, ?)
    `)
    const insertMember = sqlite.prepare(`
      INSERT INTO community_server_member
        (id, server_id, user_id, joined_at)
      VALUES (?, 'srv_1', ?, '2026-01-01T00:00:00.000Z')
    `)
    const names = [
      "Literal%Percent",
      "Literal_Underscore",
      "Literal\\Slash",
      "LiteralXDecoy",
      "PlainAlice",
      "PlainBob",
      "XPlain",
    ]
    names.forEach((name, index) => {
      const id = `u_${index}`
      insertUser.run(id, name, `${id}@example.com`, String(index).padStart(4, "0"))
      insertMember.run(`m_${index}`, id)
    })
  })

  afterEach(() => sqlite.close())

  it.each([
    ["Literal%", ["Literal%Percent"]],
    ["Literal_", ["Literal_Underscore"]],
    ["Literal\\", ["Literal\\Slash"]],
    ["Plain", ["PlainAlice", "PlainBob"]],
  ])("treats %s as a literal prefix", async (query, expected) => {
    const page = await searchMembers(db, "srv_1", query)
    expect(page.members.map((member) => member.userName)).toEqual(expected)
  })
})

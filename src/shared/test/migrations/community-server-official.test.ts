import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { getServer } from "../../src/db/queries/community/server"

const migration = readFileSync(new URL("../../../web/migrations/0100_community_server_official.sql", import.meta.url), "utf8")

describe("official server migration and reads", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE community_server (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, discriminator TEXT NOT NULL DEFAULT '0000',
        description TEXT DEFAULT '', icon TEXT, owner_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      INSERT INTO community_server (id, name, owner_id, created_at) VALUES ('existing', 'Alook', 'owner', '2026-09-10');
    `)
    sqlite.exec(migration)
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("keeps existing and newly inserted servers unofficial by default", async () => {
    sqlite.exec("INSERT INTO community_server (id, name, owner_id, created_at) VALUES ('new', 'New', 'owner', '2026-09-10')")
    expect((await getServer(db, "existing"))?.official).toBe(false)
    expect((await getServer(db, "new"))?.official).toBe(false)
  })

  it("reads manual admin updates as booleans and supports removing official status", async () => {
    sqlite.exec("UPDATE community_server SET official = 1 WHERE id = 'existing'")
    expect((await getServer(db, "existing"))?.official).toBe(true)
    sqlite.exec("UPDATE community_server SET official = 0 WHERE id = 'existing'")
    expect((await getServer(db, "existing"))?.official).toBe(false)
  })

  it("rejects null and invalid flags", () => {
    expect(() => sqlite.exec("UPDATE community_server SET official = NULL")).toThrow()
    expect(() => sqlite.exec("UPDATE community_server SET official = 2")).toThrow()
  })
})

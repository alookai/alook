import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { getValidSessionByIdForUser, getValidSessionWithIdentity } from "../../src/db/queries/session"

let sqlite: Sqlite.Database
let db: Database
beforeEach(() => {
  sqlite = new Sqlite(":memory:")
  sqlite.exec(`CREATE TABLE user(id TEXT PRIMARY KEY, name TEXT, discriminator TEXT, deletedAt TEXT, isBot INTEGER);
    CREATE TABLE session(id TEXT PRIMARY KEY, userId TEXT, token TEXT, expiresAt TEXT);
    INSERT INTO user VALUES ('owner','Owner','0001',NULL,0);
    INSERT INTO session VALUES ('session','owner','token','2999-01-01T00:00:00.000Z');`)
  db = drizzle(sqlite) as unknown as Database
})
afterEach(() => sqlite.close())
it("returns persisted identity and rejects a session reused for another owner", async () => {
  expect(await getValidSessionWithIdentity(db, "token")).toEqual({ userId: "owner", name: "Owner", discriminator: "0001", sessionId: "session", expiresAt: "2999-01-01T00:00:00.000Z" })
  expect(await getValidSessionByIdForUser(db, "session", "owner")).toEqual({ expiresAt: "2999-01-01T00:00:00.000Z" })
  expect(await getValidSessionByIdForUser(db, "session", "other")).toBeNull()
})
it.each([
  "UPDATE user SET deletedAt='2026-01-01'",
  "UPDATE user SET isBot=1",
  "UPDATE session SET expiresAt='2000-01-01T00:00:00.000Z'",
  "DELETE FROM session",
])("rejects revoked or ineligible sessions: %s", async (mutation) => {
  sqlite.exec(mutation)
  expect(await getValidSessionWithIdentity(db, "token")).toBeNull()
  expect(await getValidSessionByIdForUser(db, "session", "owner")).toBeNull()
})

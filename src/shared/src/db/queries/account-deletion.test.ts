import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as schema from "../schema"
import type { Database } from "../index"
import {
  deleteDeletionChallengeIfMatches,
  restoreDeletionChallenge,
  takeDeletionChallenge,
  upsertDeletionChallenge,
  type DeletionChallenge,
} from "./account-deletion"

function challenge(overrides: Partial<DeletionChallenge> = {}): DeletionChallenge {
  return {
    id: "account-deletion:test",
    identifier: "account-deletion-otp:user-1:user@example.com",
    value: "123456:0",
    expiresAt: "2026-09-07T15:05:00.000Z",
    createdAt: "2026-09-07T15:00:00.000Z",
    updatedAt: "2026-09-07T15:00:00.000Z",
    ...overrides,
  }
}

describe("account deletion challenge queries", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE verification (
        id TEXT PRIMARY KEY NOT NULL,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      )
    `)
    db = drizzle(sqlite, { schema }) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("keeps exactly one active row and makes the latest code authoritative", async () => {
    await upsertDeletionChallenge(db, challenge())
    await upsertDeletionChallenge(db, challenge({
      value: "654321:0",
      expiresAt: "2026-09-07T15:06:00.000Z",
      updatedAt: "2026-09-07T15:01:00.000Z",
    }))

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM verification").get()).toEqual({ count: 1 })
    expect(sqlite.prepare("SELECT value, expiresAt FROM verification").get()).toEqual({
      value: "654321:0",
      expiresAt: "2026-09-07T15:06:00.000Z",
    })
  })

  it("atomically takes a challenge only once", async () => {
    await upsertDeletionChallenge(db, challenge())

    await expect(takeDeletionChallenge(db, challenge())).resolves.toMatchObject({ value: "123456:0" })
    await expect(takeDeletionChallenge(db, challenge())).resolves.toBeNull()
  })

  it("restores only when a newer resend has not won the primary key", async () => {
    const original = challenge()
    await expect(restoreDeletionChallenge(db, original)).resolves.toBe(true)
    await upsertDeletionChallenge(db, challenge({ value: "654321:0" }))
    await expect(restoreDeletionChallenge(db, original)).resolves.toBe(false)
    expect(sqlite.prepare("SELECT value FROM verification").get()).toEqual({ value: "654321:0" })
  })

  it("rolls back only the exact challenge written by a failed send", async () => {
    const original = challenge()
    await upsertDeletionChallenge(db, original)
    await upsertDeletionChallenge(db, challenge({ value: "654321:0" }))

    await expect(deleteDeletionChallengeIfMatches(db, original)).resolves.toBe(false)
    await expect(deleteDeletionChallengeIfMatches(db, challenge({ value: "654321:0" }))).resolves.toBe(true)
  })
})

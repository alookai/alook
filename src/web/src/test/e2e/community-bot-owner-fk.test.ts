import { describe, it, expect, afterAll } from "vitest"
import { sql, sqlRun, sqlQuery } from "@alook/test-utils"

/**
 * Real-DB verification for `plans/community-account-debt-fixes.md` Fix 1.
 *
 * `src/web/migrations/0050_community_bots.sql` added `ownerUserId TEXT
 * REFERENCES user(id)` with no explicit `ON DELETE` clause (defaults to
 * `NO ACTION`, i.e. the DB refuses the delete). Cloudflare D1 enforces
 * foreign keys for every transaction, equivalent to `PRAGMA foreign_keys =
 * ON`. This test connects directly to the local D1 sqlite file (bypassing
 * the D1/miniflare query wrapper), so it must opt into that pragma itself —
 * SQLite's own default for a raw connection is OFF — to accurately predict
 * production D1 behavior rather than silently testing against a
 * non-enforcing connection.
 */

const ownerId = "e2e_fk_owner_1"
const botId = "e2e_fk_bot_1"

afterAll(() => {
  // Idempotent cleanup regardless of which assertion ran last.
  sqlRun(`DELETE FROM user WHERE id IN (?, ?)`, botId, ownerId)
})

describe("user.ownerUserId FK (community bot ownership)", () => {
  it("refuses to delete an owner while they still own a live bot", () => {
    sql("PRAGMA foreign_keys = ON")
    sqlRun(`DELETE FROM user WHERE id IN (?, ?)`, botId, ownerId)

    sqlRun(
      `INSERT INTO user (id, email, name) VALUES (?, ?, ?)`,
      ownerId,
      `${ownerId}@example.com`,
      "FK Test Owner",
    )
    sqlRun(
      `INSERT INTO user (id, email, name, isBot, ownerUserId) VALUES (?, ?, ?, 1, ?)`,
      botId,
      `${botId}@example.com`,
      "FK Test Bot",
      ownerId,
    )

    expect(() => sqlRun(`DELETE FROM user WHERE id = ?`, ownerId)).toThrow(
      /FOREIGN KEY constraint failed/i,
    )

    // Owner row must still be there — the failed DELETE must not have
    // partially applied.
    const rows = sqlQuery<{ id: string }>(`SELECT id FROM user WHERE id = ?`, ownerId)
    expect(rows).toHaveLength(1)
  })

  it("allows deleting the owner once the bot is gone", () => {
    sql("PRAGMA foreign_keys = ON")
    // Delete the bot first — clears the FK's referencing row.
    sqlRun(`DELETE FROM user WHERE id = ?`, botId)
    expect(() => sqlRun(`DELETE FROM user WHERE id = ?`, ownerId)).not.toThrow()

    const rows = sqlQuery<{ id: string }>(`SELECT id FROM user WHERE id = ?`, ownerId)
    expect(rows).toHaveLength(0)
  })
})

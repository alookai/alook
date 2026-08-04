import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { sqlRun, sqlQuery } from "@alook/test-utils"

/**
 * Real-DB existence oracle for the user discriminator unique index
 * (`idx_user_name_discriminator`, migration 0055). Backfills a coverage gap:
 * before this, only the MOCKED `withUniqueDiscriminator` retry test existed
 * (user.test.ts) — nothing asserted the DB index actually fires on a duplicate
 * `(name COLLATE NOCASE, discriminator)`. This is the user-side twin of
 * community-server-discriminator-unique.test.ts; the two share the allocator.
 *
 * EXISTENCE-COUNT oracle (Aigneis #18 form). The user index differs from the
 * server one in TWO ways this test pins: (1) it is PARTIAL (`WHERE deletedAt IS
 * NULL`) — a soft-deleted user's handle can be reissued; (2) NOCASE folding, so
 * a handle lookup can't match two live rows nondeterministically. Direct local
 * D1, same as forum-post-slug-unique.test.ts.
 */

const ids = [
  "e2e_udisc_u1",
  "e2e_udisc_u2",
  "e2e_udisc_u3",
  "e2e_udisc_u4",
  "e2e_udisc_u5",
]

function insertUser(id: string, name: string, disc: string, deletedAt: string | null = null): void {
  sqlRun(
    `INSERT INTO user (id, email, name, discriminator, deletedAt) VALUES (?, ?, ?, ?, ?)`,
    id, `${id}@example.com`, name, disc, deletedAt,
  )
}

function cleanup(): void {
  sqlRun(`DELETE FROM user WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)
}

beforeAll(cleanup)
afterAll(cleanup)

describe("idx_user_name_discriminator — user handle uniqueness (migration 0055)", () => {
  it("refuses a duplicate (name, discriminator) among LIVE users — existence count stays 1", () => {
    insertUser(ids[0]!, "e2e_udisc_alice", "0042")
    expect(() => insertUser(ids[1]!, "e2e_udisc_alice", "0042")).toThrow(/UNIQUE constraint failed/i)

    const rows = sqlQuery<{ id: string }>(
      `SELECT id FROM user WHERE name = ? AND discriminator = ? AND deletedAt IS NULL`,
      "e2e_udisc_alice", "0042",
    )
    expect(rows).toHaveLength(1)
  })

  it("folds name case-insensitively (COLLATE NOCASE) — Alice#0042 and alice#0042 collide", () => {
    insertUser(ids[2]!, "e2e_udisc_Bob", "0100")
    expect(() => insertUser(ids[3]!, "e2e_udisc_bob", "0100")).toThrow(/UNIQUE constraint failed/i)
  })

  it("PARTIAL index (WHERE deletedAt IS NULL) — a soft-deleted user's handle can be reissued", () => {
    // Soft-delete the first alice, then a NEW live alice#0042 must be allowed:
    // the deleted row is outside the partial index, so its handle frees up.
    sqlRun(`UPDATE user SET deletedAt = ? WHERE id = ?`, "2026-08-04T01:00:00.000Z", ids[0]!)
    expect(() => insertUser(ids[4]!, "e2e_udisc_alice", "0042")).not.toThrow()

    const live = sqlQuery<{ id: string }>(
      `SELECT id FROM user WHERE name = ? AND discriminator = ? AND deletedAt IS NULL`,
      "e2e_udisc_alice", "0042",
    )
    expect(live.map((r) => r.id)).toEqual([ids[4]]) // exactly the reissued live row
  })
})

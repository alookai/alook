import { describe, it, expect, afterAll } from "vitest"
import { sql, sqlRun, sqlQuery } from "@alook/test-utils"

/**
 * Real-DB verification that the `community_friendship.status` CHECK constraint
 * admits every status the query layer writes. See
 * plans/friend-cancel-card-cleanup.md.
 *
 * The unit tests for `cancelPendingRequest` / `rejectRequest` mock the drizzle
 * chain, so a `.set({ status: 'cancelled' })` "succeeds" without touching the
 * real constraint — which is exactly how the missing 'cancelled' in migration
 * 0065's CHECK slipped past a green suite and only surfaced as a 500 on real
 * D1. This test connects directly to the local D1 sqlite file (like
 * community-bot-owner-fk) so the constraint is genuinely enforced. Cloudflare
 * D1 runs with foreign keys / CHECKs on; a raw SQLite connection must opt into
 * the pragma to match production behavior.
 *
 * If a future migration writes a status the schema forbids, or drops one the
 * code still writes (the 0066 regression), one of these assertions fails.
 */

const ownerId = "e2e_fstatus_owner"
const reqId = "e2e_fstatus_req"
const addrId = "e2e_fstatus_addr"
const frId = "e2e_fstatus_fr"

// Every status the friendship query layer sets. Kept in sync with the CHECK in
// migrations/0065 + 0066 and the drizzle schema comment.
const WRITTEN_STATUSES = [
  "pending",
  "accepted",
  "blocked",
  "denied",
  "superseded",
  "cancelled",
]

function insertUser(id: string): void {
  sqlRun(`INSERT INTO user (id, email, name) VALUES (?, ?, ?)`, id, `${id}@example.com`, id)
}

function insertFriendship(status: string): void {
  const now = new Date("2026-07-27T00:00:00.000Z").toISOString()
  sqlRun(
    `INSERT INTO community_friendship (id, requester_id, addressee_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    frId,
    reqId,
    addrId,
    status,
    now,
    now,
  )
}

afterAll(() => {
  sqlRun(`DELETE FROM community_friendship WHERE id = ?`, frId)
  sqlRun(`DELETE FROM user WHERE id IN (?, ?, ?)`, ownerId, reqId, addrId)
})

describe("community_friendship.status CHECK constraint", () => {
  it.each(WRITTEN_STATUSES)("admits status '%s' the query layer writes", (status) => {
    sql("PRAGMA foreign_keys = ON")
    sqlRun(`DELETE FROM community_friendship WHERE id = ?`, frId)
    sqlRun(`DELETE FROM user WHERE id IN (?, ?, ?)`, ownerId, reqId, addrId)
    insertUser(reqId)
    insertUser(addrId)

    // The write the code path performs (INSERT-with-status, and the UPDATE the
    // cancel/reject/supersede paths run) must not trip the CHECK. This is the
    // assertion that would have caught the missing 'cancelled' before it 500'd
    // on real D1.
    expect(() => insertFriendship("pending")).not.toThrow()
    expect(() =>
      sqlRun(`UPDATE community_friendship SET status = ? WHERE id = ?`, status, frId),
    ).not.toThrow()

    const rows = sqlQuery<{ status: string }>(
      `SELECT status FROM community_friendship WHERE id = ?`,
      frId,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe(status)
  })

  it("rejects a status outside the allowed set (constraint is genuinely enforced)", () => {
    sql("PRAGMA foreign_keys = ON")
    sqlRun(`DELETE FROM community_friendship WHERE id = ?`, frId)
    sqlRun(`DELETE FROM user WHERE id IN (?, ?, ?)`, ownerId, reqId, addrId)
    insertUser(reqId)
    insertUser(addrId)

    // A guard on the test itself: proves these assertions rely on a live CHECK,
    // not a connection with constraints silently off.
    expect(() => insertFriendship("not_a_real_status")).toThrow(/CHECK constraint failed/i)
  })
})

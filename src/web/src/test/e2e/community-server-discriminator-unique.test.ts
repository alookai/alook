import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { sqlRun, sqlQuery } from "@alook/test-utils"

/**
 * Real-DB existence oracle for the community-server discriminator unique index
 * (`idx_community_server_name_discriminator`, migration 0080). Verifies the
 * LOAD-BEARING half of server-handle uniqueness that the allocator unit test
 * can't: that the DB index ACTUALLY throws on a duplicate `(name COLLATE
 * NOCASE, discriminator)` — not that `withUniqueDiscriminator` re-salts GIVEN a
 * throw (that's the mocked user.test.ts half).
 *
 * EXISTENCE-COUNT oracle, not error-absence (Aigneis #18/#61 form): two inserts
 * of the same `name#disc` must leave exactly ONE row (the 2nd is refused), and
 * a bumped disc must leave TWO distinct rows — never a silent double-insert of
 * the same handle. This is the never-drop worst side (a "unique" handle that
 * silently isn't) proven avoided; the allocator's throw-at-cap is its loud
 * terminal. Connects directly to local D1, same as forum-post-slug-unique.test.ts.
 */

const owner = "e2e_srvdisc_owner"
const ids = [
  "e2e_srvdisc_s1",
  "e2e_srvdisc_s2",
  "e2e_srvdisc_s3",
  "e2e_srvdisc_s4",
  "e2e_srvdisc_s5",
]
const TS = "2026-08-04T00:00:00.000Z"

function insertServer(id: string, name: string, disc: string): void {
  sqlRun(
    `INSERT INTO community_server (id, name, discriminator, description, owner_id, created_at)
     VALUES (?, ?, ?, '', ?, ?)`,
    id, name, disc, owner, TS,
  )
}

function cleanup(): void {
  sqlRun(`DELETE FROM community_server WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)
  sqlRun(`DELETE FROM user WHERE id = ?`, owner)
}

beforeAll(() => {
  cleanup()
  sqlRun(`INSERT INTO user (id, email, name) VALUES (?, ?, ?)`, owner, `${owner}@example.com`, "Srv Disc Owner")
})

afterAll(cleanup)

describe("idx_community_server_name_discriminator — server handle uniqueness (migration 0080)", () => {
  it("refuses a duplicate (name, discriminator) server — existence count stays 1, no silent double-insert", () => {
    insertServer(ids[0]!, "e2e_srvdisc_gaming", "0001")
    // Second insert of the SAME name#disc → the index refuses it.
    expect(() => insertServer(ids[1]!, "e2e_srvdisc_gaming", "0001")).toThrow(/UNIQUE constraint failed/i)

    // Existence oracle: exactly ONE gaming#0001 exists — the refused insert did
    // NOT silently create a second (the never-drop worst side: a handle that
    // resolves to two servers nondeterministically).
    const rows = sqlQuery<{ id: string }>(
      `SELECT id FROM community_server WHERE name = ? AND discriminator = ?`,
      "e2e_srvdisc_gaming", "0001",
    )
    expect(rows).toHaveLength(1)
  })

  it("allows the same name with a DIFFERENT discriminator — N distinct handles, never a merge", () => {
    // The allocator's response to the collision above: re-salt to a fresh disc
    // and retry. Two same-name servers coexist, disambiguated by disc.
    insertServer(ids[2]!, "e2e_srvdisc_gaming", "0002")
    const rows = sqlQuery<{ discriminator: string }>(
      `SELECT discriminator FROM community_server WHERE name = ? ORDER BY discriminator`,
      "e2e_srvdisc_gaming",
    )
    expect(rows.map((r) => r.discriminator)).toEqual(["0001", "0002"]) // 2 distinct, not merged
  })

  it("folds name case-insensitively (COLLATE NOCASE) — Alook#0001 and alook#0001 collide", () => {
    // The index MUST fold case identically to resolveServerByNameForMember's
    // lookup (the index/resolver alignment migration 0075 established), else a
    // ref differing only in case would resolve to a different-cased twin.
    insertServer(ids[3]!, "E2E_SrvDisc_Cased", "0007")
    expect(() => insertServer(ids[4]!, "e2e_srvdisc_cased", "0007")).toThrow(/UNIQUE constraint failed/i)

    const rows = sqlQuery<{ id: string }>(
      `SELECT id FROM community_server WHERE name = ? COLLATE NOCASE AND discriminator = ?`,
      "e2e_srvdisc_cased", "0007",
    )
    expect(rows).toHaveLength(1) // the case-variant twin was refused
  })
})

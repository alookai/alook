import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { sqlRun, sqlQuery } from "@alook/test-utils"
import { computeDiscriminator, createDb, queries } from "@alook/shared"
import { resolveTargetForMember } from "../../lib/community/resolve-ref"

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

function createRealQueryDb() {
  const binding = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              return { results: sqlQuery(query, ...params) }
            },
            async raw() {
              return sqlQuery<Record<string, unknown>>(query, ...params).map(Object.values)
            },
          }
        },
      }
    },
  }
  return createDb(binding as never)
}

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

const resolveOwner = "e2e_srvresolve_owner"
const resolveMember = "e2e_srvresolve_member"
const resolveOutsider = "e2e_srvresolve_outsider"
const resolveServer4 = "e2e_srvresolve_s4"
const resolveServer5 = "e2e_srvresolve_s5"
const resolveChannel4 = "e2e_srvresolve_c4"
const resolveChannel5 = "e2e_srvresolve_c5"

function resolveCleanup(): void {
  sqlRun(
    `DELETE FROM community_server WHERE id IN (?, ?)`,
    resolveServer4, resolveServer5,
  )
  sqlRun(
    `DELETE FROM user WHERE id IN (?, ?, ?)`,
    resolveOwner, resolveMember, resolveOutsider,
  )
}

describe("resolveServerByNameForMember — real D1 handle and membership behavior", () => {
  beforeAll(() => {
    resolveCleanup()
    for (const id of [resolveOwner, resolveMember, resolveOutsider]) {
      sqlRun(
        `INSERT INTO user (id, email, name) VALUES (?, ?, ?)`,
        id, `${id}@example.com`, id,
      )
    }
    sqlRun(
      `INSERT INTO community_server (id, name, discriminator, description, owner_id, created_at)
       VALUES (?, ?, ?, '', ?, ?), (?, ?, ?, '', ?, ?)`,
      resolveServer4, "E2E_Resolve_Studio", "0042", resolveOwner, TS,
      resolveServer5, "e2e_resolve_studio", "12345", resolveOwner, TS,
    )
    sqlRun(
      `INSERT INTO community_server_member (id, server_id, user_id, role, joined_at)
       VALUES (?, ?, ?, 'member', ?), (?, ?, ?, 'member', ?)`,
      "e2e_srvresolve_m4", resolveServer4, resolveMember, TS,
      "e2e_srvresolve_m5", resolveServer5, resolveMember, TS,
    )
    sqlRun(
      `INSERT INTO community_channel (id, server_id, name, type, created_at)
       VALUES (?, ?, 'general', 'text', ?), (?, ?, 'general', 'text', ?)`,
      resolveChannel4, resolveServer4, TS,
      resolveChannel5, resolveServer5, TS,
    )
  })
  afterAll(resolveCleanup)

  it("resolves same-name 4-digit and expanded handles uniquely with NOCASE names", async () => {
    const db = createRealQueryDb()
    await expect(
      queries.communityServer.resolveServerByNameForMember(
        db, resolveMember, "e2e_resolve_studio#0042",
      ),
    ).resolves.toEqual([
      { id: resolveServer4, name: "E2E_Resolve_Studio", discriminator: "0042" },
    ])
    await expect(
      queries.communityServer.resolveServerByNameForMember(
        db, resolveMember, "E2E_RESOLVE_STUDIO#12345",
      ),
    ).resolves.toEqual([
      { id: resolveServer5, name: "e2e_resolve_studio", discriminator: "12345" },
    ])
  })

  it("rejects a bare name even when it matches member servers", async () => {
    const rows = await queries.communityServer.resolveServerByNameForMember(
      createRealQueryDb(), resolveMember, "E2E_RESOLVE_STUDIO",
    )
    expect(rows).toEqual([])
  })

  it("masks a non-member real handle exactly like a nonexistent handle", async () => {
    const db = createRealQueryDb()
    const real = await resolveTargetForMember(
      db, resolveOutsider, "/E2E_Resolve_Studio#0042/general",
    )
    const missing = await resolveTargetForMember(
      db, resolveOutsider, "/E2E_Resolve_Studio#99999/general",
    )
    expect(real).toEqual({ error: 404, message: "server not found" })
    expect(missing).toEqual(real)
  })
})

/**
 * Real-DB widen oracle for (A) variable-width allocation — the load-bearing
 * proof Aigneis #91 / Ingaborg #93 required, driving the REAL allocator
 * (`withUniqueDiscriminator`) against real D1, NOT a mock. Proves:
 *  (i)  never-cap: when every width-4 salt the allocator tries is already taken,
 *       it WIDENS to a 5-digit discriminator instead of throwing at a cap.
 *  (ii) loud / never-silent-dup: the win is a real INSERT that survived the real
 *       UNIQUE index — the taken width-4 rows are NOT overwritten or duplicated.
 * The (A)-vs-(B) behavior reversal: (B) threw at the cap, (A) widens.
 */
const wOwner = "e2e_widen_owner"
const wName = "e2e_widen_saturated"
// The exact seed the allocator will use for a given (id, width, attempt).
const wId = "e2e_widen_server_id"
const width4Salts = [
  computeDiscriminator(wId), // bare id, width 4, attempt 0
  computeDiscriminator(`${wId}:4:1`, 4),
  computeDiscriminator(`${wId}:4:2`, 4),
  computeDiscriminator(`${wId}:4:3`, 4),
  computeDiscriminator(`${wId}:4:4`, 4),
]
const distinctWidth4 = [...new Set(width4Salts)]
const wSquatIds = distinctWidth4.map((_, i) => `e2e_widen_squat_${i}`)
const wWinId = "e2e_widen_winner"

function widenCleanup(): void {
  sqlRun(
    `DELETE FROM community_server WHERE id IN (${[...wSquatIds, wWinId].map(() => "?").join(",")})`,
    ...wSquatIds, wWinId,
  )
  sqlRun(`DELETE FROM user WHERE id = ?`, wOwner)
}

describe("withUniqueDiscriminator widen — never-cap, loud (A: variable-width)", () => {
  beforeAll(() => {
    widenCleanup()
    sqlRun(`INSERT INTO user (id, email, name) VALUES (?, ?, ?)`, wOwner, `${wOwner}@example.com`, "Widen Owner")
    // Squat EVERY width-4 salt the allocator will try for (wId, wName) so the
    // width-4 budget is fully saturated and it must widen to 5 digits. Two salts
    // can hash to the same 4-digit value — occupy each DISTINCT value once (the
    // unique index would reject a duplicate value anyway).
    distinctWidth4.forEach((disc, i) => insertServer(wSquatIds[i]!, wName, disc))
  })
  afterAll(widenCleanup)

  it("widens to a 5-digit discriminator when all width-4 salts are taken (never caps, never dups)", async () => {
    // Drive the REAL allocator; its insertFn does a REAL INSERT that hits the
    // REAL unique index. `_db` is unused by withUniqueDiscriminator.
    const winning = await queries.user.withUniqueDiscriminator(
      {} as never,
      { id: wId, name: wName },
      async (discriminator: string) => {
        insertServer(wWinId, wName, discriminator) // throws on UNIQUE collision → allocator re-salts
        return discriminator
      },
    )

    // (i) never-cap: the winning disc widened past 4 digits.
    expect(winning.length).toBe(5)
    expect(width4Salts).not.toContain(winning)

    // (ii) never-silent-dup: exactly ONE row holds the winning handle, and the
    // 5 squatted width-4 rows are all still present + untouched (N+1 total, no
    // overwrite of a taken width-4 handle).
    const win = sqlQuery<{ id: string }>(
      `SELECT id FROM community_server WHERE name = ? AND discriminator = ?`,
      wName, winning,
    )
    expect(win.map((r) => r.id)).toEqual([wWinId])
    const all = sqlQuery<{ c: number }>(
      `SELECT COUNT(*) AS c FROM community_server WHERE name = ?`,
      wName,
    )
    expect(all[0]!.c).toBe(distinctWidth4.length + 1) // squatted width-4 + 1 widened winner
  })
})

import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { listPending } from "../../src/db/queries/community/friendship"

describe("listPending canonical order and visibility", () => {
  let sqlite: Sqlite.Database
  let db: Database
  const time = "2026-10-17T00:00:00.000Z"
  const request = (id: string, requester: string, addressee: string, created = time, gate: string | null = null, status = "pending") => sqlite.prepare("INSERT INTO community_friendship (id, requester_id, addressee_id, status, needs_owner_approval, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, requester, addressee, status, gate, created)
  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, image TEXT, avatarVersion INTEGER NOT NULL DEFAULT 0, isBot INTEGER NOT NULL DEFAULT 0, ownerUserId TEXT, deletedAt TEXT);
      CREATE TABLE community_friendship (id TEXT PRIMARY KEY, requester_id TEXT NOT NULL, addressee_id TEXT NOT NULL, status TEXT NOT NULL, needs_owner_approval TEXT, created_at TEXT NOT NULL);
    `)
    const user = sqlite.prepare("INSERT INTO user (id, name, isBot, ownerUserId, deletedAt) VALUES (?, ?, ?, ?, ?)")
    for (const id of ["viewer", "peer-a", "peer-b", "stranger"]) user.run(id, id, 0, null, null)
    user.run("own-bot", "own-bot", 1, "viewer", null)
    user.run("deleted-bot", "deleted-bot", 1, "viewer", time)
    user.run("other-bot", "other-bot", 1, "stranger", null)
    db = drizzle(sqlite) as unknown as Database
  })
  afterEach(() => sqlite.close())
  it("globally interleaves incoming and outgoing by newest time", async () => {
    request("fr_old_in", "peer-a", "viewer", "2026-10-16T00:00:00.000Z")
    request("fr_new_out", "viewer", "peer-b", "2026-10-18T00:00:00.000Z")
    request("fr_mid_in", "stranger", "viewer")
    const rows = await listPending(db, "viewer")
    expect(rows.map(row => [row.id, row.kind])).toEqual([["fr_new_out", "outgoing"], ["fr_mid_in", "incoming"], ["fr_old_in", "incoming"]])
    expect(rows[0]).toMatchObject({ userId: "peer-b", createdAt: "2026-10-18T00:00:00.000Z" })
  })
  it("uses descending binary id order for equal times across directions", async () => {
    request("fr_Z", "peer-a", "viewer")
    request("fr_a", "viewer", "peer-b")
    request("fr_9", "stranger", "viewer")
    expect((await listPending(db, "viewer")).map(row => row.id)).toEqual(["fr_a", "fr_Z", "fr_9"])
  })
  it("preserves owner gates, live-own-bot scope and pending-only visibility", async () => {
    request("fr_in", "peer-a", "viewer")
    request("fr_own_out", "own-bot", "peer-b", time, "viewer")
    request("fr_gated_in", "stranger", "viewer", time, "stranger")
    request("fr_owner_card", "stranger", "own-bot", time, "viewer")
    request("fr_deleted_bot", "deleted-bot", "peer-b")
    request("fr_other_bot", "other-bot", "peer-b")
    request("fr_accepted", "peer-b", "viewer", time, null, "accepted")
    const rows = await listPending(db, "viewer")
    expect(rows.map(row => row.id)).toEqual(["fr_own_out", "fr_in"])
    expect(rows[0]).toMatchObject({ kind: "outgoing", requesterId: "own-bot", needsOwnerApproval: "viewer" })
    expect((await listPending(db, "stranger")).some(row => row.id === "fr_in")).toBe(false)
  })
  it("retains id deduplication when an existing row overlaps both directions", async () => {
    request("fr_overlap", "viewer", "viewer")
    const rows = await listPending(db, "viewer")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "fr_overlap", kind: "incoming" })
  })
})

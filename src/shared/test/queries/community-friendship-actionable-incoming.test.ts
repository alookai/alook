import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { listActionableIncomingRequests } from "../../src/db/queries/community/friendship"

describe("listActionableIncomingRequests", () => {
  let sqlite: Sqlite.Database
  let db: Database

  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE user (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        image TEXT,
        avatarVersion INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE community_friendship (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL,
        addressee_id TEXT NOT NULL,
        status TEXT NOT NULL,
        needs_owner_approval TEXT,
        blocker_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
    `)
    sqlite.prepare("INSERT INTO user (id, name, image, avatarVersion) VALUES (?, ?, ?, ?)")
      .run("viewer", "Viewer", null, 0)
    for (const [id, name, version] of [
      ["newer", "Newer", 2],
      ["tie-z", "Tie Z", 3],
      ["tie-a", "Tie A", 4],
      ["outgoing", "Outgoing", 5],
      ["gated", "Gated", 6],
      ["terminal", "Terminal", 7],
    ] as const) {
      sqlite.prepare("INSERT INTO user (id, name, image, avatarVersion) VALUES (?, ?, ?, ?)")
        .run(id, name, null, version)
    }
    const insert = sqlite.prepare(`
      INSERT INTO community_friendship
        (id, requester_id, addressee_id, status, needs_owner_approval, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run("fr_newer", "newer", "viewer", "pending", null, "2026-09-12T02:00:00Z", "2026-09-12T02:00:00Z")
    insert.run("fr_z", "tie-z", "viewer", "pending", null, "2026-09-12T01:00:00Z", "2026-09-12T01:00:00Z")
    insert.run("fr_a", "tie-a", "viewer", "pending", null, "2026-09-12T01:00:00Z", "2026-09-12T01:00:00Z")
    insert.run("fr_out", "viewer", "outgoing", "pending", null, "2026-09-12T03:00:00Z", "2026-09-12T03:00:00Z")
    insert.run("fr_gated", "gated", "viewer", "pending", "viewer", "2026-09-12T03:00:00Z", "2026-09-12T03:00:00Z")
    for (const status of ["accepted", "denied", "cancelled", "superseded", "blocked"]) {
      insert.run(`fr_${status}`, "terminal", "viewer", status, null, "2026-09-12T04:00:00Z", "2026-09-12T04:00:00Z")
    }
    db = drizzle(sqlite) as unknown as Database
  })

  afterEach(() => sqlite.close())

  it("returns only ungated incoming pending rows in deterministic newest-first order", async () => {
    await expect(listActionableIncomingRequests(db, "viewer")).resolves.toEqual([
      {
        id: "fr_newer",
        userId: "newer",
        name: "Newer",
        image: null,
        avatarVersion: 2,
        createdAt: "2026-09-12T02:00:00Z",
      },
      {
        id: "fr_z",
        userId: "tie-z",
        name: "Tie Z",
        image: null,
        avatarVersion: 3,
        createdAt: "2026-09-12T01:00:00Z",
      },
      {
        id: "fr_a",
        userId: "tie-a",
        name: "Tie A",
        image: null,
        avatarVersion: 4,
        createdAt: "2026-09-12T01:00:00Z",
      },
    ])
  })
})

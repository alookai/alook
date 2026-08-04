import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { sqlRun, sqlQuery } from "@alook/test-utils"

/**
 * Real-DB existence oracle for the forum-post slug unique index
 * (`idx_forum_post_parent_name`, migration 0078). This verifies the
 * LOAD-BEARING half of pure-create's concurrent no-merge contract that the
 * create-collision unit test can't: that the DB index ACTUALLY throws on a
 * duplicate `(parent_channel_id, name)` for a forum_post — not that the policy
 * re-bumps GIVEN a throw (that's the unit test's mocked half).
 *
 * The oracle is EXISTENCE-COUNT, not error-absence (Aigneis's #18 form): two
 * inserts of the same forum-post slug must leave exactly ONE row (the 2nd is
 * refused), and the bumped-slug retry must leave TWO distinct rows — never a
 * silent double-insert of the same slug (the original race this whole B4 guards).
 * Connects directly to the local D1 sqlite (bypassing the query wrapper), same
 * as community-bot-owner-fk.test.ts.
 */

const forumA = "e2e_slug_forum_a"
const forumB = "e2e_slug_forum_b"
const srv = "e2e_slug_srv"
const owner = "e2e_slug_owner"
const ids = ["e2e_slug_p1", "e2e_slug_p2", "e2e_slug_p3", "e2e_slug_p4", "e2e_slug_p5"]
const TS = "2026-08-04T00:00:00.000Z"

function insertPost(id: string, parent: string, name: string, type = "forum_post"): void {
  sqlRun(
    `INSERT INTO community_channel (id, server_id, parent_channel_id, name, type, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, srv, parent, name, type, TS,
  )
}

// FK parents: a user (server owner) → a server → the two top-level forum
// channels the posts hang under. The e2e connection enforces foreign keys, so
// these must exist before any forum_post row references them.
function cleanup(): void {
  sqlRun(`DELETE FROM community_channel WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids)
  sqlRun(`DELETE FROM community_channel WHERE id IN (?, ?)`, forumA, forumB)
  sqlRun(`DELETE FROM community_server WHERE id = ?`, srv)
  sqlRun(`DELETE FROM user WHERE id = ?`, owner)
}

beforeAll(() => {
  cleanup()
  sqlRun(`INSERT INTO user (id, email, name) VALUES (?, ?, ?)`, owner, `${owner}@example.com`, "Slug Owner")
  sqlRun(
    `INSERT INTO community_server (id, name, description, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    srv, "Slug Srv", "", owner, TS,
  )
  // Two top-level forum channels (parent_channel_id NULL) — the posts' anchors.
  sqlRun(
    `INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, ?, ?, 'forum', ?)`,
    forumA, srv, "forum-a", TS,
  )
  sqlRun(
    `INSERT INTO community_channel (id, server_id, name, type, created_at) VALUES (?, ?, ?, 'forum', ?)`,
    forumB, srv, "forum-b", TS,
  )
})

afterAll(cleanup)

describe("idx_forum_post_parent_name — forum-post slug uniqueness (migration 0078)", () => {
  it("refuses a duplicate (parent, name) forum_post — existence count stays 1, no silent double-insert", () => {
    insertPost(ids[0]!, forumA, "ideas")
    // Second insert of the SAME slug under the SAME forum → the index refuses it.
    expect(() => insertPost(ids[1]!, forumA, "ideas")).toThrow(/UNIQUE constraint failed/i)

    // Existence oracle: exactly ONE "ideas" post exists under forumA — the
    // refused insert did NOT silently create a second (the original race).
    const rows = sqlQuery<{ id: string }>(
      `SELECT id FROM community_channel WHERE parent_channel_id = ? AND name = ? AND type = 'forum_post'`,
      forumA, "ideas",
    )
    expect(rows).toHaveLength(1)
  })

  it("a bumped slug creates a SECOND distinct post — pure-create yields N distinct, never a merge", () => {
    // The pure-create policy's response to the collision above: bump to
    // `ideas-2` and retry. That must succeed → two distinct addressable posts.
    insertPost(ids[2]!, forumA, "ideas-2")
    const rows = sqlQuery<{ name: string }>(
      `SELECT name FROM community_channel WHERE parent_channel_id = ? AND type = 'forum_post' ORDER BY name`,
      forumA,
    )
    expect(rows.map((r) => r.name)).toEqual(["ideas", "ideas-2"]) // 2 distinct, N-distinct not merged
  })

  it("does NOT restrict the same slug under a DIFFERENT forum (index is per-parent)", () => {
    // Same name "ideas" under forumB is legal — the anchor is (parent, name).
    expect(() => insertPost(ids[3]!, forumB, "ideas")).not.toThrow()
    const rows = sqlQuery<{ id: string }>(
      `SELECT id FROM community_channel WHERE name = ? AND type = 'forum_post'`,
      "ideas",
    )
    expect(rows).toHaveLength(2) // one per forum
  })

  it("does NOT restrict a duplicate name for a NON-forum_post child (WHERE type='forum_post' scoping — no thread false-positive)", () => {
    // A thread (or any non-forum_post child) may share a name freely — the
    // partial index's WHERE clause excludes it, so blanket-uniqueness never
    // wrongly rejects a legal duplicate thread name.
    insertPost(ids[4]!, forumA, "ideas", "thread")
    const threadRows = sqlQuery<{ id: string }>(
      `SELECT id FROM community_channel WHERE parent_channel_id = ? AND name = ? AND type = 'thread'`,
      forumA, "ideas",
    )
    expect(threadRows).toHaveLength(1) // the thread inserted fine despite forum_post "ideas" existing
  })
})

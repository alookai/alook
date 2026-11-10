import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "../../src/db"
import { countUnarchivedForumPosts } from "../../src/db/queries/community/thread"

describe("forum counts against SQLite", () => {
  let sqlite: Sqlite.Database
  let db: Database
  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.exec(`
      CREATE TABLE community_channel (id TEXT PRIMARY KEY, server_id TEXT, parent_channel_id TEXT, parent_message_id TEXT, type TEXT, archived INTEGER);
      CREATE TABLE community_message_tag (message_id TEXT, tag TEXT);
      INSERT INTO community_channel VALUES
        ('open', 's1', 'f1', 'm1', 'thread', 0),
        ('tagged', 's1', 'f1', 'm2', 'thread', 0),
        ('closed', 's1', 'f1', 'm3', 'thread', 1),
        ('other-server', 's2', 'f1', 'm4', 'thread', 0),
        ('hidden', 's1', 'private', 'm5', 'thread', 0),
        ('no-opener', 's1', 'f1', NULL, 'thread', 0),
        ('not-post', 's1', 'f1', 'm6', 'text', 0);
      INSERT INTO community_message_tag VALUES ('m1', 'bug'), ('m2', 'archived');
    `)
    db = drizzle(sqlite) as unknown as Database
  })
  afterEach(() => sqlite.close())
  it("scopes before counting, excludes both archive forms and preserves explicit zero", async () => {
    expect(await countUnarchivedForumPosts(db, "s1", ["f1", "empty"])).toEqual({ f1: 1, empty: 0 })
    sqlite.exec("DELETE FROM community_message_tag WHERE message_id = 'm2'")
    expect(await countUnarchivedForumPosts(db, "s1", ["f1"])).toEqual({ f1: 2 })
    sqlite.exec("DELETE FROM community_channel WHERE id = 'open'")
    expect(await countUnarchivedForumPosts(db, "s1", ["f1"])).toEqual({ f1: 1 })
  })
  it("does no query for no visible forums and chunks a large parent set", async () => {
    const select = vi.spyOn(db, "select")
    expect(await countUnarchivedForumPosts(db, "s1", [])).toEqual({})
    expect(select).not.toHaveBeenCalled()
    const ids = ["f1", ...Array.from({ length: 180 }, (_, n) => `f-${n}`)]
    const counts = await countUnarchivedForumPosts(db, "s1", ids)
    expect(Object.keys(counts)).toHaveLength(181)
    expect(counts.f1).toBe(1)
  })
  it.each<[number, number[]]>([
    [1, [5]],
    [90, [94]],
    [91, [94, 5]],
    [181, [94, 94, 5]],
    [1500, [...Array<number>(16).fill(94), 64]],
  ])("keeps actual emitted SQL below D1's bind limit for %i parents", async (size, expectedBinds) => {
    const bindCounts: number[] = []
    const measured = drizzle(sqlite, { logger: { logQuery: (_query, params) => { bindCounts.push(params.length) } } }) as unknown as Database
    const ids = ["f1", ...Array.from({ length: size - 1 }, (_, index) => `extra-${index}`)]
    const counts = await countUnarchivedForumPosts(measured, "s1", ids)
    expect(bindCounts).toEqual(expectedBinds)
    expect(bindCounts.every(value => value <= 100)).toBe(true)
    expect(Object.keys(counts)).toHaveLength(size)
    expect(counts.f1).toBe(1)
  })

})

import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { readFileSync, readdirSync } from "node:fs"
import type { Database } from "../../src/db"
import { communityChannel, communityMessage, communityServer } from "../../src/db/community-schema"
import { user } from "../../src/db/schema"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as marks from "../../src/db/queries/community/mark"

function countDb(responses: Array<Array<{ count: number }>>) {
  let call = 0
  const select = vi.fn(() => {
    const rows = responses[call++] ?? []
    const chain: any = {}
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => Promise.resolve(rows))
    return chain
  })
  return { select } as any
}

describe("countMarksForUser", () => {
  it("returns zero without querying for an empty visibility scope", async () => {
    const db = countDb([])
    await expect(marks.countMarksForUser(db, "u1", {
      visibleChannelIds: [],
    })).resolves.toBe(0)
    expect(db.select).not.toHaveBeenCalled()
  })

  it("sums every visibility chunk beyond D1's 100-parameter boundary", async () => {
    const db = countDb([[{ count: 100 }], [{ count: 1 }]])
    const visibleChannelIds = Array.from({ length: 101 }, (_, index) => `c${index}`)
    await expect(marks.countMarksForUser(db, "u1", {
      visibleChannelIds,
    })).resolves.toBe(101)
    expect(db.select).toHaveBeenCalledTimes(2)
  })
})

describe("durable mark notes", () => {
  let sqlite: Sqlite.Database
  let db: Database
  const own = { userId: "owner", channelId: "channel", messageId: "message" }
  const createdAt = "2026-01-01T00:00:00.000Z"

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"))
    sqlite = new Sqlite(":memory:")
    sqlite.pragma("foreign_keys = ON")
    const migrations = new URL("../../../web/migrations/", import.meta.url)
    const noteMigration = "0112_community_message_mark_note.sql"
    const timeMigration = "0115_community_mark_updated_at.sql"
    for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql") && file !== noteMigration && file !== timeMigration).sort()) {
      sqlite.exec(readFileSync(new URL(file, migrations), "utf8"))
    }
    const seed = drizzle(sqlite)
    for (const id of ["owner", "other"]) seed.insert(user).values({ id, name: id, email: `${id}@mark.test`, discriminator: "0001", createdAt, updatedAt: createdAt }).run()
    seed.insert(communityServer).values({ id: "server", name: "test", discriminator: "0001", ownerId: "owner", createdAt }).run()
    for (const id of ["channel", "hidden"]) seed.insert(communityChannel).values({ id, name: id, type: "text", serverId: "server", createdAt }).run()
    seed.insert(communityMessage).values({ id: "message", channelId: "channel", authorId: "owner", seq: 1, content: "task body", createdAt }).run()
    seed.insert(communityMessage).values({ id: "hidden-message", channelId: "hidden", authorId: "owner", seq: 1, content: "hidden task", createdAt }).run()
    sqlite.prepare("INSERT INTO community_message_mark (id,user_id,channel_id,message_id,created_at) VALUES (?,?,?,?,?)").run("old", "owner", "channel", "message", createdAt)
    sqlite.exec(readFileSync(new URL(noteMigration, migrations), "utf8"))
    sqlite.exec(readFileSync(new URL(timeMigration, migrations), "utf8"))
    db = drizzle(sqlite) as unknown as Database
  })
  afterEach(() => { sqlite.close(); vi.useRealTimers() })

  it("migrates existing marks to null without changing identity, time, or unique constraints", async () => {
    expect(await marks.getMessageMark(db, "owner", "message")).toEqual({ id: "old", note: null, updatedAt: null })
    expect(await marks.markMessage(db, own)).toBeNull()
    expect(sqlite.prepare("SELECT id,created_at,note FROM community_message_mark").get()).toEqual({ id: "old", created_at: createdAt, note: null })
  })

  it("keeps legacy time unknown and only timestamps actual creates/changes", async () => {
    expect(await marks.getMessageMark(db, "owner", "message")).toMatchObject({ updatedAt: null })
    expect(await marks.markMessage(db, own)).toBeNull()
    expect(await marks.markMessage(db, { ...own, note: null })).toBeNull()
    expect(await marks.getMessageMark(db, "owner", "message")).toMatchObject({ updatedAt: null })
    await marks.markMessage(db, { ...own, note: "working" })
    const first = "2026-11-11T12:00:00.000Z"
    expect(await marks.getMessageMark(db, "owner", "message")).toMatchObject({ updatedAt: first })
    vi.setSystemTime(new Date("2026-11-11T13:00:00.000Z"))
    expect(await marks.markMessage(db, own)).toBeNull()
    expect(await marks.markMessage(db, { ...own, note: "working" })).toBeNull()
    expect(await marks.getMessageMark(db, "owner", "message")).toMatchObject({ updatedAt: first })
    await marks.markMessage(db, { ...own, note: null })
    expect(await marks.getMessageMark(db, "owner", "message")).toMatchObject({ note: null, updatedAt: "2026-11-11T13:00:00.000Z" })
    await marks.unmarkMessage(db, own)
    vi.setSystemTime(new Date("2026-11-11T14:00:00.000Z"))
    await marks.markMessage(db, own)
    expect(await marks.getMessageMark(db, "owner", "message")).toMatchObject({ note: null, updatedAt: "2026-11-11T14:00:00.000Z" })
  })

  it("edits progress atomically while preserving identity/time and idempotency; omission keeps it", async () => {
    const note = "接口完成，等待验收\n下一步：评审"
    expect(await marks.markMessage(db, { ...own, note })).toMatchObject({ id: "old", createdAt, note })
    expect(await marks.markMessage(db, { ...own, note })).toBeNull()
    expect(await marks.markMessage(db, own)).toBeNull()
    expect(await marks.getMessageMark(db, "owner", "message")).toEqual({ id: "old", note, updatedAt: "2026-11-11T12:00:00.000Z" })
    expect(await marks.markMessage(db, { ...own, note: "" })).toMatchObject({ note: "" })
    expect(await marks.markMessage(db, { ...own, note: null })).toMatchObject({ id: "old", createdAt, note: null })
    expect(await marks.markMessage(db, { ...own, note: null })).toBeNull()
  })

  it.each([undefined, null, "new task"])("creates a mark with note %j", async note => {
    await marks.unmarkMessage(db, own)
    expect(await marks.markMessage(db, { ...own, note })).toMatchObject({ note: note ?? null })
  })

  it("isolates actors when reading, editing and removing notes on the same message", async () => {
    await marks.markMessage(db, { ...own, note: "owner progress" })
    expect(await marks.getMessageMark(db, "other", "message")).toBeNull()
    expect(await marks.unmarkMessage(db, { userId: "other", messageId: "message" })).toBeNull()
    await marks.markMessage(db, { ...own, userId: "other", note: "other progress" })
    expect(await marks.getMessageMark(db, "owner", "message")).toEqual({ id: "old", note: "owner progress", updatedAt: "2026-11-11T12:00:00.000Z" })
    await marks.unmarkMessage(db, { userId: "other", messageId: "message" })
    expect(await marks.getMessageMark(db, "owner", "message")).toEqual({ id: "old", note: "owner progress", updatedAt: "2026-11-11T12:00:00.000Z" })
  })

  it("lists notes from current rows and excludes invisible channels in the query", async () => {
    await marks.markMessage(db, { ...own, note: "current progress" })
    await marks.markMessage(db, { userId: "owner", channelId: "hidden", messageId: "hidden-message", note: "private progress" })
    const list = await marks.listMarksForUser(db, "owner", { visibleChannelIds: ["channel"] })
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ mark: { note: "current progress" }, message: { id: "message", content: "task body" } })
    expect(await marks.listMarksForUser(db, "owner", { visibleChannelIds: [] })).toEqual([])
  })

  it.each(["user", "community_channel", "community_message"])("preserves cascading deletion from %s", async table => {
    await marks.markMessage(db, { ...own, note: "remove with parent" })
    if (table === "user") {
      await marks.unmarkMessage(db, own)
      await marks.markMessage(db, { ...own, userId: "other", note: "other task" })
    }
    const id = table === "user" ? "other" : table === "community_channel" ? "channel" : "message"
    sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
    expect(sqlite.prepare("SELECT * FROM community_message_mark").all()).toEqual([])
    expect(sqlite.pragma("foreign_key_check")).toEqual([])
  })
})

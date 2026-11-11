import Sqlite from "better-sqlite3"
import { drizzle } from "drizzle-orm/better-sqlite3"
import { readFileSync, readdirSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Database } from "../../src/db"
import { user } from "../../src/db/schema"
import { communityChannel, communityChannelMember, communityCategory, communityMessage, communityServer, communityServerMember, communityFriendship } from "../../src/db/community-schema"
import { listOtherBotMarks, markMessage, unmarkMessage } from "../../src/db/queries/community/mark"

const createdAt = "2026-01-01T00:00:00.000Z"
describe("shared bot progress with real SQLite permissions", () => {
  let sqlite: Sqlite.Database
  let db: Database
  let seed: ReturnType<typeof drizzle>
  let queryParams: unknown[][]
  beforeEach(() => {
    sqlite = new Sqlite(":memory:")
    sqlite.pragma("foreign_keys = ON")
    const migrations = new URL("../../../web/migrations/", import.meta.url)
    for (const f of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, migrations), "utf8"))
    queryParams = []
    seed = drizzle(sqlite, { logger: { logQuery: (_query, params) => queryParams.push(params) } })
    db = seed as unknown as Database
    for (const id of ["human", "human2", "a", "b", "gone"]) {
      seed.insert(user).values({ id, name: id, email: `${id}@mark.test`, discriminator: "0001", isBot: !id.startsWith("human"), ownerUserId: id === "a" ? "human" : id === "b" ? "human2" : null, deletedAt: id === "gone" ? createdAt : null, createdAt, updatedAt: createdAt }).run()
    }
    seed.insert(communityServer).values({ id: "s", name: "test", discriminator: "0001", ownerId: "human", createdAt }).run()
    for (const userId of ["a", "b", "human", "gone"]) seed.insert(communityServerMember).values({ serverId: "s", userId, role: "member", createdAt }).run()
    seed.insert(communityCategory).values({ id: "private", serverId: "s", name: "private", private: 1, createdAt }).run()
    for (const id of ["public", "private"]) seed.insert(communityChannel).values({ id, name: id, type: "text", serverId: "s", categoryId: id === "private" ? "private" : null, createdAt }).run()
    seed.insert(communityChannel).values({ id: "thread", type: "thread", serverId: "s", parentChannelId: "private", createdAt }).run()
    seed.insert(communityChannel).values({ id: "dm", type: "dm", createdAt }).run()
    for (const channelId of ["private", "dm"]) for (const userId of ["a", "b"]) seed.insert(communityChannelMember).values({ channelId, userId, relation: "access", createdAt }).run()
    for (const channelId of ["public", "private", "thread", "dm"]) seed.insert(communityMessage).values({ id: channelId, channelId, authorId: "human", seq: 1, content: "task", createdAt }).run()
    queryParams = []
  })
  afterEach(() => sqlite?.close())
  const entry = { handle: "@b#0001", note: "QA" }
  async function mark(userId: string, messageId: string, note: string | null = "QA") {
    return markMessage(db, { userId, messageId, channelId: messageId, note })
  }
  it("shares existing notes, excludes self/humans/deleted bots, and needs no own mark", async () => {
    for (const id of ["a", "b", "human", "gone"]) await mark(id, "public")
    expect((await listOtherBotMarks(db, "a", ["public"])).get("public")).toEqual([entry])
    expect(Object.keys((await listOtherBotMarks(db, "a", ["public"])).get("public")![0]).sort()).toEqual(["handle", "note"])
    await unmarkMessage(db, { userId: "a", messageId: "public" })
    expect((await listOtherBotMarks(db, "a", ["public"])).get("public")).toEqual([entry])
    await mark("b", "public", null)
    expect((await listOtherBotMarks(db, "a", ["public"])).get("public")).toEqual([{ ...entry, note: null }])
  })
  it("keeps independent concurrent marks; update and removal never change the other bot", async () => {
    await Promise.all([mark("a", "public", "implementation"), mark("b", "public")])
    expect(await mark("a", "public", "implementation")).toBeNull()
    expect((await listOtherBotMarks(db, "a", ["public"])).get("public")).toEqual([entry])
    await unmarkMessage(db, { userId: "a", messageId: "public" })
    expect((await listOtherBotMarks(db, "a", ["public"])).get("public")).toEqual([entry])
  })
  it("inherits private parent access without thread notification membership", async () => {
    await mark("b", "thread")
    expect((await listOtherBotMarks(db, "a", ["thread"])).get("thread")).toEqual([entry])
    sqlite.prepare("DELETE FROM community_channel_member WHERE channel_id='private' AND user_id='a'").run()
    expect(await listOtherBotMarks(db, "a", ["thread"])).toEqual(new Map())
  })
  it("excludes private marks after the marker loses access, even though its row remains", async () => {
    await mark("b", "private")
    sqlite.prepare("DELETE FROM community_channel_member WHERE channel_id='private' AND user_id='b'").run()
    expect(await listOtherBotMarks(db, "a", ["private"])).toEqual(new Map())
    expect(sqlite.prepare("SELECT count(*) AS n FROM community_message_mark").get()).toEqual({ n: 1 })
  })
  it.each(["a", "b"])("hides public marks when %s leaves the server", async userId => {
    await mark("b", "public")
    sqlite.prepare("DELETE FROM community_server_member WHERE user_id=?").run(userId)
    expect(await listOtherBotMarks(db, "a", ["public"])).toEqual(new Map())
  })
  it("isolates DMs and hides blocked conversations in either direction", async () => {
    await mark("b", "dm")
    expect((await listOtherBotMarks(db, "a", ["dm"])).get("dm")).toEqual([entry])
    expect(await listOtherBotMarks(db, "human", ["dm"])).toEqual(new Map())
    for (const [requesterId, addresseeId] of [["a", "b"], ["b", "a"]]) {
      seed.insert(communityFriendship).values({ requesterId, addresseeId, status: "blocked", createdAt, updatedAt: createdAt }).run()
      expect(await listOtherBotMarks(db, "a", ["dm"])).toEqual(new Map())
      sqlite.prepare("DELETE FROM community_friendship").run()
    }
  })
  it("batches all messages under D1's bind limit without duplicate peers", async () => {
    const ids = []
    for (let i = 0; i < 180; i++) {
      const id = `message-${i}`
      ids.push(id)
      seed.insert(communityMessage).values({ id, channelId: "public", authorId: "human", seq: i + 2, content: "task", createdAt }).run()
      await markMessage(db, { userId: "b", messageId: id, channelId: "public", note: id })
    }
    queryParams = []
    const marks = await listOtherBotMarks(db, "a", [...ids, ids[0]])
    expect(marks.size).toBe(180)
    expect(queryParams.length).toBe(3)
    expect(queryParams.every(params => params.length <= 100)).toBe(true)
    expect(marks.get(ids[0])).toEqual([{ ...entry, note: ids[0] }])
  })
  it("returns an empty map without querying and installs a message-first index", async () => {
    expect(await listOtherBotMarks(db, "a", [])).toEqual(new Map())
    expect(queryParams).toHaveLength(0)
    expect(sqlite.prepare("PRAGMA index_info(idx_mark_message_user)").all()).toMatchObject([{ name: "message_id" }, { name: "user_id" }])
  })
})

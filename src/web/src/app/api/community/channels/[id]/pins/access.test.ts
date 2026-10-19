import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { createRequire } from "node:module"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { WS_EVENTS } from "@alook/shared"
import { user } from "../../../../../../../../shared/src/db/schema"
import {
  communityCategory,
  communityChannel,
  communityChannelMember,
  communityMessage,
  communityPin,
  communityServerMember,
} from "../../../../../../../../shared/src/db/community-schema"
import type { AuthenticatedHandler } from "@/lib/middleware/auth"

const { getTableConfig } = createRequire(import.meta.resolve("@alook/shared"))("drizzle-orm/sqlite-core") as {
  getTableConfig: (table: object) => { name: string; columns: Array<{ name: string; getSQLType: () => string }> }
}

const { state, fanOut } = vi.hoisted(() => ({
  state: { binding: null as unknown as D1Database, userId: "admin" },
  fanOut: vi.fn(),
}))

vi.mock("@/lib/middleware/auth", () => ({
  withAuth: (handler: AuthenticatedHandler) => async (
    request: NextRequest,
    context?: { params?: Record<string, string> | Promise<Record<string, string>> },
  ) => handler(request, {
    userId: state.userId,
    email: "pin-access@example.test",
    env: { DB: state.binding } as Env,
    params: await context?.params,
  }),
}))
vi.mock("@/lib/community/fanout", () => ({ fanOutToChannel: fanOut }))

import { GET, POST } from "./route"
import { DELETE } from "./[messageId]/route"

let primary: DatabaseSync
let replica: DatabaseSync
let sessions: string[]

function seedDatabase() {
  const sqlite = new DatabaseSync(":memory:")
  for (const table of [user, communityChannel, communityChannelMember, communityMessage, communityServerMember, communityCategory, communityPin]) {
    const config = getTableConfig(table)
    sqlite.exec(`CREATE TABLE "${config.name}" (${config.columns.map((column) => `"${column.name}" ${column.getSQLType()}`).join(", ")})`)
  }
  sqlite.exec(`
    INSERT INTO user (id,name,discriminator,"avatarVersion","isBot") VALUES
      ('admin','Administrator','0001',0,0),('creator','Creator','0002',0,0),('member','Member','0003',0,0);
    INSERT INTO community_server_member (id,server_id,user_id,role) VALUES
      ('admin-row','server','admin','admin'),('creator-row','server','creator','member'),('member-row','server','member','member');
    INSERT INTO community_category (id,server_id,private) VALUES ('private-category','server',1),('public-category','server',0);
    INSERT INTO community_channel (id,server_id,category_id,type,creator_id,parent_channel_id) VALUES
      ('private','server','private-category','text','creator',NULL),
      ('public','server','public-category','text','creator',NULL),
      ('private-thread','server',NULL,'thread','admin','private'),
      ('private-forum','server','private-category','forum','creator',NULL),
      ('private-post','server',NULL,'thread','admin','private-forum');
    INSERT INTO community_message (id,author_id,content,channel_id,seq,created_at) VALUES
      ('private-message','creator','Private example','private',1,'2026-10-19T00:00:00Z'),
      ('public-message','creator','Public example','public',1,'2026-10-19T00:00:00Z'),
      ('private-thread-message','creator','Thread example','private-thread',1,'2026-10-19T00:00:00Z'),
      ('private-forum-message','creator','Forum example','private-forum',1,'2026-10-19T00:00:00Z'),
      ('private-post-message','creator','Post example','private-post',1,'2026-10-19T00:00:00Z');
    INSERT INTO community_message (id,author_id,content,channel_id,seq,created_at)
      SELECT id || '-unpinned',author_id,content,channel_id,2,created_at FROM community_message;
    CREATE UNIQUE INDEX uq_pin_channel_message ON community_pin(channel_id,message_id);
    INSERT INTO community_pin (channel_id,message_id,pinned_by,created_at) VALUES
      ('private','private-message','creator','2026-10-19T00:00:00Z'),
      ('public','public-message','admin','2026-10-19T00:00:00Z');
  `)
  return sqlite
}

function session(view: DatabaseSync) {
  let current = view
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = []
      const statement = () => {
        if (!/^\s*select\b/i.test(sql)) current = primary
        return current.prepare(sql)
      }
      const query = {
        bind(...params: SQLInputValue[]) { values = params; return query },
        async raw() {
          const prepared = statement()
          prepared.setReturnArrays(true)
          return prepared.all(...values)
        },
        async all() { return { results: statement().all(...values), success: true } },
        async run() { return { meta: statement().run(...values), success: true } },
      }
      return query
    },
  }
}

function context(channelId: string, messageId = `${channelId}-message`) {
  return { params: { id: channelId, messageId } }
}
function request(channelId: string, method: "GET" | "POST" | "DELETE", messageId = `${channelId}-message`) {
  return new NextRequest(`http://localhost/api/community/channels/${channelId}/pins${method === "DELETE" ? `/${messageId}` : ""}`, {
    method,
    ...(method === "POST" ? { body: JSON.stringify({ messageId }), headers: { "Content-Type": "application/json" } } : {}),
  })
}
function pins() {
  return primary.prepare("SELECT channel_id,message_id,pinned_by FROM community_pin ORDER BY channel_id,message_id").all()
}
function onBoth(sql: string) { primary.exec(sql); replica.exec(sql) }

async function expectDenied(channelId: string, status = 403) {
  const before = pins()
  const freshMessageId = `${channelId}-message-unpinned`
  expect((await POST(request(channelId, "POST", freshMessageId), context(channelId))).status).toBe(status)
  expect(pins()).toEqual(before)
  expect((await DELETE(request(channelId, "DELETE"), context(channelId))).status).toBe(status)
  expect(pins()).toEqual(before)
  expect(fanOut).not.toHaveBeenCalled()
}

beforeEach(() => {
  primary = seedDatabase()
  replica = seedDatabase()
  sessions = []
  state.userId = "admin"
  state.binding = {
    withSession(constraint: string) {
      sessions.push(constraint)
      return session(constraint === "first-primary" ? primary : replica)
    },
  } as unknown as D1Database
  fanOut.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { primary.close(); replica.close() })

describe("pin writes with real channel authorization and SQLite queries", () => {
  it.each([
    ["admin", "POST"], ["admin", "DELETE"], ["owner", "POST"], ["owner", "DELETE"],
  ] as const)("denies a private-channel outsider with server role %s for %s without mutation or pin events", async (role, method) => {
    onBoth(`UPDATE community_server_member SET role='${role}' WHERE user_id='admin'`)
    expect((await GET(request("private", "GET"), context("private"))).status).toBe(403)
    const before = pins()
    const messageId = method === "POST" ? "private-message-unpinned" : "private-message"
    const response = method === "POST"
      ? await POST(request("private", method, messageId), context("private"))
      : await DELETE(request("private", method, messageId), context("private"))
    expect(response.status).toBe(403)
    expect(pins()).toEqual(before)
    expect(fanOut).not.toHaveBeenCalled()
  })

  it.each(["private-thread", "private-forum", "private-post"])("denies inaccessible inherited/private surface %s", async (channelId) => {
    await expectDenied(channelId)
  })

  it("does not treat a notify-only row as private content access", async () => {
    onBoth("INSERT INTO community_channel_member (id,channel_id,user_id,relation) VALUES ('notify','private','admin','notify')")
    await expectDenied("private")
  })

  it.each([
    ["public", "admin", null],
    ["private", "admin", "private"],
    ["private", "owner", "private"],
    ["private-thread", "admin", "private"],
    ["private-forum", "admin", "private-forum"],
    ["private-post", "admin", "private-forum"],
    ["private", "creator-admin", null],
  ] as const)("pins/unpins accessible %s as %s with exact row and event scope", async (channelId, role, anchorId) => {
    if (anchorId) onBoth(`INSERT INTO community_channel_member (id,channel_id,user_id,relation) VALUES ('access','${anchorId}','admin','access')`)
    if (role === "creator-admin") onBoth("UPDATE community_channel SET creator_id='admin' WHERE id='private'")
    else onBoth(`UPDATE community_server_member SET role='${role}' WHERE user_id='admin'`)
    onBoth(`DELETE FROM community_pin WHERE channel_id='${channelId}'`)
    const before = pins()
    const messageId = `${channelId}-message`
    const pinned = await POST(request(channelId, "POST"), context(channelId))
    expect(pinned.status).toBe(201)
    expect(pins()).toEqual(expect.arrayContaining([...before, { channel_id: channelId, message_id: messageId, pinned_by: "admin" }]))
    expect(pins()).toHaveLength(before.length + 1)
    expect(fanOut).toHaveBeenNthCalledWith(1, channelId, { type: WS_EVENTS.PIN_ADD, channelId, messageId })
    expect((await DELETE(request(channelId, "DELETE"), context(channelId))).status).toBe(204)
    expect(pins()).toEqual(before)
    expect(fanOut).toHaveBeenNthCalledWith(2, channelId, { type: WS_EVENTS.PIN_REMOVE, channelId, messageId })
    expect(fanOut).toHaveBeenCalledTimes(2)
    expect(sessions).toEqual(["first-primary", "first-primary"])
  })

  it.each([
    ["public", "member"],
    ["private", "member"],
    ["private", "creator"],
  ] as const)("does not grant %s moderation to ordinary member/private creator %s", async (channelId, userId) => {
    state.userId = userId
    if (userId === "member") onBoth("INSERT INTO community_channel_member (id,channel_id,user_id,relation) VALUES ('member-access','private','member','access')")
    await expectDenied(channelId)
  })

  it("denies writes after server membership is removed even with a private access row", async () => {
    onBoth("DELETE FROM community_server_member WHERE user_id='admin'; INSERT INTO community_channel_member (id,channel_id,user_id,relation) VALUES ('orphan-access','private','admin','access')")
    await expectDenied("private")
    await expectDenied("public")
  })

  it("reads committed removal from primary even while a replica still has private membership", async () => {
    onBoth("INSERT INTO community_channel_member (id,channel_id,user_id,relation) VALUES ('access','private','admin','access')")
    expect((await GET(request("private", "GET"), context("private"))).status).toBe(200)
    primary.exec("DELETE FROM community_channel_member WHERE channel_id='private' AND user_id='admin'")
    expect(replica.prepare("SELECT count(*) AS count FROM community_channel_member WHERE user_id='admin'").get()).toEqual({ count: 1 })
    sessions.length = 0
    await expectDenied("private")
    expect(sessions).toEqual(["first-primary", "first-primary"])
  })

  it("keeps cross-channel pin POST rejected and wrong-channel unpin scoped/idempotent", async () => {
    const before = pins()
    const ctx = context("public", "private-message")
    expect((await POST(request("public", "POST", "private-message"), ctx)).status).toBe(404)
    expect(fanOut).not.toHaveBeenCalled()
    expect((await DELETE(request("public", "DELETE", "private-message"), ctx)).status).toBe(204)
    expect(pins()).toEqual(before)
    expect(fanOut).toHaveBeenCalledExactlyOnceWith("public", { type: WS_EVENTS.PIN_REMOVE, channelId: "public", messageId: "private-message" })
  })

  it("retains duplicate-pin409 against the real unique constraint", async () => {
    const before = pins()
    expect((await POST(request("public", "POST"), context("public"))).status).toBe(409)
    expect(pins()).toEqual(before)
    expect(fanOut).not.toHaveBeenCalled()
  })

  it("preserves missing-channel rejection", async () => { await expectDenied("missing", 404) })
  it.each(["dm", "unsupported"])("preserves unsupported %s surface rejection", async (type) => {
    onBoth(`UPDATE community_channel SET type='${type}' WHERE id='public'`)
    await expectDenied("public", 400)
  })
})

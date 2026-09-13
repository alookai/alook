import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { communityWriteDb } from "../../../../../../../../shared/test/helpers/community-write-db"

const background: Promise<unknown>[] = []
vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext: () => ({ ctx: { waitUntil: (work: Promise<unknown>) => background.push(work) } }) }))

let fixture: ReturnType<typeof communityWriteDb>
let actorKind: "human" | "bot" = "bot"
let targetKind: "channel" | "forum" = "channel"
let nonceReads = 0
let releaseReads: (() => void) | undefined
let bothPrechecks: Promise<void>
let beforeUnread: (() => Promise<boolean>) | undefined

vi.mock("@/lib/db", () => ({ getDb: () => fixture.db, getPrimaryDb: () => fixture.db }))
vi.mock("@/lib/middleware/community-actor", () => ({
  withCommunityActor: (handler: any) => (request: any) => handler(request, {
    env: { DB: {} }, actor: { kind: actorKind, userId: "author" }, params: { id: "channel" },
  }),
}))
vi.mock("@/lib/community/message-door", () => ({
  resolveMessageTarget: async () => ({ ok: true, value: { target: { kind: targetKind, channelId: "channel", serverId: "server" } } }),
}))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }) }))
vi.mock("@/lib/community/fanout", () => ({
  broadcastToUserSafe: vi.fn(), fanOutToChannel: vi.fn(), fanOutToServerMembers: vi.fn(),
}))
vi.mock("@/lib/community/message-dispatcher", () => ({ dispatchCommittedMessage: vi.fn() }))
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared")
  return { ...actual, queries: { ...actual.queries,
    communityChannel: { ...actual.queries.communityChannel, isChannelPrivate: async () => false },
    communityMessage: { ...actual.queries.communityMessage,
      getMessageByAuthorAndNonce: async (...args: Parameters<typeof actual.queries.communityMessage.getMessageByAuthorAndNonce>) => {
        const row = await actual.queries.communityMessage.getMessageByAuthorAndNonce(...args)
        const read = ++nonceReads
        if (read <= 2) {
          expect(row).toBeNull()
          if (read === 2) releaseReads?.()
          await bothPrechecks
        }
        return row
      },
    },
    communityAgentInbox: { ...actual.queries.communityAgentInbox,
      getLatestSeqForScope: async () => (fixture.sqlite.prepare("SELECT next_seq FROM community_message_seq").get() as any)?.next_seq ?? 0,
      hasDeliverableUnreadForAgentScope: async () => beforeUnread ? beforeUnread() : false,
      toAgentMessage: async (_db: unknown, row: unknown, _userId: unknown, attachments: unknown) => ({ ...row as object, attachments }),
    },
  } }
})

import { POST } from "./route"
import { queries } from "@alook/shared"
import { dispatchCommittedMessage } from "@/lib/community/message-dispatcher"

describe("message HTTP route — concurrent nonce with real SQL writes", () => {
  beforeEach(() => {
    fixture = communityWriteDb()
    actorKind = "bot"
    targetKind = "channel"
    nonceReads = 0
    background.length = 0
    beforeUnread = undefined
    bothPrechecks = new Promise<void>((resolve) => { releaseReads = resolve })
    vi.clearAllMocks()
    fixture.sqlite.exec(`
      ALTER TABLE user ADD COLUMN name TEXT;
      ALTER TABLE user ADD COLUMN email TEXT;
      ALTER TABLE user ADD COLUMN image TEXT;
      ALTER TABLE user ADD COLUMN avatarVersion INTEGER DEFAULT 0;
      ALTER TABLE community_attachment ADD COLUMN filename TEXT DEFAULT 'a.png';
      ALTER TABLE community_attachment ADD COLUMN r2_key TEXT;
      ALTER TABLE community_attachment ADD COLUMN thumbnail_r2_key TEXT;
      ALTER TABLE community_attachment ADD COLUMN content_type TEXT;
      ALTER TABLE community_attachment ADD COLUMN size INTEGER;
      ALTER TABLE community_attachment ADD COLUMN width INTEGER;
      ALTER TABLE community_attachment ADD COLUMN height INTEGER;
      ALTER TABLE community_attachment ADD COLUMN created_at TEXT;
      CREATE TABLE community_bot_daily_activity (bot_id TEXT NOT NULL, day TEXT NOT NULL, handled_count INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(bot_id, day));
      INSERT INTO community_attachment(id, uploader_id, target_id) VALUES ('a', 'author', 'channel');
    `)
  })
  afterEach(() => fixture.sqlite.close())
  function request() {
    const body = actorKind === "bot"
      ? { channel: "/test#1234/general", content: { text: "hello" }, nonce: "same-nonce", attachments: ["a"] }
      : { content: "hello", nonce: "same-nonce", attachments: ["a"] }
    return new NextRequest("http://localhost/api/community/channels/channel/messages", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
  }

  it.each(["human", "bot"] as const)("%s concurrent first sends both acknowledge the same complete attached message", async (kind) => {
    actorKind = kind
    const responses = await Promise.all([POST(request()), POST(request())])
    const bodies = await Promise.all(responses.map((response) => response.json()))
    expect(responses.map((response) => response.status)).toEqual(kind === "human" ? [201, 201] : [200, 200])
    expect(bodies[0].message.id).toBe(bodies[1].message.id)
    expect(bodies.filter((body) => body.deduped)).toHaveLength(1)
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM community_message").get()).toEqual({ count: 1 })
    expect(fixture.sqlite.prepare("SELECT message_id FROM community_attachment").get()).toEqual({ message_id: bodies[0].message.id })
    expect(dispatchCommittedMessage).toHaveBeenCalledOnce()
    if (kind === "bot") expect(fixture.sqlite.prepare("SELECT sent_count FROM community_bot_daily_activity").get()).toEqual({ sent_count: 1 })
  })

  it("concurrent bot forum titles return the same complete thread and count sent once", async () => {
    targetKind = "forum"
    const responses = await Promise.all([POST(request()), POST(request())])
    const bodies = await Promise.all(responses.map((response) => response.json()))
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(bodies[0].message.id).toBe(bodies[1].message.id)
    expect(bodies[0].threadId).toBe(bodies[1].threadId)
    expect(bodies[0].threadId).toBeTruthy()
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM community_channel WHERE type='thread'").get()).toEqual({ count: 1 })
    expect(fixture.sqlite.prepare("SELECT target_id, message_id FROM community_attachment").get()).toEqual({ target_id: bodies[0].threadId, message_id: null })
    expect(fixture.sqlite.prepare("SELECT sent_count FROM community_bot_daily_activity").get()).toEqual({ sent_count: 1 })
  })

  it("a nonce committed during the unread gate is returned instead of blocked", async () => {
    nonceReads = 2
    beforeUnread = async () => {
      await queries.communityMessage.createMessage(fixture.db, {
        authorId: "author", content: "hello", channelId: "channel", clientNonce: "same-nonce", attachmentIds: ["a"],
      })
      return true
    }
    const response = await POST(request())
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body).toMatchObject({ state: "sent", deduped: true })
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM community_message").get()).toEqual({ count: 1 })
  })
  it("notification failure after a forum commit preserves storage and replay counts once", async () => {
    targetKind = "forum"
    nonceReads = 2
    vi.mocked(dispatchCommittedMessage).mockRejectedValueOnce(new Error("notification offline"))
    expect((await POST(request())).status).toBe(200)
    await Promise.all(background)
    const committed = fixture.sqlite.prepare("SELECT id FROM community_message").get() as { id: string }
    expect(committed.id).toBeTruthy()
    expect(fixture.sqlite.prepare("SELECT count(*) AS count FROM community_channel WHERE type='thread'").get()).toEqual({ count: 1 })
    const response = await POST(request())
    expect(await response.json()).toMatchObject({ state: "sent", message: { id: committed.id }, deduped: true })
    expect(fixture.sqlite.prepare("SELECT sent_count FROM community_bot_daily_activity").get()).toEqual({ sent_count: 1 })
    expect(dispatchCommittedMessage).toHaveBeenCalledOnce()
  })

})

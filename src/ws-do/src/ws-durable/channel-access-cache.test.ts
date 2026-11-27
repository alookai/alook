import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BUSINESS_SCHEMA_VERSION,
  COMMUNITY_CONTRACT_HEADER,
  deriveCommunityDeliveryOperationId,
  encodeCommunityBrowserEvent,
  prepareCommunityDeliveryEvents,
  WS_EVENTS,
} from "@alook/shared"
import { createMockCtx, createMockWebSocket } from "../__mocks__/cf"
import { INTERNAL_USER_TARGET_HEADER } from "../internal-user-broadcast"
import { createCountingSqliteD1, seedServerWithMembers } from "../test/sqlite-d1"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

const { WebSocketDurableObject } = await import("../ws-durable")

const openDbs: Array<{ close: () => void }> = []

afterEach(() => {
  for (const sqlite of openDbs) sqlite.close()
  openDbs.length = 0
})

describe("in-DO channel access cache", () => {
  it("caches repeated channel access reads and evicts only on matching user revocation control events", async () => {
    const db = createCountingSqliteD1(openDbs as never)
    seedServerWithMembers(db.sqlite, 1)
    const { ctx } = createMockCtx()
    const env = { DB: db.d1, WS_DO: {} } as unknown as Env
    const durable = new WebSocketDurableObject(ctx, env)
    const ws = createMockWebSocket()
    ws.serializeAttachment({
      type: "user",
      userId: "user-1",
      targetUserId: "user-1",
      authenticated: true,
      communityContract: BUSINESS_SCHEMA_VERSION,
      sessionId: "sess-1",
      sessionValidUntil: Date.now() + 60_000,
    })
    ;(ctx.getWebSockets as ReturnType<typeof vi.fn>).mockReturnValue([ws])

    const makeBundleRequest = async (messageId: string) => {
      const event = {
        type: WS_EVENTS.MESSAGE_CREATE,
        channelId: "ch-1",
        serverId: "srv-1",
        profiles: [{ id: "user-0", name: "User0", discriminator: "0000", avatar: null, avatarVersion: 0 }],
        message: {
          id: messageId,
          channelId: "ch-1",
          replyToId: null,
          clientNonce: null,
          attachments: [],
          seq: 1,
          authorId: "user-0",
          authorName: "User0",
          authorAvatarVersion: 0,
          content: "hello",
          type: "chat",
          createdAt: "2026-11-26T00:00:00.000Z",
        },
      }
      const prepared = await prepareCommunityDeliveryEvents([event], BUSINESS_SCHEMA_VERSION)
      if (!prepared.ok) throw new Error(prepared.reason)
      return new Request("http://internal/community-broadcast-bundle", {
        method: "POST",
        headers: {
          [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
          [INTERNAL_USER_TARGET_HEADER]: "user-1",
        },
        body: JSON.stringify({
          operationId: await deriveCommunityDeliveryOperationId(messageId),
          operationDigest: prepared.prepared.digest,
          events: prepared.prepared.envelopes,
          communityContract: BUSINESS_SCHEMA_VERSION,
        }),
      })
    }

    db.resetCount()
    for (let i = 0; i < 10; i++) {
      const res = await durable.fetch(await makeBundleRequest(`m-${i}`))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: "complete" })
    }
    expect(db.queries.length).toBe(1)

    db.sqlite.prepare("DELETE FROM community_server_member WHERE server_id = 'srv-1' AND user_id = 'user-1'").run()

    const otherLeaveEnvelope = encodeCommunityBrowserEvent({
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId: "srv-1",
      userId: "user-other",
    })
    if (!otherLeaveEnvelope.ok) throw new Error(otherLeaveEnvelope.reason)
    await durable.fetch(new Request("http://internal/community-broadcast", {
      method: "POST",
      headers: {
        [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
        [INTERNAL_USER_TARGET_HEADER]: "user-1",
      },
      body: JSON.stringify(otherLeaveEnvelope.envelope),
    }))
    const otherMembershipEnvelope = encodeCommunityBrowserEvent({
      type: WS_EVENTS.CHANNEL_MEMBERSHIP_CHANGE,
      serverId: "srv-1",
      channelId: "ch-1",
      userId: "user-other",
      relation: "access",
      present: false,
    })
    if (!otherMembershipEnvelope.ok) throw new Error(otherMembershipEnvelope.reason)
    await durable.fetch(new Request("http://internal/community-broadcast", {
      method: "POST",
      headers: {
        [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
        [INTERNAL_USER_TARGET_HEADER]: "user-1",
      },
      body: JSON.stringify(otherMembershipEnvelope.envelope),
    }))
    const stillCachedRes = await durable.fetch(await makeBundleRequest("m-after-other-leave"))
    expect(stillCachedRes.status).toBe(200)
    expect(await stillCachedRes.json()).toMatchObject({ status: "complete" })
    expect(db.queries.length).toBe(1)

    const leaveEnvelope = encodeCommunityBrowserEvent({
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId: "srv-1",
      userId: "user-1",
    })
    if (!leaveEnvelope.ok) throw new Error(leaveEnvelope.reason)
    await durable.fetch(new Request("http://internal/community-broadcast", {
      method: "POST",
      headers: {
        [COMMUNITY_CONTRACT_HEADER]: String(BUSINESS_SCHEMA_VERSION),
        [INTERNAL_USER_TARGET_HEADER]: "user-1",
      },
      body: JSON.stringify(leaveEnvelope.envelope),
    }))

    const revokedRes = await durable.fetch(await makeBundleRequest("m-after-leave"))
    expect(revokedRes.status).toBe(200)
    expect(await revokedRes.json()).toMatchObject({ status: "cancelled", reason: "access-revoked" })
  })
})

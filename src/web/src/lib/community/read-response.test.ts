import { describe, expect, it } from "vitest"
import { COMMUNITY_CONTRACT_HEADER, normalizeCommunityChannelResource, normalizeCommunityMessageResource } from "@alook/shared"
import { communityReadTarget, decodeCommunityReadResponse } from "./read-response"

const parent = normalizeCommunityChannelResource({ id: "forum", type: "forum", serverId: "server", name: "Forum", archived: 0, createdAt: "2026-10-07T12:00:00Z" })
const child = normalizeCommunityChannelResource({ ...parent, id: "thread", type: "thread", parentChannelId: "forum", parentMessageId: "opener", creatorId: "viewer", lastMessageAt: "2026-10-07T13:00:00Z" })
const profile = { id: "viewer", name: "Viewer", discriminator: null, avatar: null, avatarVersion: 0, statusEmoji: null, statusText: "" }
const member = { channelId: "thread", userId: "viewer", relation: "notify" as const, source: "spoke", isCreator: true, role: null, memberId: null }
const message = (id: string, channelId: string) => normalizeCommunityMessageResource({ id, channelId, seq: 1, authorId: "viewer", authorAvatar: "avatar", createdAt: "2026-10-07T12:00:00Z", type: "chat", content: id }, channelId)
const confirmed = () => new Response(null, { headers: { [COMMUNITY_CONTRACT_HEADER]: "2" } })
const threads = () => ({ contractVersion: 2, channelId: "forum", channel: { ...parent }, threads: [{ ...child }],
  included: { messages: [message("opener", "forum"), message("reply", "thread")], members: [{ ...member }], profiles: [{ ...profile }], tags: [{ messageId: "opener", tag: "bug" }], participantCounts: [{ channelId: "thread", count: 7 }] },
  page: { hasMore: true, nextCursor: "next" as string | null } })
const decodeThreads = (body: unknown) => decodeCommunityReadResponse("/api/community/channels/forum/threads", "GET", confirmed(), body)
const members = () => ({ contractVersion: 2, channelId: "thread", relation: "notify" as const, members: [{ ...member }], profiles: [{ ...profile }] })
const decodeMembers = (body: unknown, path = "/api/community/channels/thread/members?relation=notify") => decodeCommunityReadResponse(path, "GET", confirmed(), body)

describe("common read response publication", () => {
  it("admits a legacy single-message preview only with an explicit valid scope", () => {
    const value = { id: "legacy", channelId: "thread", seq: 1, authorId: "viewer", createdAt: "now", type: "chat", content: "body" }
    expect(decodeCommunityReadResponse("/api/community/messages/legacy", "GET", new Response(), value))
      .toEqual({ ...value, resourceComplete: false })
    for (const invalid of [null, {}, { ...value, channelId: undefined }, { ...value, channelId: 4 }, { ...value, channelId: "" }]) {
      expect(() => decodeCommunityReadResponse("/api/community/messages/legacy", "GET", new Response(), invalid)).toThrow()
    }
  })
  it("recognizes only complete read routes and decodes their encoded channel identity", () => {
    expect(communityReadTarget("/api/community/channels/a%2Fb/read?lastReadSeq=4", "put")).toEqual({ channelId: "a/b", resource: "read" })
    expect(communityReadTarget("/api/community/channels/thread/members?relation=notify")).toEqual({ channelId: "thread", resource: "members" })
    for (const [path, method] of [["/api/community/channels/thread/read", "GET"], ["/api/community/channels/thread/messages/extra", "GET"], ["/api/community/channels/thread", "PUT"], ["/api/community/messages/search?q=term", "GET"], ["/api/community/messages/batch", "GET"]]) {
      expect(communityReadTarget(path!, method)).toBeNull()
      const body = { contractVersion: 2, private: "unrelated endpoint" }
      expect(decodeCommunityReadResponse(path!, method, confirmed(), body)).toBe(body)
    }
  })

  it("keeps metadata authority in the admitted decision and strips legacy forged authority", () => {
    const channel = threads().channel
    const access = { channelId: channel.id, canRead: false, canSend: false, canCreateDiscussion: false }
    const path = `/api/community/channels/${channel.id}`
    const current = decodeCommunityReadResponse(path, "GET", confirmed(), { contractVersion: 2, channelId: channel.id, channel, access })
    expect(current).toEqual({ ...channel, resourceComplete: true, accessDecision: access })
    expect(current).not.toHaveProperty("readContractVersion")
    expect(decodeCommunityReadResponse(path, "GET", new Response(), { ...channel, readContractVersion: 2, accessDecision: access })).toEqual(channel)
  })

  it("publishes only a confirmed scoped read-waterline advancement", () => {
    const body = { contractVersion: 2, channelId: "thread", changed: false, targetSeq: 8, revision: 12 }
    expect(decodeCommunityReadResponse("/api/community/channels/thread/read", "PUT", confirmed(), body)).toEqual({ changed: false, targetSeq: 8, revision: 12 })
    expect(() => decodeCommunityReadResponse("/api/community/channels/other/read", "PUT", confirmed(), body)).toThrow("scope mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/thread/read", "PUT", confirmed(), { ...body, targetSeq: -1 })).toThrow()
  })

  it("retains parent/child resources, included profiles and exact pagination without legacy reconstruction", () => {
    const body = threads()
    expect(decodeThreads(body)).toEqual(body)
    body.threads[0]!.lastMessageAt = null
    body.included.participantCounts = []
    body.page.nextCursor = null
    delete body.included.messages[0]!.authorAvatar
    expect(decodeThreads(body)).toEqual(body)
  })

  it.each([
    ["envelope", (body: ReturnType<typeof threads>) => { body.channelId = "other" }],
    ["parent", (body: ReturnType<typeof threads>) => { body.channel.id = "other" }],
    ["child parent", (body: ReturnType<typeof threads>) => { body.threads[0]!.parentChannelId = "other" }],
    ["child server", (body: ReturnType<typeof threads>) => { body.threads[0]!.serverId = "other" }],
    ["message", (body: ReturnType<typeof threads>) => { body.included.messages[0]!.channelId = "other" }],
    ["count", (body: ReturnType<typeof threads>) => { body.included.participantCounts[0]!.channelId = "other" }],
    ["tag", (body: ReturnType<typeof threads>) => { body.included.tags[0]!.messageId = "other" }],
    ["member", (body: ReturnType<typeof threads>) => { body.included.members[0]!.channelId = "other" }],
  ] as const)("rejects an included %s from another resource scope", (_label, mutate) => {
    const body = threads()
    mutate(body)
    expect(() => decodeThreads(body)).toThrow("scope mismatch")
  })

  it("rejects access members and absent profiles in the thread notify projection", () => {
    const body = threads()
    expect(() => decodeThreads({ ...body, included: { ...body.included, members: [{ ...member, relation: "access" }] } })).toThrow("member scope mismatch")
    body.included.profiles = []
    expect(() => decodeThreads(body)).toThrow("profile missing")
  })

  it("retains relation facts and profile resources separately without a UI roster DTO", () => {
    const body = members()
    expect(decodeMembers(body)).toEqual(body)
    const changed = { ...body, members: [{ ...member, memberId: "server-member", role: "admin" }], profiles: [{ ...profile, discriminator: "1234", avatar: "image" }] }
    expect(decodeMembers(changed)).toEqual(changed)
  })

  it("rejects mismatched roster scopes, relations and unhydrated members", () => {
    const body = members()
    expect(() => decodeMembers(body, "/api/community/channels/thread/members?relation=access")).toThrow("relation mismatch")
    expect(() => decodeMembers(body, "/api/community/channels/thread/members")).toThrow("relation mismatch")
    expect(() => decodeMembers({ ...body, channelId: "other" })).toThrow("scope mismatch")
    expect(() => decodeMembers({ ...body, members: [{ ...member, channelId: "other" }] })).toThrow("scope mismatch")
    expect(() => decodeMembers({ ...body, members: [{ ...member, relation: "access" }] })).toThrow("resource relation mismatch")
    expect(() => decodeMembers({ ...body, profiles: [] })).toThrow("profile missing")
  })

  it("keeps legacy nonmessage resources but rejects unconfirmed version claims", () => {
    const legacy = { relation: "notify", members: [] }
    expect(decodeCommunityReadResponse("/api/community/channels/thread/members", "GET", new Response(), legacy)).toBe(legacy)
    expect(() => decodeMembers({ ...members(), contractVersion: 1 })).toThrow("confirmation mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/thread/messages", "GET", new Response(), {})).toThrow("resource missing")
  })
})


describe("explicit v3 HTTP confirmation", () => {
  const full = { ...message("message", "thread"), authorAvatar: null, attachments: [
    { id: "a2", name: "unknown", url: "/a2", thumbnailUrl: null, contentType: null, sizeBytes: null, width: null, height: null },
    { id: "a1", name: "photo", url: "/a1", thumbnailUrl: null, contentType: "image/png", sizeBytes: 12, width: 1, height: 1 },
  ], embeds: [null, { raw: "unknown" }] }
  const response = (version: string | null) => new Response(null, { headers: version === null ? {} : { [COMMUNITY_CONTRACT_HEADER]: version } })
  const body = { contractVersion: 3, channelId: "thread", message: full, deduped: false }
  it("retains full POST and single-read resources with exact positive v3 claims", () => {
    expect(communityReadTarget("/api/community/channels/thread/messages", "POST")).toEqual({ channelId: "thread", resource: "posted" })
    expect(decodeCommunityReadResponse("/api/community/channels/thread/messages", "POST", response("3"), body, 3)).toEqual({ message: { ...full, resourceComplete: true }, deduped: false })
    const { deduped: _deduped, ...read } = body
    expect(decodeCommunityReadResponse("/api/community/messages/message", "GET", response("3"), read, 3)).toEqual({ ...full, resourceComplete: true })
    expect(() => decodeCommunityReadResponse("/api/community/messages/other", "GET", response("3"), read, 3)).toThrow("scope mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/other/messages", "POST", response("3"), body, 3)).toThrow("scope mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/thread/messages", "POST", response("3"), { ...body, message: { ...full, attachments: undefined } }, 3)).toThrow()
  })
  it("refuses missing, mixed and unknown confirmation without downgrading a v3 request", () => {
    for (const header of [null, "1", "2", "4"]) expect(() => decodeCommunityReadResponse("/api/community/channels/thread/messages", "POST", response(header), body, 3)).toThrow("confirmation mismatch")
    for (const contractVersion of [undefined, 1, 2, 4]) expect(() => decodeCommunityReadResponse("/api/community/channels/thread/messages", "POST", response("3"), { ...body, contractVersion }, 3)).toThrow("confirmation mismatch")
    expect(() => decodeCommunityReadResponse("/api/community/channels/thread/messages", "POST", response(null), { message: full }, 3)).toThrow("confirmation mismatch")
    const old = { message: { id: "old" } }
    expect(decodeCommunityReadResponse("/api/community/channels/thread/messages", "POST", response(null), old, 2)).toBe(old)
  })
})

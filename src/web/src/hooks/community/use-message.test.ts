import { beforeEach, describe, expect, it, vi } from "vitest"
import { BUSINESS_SCHEMA_VERSION, COMMUNITY_CONTRACT_HEADER, CommunityMessageReadSchema, type CommunityMessageResource } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { profileResourceFixture } from "@/test/community-resource-fixtures"
import { writeCommunityProfilePatches, communityUserProfilePatch } from "@/lib/community/profile-seed"
import { ingestMessages, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { findCachedMessage, messageQueryFn, prefetchCommunityMessage, prefetchCommunityLatestMessage } from "./use-message"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
beforeEach(() => { apiFetchMock.mockReset() })

const payload = { seq: 4, replyToId: null, clientNonce: null, attachments: [],
  id: "m_1", channelId: "channel-1", type: "chat" as const, authorId: "u_1",
  authorName: "Alice", authorAvatar: null, authorAvatarVersion: 0, content: "hi there",
  createdAt: "2026-07-03T00:00:00.000Z",
}

const completePayload = { ...payload, seq: 4, replyToId: null, clientNonce: null, attachments: [], embeds: [], reactions: [] }

const authorProfile = profileResourceFixture({ id: "u_1", name: "Alice", discriminator: "0001" })
const singleRead = (message: CommunityMessageResource) => CommunityMessageReadSchema.parse({ contractVersion: BUSINESS_SCHEMA_VERSION, channelId: message.channelId, message, profiles: [authorProfile] })
const pageRead = (messages: CommunityMessageResource[]) => ({ messages, profiles: messages.length ? [authorProfile] : [], latestSeq: Math.max(0, ...messages.map(message => message.seq)), hasMoreOlder: false, hasMoreNewer: false })

describe("background canonical message hydration", () => {
  it("deduplicates concurrent reads and shares the exact message cache without opening a window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let release!: (value: ReturnType<typeof singleRead>) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    const second = prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    release(singleRead(completePayload))
    await Promise.all([first, second])
    expect(registry.collections.messages.get(payload.id)).toMatchObject({ content: payload.content, seq: 4 })
    expect(client.getQueryData(communityKeys.message(payload.id))).toBe(payload.id)
    expect(client.getQueryData(communityKeys.channelMessages(payload.channelId))).toBeUndefined()
    await prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("reads a hint-only channel's latest full resource without creating a conversation window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValue(pageRead([completePayload]))
    await Promise.all([
      prefetchCommunityLatestMessage(client, payload.channelId),
      prefetchCommunityLatestMessage(client, payload.channelId),
    ])
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/channel-1/messages?limit=1"])
    expect(new Headers(apiFetchMock.mock.calls[0][1].headers).get(COMMUNITY_CONTRACT_HEADER)).toBe(String(BUSINESS_SCHEMA_VERSION))
    expect(registry.collections.messages.get(payload.id)).toMatchObject(payload)
    expect(client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBe(payload.id)
    expect(client.getQueryData(communityKeys.channelMessages(payload.channelId))).toBeUndefined()
  })

  it("rejects a partial canonical message and hydrates through the existing exact-ID reader", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const { attachments: _attachments, ...partial } = payload
    expect(() => ingestMessages(registry, payload.channelId, [partial])).toThrow()
    expect(registry.collections.messages.get(payload.id)).toBeUndefined()
    apiFetchMock.mockResolvedValueOnce(singleRead(completePayload))
    await prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/community/messages/m_1"])
    expect(registry.collections.messages.get(payload.id)).toMatchObject(payload)
  })

  it("does not fetch for retired access or an inactive owner", async () => {
    const owner = await createCommunityQueryOwner()
    owner.runtime.ws.actions.revokeChannelAccess("server-1", payload.channelId!)
    await prefetchCommunityMessage(owner.client, payload.id, { channelId: payload.channelId })
    await prefetchCommunityLatestMessage(owner.client, payload.channelId)
    owner.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    await prefetchCommunityMessage(owner.client, payload.id, {})
    await prefetchCommunityLatestMessage(owner.client, payload.channelId)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("does not publish a latest resource after its account owner retires", async () => {
    const owner = await createCommunityQueryOwner()
    let release!: (value: ReturnType<typeof pageRead>) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = prefetchCommunityLatestMessage(owner.client, payload.channelId).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    owner.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    release(pageRead([completePayload]))
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(owner.registry.collections.messages.get(payload.id)).toBeUndefined()
  })

  it("keeps different channel reads independent and cancels an older same-channel read", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const next = { ...completePayload, id: "new", seq: 5, content: "newest" }
    const other = { ...completePayload, id: "other", channelId: "channel-2" }
    let releaseOld!: (value: ReturnType<typeof pageRead>) => void
    let releaseOther!: (value: ReturnType<typeof pageRead>) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOther = resolve }))
      .mockResolvedValueOnce(pageRead([next]))
    const old = prefetchCommunityLatestMessage(client, payload.channelId).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    const secondChannel = prefetchCommunityLatestMessage(client, other.channelId)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    await prefetchCommunityLatestMessage(client, payload.channelId)
    expect(apiFetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(apiFetchMock.mock.calls[1][1].signal.aborted).toBe(false)
    releaseOld(pageRead([completePayload]))
    releaseOther(pageRead([other]))
    await Promise.all([old, secondChannel])
    expect(registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(registry.collections.messages.get(next.id)?.content).toBe("newest")
    expect(registry.collections.messages.get(other.id)).toMatchObject(other)
    expect(client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBe(next.id)
    expect(client.getQueryData(communityKeys.channelLatestMessage(other.channelId))).toBe(other.id)
  })

  it("stores null for an empty latest page and rejects a late revoked-scope resource", async () => {
    const owner = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(pageRead([]))
    await prefetchCommunityLatestMessage(owner.client, payload.channelId)
    expect(owner.client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBeNull()
    let release!: (value: ReturnType<typeof pageRead>) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = prefetchCommunityLatestMessage(owner.client, payload.channelId).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    retireCommunityChannelReading(owner.registry, payload.channelId, { reason: "read-denied" })
    release(pageRead([completePayload]))
    await result
    expect(owner.registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(owner.client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBeUndefined()
  })

  it("does not publish a full message response after channel access is revoked", async () => {
    const owner = await createCommunityQueryOwner()
    let release!: (value: ReturnType<typeof singleRead>) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = prefetchCommunityMessage(owner.client, payload.id, { channelId: payload.channelId }).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    owner.runtime.ws.actions.revokeChannelAccess(null, payload.channelId)
    release(singleRead(completePayload))
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(owner.registry.collections.messages.get(payload.id)).toBeUndefined()
  })
})

describe("useMessage / messageQueryFn", () => {
  it("clears absent rich fields from a fresh complete exact response", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    ingestMessages(registry, payload.channelId, [{ ...payload,
      attachments: [{ id: "old", name: "old.txt", url: "/old", sizeBytes: 1024, thumbnailUrl: null, contentType: null, width: null, height: null }],
      embeds: [{ title: "Old" }], reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["peer"] }],
      replyToId: "reply", replyTo: { id: "reply", authorId: "peer", authorName: "Peer", text: "Old reply" },
    }])
    apiFetchMock.mockResolvedValueOnce(singleRead({ ...payload, seq: 1, replyToId: null, clientNonce: null, attachments: [], embeds: [], reactions: [] }))
    await client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, client) })
    expect(registry.collections.messages.get(payload.id)).toMatchObject({ attachments: [], embeds: [], reactions: [], replyToId: null })
    expect(registry.collections.messages.get(payload.id)?.replyTo).toBeUndefined()
  })
  it("fetches from /messages/:id and publishes the hydrated payload into canonical DB", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(singleRead(payload))
    const data = await client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, client) })
    expect(data).toBe(payload.id)
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m_1", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(registry.collections.messages.get(payload.id)).toMatchObject(payload)
    expect(registry.collections.profiles.get(payload.authorId)).toMatchObject(authorProfile)
  })

  it("populates queryClient at communityKeys.message(messageId) with only the ID", async () => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(singleRead(payload))
    const key = communityKeys.message(payload.id)
    await client.query({ queryKey: key, queryFn: messageQueryFn(payload.id, client) })
    expect(client.getQueryData(key)).toBe(payload.id)
  })

  it("publishes an exact opener through the channel id carried by its response", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(singleRead({ ...payload, channelId: "archived-post-1", content: "archived opener" }))
    await client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, client, "route-hint") })
    expect(registry.collections.messages.get(payload.id)).toMatchObject({ channelId: "archived-post-1", content: "archived opener" })
  })

  it("derives an opener placeholder from a persisted canonical message window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const message = {
      ...payload, content: "cached opener",
      replyToId: "m_0", replyTo: { id: "m_0", authorId: "u_0", authorName: "Bob", text: "parent" },
      attachments: [{ id: "notes", name: "notes.txt", url: "/notes.txt", sizeBytes: 1024, thumbnailUrl: null, contentType: null, width: null, height: null }],
      embeds: [{ title: "Reference" }],
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_1"] }],
    }
    writeCommunityProfilePatches([authorProfile, profileResourceFixture({ id: "u_0", name: "Bob" })].map(profile => communityUserProfilePatch(profile.id, profile)), registry)
    ingestMessages(registry, "channel-1", [message])
    client.setQueryData(communityKeys.channelMessages("channel-1"), { pages: [{ ids: [message.id], hasMoreOlder: false, hasMoreNewer: false }], pageParams: [{ mode: "newest" }] })
    const { channelId: _channelId, replyToId: _replyToId, clientNonce: _clientNonce, ...view } = message
    expect(findCachedMessage(client, message.id)).toMatchObject({ ...view, authorAvatar: "A", attachments: [{ kind: "file", name: "notes.txt", url: "/notes.txt", sizeBytes: 1024, size: "1.0 KB" }] })
    expect(findCachedMessage(client, "missing")).toBeUndefined()
  })

  it.each([
    ["communityKeys.message(id)", communityKeys.message(payload.id)],
    ["communityKeys.all", communityKeys.all],
  ])("invalidation via %s marks the exact message resource invalidated", async (_label, queryKey) => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(singleRead(payload))
    const key = communityKeys.message(payload.id)
    await client.query({ queryKey: key, queryFn: messageQueryFn(payload.id, client) })
    await client.invalidateQueries({ queryKey })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("does not publish an exact opener after its original owner retires", async () => {
    const a = await createCommunityQueryOwner("A"), b = await createCommunityQueryOwner("B")
    let release!: (data: ReturnType<typeof singleRead>) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = a.client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, a.client) }).then(() => null, (error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    a.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    release(singleRead(payload))
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(a.registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(b.registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(b.registry.collections.profiles.get(payload.authorId)).toBeUndefined()
  })
})

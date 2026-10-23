import { beforeEach, describe, expect, it, vi } from "vitest"
import { COMMUNITY_CONTRACT_HEADER } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestMessages, retireCommunityChannelReading } from "@/lib/community-db/sync"
import { findCachedMessage, messageQueryFn, prefetchCommunityMessage, prefetchCommunityLatestMessage } from "./use-message"
import { getActiveAccountUnreadProjection } from "./account-unread-projection"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
beforeEach(() => { apiFetchMock.mockReset() })

const payload = {
  id: "m_1", channelId: "channel-1", type: "chat" as const, authorId: "u_1",
  authorName: "Alice", authorAvatar: "", authorAvatarVersion: 0, content: "hi there",
  createdAt: "2026-07-03T00:00:00.000Z",
}

const completePayload = { ...payload, resourceComplete: true as const, seq: 4, replyToId: null, clientNonce: null, attachments: [], embeds: [], reactions: [] }

describe("background canonical message hydration", () => {
  it("deduplicates concurrent reads and shares the exact message cache without opening a window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    let release!: (value: typeof completePayload) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    const second = prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    release(completePayload)
    await Promise.all([first, second])
    expect(registry.collections.messages.get(payload.id)).toMatchObject({ resourceComplete: true, content: payload.content, seq: 4 })
    expect(client.getQueryData(communityKeys.message(payload.id))).toBe(payload.id)
    expect(client.getQueryData(communityKeys.channelMessages(payload.channelId))).toBeUndefined()
    await prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("reads a hint-only channel's latest full resource without creating a conversation window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValue({ messages: [completePayload] })
    await Promise.all([
      prefetchCommunityLatestMessage(client, payload.channelId),
      prefetchCommunityLatestMessage(client, payload.channelId),
    ])
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/community/channels/channel-1/messages?limit=1"])
    expect(new Headers(apiFetchMock.mock.calls[0][1].headers).get(COMMUNITY_CONTRACT_HEADER)).toBe("3")
    expect(registry.collections.messages.get(payload.id)?.resourceComplete).toBe(true)
    expect(client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBe(payload.id)
    expect(client.getQueryData(communityKeys.channelMessages(payload.channelId))).toBeUndefined()
  })

  it("hydrates a partial canonical message through the existing exact-ID reader", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    ingestMessages(registry, payload.channelId, [{ ...payload, seq: 4 }])
    apiFetchMock.mockResolvedValueOnce(completePayload)
    await prefetchCommunityMessage(client, payload.id, { channelId: payload.channelId })
    expect(apiFetchMock.mock.calls.map(([path]) => path)).toEqual(["/api/community/messages/m_1"])
    expect(registry.collections.messages.get(payload.id)?.resourceComplete).toBe(true)
  })

  it("does not fetch for retired access or an inactive owner", async () => {
    const owner = await createCommunityQueryOwner()
    getActiveAccountUnreadProjection(owner.client).retireAccessScope({ kind: "channel", channelId: payload.channelId })
    await prefetchCommunityMessage(owner.client, payload.id, { channelId: payload.channelId })
    await prefetchCommunityLatestMessage(owner.client, payload.channelId)
    owner.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    await prefetchCommunityMessage(owner.client, payload.id, {})
    await prefetchCommunityLatestMessage(owner.client, payload.channelId)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("does not publish a latest resource after its account owner retires", async () => {
    const owner = await createCommunityQueryOwner()
    let release!: (value: { messages: typeof completePayload[] }) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = prefetchCommunityLatestMessage(owner.client, payload.channelId).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    owner.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    release({ messages: [completePayload] })
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(owner.registry.collections.messages.get(payload.id)).toBeUndefined()
  })

  it("keeps different channel reads independent and cancels an older same-channel read", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const next = { ...completePayload, id: "new", seq: 5, content: "newest" }
    const other = { ...completePayload, id: "other", channelId: "channel-2" }
    let releaseOld!: (value: { messages: typeof completePayload[] }) => void
    let releaseOther!: (value: { messages: typeof completePayload[] }) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOther = resolve }))
      .mockResolvedValueOnce({ messages: [next] })
    const old = prefetchCommunityLatestMessage(client, payload.channelId).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    const secondChannel = prefetchCommunityLatestMessage(client, other.channelId)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    await prefetchCommunityLatestMessage(client, payload.channelId)
    expect(apiFetchMock.mock.calls[0][1].signal.aborted).toBe(true)
    expect(apiFetchMock.mock.calls[1][1].signal.aborted).toBe(false)
    releaseOld({ messages: [completePayload] })
    releaseOther({ messages: [other] })
    await Promise.all([old, secondChannel])
    expect(registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(registry.collections.messages.get(next.id)?.content).toBe("newest")
    expect(registry.collections.messages.get(other.id)?.resourceComplete).toBe(true)
    expect(client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBe(next.id)
    expect(client.getQueryData(communityKeys.channelLatestMessage(other.channelId))).toBe(other.id)
  })

  it("stores null for an empty latest page and rejects a late revoked-scope resource", async () => {
    const owner = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce({ messages: [] })
    await prefetchCommunityLatestMessage(owner.client, payload.channelId)
    expect(owner.client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBeNull()
    let release!: (value: { messages: typeof completePayload[] }) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = prefetchCommunityLatestMessage(owner.client, payload.channelId).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2))
    retireCommunityChannelReading(owner.registry, payload.channelId, { reason: "read-denied" })
    release({ messages: [completePayload] })
    await result
    expect(owner.registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(owner.client.getQueryData(communityKeys.channelLatestMessage(payload.channelId))).toBeUndefined()
  })

  it("does not publish a full message response after channel access is revoked", async () => {
    const owner = await createCommunityQueryOwner()
    let release!: (value: typeof completePayload) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = prefetchCommunityMessage(owner.client, payload.id, { channelId: payload.channelId }).catch((error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    owner.runtime.ws.actions.revokeChannelAccess(null, payload.channelId)
    release(completePayload)
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(owner.registry.collections.messages.get(payload.id)).toBeUndefined()
  })
})

describe("useMessage / messageQueryFn", () => {
  it("clears absent rich fields from a fresh complete exact response", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    ingestMessages(registry, payload.channelId, [{ ...payload,
      attachments: [{ name: "old.txt", url: "/old", sizeBytes: 1024 }],
      embeds: [{ title: "Old" }], reactions: [{ emoji: "👍", count: 1, me: false, userIds: ["peer"] }],
      replyTo: { id: "reply", authorName: "Peer", text: "Old reply" },
    }])
    apiFetchMock.mockResolvedValueOnce({ ...payload, resourceComplete: true, seq: 1, replyToId: null, clientNonce: null, attachments: [], embeds: [], reactions: [] })
    await client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, client) })
    expect(registry.collections.messages.get(payload.id)).toMatchObject({ attachments: [], embeds: [], reactions: [], replyToId: null })
    expect(registry.collections.messages.get(payload.id)?.replyTo).toBeUndefined()
  })
  it("fetches from /messages/:id and publishes the hydrated payload into canonical DB", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(payload)
    const data = await client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, client) })
    expect(data).toBe(payload.id)
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m_1", expect.objectContaining({ signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(registry.collections.messages.get(payload.id)).toMatchObject(payload)
    expect(registry.collections.profiles.get(payload.authorId)).toMatchObject({ name: "Alice" })
  })

  it("populates queryClient at communityKeys.message(messageId) with only the ID", async () => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(payload)
    const key = communityKeys.message(payload.id)
    await client.query({ queryKey: key, queryFn: messageQueryFn(payload.id, client) })
    expect(client.getQueryData(key)).toBe(payload.id)
  })

  it("publishes an exact opener through the channel id carried by its response", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce({ ...payload, channelId: "archived-post-1", content: "archived opener" })
    await client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, client, "route-hint") })
    expect(registry.collections.messages.get(payload.id)).toMatchObject({ channelId: "archived-post-1", content: "archived opener" })
  })

  it("derives an opener placeholder from a persisted canonical message window", async () => {
    const { client, registry } = await createCommunityQueryOwner()
    const message = {
      ...payload, content: "cached opener",
      replyTo: { id: "m_0", authorName: "Bob", text: "parent" },
      attachments: [{ name: "notes.txt", url: "/notes.txt", sizeBytes: 1024 }],
      embeds: [{ title: "Reference" }],
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_1"] }],
    }
    ingestMessages(registry, "channel-1", [message])
    client.setQueryData(communityKeys.channelMessages("channel-1"), { pages: [{ ids: [message.id], hasMoreOlder: false, hasMoreNewer: false }], pageParams: [{ mode: "newest" }] })
    const { channelId: _channelId, ...view } = message
    expect(findCachedMessage(client, message.id)).toMatchObject({ ...view, attachments: [{ kind: "file", name: "notes.txt", url: "/notes.txt", sizeBytes: 1024, size: "1.0 KB" }] })
    expect(findCachedMessage(client, "missing")).toBeUndefined()
  })

  it.each([
    ["communityKeys.message(id)", communityKeys.message(payload.id)],
    ["communityKeys.all", communityKeys.all],
  ])("invalidation via %s marks the exact message resource invalidated", async (_label, queryKey) => {
    const { client } = await createCommunityQueryOwner()
    apiFetchMock.mockResolvedValueOnce(payload)
    const key = communityKeys.message(payload.id)
    await client.query({ queryKey: key, queryFn: messageQueryFn(payload.id, client) })
    await client.invalidateQueries({ queryKey })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("does not publish an exact opener after its original owner retires", async () => {
    const a = await createCommunityQueryOwner("A"), b = await createCommunityQueryOwner("B")
    let release!: (data: typeof payload) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const result = a.client.query({ queryKey: communityKeys.message(payload.id), queryFn: messageQueryFn(payload.id, a.client) }).then(() => null, (error) => error)
    await vi.waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    a.runtime.lifecycle.setState((state) => ({ active: false, generation: state.generation + 1 }))
    release(payload)
    expect(await result).toMatchObject({ name: "AbortError" })
    expect(a.registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(b.registry.collections.messages.get(payload.id)).toBeUndefined()
    expect(b.registry.collections.profiles.get(payload.authorId)).toBeUndefined()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { ingestMessages } from "@/lib/community-db/sync"
import { findCachedMessage, messageQueryFn } from "./use-message"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
beforeEach(() => { apiFetchMock.mockReset() })

const payload = {
  id: "m_1", channelId: "channel-1", type: "chat" as const, authorId: "u_1",
  authorName: "Alice", authorAvatar: "", authorAvatarVersion: 0, content: "hi there",
  createdAt: "2026-07-03T00:00:00.000Z",
}

describe("useMessage / messageQueryFn", () => {
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
      attachments: [{ kind: "file" as const, name: "notes.txt", url: "/notes.txt", size: "1 KB" }],
      embeds: [{ title: "Reference" }],
      reactions: [{ emoji: "👍", count: 1, me: true, userIds: ["u_1"] }],
    }
    ingestMessages(registry, "channel-1", [message])
    client.setQueryData(communityKeys.channelMessages("channel-1"), { pages: [{ ids: [message.id], hasMoreOlder: false, hasMoreNewer: false }], pageParams: [{ mode: "newest" }] })
    expect(findCachedMessage(client, message.id)).toMatchObject(message)
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

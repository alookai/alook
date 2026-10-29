import { messageProfilesFixture, messageResourceFixture, singleMessageReadFixture } from "@/test/community-resource-fixtures"
import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, publishCommunityMessages } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
import { writeCommunityCollectionRows } from "@/lib/community-db/write"
import { useMessage } from "./use-message"
import { takeMessageIdsForAccessScope } from "@/lib/community-db/message-access-scope"

const apiFetchMock = vi.fn(() => new Promise(() => {}))
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
beforeEach(async () => {
  apiFetchMock.mockClear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  registry = createCommunityDbRegistry(client, "viewer")
  await registry.preload()
})
afterEach(async () => {
  await act(async () => {
    await client.cancelQueries()
    await registry.cleanup()
    client.clear()
  })
})
function Owner({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children))
}
const scope = { channelId: "channel-1", serverId: "server-1" }
const message = messageResourceFixture({ id: "m_1", channelId: scope.channelId, authorId: "u_1", authorName: "Alice", content: "cached opener", createdAt: "2026-07-03T00:00:00.000Z" })

describe("useMessage cache-first placeholder", () => {
  it("returns a cached canonical list message while the exact query is pending", async () => {
    publishCommunityMessages(client, { channelId: scope.channelId, messages: [message], profiles: messageProfilesFixture([message]), proof: { token: captureCommunityLiveSnapshotToken(client) } })
    client.setQueryData(communityKeys.channelMessages(scope.channelId), { pages: [{ ids: [message.id], hasMore: false }], pageParams: [{ mode: "newest" }] })
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.message).toMatchObject({ id: message.id, type: message.type, seq: message.seq, authorId: message.authorId, authorName: message.authorName, content: message.content, createdAt: message.createdAt }))
    expect(rendered.result.current.isPlaceholderData).toBe(true)
    expect(rendered.result.current.fetchStatus).toBe("fetching")
  })

  it.each(["body", "profile"] as const)("repairs a fresh cached ID with its native %s missing through the same query", async missing => {
    publishCommunityMessages(client, { channelId: scope.channelId, messages: [message], profiles: messageProfilesFixture([message]), proof: { token: captureCommunityLiveSnapshotToken(client) } })
    client.setQueryData(communityKeys.message(message.id), message.id)
    if (missing === "body") await writeCommunityCollectionRows(registry, "messages", [], row => row.id)
    else await writeCommunityCollectionRows(registry, "profiles", [], row => row.id)
    let release!: (value: ReturnType<typeof singleMessageReadFixture>) => void
    const held = new Promise<ReturnType<typeof singleMessageReadFixture>>(resolve => { release = resolve })
    apiFetchMock.mockImplementationOnce(() => held)
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    expect(rendered.result.current.message).toBeNull()
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    expect(apiFetchMock).toHaveBeenCalledWith(`/api/community/messages/${message.id}`, expect.any(Object))
    expect(rendered.result.current.message).toBeNull()
    await act(async () => { release(singleMessageReadFixture(message)); await held })
    await waitFor(() => expect(rendered.result.current.message).toMatchObject({ id: message.id, authorId: message.authorId, authorName: "Alice", content: message.content }))
    expect(client.getQueryData(communityKeys.message(message.id))).toBe(message.id)
    expect(registry.collections.profiles.get(message.authorId)).toMatchObject({ id: message.authorId, name: "Alice", discriminator: expect.any(String), avatarVersion: 0 })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps a missing id disabled and returns no message", () => {
    const rendered = renderHook(() => useMessage(null), { wrapper: Owner })
    expect(rendered.result.current.message).toBeNull()
    expect(rendered.result.current.fetchStatus).toBe("idle")
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("uses canonical identity exclusively when the DB provider is active", async () => {
    client.setQueryData(communityKeys.message(message.id), { ...message, authorId: "raw", content: "raw query" })
    publishCommunityMessages(client, { channelId: scope.channelId, messages: [{ ...message, authorId: "canonical", authorName: "Canonical", content: "canonical row" }], profiles: messageProfilesFixture([{ ...message, authorId: "canonical", authorName: "Canonical" }]), proof: { token: captureCommunityLiveSnapshotToken(client) } })
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.message).toMatchObject({ authorId: "canonical", content: "canonical row" }))
  })

  it("does not fall back to a raw single-message response in an active empty registry", async () => {
    client.setQueryData(communityKeys.message(message.id), { ...message, authorId: "raw", attachments: [{ kind: "file", name: "raw.txt", url: "/raw.txt", size: "1 KB" }] })
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    await act(async () => { await Promise.resolve() })
    expect(apiFetchMock).not.toHaveBeenCalled()
    expect(rendered.result.current.message).toBeNull()
  })

  it.each(["current", "retired"] as const)("observes a %s native server retirement without copying access state", async lifetime => {
    publishCommunityMessages(client, { channelId: scope.channelId, messages: [message], profiles: messageProfilesFixture([message]), proof: { token: captureCommunityLiveSnapshotToken(client) } })
    client.setQueryData(communityKeys.message(message.id), message.id)
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.message?.id).toBe(message.id))
    let reject!: (error: Error) => void
    const held = new Promise<void>((_resolve, fail) => { reject = fail })
    const mutation = client.getMutationCache().build<void, Error, { serverId: string; original: { registry: unknown } }, unknown>(client, { mutationKey: ["community", "server-retirement", "leave"], mutationFn: async () => held })
    let pending!: Promise<unknown>
    await act(async () => { pending = mutation.execute({ serverId: scope.serverId, original: { registry: lifetime === "current" ? registry : {} } }).catch(error => error) })
    await waitFor(() => expect(rendered.result.current.message?.id).toBe(lifetime === "current" ? undefined : message.id))
    await act(async () => { reject(new Error("denied")); await pending })
    await waitFor(() => expect(rendered.result.current.message?.id).toBe(message.id))
  })

  it("keeps the access index empty after revocation and restores it after a fresh grant", async () => {
    client.setQueryData(communityKeys.message(message.id), message.id)
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    await waitFor(() => expect(takeMessageIdsForAccessScope(client, new Set([scope.channelId]), null)).toEqual([message.id]))
    act(() => registry.runtime.ws.actions.revokeChannelAccess(scope.serverId, scope.channelId))
    expect(rendered.result.current.message).toBeNull()
    await waitFor(() => expect(takeMessageIdsForAccessScope(client, new Set([scope.channelId]), null)).toEqual([]))
    act(() => registry.runtime.ws.actions.rememberChannelAccess(scope.serverId, scope.channelId))
    await waitFor(() => expect(takeMessageIdsForAccessScope(client, new Set([scope.channelId]), null)).toEqual([message.id]))
    expect(rendered.result.current.message).toBeNull()
  })
})

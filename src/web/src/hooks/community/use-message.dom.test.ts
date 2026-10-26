import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { ingestMessages } from "@/lib/community-db/sync"
import { communityKeys } from "@/lib/query-keys"
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
const message = { id: "m_1", type: "chat" as const, authorId: "u_1", authorName: "Alice", content: "cached opener", createdAt: "2026-07-03T00:00:00.000Z" }

describe("useMessage cache-first placeholder", () => {
  it("returns a cached canonical list message while the exact query is pending", async () => {
    ingestMessages(registry, scope.channelId, [message])
    client.setQueryData(communityKeys.channelMessages(scope.channelId), { pages: [{ ids: [message.id], hasMore: false }], pageParams: [{ mode: "newest" }] })
    const rendered = renderHook(() => useMessage(message.id, scope), { wrapper: Owner })
    await waitFor(() => expect(rendered.result.current.message).toMatchObject(message))
    expect(rendered.result.current.isPlaceholderData).toBe(true)
    expect(rendered.result.current.fetchStatus).toBe("fetching")
  })

  it("keeps a missing id disabled and returns no message", () => {
    const rendered = renderHook(() => useMessage(null), { wrapper: Owner })
    expect(rendered.result.current.message).toBeNull()
    expect(rendered.result.current.fetchStatus).toBe("idle")
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it("uses canonical identity exclusively when the DB provider is active", async () => {
    client.setQueryData(communityKeys.message(message.id), { ...message, authorId: "raw", content: "raw query" })
    ingestMessages(registry, scope.channelId, [{ ...message, authorId: "canonical", authorName: "Canonical", content: "canonical row" }])
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
    ingestMessages(registry, scope.channelId, [message])
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

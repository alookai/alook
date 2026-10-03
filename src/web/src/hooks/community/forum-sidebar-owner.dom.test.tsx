import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { ingestServerDetail } from "@/lib/community-db/sync"
import { useForumSidebarThreads } from "./use-forum-sidebar-threads"
import { communityKeys } from "@/lib/query-keys"
const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let client: QueryClient
function Probe({ index }: { index: number }) { const currentClient = useQueryClient(); useLayoutEffect(() => { client = currentClient }); const value = useForumSidebarThreads("server", null); return <output data-testid={`sidebar-${index}`}>{value.threads.map((thread) => thread.title).join(",")}</output> }
function Root({ id = sdk.id, consumers = 2 }: { id?: string; consumers?: number }) { return <QueryProvider userId={id}>{Array.from({ length: consumers }, (_, index) => <Probe key={index} index={index} />)}</QueryProvider> }
type Request = { signal: AbortSignal; authenticationAccount?: string; resolve: (value: unknown) => void }
const requests: Request[] = []
function seedForum(current: QueryClient) {
  ingestServerDetail(getCommunityDbRegistry(current)!, { id: "server", name: "Server", discriminator: "0001", description: "", icon: null, ownerId: sdk.id, categories: [{ id: "category", name: "Channels", channels: [{ id: "forum", name: "Forum", type: "forum", active: false, unread: false }] }] })
}
function envelope(content: string) { return { channels: [{ id: "child", serverId: "server", type: "thread", name: "Thread", parentChannelId: "forum", parentMessageId: "opener", creatorId: "peer", archived: false, activityAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(), unread: false }], included: { parentMessages: [{ id: "opener", content, seq: 1, channelId: "forum", type: "chat" }] }, serverNow: new Date().toISOString() } }
beforeEach(async () => { await clearAllPersistedCaches(); requests.length = 0; api.mockReset(); sdk.id = "A"; api.mockImplementation((_path: string, options: Omit<Request, "resolve">) => new Promise((resolve) => { requests.push({ ...options, resolve }) })) })
describe("actual native forum sidebar reads", () => {
  it("deduplicates StrictMode consumers and publishes canonical sidebar rows with metadata-only transport", async () => {
    render(<React.StrictMode><Root /></React.StrictMode>)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].authenticationAccount).toBe("A")
    await act(async () => { seedForum(client); requests[0].resolve(envelope("A current")); await new Promise((done) => setTimeout(done, 0)) })
    await waitFor(() => expect(screen.getByTestId("sidebar-0").textContent).toBe("A current"))
    expect(screen.getByTestId("sidebar-1").textContent).toBe("A current")
    expect(client.getQueryData<{ threads: unknown[] }>(communityKeys.forumSidebarThreads("server"))?.threads).toEqual([])
  })
  it("keeps one shared native request, aborts at zero observers, and blocks late canonical publication", async () => {
    const view = render(<Root />); await waitFor(() => expect(requests).toHaveLength(1))
    const original = client, registry = getCommunityDbRegistry(original)!
    expect(requests[0].authenticationAccount).toBe("A")
    act(() => view.rerender(<Root consumers={1} />)); expect(requests[0].signal.aborted).toBe(false); expect(requests).toHaveLength(1)
    act(() => view.rerender(<Root consumers={0} />)); await waitFor(() => expect(requests[0].signal.aborted).toBe(true))
    await act(async () => { requests[0].resolve(envelope("late A")); await new Promise((done) => setTimeout(done, 0)) })
    expect(registry.collections.channels.has("child")).toBe(false)
    expect(registry.collections.messages.has("opener")).toBe(false)
    expect(registry.runtime.lifecycle.get().active).toBe(true)
  })
  it("starts B own request while A same-server read is held and ignores A late response", async () => {
    const view = render(<Root consumers={1} />); await waitFor(() => expect(requests).toHaveLength(1)); const original = client
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" consumers={1} />) })
    await waitFor(() => expect(client).not.toBe(original))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].authenticationAccount).toBe("B")
    await act(async () => { seedForum(client); requests[1].resolve(envelope("B own")); await new Promise((done) => setTimeout(done, 0)) })
    await waitFor(() => expect(screen.getByTestId("sidebar-0").textContent).toBe("B own"))
    await act(async () => { requests[0].resolve(envelope("late A")); await new Promise((done) => setTimeout(done, 0)) })
    expect(screen.getByTestId("sidebar-0").textContent).toBe("B own")
    expect(original.getQueryCache().getAll()).toHaveLength(0)
    expect(client.getQueryData<{ threads: unknown[] }>(communityKeys.forumSidebarThreads("server"))?.threads).toEqual([])
  })
})

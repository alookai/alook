import { useLayoutEffect } from "react"
import "fake-indexeddb/auto"
import React from "react"
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@/test/react-dom-harness"
import { QueryProvider } from "@/app/c/QueryProvider"
import { clearAllPersistedCaches } from "@/lib/query-persister"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { useCanonicalChannelsById, useCanonicalMessagesById } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, projectCommunityWsEventToDb, publishCommunityForumSidebar } from "@/lib/community-db/sync"
import { dispatchCommunityWsEvent } from "../community-ws/registry"
import { getCommunityRuntime } from "@/stores/community/runtime"
import { useDeleteForumThread } from "./forum"
const api = vi.hoisted(() => vi.fn())
const sdk = vi.hoisted(() => ({ id: "A" }))
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
vi.mock("@/lib/auth-client", () => { const sessionSDK = { useSession: () => ({ data: { user: { id: sdk.id } }, isPending: false, error: null }) }; return { ...sessionSDK, currentSessionViewer: () => { const value = sessionSDK.useSession(); return !value || value.isPending || value.error ? undefined : value.data?.user.id ?? null } } })
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }))
let client: QueryClient, remove: ReturnType<typeof useDeleteForumThread>
const navigate = vi.fn()
function Probe() { const currentClient = useQueryClient(), command = useDeleteForumThread(); useLayoutEffect(() => { client = currentClient; remove = command }); const channels = useCanonicalChannelsById(), messages = useCanonicalMessagesById(); return <><output data-testid="child">{channels.get("child")?.name ?? "missing"}</output><output data-testid="opener">{messages?.get("opener")?.content ?? "missing"}</output></> }
function Root({ id = sdk.id, show = true }: { id?: string; show?: boolean }) { return <QueryProvider userId={id}>{show ? <Probe /> : null}</QueryProvider> }
async function seed(qc: QueryClient) {
  const registry = getCommunityDbRegistry(qc)!
  await act(async () => { await registry.ready; await registry.preload() })
  act(() => {
    projectCommunityWsEventToDb(qc, { type: "community:channel.create", serverId: "server", channel: { id: "forum", name: "Forum", type: "forum", categoryId: null, position: 0, createdAt: new Date().toISOString() } })
    publishCommunityForumSidebar(qc, { serverId: "server", channels: [{ id: "child", name: "Original", parentChannelId: "forum", parentMessageId: "opener", activityAt: new Date().toISOString(), unread: false, type: "thread", serverId: "server", archived: false }], openers: [{ id: "opener", channelId: "forum", seq: 1, type: "chat", content: "Original opener" }], proof: { token: captureCommunityLiveSnapshotToken(qc), signal: undefined } })
    const runtime = getCommunityRuntime(qc); runtime.ui.actions.setCurrentServerId("server"); runtime.ui.actions.setCurrentChannelId("child"); runtime.ui.actions.registerUiHandlers({ replacePath: navigate })
  })
  await waitFor(() => expect(screen.getByTestId("child").textContent).toBe("Original"))
}
async function mount() {
  let resolve!: (value: unknown) => void, reject!: (error: Error) => void
  const held = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  api.mockImplementation(async (_path, options) => {
    const signal = options.signal as AbortSignal | undefined
    options.assertActive?.()
    if (signal?.aborted) throw new DOMException("Cancelled DELETE", "AbortError")
    let abort!: () => void
    const cancelled = new Promise<never>((_, fail) => {
      abort = () => fail(new DOMException("Cancelled DELETE", "AbortError"))
      signal?.addEventListener("abort", abort, { once: true })
    })
    try {
      const result = await Promise.race([held, cancelled])
      options.assertActive?.()
      return result
    } finally { signal?.removeEventListener("abort", abort) }
  })
  const view = render(<Root />); await waitFor(() => expect(client).toBeDefined()); await seed(client)
  return { view, resolve, reject, original: client }
}
const args = { serverId: "server", forumChannelId: "forum", threadId: "child", openerMessageId: "opener" }
function command() { return remove.mutateAsync(args).catch((error) => error) }
async function pending() { await waitFor(() => expect(api.mock.calls.some(([, options]) => options.method === "DELETE")).toBe(true)) }
function wsDelete(qc: QueryClient) { const runtime = getCommunityRuntime(qc); dispatchCommunityWsEvent({ type: "community:channel.delete", serverId: "server", channelId: "child", parentChannelId: "forum", parentMessageId: "opener" }, { deliveryMode: "single", queryClient: qc, communityStore: runtime.ui, wsStore: runtime.ws, sub: {}, viewerUserIdRef: { current: sdk.id }, matchesFocus: () => false, scheduleInboxInvalidate: vi.fn() }) }
beforeEach(async () => { await clearAllPersistedCaches(); api.mockReset(); sdk.id = "A"; navigate.mockClear(); client = undefined as unknown as QueryClient })
describe("actual native forum post-unit deletion", () => {
  it("hides both canonical identities optimistically and restores them on ordinary failure", async () => {
    const { reject } = await mount(); let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    expect(screen.getByTestId("child").textContent).toBe("missing"); expect(screen.getByTestId("opener").textContent).toBe("missing")
    await act(async () => { reject(new Error("denied")); await result })
    expect(screen.getByTestId("child").textContent).toBe("Original"); expect(screen.getByTestId("opener").textContent).toBe("Original opener"); expect(navigate).not.toHaveBeenCalled()
  })
  it("reveals newer committed child WS fields on failed deletion", async () => {
    const { reject, original } = await mount(); let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    act(() => projectCommunityWsEventToDb(original, { type: "community:channel.child_update", parentChannelId: "forum", channelId: "child", changes: { name: "newer-ws" } }))
    await act(async () => { reject(new Error("denied")); await result })
    expect(screen.getByTestId("child").textContent).toBe("newer-ws"); expect(screen.getByTestId("opener").textContent).toBe("Original opener")
  })
  it("keeps newer authoritative WS post deletion absent when HTTP fails", async () => {
    const { reject, original } = await mount(); let result!: Promise<unknown>; act(() => { result = command() }); await pending(); act(() => wsDelete(original))
    await act(async () => { reject(new Error("denied")); await result })
    expect(screen.getByTestId("child").textContent).toBe("missing"); expect(screen.getByTestId("opener").textContent).toBe("missing")
    expect(navigate).toHaveBeenCalledTimes(1)
  })
  it("finishes an issued DELETE after self WS and view retirement without repeating navigation", async () => {
    const { view, resolve, original } = await mount()
    let result!: Promise<unknown>
    act(() => { result = command() })
    await pending()
    const mutation = original.getMutationCache().find({ mutationKey: ["community", "forum-post-delete"], exact: true })!
    const options = api.mock.calls.find(([, value]) => value.method === "DELETE")![1] as { signal: AbortSignal; assertActive: () => void }
    act(() => wsDelete(original))
    act(() => view.rerender(<Root show={false} />))
    expect(options.signal.aborted).toBe(false)
    expect(() => options.assertActive()).not.toThrow()
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    expect(mutation.state.status).toBe("success")
    act(() => view.rerender(<Root />))
    expect(screen.getByTestId("child").textContent).toBe("missing")
    expect(screen.getByTestId("opener").textContent).toBe("missing")
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(getCommunityDbRegistry(original)!.runtime.lifecycle.get().active).toBe(true)
  })
  it("physically cancels the original DELETE through A to B to A without deleting the new A's facts", async () => {
    const { view, resolve, original } = await mount()
    let result!: Promise<unknown>
    act(() => { result = command() })
    await pending()
    const signal = api.mock.calls.find(([, value]) => value.method === "DELETE")![1].signal as AbortSignal
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" />) })
    await waitFor(() => expect(client).not.toBe(original))
    const accountB = client
    act(() => { sdk.id = "A"; view.rerender(<Root id="A" />) })
    await waitFor(() => { expect(client).not.toBe(original); expect(client).not.toBe(accountB) })
    await seed(client)
    navigate.mockClear()
    expect(signal.aborted).toBe(true)
    await act(async () => { resolve(undefined); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(original.getQueryCache().getAll()).toHaveLength(0)
    expect(screen.getByTestId("child").textContent).toBe("Original")
    expect(screen.getByTestId("opener").textContent).toBe("Original opener")
    expect(navigate).not.toHaveBeenCalled()
  })
  it("commits both identities and ejects the active child once without self WS", async () => {
    const { resolve, original } = await mount(); let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    await act(async () => { resolve(undefined); expect(await result).toBeUndefined() })
    expect(screen.getByTestId("child").textContent).toBe("missing"); expect(screen.getByTestId("opener").textContent).toBe("missing")
    expect(navigate).toHaveBeenCalledTimes(1); expect(getCommunityRuntime(original).ui.get().currentChannelId).toBe("forum")
    act(() => wsDelete(original)); expect(navigate).toHaveBeenCalledTimes(1)
  })
  it.each(["success", "failure"] as const)("rejects old account %s without restoring old caches or navigating B", async (outcome) => {
    const { view, resolve, reject, original } = await mount(); let result!: Promise<unknown>; act(() => { result = command() }); await pending()
    act(() => { sdk.id = "B"; view.rerender(<Root id="B" />) }); await waitFor(() => expect(client).not.toBe(original)); await seed(client); navigate.mockClear()
    await act(async () => { if (outcome === "success") resolve(undefined); else reject(new Error("old error")); expect(await result).toMatchObject({ name: "AbortError" }) })
    expect(original.getQueryCache().getAll()).toHaveLength(0); expect(screen.getByTestId("child").textContent).toBe("Original"); expect(screen.getByTestId("opener").textContent).toBe("Original opener"); expect(navigate).not.toHaveBeenCalled()
  })
})

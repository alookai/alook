import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { getCommunityDbRegistry } from "@/lib/community-db/collections"
import { createElement, useEffect } from "react"
import type { QueryClient } from "@tanstack/react-query"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, render } from "@/test/react-dom-harness"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), replace: vi.fn(), toast: vi.fn(),
  server: { server: { id: "server-1", categories: [{ channels: [{ id: "parent-1", name: "parent", type: "text" }] }] } as { id: string; categories: { channels: { id: string; name: string; type: string }[] }[] } | null,
    isError: false, isFetching: false, refetch: vi.fn(() => Promise.resolve()) },
}))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch, toastApiError: mocks.toast }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("./use-servers", () => ({
  useServer: () => mocks.server,
}))
vi.mock("./use-community-ws", () => ({ communityWsSubscribe: vi.fn(), communityWsUnsubscribe: vi.fn() }))
vi.mock("./use-forum-sidebar-threads", () => ({
  removeForumSidebarUnreadChild: vi.fn(), removeForumSidebarThreadExact: vi.fn(),
  invalidateForumSidebarBaseExact: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/community/last-channel", () => ({ getLastChannel: () => null, clearLastChannel: vi.fn() }))
vi.mock("@/lib/community/last-community-route", () => ({
  consumeCommunityColdEntryFailure: () => false, COMMUNITY_COLD_ENTRY_FALLBACK: "/c/me/machines",
}))

import { useChannelRouteModel } from "./use-channel-route-model"
import { reconcileCommunityWsReconnect } from "./community-ws/reconnect"

let current!: ReturnType<typeof useChannelRouteModel>
let renderer: ReturnType<typeof render> | undefined
let client: QueryClient

function Harness({ channelId = "post-1", accountId = "viewer-1" }: { channelId?: string; accountId?: string }) {
  const model = useChannelRouteModel("server-1", "server-1", channelId, accountId)
  useEffect(() => { current = model }, [model])
  return null
}
function tree(props: { channelId?: string; accountId?: string } = {}) {
  return createElement(QueryClientProvider, { client, userId: "viewer-1" }, createElement(Harness, props))
}
async function mount() {
  renderer = render(tree())
}
async function until(predicate: () => boolean) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(predicate()).toBe(true)
  }, { timeout: 2000, interval: 5 })
}
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function payload(id = "post-1") {
  return {
    id, serverId: "server-1", name: "post", type: "thread", parentChannelId: "parent-1",
    parentMessageId: "opener-1", creatorId: "viewer-1", archived: false,
    lastMessageAt: "2026-08-09T00:00:00.000Z", createdAt: "2026-08-08T00:00:00.000Z",
  }
}

beforeEach(async () => {
  mocks.apiFetch.mockReset()
  Object.assign(mocks.server, { server: { id: "server-1", categories: [{ channels: [{ id: "parent-1", name: "parent", type: "text" }] }] }, isError: false, isFetching: false })
  mocks.server.refetch.mockReset().mockResolvedValue(undefined)
  mocks.replace.mockClear()
  mocks.toast.mockClear()
  client = (await createCommunityQueryOwner("viewer-1", { defaultOptions: { queries: { retry: 1, retryDelay: 0, gcTime: Infinity } } })).client
})
afterEach(async () => {
  await act(async () => { renderer?.unmount() })
  renderer = undefined
  client.clear()
})

describe("unresolved metadata terminal error and retry", () => {
  it("keeps a missing server dependency retryable until its own read settles", async () => {
    mocks.apiFetch.mockResolvedValue(payload())
    Object.assign(mocks.server, { server: null, isError: true })
    await mount()
    await until(() => current.serverError)
    expect(current.routeLifecycle).toBe("terminal-error")
    let release!: () => void
    mocks.server.refetch.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    let request!: Promise<void>
    await act(async () => { request = current.retryServer(); void current.retryServer() })
    expect(mocks.server.refetch).toHaveBeenCalledOnce()
    Object.assign(mocks.server, { isError: false, isFetching: true })
    renderer!.rerender(tree())
    expect(current.serverError).toBe(true)
    expect(current.retryingServer).toBe(true)
    await act(async () => { release(); await request })
    Object.assign(mocks.server, { server: { id: "server-1", categories: [{ channels: [{ id: "parent-1", name: "parent", type: "text" }] }] }, isFetching: false })
    renderer!.rerender(tree())
    await until(() => current.routeHydrated)
    expect(current.serverError).toBe(false)
  })

  it("waits for the original automatic retries before showing a persistent error", async () => {
    const first = deferred()
    const second = deferred()
    mocks.apiFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await mount()
    expect(current.routeLifecycle).toBe("pending")
    expect(current.metadataError).toBe(false)
    await current.retryMetadata()
    await until(() => mocks.apiFetch.mock.calls.length === 1)

    await act(async () => { first.reject(new ApiError("unavailable", 500)) })
    await until(() => mocks.apiFetch.mock.calls.length === 2)
    expect(current.metadataError).toBe(false)
    await act(async () => { second.reject(new ApiError("unavailable", 500)) })
    await until(() => current.metadataError)
    expect(current.routeLifecycle).toBe("terminal-error")
    expect(current.retryingMetadata).toBe(false)
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(getCommunityDbRegistry(client)!.collections.channels.get("post-1") ?? null).toBeNull()
  })

  it("deduplicates manual retry, keeps its error frame in flight, and recovers through the same query", async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError("unavailable", 500))
    await mount()
    await until(() => current.metadataError)
    const retry = deferred()
    mocks.apiFetch.mockReturnValueOnce(retry.promise)
    let request!: Promise<void>
    await act(async () => {
      request = current.retryMetadata()
      void current.retryMetadata()
    })
    await until(() => mocks.apiFetch.mock.calls.length === 3)
    expect(current.retryingMetadata).toBe(true)
    expect(current.metadataError).toBe(true)
    expect(client.getQueryState(communityKeys.channelMeta("server-1", "post-1"))?.status).toBe("pending")
    await current.retryMetadata()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(3)
    await act(async () => { retry.reject(new ApiError("unavailable", 500)); await request })
    await until(() => current.metadataError && !current.retryingMetadata)
    expect(mocks.apiFetch).toHaveBeenCalledTimes(4)

    mocks.apiFetch.mockResolvedValueOnce(payload())
    await act(async () => { await current.retryMetadata() })
    await until(() => current.routeLifecycle === "ready")
    expect(current.metadataError).toBe(false)
    expect(current.currentChannelMeta?.id).toBe("post-1")
    expect(mocks.apiFetch.mock.calls.every(([url]) => url === "/api/community/channels/post-1")).toBe(true)
    expect(client.getQueryCache().findAll({ queryKey: communityKeys.channelMeta("server-1", "post-1"), exact: true })).toHaveLength(1)
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404])("exits on the first authoritative %s instead of retrying or offering metadata Retry", async (status) => {
    mocks.apiFetch.mockRejectedValue(new ApiError("denied", status))
    await mount()
    await until(() => current.routeLifecycle === "terminal-error")
    expect(current.metadataError).toBe(false)
    await current.retryMetadata()
    expect(mocks.apiFetch).toHaveBeenCalledOnce()
    if (status === 401) expect(mocks.replace).not.toHaveBeenCalled()
    else expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
  })

  it("does not let a late missing-metadata response overwrite newer navigation", async () => {
    const request = deferred()
    mocks.apiFetch.mockReturnValueOnce(request.promise)
    await mount()
    await until(() => mocks.apiFetch.mock.calls.length === 1)

    act(() => getCommunityDbRegistry(client)!.runtime.ui.actions.setCurrentChannelId(null))
    await act(async () => request.reject(new ApiError("missing", 404)))
    await until(() => current.routeLifecycle === "terminal-error")

    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it.each([0, 500])("keeps a verified thread ready through disconnect, failed %s revalidation, and recovery", async (status) => {
    mocks.apiFetch.mockResolvedValue(payload())
    await mount()
    await until(() => current.routeHydrated)
    await act(async () => { getCommunityDbRegistry(client)!.runtime.ws.actions.markAccessDisconnected() })
    mocks.apiFetch.mockRejectedValue(new ApiError("offline", status))
    await act(async () => {
      getCommunityDbRegistry(client)!.runtime.ws.actions.markAccessConnected()
      await reconcileCommunityWsReconnect(client, 60_000)
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(client.getQueryState(communityKeys.channelMeta("server-1", "post-1"))?.status).toBe("error")
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/community/channels/post-1", expect.anything())
    expect(current.routeLifecycle).toBe("ready")
    expect(current.currentChannelMeta?.id).toBe("post-1")
    expect(current.metadataError).toBe(false)
    mocks.apiFetch.mockResolvedValue(payload())
    await act(async () => { await reconcileCommunityWsReconnect(client, 60_000) })
    expect(current.routeLifecycle).toBe("ready")
    expect(client.getQueryState(communityKeys.channelMeta("server-1", "post-1"))?.status).toBe("success")
  })

  it.each([401, 403, 404])("does not retain a trusted route after authoritative %s", async (status) => {
    mocks.apiFetch.mockResolvedValue(payload())
    await mount()
    await until(() => current.routeHydrated)
    await act(async () => { getCommunityDbRegistry(client)!.runtime.ws.actions.markAccessDisconnected() })
    mocks.apiFetch.mockRejectedValue(new ApiError("denied", status))
    await act(async () => { await reconcileCommunityWsReconnect(client, 60_000) })
    await until(() => current.routeLifecycle === "terminal-error")
    expect(current.metadataError).toBe(false)
    if (status !== 401) expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
  })

  it("keeps a legacy tag-derived archive bit pending without purging or revoking access", async () => {
    const owner = getCommunityDbRegistry(client)!
    owner.collections.channels.utils.writeUpsert([{ ...payload(), type: "thread", archived: true, tags: ["archived"], position: 0, muted: false, unread: false, pending: false }])
    owner.collections.messages.utils.writeUpsert([{ id: "reply-1", channelId: "post-1", type: "chat", content: "kept" }])
    const held = deferred()
    mocks.apiFetch.mockReturnValue(held.promise)
    await mount()
    await until(() => mocks.apiFetch.mock.calls.length > 0)
    expect(current.routeLifecycle).toBe("pending")
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(owner.runtime.ws.actions.isChannelAccessRevoked("post-1", "server-1")).toBe(false)
    expect(owner.collections.messages.get("reply-1")?.content).toBe("kept")
    await act(async () => held.resolve(payload()))
    await until(() => current.routeHydrated)
    expect(owner.collections.channels.get("post-1")?.archived).toBe(false)
    expect(owner.collections.channels.get("post-1")?.tags).toEqual(["archived"])
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(owner.collections.messages.get("reply-1")?.content).toBe("kept")
  })

  it("does not retain a trusted route after an archived metadata response", async () => {
    mocks.apiFetch.mockResolvedValue(payload())
    await mount()
    await until(() => current.routeHydrated)
    mocks.apiFetch.mockResolvedValue({ ...payload(), archived: true })
    await act(async () => { await reconcileCommunityWsReconnect(client, 60_000) })
    await until(() => !current.routeHydrated)
    expect(current.routeLifecycle).not.toBe("ready")
    expect(mocks.replace).toHaveBeenCalledOnce()
    expect(getCommunityDbRegistry(client)!.runtime.ws.actions.isChannelAccessRevoked("post-1", "server-1")).toBe(true)
  })

  it("requires fresh metadata after reauthorization and can exit again on a later denial", async () => {
    const metadataPath = "/api/community/channels/post-1"
    const metadataCalls = () => mocks.apiFetch.mock.calls.filter(([path]) => path === metadataPath).length
    let readMetadata: () => Promise<unknown> = async () => payload()
    mocks.apiFetch.mockImplementation((path: string) => path === metadataPath ? readMetadata() : Promise.resolve({ id: "viewer-1", name: "Viewer", discriminator: "0001", avatar: "V", avatarVersion: 0 }))
    await mount()
    await until(() => current.routeHydrated)
    readMetadata = async () => { throw new ApiError("denied", 403) }
    await act(async () => { await reconcileCommunityWsReconnect(client, 60_000, { viewerUserId: "viewer-1" }) })
    await until(() => current.routeLifecycle === "terminal-error")
    const deniedCalls = metadataCalls()
    const profileCalls = mocks.apiFetch.mock.calls.filter(([path]) => path === "/api/community/users/viewer-1/profile").length
    expect(mocks.replace).toHaveBeenCalledTimes(1)
    await act(async () => { await reconcileCommunityWsReconnect(client, 60_000, { viewerUserId: "viewer-1" }) })
    expect(metadataCalls()).toBe(deniedCalls)
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === "/api/community/users/viewer-1/profile").length).toBeGreaterThan(profileCalls)
    const fresh = deferred()
    readMetadata = () => fresh.promise
    expect(getCommunityDbRegistry(client)!.runtime.ui.get().currentChannelId).toBeNull()
    await act(async () => {
      const runtime = getCommunityDbRegistry(client)!.runtime
      runtime.ui.actions.setCurrentChannelId("post-1")
      runtime.ws.actions.rememberChannelAccess("server-1", "post-1", "parent-1")
    })
    await until(() => metadataCalls() > deniedCalls)
    expect(current.routeLifecycle).not.toBe("ready")
    await act(async () => { fresh.resolve(payload()) })
    await until(() => current.routeLifecycle === "ready")
    readMetadata = async () => { throw new ApiError("denied again", 403) }
    await act(async () => { await reconcileCommunityWsReconnect(client, 60_000, { viewerUserId: "viewer-1" }) })
    await until(() => current.routeLifecycle === "terminal-error")
    expect(mocks.replace).toHaveBeenCalledTimes(2)
  })

  it("does not let an old route retry completion clear the new route retry", async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError("offline", 0))
    await mount()
    await until(() => current.metadataError)
    const oldRetry = deferred()
    mocks.apiFetch.mockReturnValueOnce(oldRetry.promise)
    let oldRequest!: Promise<void>
    await act(async () => { oldRequest = current.retryMetadata() })
    renderer!.rerender(tree({ channelId: "post-2" }))
    await until(() => current.metadataError)
    expect(current.retryingMetadata).toBe(false)
    const newRetry = deferred()
    mocks.apiFetch.mockReturnValueOnce(newRetry.promise)
    let newRequest!: Promise<void>
    await act(async () => { newRequest = current.retryMetadata() })
    await act(async () => { oldRetry.resolve(payload()); await oldRequest })
    expect(current.retryingMetadata).toBe(true)
    expect(current.metadataError).toBe(true)
    expect(getCommunityDbRegistry(client)!.collections.channels.get("post-1") ?? null).toBeNull()
    await act(async () => { newRetry.resolve(payload("post-2")); await newRequest })
    await until(() => current.routeHydrated)
    expect(current.currentChannelMeta?.id).toBe("post-2")
    expect(current.retryingMetadata).toBe(false)
  })

  it.each(["account", "epoch"])("does not carry retry feedback across an %s change", async (change) => {
    mocks.apiFetch.mockRejectedValue(new ApiError("offline", 0))
    await mount()
    await until(() => current.metadataError)
    const retry = deferred()
    mocks.apiFetch.mockReturnValueOnce(retry.promise)
    let request!: Promise<void>
    await act(async () => { request = current.retryMetadata() })
    expect(current.retryingMetadata).toBe(true)
    await act(async () => {
      if (change === "account") renderer!.rerender(tree({ accountId: "viewer-2" }))
      else {
        getCommunityDbRegistry(client)!.runtime.ws.setState((state) => ({ ...state,  accessEpoch: state.accessEpoch + 1 }))
      }
    })
    expect(current.retryingMetadata).toBe(false)
    await act(async () => { retry.resolve(payload()); await request })
    expect(current.retryingMetadata).toBe(false)
  })
})

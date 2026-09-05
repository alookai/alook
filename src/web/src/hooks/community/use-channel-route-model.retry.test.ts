import { createElement, useEffect } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityStore } from "@/stores/community"
import { useCommunityWsStore } from "@/stores/community/ws"

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), replace: vi.fn(), toast: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.apiFetch, toastApiError: mocks.toast }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("./use-servers", () => ({
  useServer: () => ({ server: {
    id: "server-1",
    categories: [{ channels: [{ id: "parent-1", name: "parent", type: "text" }] }],
  } }),
}))
vi.mock("./use-community-ws", () => ({ communityWsSubscribe: vi.fn(), communityWsUnsubscribe: vi.fn() }))
vi.mock("./use-forum-sidebar-threads", () => ({
  removeForumSidebarUnreadChild: vi.fn(), removeForumSidebarThreadExact: vi.fn(),
}))
vi.mock("@/lib/community/last-channel", () => ({ getLastChannel: () => null, clearLastChannel: vi.fn() }))
vi.mock("@/lib/community/last-community-route", () => ({
  consumeCommunityColdEntryFailure: () => false, COMMUNITY_COLD_ENTRY_FALLBACK: "/c/me/machines",
}))

import { useChannelRouteModel } from "./use-channel-route-model"

let current!: ReturnType<typeof useChannelRouteModel>
let renderer: TestRenderer.ReactTestRenderer | undefined
let client: QueryClient

function Harness({ channelId = "post-1", accountId = "viewer-1" }: { channelId?: string; accountId?: string }) {
  const model = useChannelRouteModel("server-1", "server-1", channelId, accountId)
  useEffect(() => { current = model }, [model])
  return null
}
function tree(props: { channelId?: string; accountId?: string } = {}) {
  return createElement(QueryClientProvider, { client }, createElement(Harness, props))
}
async function mount() {
  await act(async () => { renderer = TestRenderer.create(tree()) })
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

beforeEach(() => {
  mocks.apiFetch.mockReset()
  mocks.replace.mockClear()
  mocks.toast.mockClear()
  useCommunityStore.getState().reset()
  useCommunityWsStore.getState().reset()
  useCommunityWsStore.getState().markAccessConnected()
  client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0, gcTime: Infinity } } })
})
afterEach(async () => {
  await act(async () => { renderer?.unmount() })
  renderer = undefined
  client.clear()
  useCommunityStore.getState().reset()
})

describe("unresolved metadata terminal error and retry", () => {
  it("waits for the original automatic retries before showing a persistent error", async () => {
    const first = deferred()
    const second = deferred()
    mocks.apiFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await mount()
    expect(current.routeLifecycle).toBe("pending")
    expect(current.metadataError).toBe(false)
    await current.retryMetadata()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1)

    await act(async () => { first.reject(new ApiError("unavailable", 500)) })
    await until(() => mocks.apiFetch.mock.calls.length === 2)
    expect(current.metadataError).toBe(false)
    await act(async () => { second.reject(new ApiError("unavailable", 500)) })
    await until(() => current.metadataError)
    expect(current.routeLifecycle).toBe("terminal-error")
    expect(current.retryingMetadata).toBe(false)
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
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
    expect(client.getQueryCache().getAll()).toHaveLength(1)
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404])("preserves the existing %s exit instead of offering metadata Retry", async (status) => {
    mocks.apiFetch.mockRejectedValue(new ApiError("denied", status))
    await mount()
    await until(() => current.routeLifecycle === "terminal-error")
    expect(current.metadataError).toBe(false)
    await current.retryMetadata()
    expect(mocks.apiFetch).toHaveBeenCalledTimes(2)
    if (status === 401) expect(mocks.replace).not.toHaveBeenCalled()
    else expect(mocks.replace).toHaveBeenCalledWith("/c/channels/server-1")
  })

  it("does not replace previously verified content with the new error UI on background failure", async () => {
    mocks.apiFetch.mockResolvedValue(payload())
    await mount()
    await until(() => current.routeHydrated)
    mocks.apiFetch.mockRejectedValue(new ApiError("offline", 0))
    await act(async () => { await client.refetchQueries({ queryKey: communityKeys.channelMeta("server-1", "post-1") }) })
    await until(() => current.routeLifecycle === "terminal-error")
    expect(current.currentChannelMeta?.id).toBe("post-1")
    expect(current.metadataError).toBe(false)
  })

  it("does not let an old route retry completion clear the new route retry", async () => {
    mocks.apiFetch.mockRejectedValue(new ApiError("offline", 0))
    await mount()
    await until(() => current.metadataError)
    const oldRetry = deferred()
    mocks.apiFetch.mockReturnValueOnce(oldRetry.promise)
    let oldRequest!: Promise<void>
    await act(async () => { oldRequest = current.retryMetadata() })
    await act(async () => { renderer!.update(tree({ channelId: "post-2" })) })
    await until(() => current.metadataError)
    expect(current.retryingMetadata).toBe(false)
    const newRetry = deferred()
    mocks.apiFetch.mockReturnValueOnce(newRetry.promise)
    let newRequest!: Promise<void>
    await act(async () => { newRequest = current.retryMetadata() })
    await act(async () => { oldRetry.resolve(payload()); await oldRequest })
    expect(current.retryingMetadata).toBe(true)
    expect(current.metadataError).toBe(true)
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
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
      if (change === "account") renderer!.update(tree({ accountId: "viewer-2" }))
      else {
        useCommunityWsStore.getState().markAccessDisconnected()
        useCommunityWsStore.getState().markAccessConnected()
      }
    })
    expect(current.retryingMetadata).toBe(false)
    await act(async () => { retry.resolve(payload()); await request })
    expect(current.retryingMetadata).toBe(false)
  })
})

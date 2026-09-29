import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { notificationSettingsResourceKey } from "@/lib/community-db/notification-settings-resource"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  reconcileCommunityLiveSnapshot,
} from "@/lib/community-db/sync"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function mockCommunityFetch(notificationRows: unknown[] = []) {
  apiFetchMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/read-state")) return { revision: 0, readStates: [] }
    if (path.endsWith("/attention")) {
      return {
        scopes: [], items: [], limit: 100, truncated: false,
        included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
      }
    }
    if (path.endsWith("/server-folders")) return { folders: [] }
    if (path.endsWith("/notifications")) return notificationRows
    if (path.endsWith("/dms")) return { conversations: [] }
    throw new Error(`unexpected ${path}`)
  })
}

beforeEach(() => {
  apiFetchMock.mockReset()
  mockCommunityFetch()
})

describe("useNotificationSettings / notificationSettingsQueryFn", () => {
  it("uses the backend-compatible all default when a server has no setting row", async () => {
    const { resolveServerNotificationDisplayLevel } = await import("./use-notification-settings")
    expect(resolveServerNotificationDisplayLevel(undefined)).toBe("All Messages")
    expect(resolveServerNotificationDisplayLevel("Only @mentions")).toBe("Only @mentions")
  })

  it("groups rows into server/channel maps with display strings", async () => {
    mockCommunityFetch([
      { serverId: "srv_1", channelId: null, level: "all" },
      { serverId: null, channelId: "ch_1", level: "mentions" },
      { serverId: null, channelId: "ch_2", level: "nothing" },
    ])
    const { notificationSettingsQueryFn } = await import("./use-notification-settings")
    const data = await notificationSettingsQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/notifications",
      { signal: undefined },
    )
    expect(data.server).toEqual({ srv_1: "All Messages" })
    expect(data.channel).toEqual({ ch_1: "Only @mentions", ch_2: "Nothing" })
    expect(data.raw).toHaveLength(3)
  })

  it("populates the account-scoped notification resource", async () => {
    const queryClient = new QueryClient()
    const registry = createCommunityDbRegistry(queryClient, "viewer_1")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const key = notificationSettingsResourceKey("viewer_1")
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/notifications",
      { signal: expect.any(AbortSignal) },
    )
    expect(queryClient.getQueryData(key)).toBeDefined()
    unregister()
    await disposeRegistry()
  })

  it("projects fetched settings into the active account unread owner", async () => {
    mockCommunityFetch([
      { serverId: "srv_1", channelId: null, level: "nothing" },
    ])
    const { useNotificationSettings } = await import("./use-notification-settings")
    const {
      disposeAccountUnreadProjection,
      getAccountUnreadProjection,
    } = await import("./account-unread-projection")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer_1")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    const projection = getAccountUnreadProjection(queryClient, "viewer_1")
    projection.recordArrival({ channelId: "channel_1", serverId: "srv_1", seq: 1 })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CommunityDbProvider, { registry }, children),
    )
    const rendered = renderHook(() => useNotificationSettings(), { wrapper })

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    expect(rendered.result.current.server).toEqual({ srv_1: "Nothing" })
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(false)

    rendered.unmount()
    unregister()
    await disposeRegistry()
    disposeAccountUnreadProjection(queryClient)
  })

  it("projects warm canonical policy while the transport request is stalled", async () => {
    mockCommunityFetch()
    const { useNotificationSettings } = await import("./use-notification-settings")
    const {
      disposeAccountUnreadProjection,
      getAccountUnreadProjection,
    } = await import("./account-unread-projection")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const registry = createCommunityDbRegistry(queryClient, "viewer_1")
    const disposeRegistry = registry.cleanup.bind(registry)
    await registry.preload()
    const unregister = registerCommunityDbRegistry(registry)
    await reconcileCommunityLiveSnapshot(queryClient, {
      snapshot: {
        kind: "notification-settings",
        data: {
          raw: [{ serverId: "srv_1", channelId: null, level: "nothing" }],
          server: { srv_1: "Nothing" },
          channel: {},
        },
      },
      proof: {
        kind: "structural",
        token: captureCommunityLiveSnapshotToken(queryClient),
        signal: undefined,
      },
    })
    apiFetchMock.mockImplementation((path: string) => {
      if (path.endsWith("/notifications")) return new Promise(() => {})
      if (path.endsWith("/read-state")) return Promise.resolve({ revision: 0, readStates: [] })
      if (path.endsWith("/attention")) {
        return Promise.resolve({
          scopes: [], items: [], limit: 100, truncated: false,
          included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
        })
      }
      if (path.endsWith("/server-folders")) return Promise.resolve({ folders: [] })
      if (path.endsWith("/dms")) return Promise.resolve({ conversations: [] })
      return Promise.reject(new Error(`unexpected ${path}`))
    })
    const projection = getAccountUnreadProjection(queryClient, "viewer_1")
    projection.recordArrival({ channelId: "channel_1", serverId: "srv_1", seq: 1 })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CommunityDbProvider, { registry }, children),
    )
    const rendered = renderHook(() => useNotificationSettings(), { wrapper })

    await waitFor(() => expect(rendered.result.current.server).toEqual({ srv_1: "Nothing" }))
    await waitFor(() => expect(
      projection.projectUnread("servers", "channel_1", false),
    ).toBe(false))
    expect(rendered.result.current.fetchStatus).toBe("fetching")

    rendered.unmount()
    unregister()
    await disposeRegistry()
    disposeAccountUnreadProjection(queryClient)
  })
})

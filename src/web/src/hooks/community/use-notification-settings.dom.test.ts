import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
} from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  publishCommunityLiveSnapshot,
} from "@/lib/community-db/sync"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useNotificationSettings / notificationSettingsQueryFn", () => {
  it("uses the backend-compatible all default when a server has no setting row", async () => {
    const { resolveServerNotificationDisplayLevel } = await import("./use-notification-settings")
    expect(resolveServerNotificationDisplayLevel(undefined)).toBe("All Messages")
    expect(resolveServerNotificationDisplayLevel("Only @mentions")).toBe("Only @mentions")
  })

  it("groups rows into server/channel maps with display strings", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { serverId: "srv_1", channelId: null, level: "all" },
      { serverId: null, channelId: "ch_1", level: "mentions" },
      { serverId: null, channelId: "ch_2", level: "nothing" },
    ])
    const { notificationSettingsQueryFn } = await import("./use-notification-settings")
    const data = await notificationSettingsQueryFn()
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/notifications")
    expect(data.server).toEqual({ srv_1: "All Messages" })
    expect(data.channel).toEqual({ ch_1: "Only @mentions", ch_2: "Nothing" })
    expect(data.raw).toHaveLength(3)
  })

  it("populates queryClient at communityKeys.notificationSettings()", async () => {
    apiFetchMock.mockResolvedValueOnce([])
    const { notificationSettingsQueryFn } = await import("./use-notification-settings")
    const queryClient = new QueryClient()
    const key = communityKeys.notificationSettings()
    await queryClient.fetchQuery({ queryKey: key, queryFn: notificationSettingsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/notifications",
      { signal: expect.any(AbortSignal) },
    )
    expect(queryClient.getQueryData(key)).toBeDefined()
  })

  it("projects fetched settings into the active account unread owner", async () => {
    apiFetchMock.mockResolvedValueOnce([
      { serverId: "srv_1", channelId: null, level: "nothing" },
    ])
    const { useNotificationSettings } = await import("./use-notification-settings")
    const {
      disposeAccountUnreadProjection,
      getAccountUnreadProjection,
    } = await import("./account-unread-projection")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const projection = getAccountUnreadProjection(queryClient, "viewer_1")
    projection.recordArrival({ channelId: "channel_1", serverId: "srv_1", seq: 1 })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    )
    const rendered = renderHook(() => useNotificationSettings(), { wrapper })

    await waitFor(() => expect(rendered.result.current.isSuccess).toBe(true))
    expect(rendered.result.current.server).toEqual({ srv_1: "Nothing" })
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(false)

    rendered.unmount()
    disposeAccountUnreadProjection(queryClient)
  })

  it("projects warm canonical policy while the transport request is stalled", async () => {
    apiFetchMock.mockReturnValue(new Promise(() => {}))
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
    publishCommunityLiveSnapshot(queryClient, {
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

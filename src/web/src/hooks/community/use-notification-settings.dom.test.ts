import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { renderHook, waitFor } from "@/test/react-dom-harness"
import { useNotificationSettings } from "./use-notification-settings"
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
    apiFetchMock.mockResolvedValue([
      { serverId: "srv_1", channelId: null, level: "all" },
      { serverId: null, channelId: "ch_1", level: "mentions" },
      { serverId: null, channelId: "ch_2", level: "nothing" },
    ])
    const { notificationSettingsQueryFn } = await import("./use-notification-settings")
    const { client, registry } = await createCommunityQueryOwner()
    const data = await client.fetchQuery({ queryKey: communityKeys.notificationSettings(), queryFn: notificationSettingsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/users/me/notifications", expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }))
    expect(data.ids).toEqual(["server:srv_1", "channel:ch_1", "channel:ch_2"])
    expect([...registry.collections.notificationSettings.values()].map(({ id, level }) => ({ id, level })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "channel:ch_1", level: "mentions" }, { id: "channel:ch_2", level: "nothing" }, { id: "server:srv_1", level: "all" },
    ])
    const wrapper = ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children)
    const rendered = renderHook(() => useNotificationSettings(), { wrapper })
    await waitFor(() => expect(rendered.result.current.server).toEqual({ srv_1: "All Messages" }))
    expect(rendered.result.current.channel).toEqual({ ch_1: "Only @mentions", ch_2: "Nothing" })

  })

  it("populates queryClient at communityKeys.notificationSettings()", async () => {
    apiFetchMock.mockResolvedValue([])
    const { notificationSettingsQueryFn } = await import("./use-notification-settings")
    const queryClient = (await createCommunityQueryOwner()).client
    const key = communityKeys.notificationSettings()
    await queryClient.fetchQuery({ queryKey: key, queryFn: notificationSettingsQueryFn })
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/community/users/me/notifications",
      expect.objectContaining({ signal: expect.any(AbortSignal), authenticationAccount: "viewer" }),
    )
    expect(queryClient.getQueryData(key)).toBeDefined()
  })

  it("projects fetched settings into the active account unread owner", async () => {
    apiFetchMock.mockResolvedValue([
      { serverId: "srv_1", channelId: null, level: "nothing" },
    ])
    const { useNotificationSettings } = await import("./use-notification-settings")
    const {
      disposeAccountUnreadProjection,
      getAccountUnreadProjection,
    } = await import("./account-unread-projection")
    const queryClient = (await createCommunityQueryOwner("viewer_1")).client
    const projection = getAccountUnreadProjection(queryClient, "viewer_1")
    projection.recordArrival({ channelId: "channel_1", serverId: "srv_1", seq: 1 })
    const wrapper = ({ children }: PropsWithChildren) => createElement(
      QueryClientProvider,
      { client: queryClient, userId: "viewer_1" },
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
      { client: queryClient, registry, userId: "viewer_1" },
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

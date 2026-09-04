import React from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

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
    const qc = new QueryClient()
    const key = communityKeys.notificationSettings()
    await qc.fetchQuery({ queryKey: key, queryFn: notificationSettingsQueryFn })
    expect(qc.getQueryData(key)).toBeDefined()
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
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const projection = getAccountUnreadProjection(qc, "viewer_1")
    projection.recordArrival({ channelId: "channel_1", serverId: "srv_1", seq: 1 })
    let latest: ReturnType<typeof useNotificationSettings> | undefined
    function Harness() {
      latest = useNotificationSettings()
      return null
    }

    let renderer!: TestRenderer.ReactTestRenderer
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(Harness),
      ))
    })
    await vi.waitFor(() => expect(latest?.isSuccess).toBe(true))

    expect(latest?.server).toEqual({ srv_1: "Nothing" })
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(false)

    await act(async () => renderer.unmount())
    disposeAccountUnreadProjection(qc)
  })
})

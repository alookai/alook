import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@/test/react-dom-harness"
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
    const queryClient = new QueryClient()
    const key = communityKeys.notificationSettings()
    await queryClient.fetchQuery({ queryKey: key, queryFn: notificationSettingsQueryFn })
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
})

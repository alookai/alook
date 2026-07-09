import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

beforeEach(() => {
  apiFetchMock.mockReset()
})

describe("useNotificationSettings / notificationSettingsQueryFn", () => {
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
})

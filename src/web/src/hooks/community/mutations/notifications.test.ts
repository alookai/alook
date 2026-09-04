import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { USE_SERVER_DEFAULT } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"

const apiFetch = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }))

type MutationConfig = {
  mutationFn?: (args: any) => Promise<unknown>
  onSuccess?: (data: unknown, args: any, context?: any) => void
  onMutate?: (args: any) => Promise<any>
  onError?: (error: unknown, args: any, context: any) => void
}
let config: MutationConfig | null = null
let queryClient: QueryClient

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => queryClient,
    useMutation: (next: MutationConfig) => {
      config = next
      return {}
    },
  }
})

beforeEach(() => {
  vi.resetModules()
  config = null
  queryClient = new QueryClient()
})

describe("notification mutation cache refresh", () => {
  it("changes only reversible eligibility and restores it on failure", async () => {
    const settings = {
      raw: [],
      server: { server_1: "All Messages" },
      channel: {},
    }
    queryClient.setQueryData(communityKeys.notificationSettings(), settings)
    const { getActiveAccountUnreadProjection } = await import("../account-unread-projection")
    const projection = getActiveAccountUnreadProjection(queryClient)
    projection.recordArrival({ channelId: "channel_1", serverId: "server_1", seq: 2 })
    const before = projection.inspectForTests()
    const { useSetServerNotifLevel } = await import("./notifications")
    useSetServerNotifLevel()

    const context = await config!.onMutate?.({ serverId: "server_1", level: "Nothing" })
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(false)
    expect(projection.inspectForTests().sourceCount).toBe(before.sourceCount)
    expect(projection.inspectForTests().readState).toEqual(before.readState)

    projection.setNotificationPolicy({ server: { server_1: "Nothing" } })

    config!.onError?.(new Error("failed"), { serverId: "server_1", level: "Nothing" }, context)
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(true)
  })

  it("rolls back one server field without clobbering a concurrent success", async () => {
    queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [],
      server: { server_1: "All Messages", server_2: "All Messages" },
      channel: {},
    })
    const { useSetServerNotifLevel } = await import("./notifications")
    useSetServerNotifLevel()

    const first = await config!.onMutate?.({ serverId: "server_1", level: "Nothing" })
    const second = await config!.onMutate?.({ serverId: "server_2", level: "Nothing" })
    config!.onSuccess?.(undefined, { serverId: "server_2", level: "Nothing" }, second)
    config!.onError?.(
      new Error("first failed"),
      { serverId: "server_1", level: "Nothing" },
      first,
    )

    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      server: { server_1: "All Messages", server_2: "Nothing" },
    })
  })

  it("refreshes settings, inbox, and all read-state snapshots after a server change", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { useSetServerNotifLevel } = await import("./notifications")
    useSetServerNotifLevel()
    config!.onSuccess?.(undefined, { serverId: "server_1", level: "Nothing" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.notificationSettings() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.servers() })
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ predicate: expect.any(Function) }))
  })

  it("refreshes every read-state snapshot after a parent channel change", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()
    config!.onSuccess?.(undefined, { channelId: "parent_1", level: "Nothing" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.servers() })
    const predicateCall = invalidate.mock.calls.find(
      ([filters]) => typeof filters?.predicate === "function",
    )
    const predicate = predicateCall?.[0].predicate
    expect(predicate).toBeTypeOf("function")
    expect(predicate!({ queryKey: communityKeys.channelReadStateSnapshot("parent_1") } as any)).toBe(true)
    expect(predicate!({ queryKey: communityKeys.channelReadStateSnapshot("child_1") } as any)).toBe(true)
    expect(predicate!({ queryKey: communityKeys.dmReadStateSnapshot("dm_1") } as any)).toBe(true)
    expect(predicate!({ queryKey: communityKeys.inbox() } as any)).toBe(false)
  })

  it("PUTs and rolls back a new channel override", async () => {
    queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [],
      server: {},
      channel: {},
    })
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()

    const args = { channelId: "channel_1", level: "Nothing" }
    const context = await config!.onMutate?.(args)
    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      channel: { channel_1: "Nothing" },
    })
    await config!.mutationFn?.(args)
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/users/me/notifications/channel/channel_1",
      { method: "PUT", body: JSON.stringify({ level: "nothing" }) },
    )

    config!.onError?.(new Error("failed"), args, context)
    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      channel: {},
    })
  })

  it("DELETEs and restores an inherited channel override", async () => {
    queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [],
      server: {},
      channel: { channel_1: "Nothing" },
    })
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()

    const args = { channelId: "channel_1", level: USE_SERVER_DEFAULT }
    const context = await config!.onMutate?.(args)
    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      channel: {},
    })
    await config!.mutationFn?.(args)
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/users/me/notifications/channel/channel_1",
      { method: "DELETE" },
    )

    config!.onError?.(new Error("failed"), args, context)
    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      channel: { channel_1: "Nothing" },
    })
  })

  it("does not let a failed channel override clobber a concurrent value", async () => {
    queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [],
      server: {},
      channel: {},
    })
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()
    const args = { channelId: "channel_1", level: "Nothing" }
    const context = await config!.onMutate?.(args)
    queryClient.setQueryData(communityKeys.notificationSettings(), {
      raw: [],
      server: {},
      channel: { channel_1: "All Messages" },
    })

    config!.onError?.(new Error("failed"), args, context)

    expect(queryClient.getQueryData(communityKeys.notificationSettings())).toMatchObject({
      channel: { channel_1: "All Messages" },
    })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { USE_SERVER_DEFAULT } from "@alook/shared"
import { communityKeys } from "@/lib/query-keys"
import { serversCollectionQueryKey } from "@/lib/community-db/server-collection"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { notificationSettingKey } from "@/lib/community-db/schema"
import { notificationSettingsResourceKey } from "@/lib/community-db/notification-settings-resource"

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
let registry: CommunityDbRegistry
let unregister: () => void

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

beforeEach(async () => {
  vi.resetModules()
  config = null
  queryClient = new QueryClient()
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (path: string) => {
    if (path === "/api/community/servers") return { servers: [] }
    if (path === "/api/community/users/me/read-state") return { revision: 0, readStates: [] }
    if (path === "/api/community/users/me/dms") return { conversations: [] }
    if (path === "/api/community/users/me/server-folders") return { folders: [] }
    if (path === "/api/community/users/me/notifications") return []
    if (path === "/api/community/users/me/attention") {
      return {
        scopes: [], items: [], limit: 100, truncated: false,
        included: { servers: [], channels: [], dms: [], profiles: [], messages: [] },
      }
    }
    throw new Error(`unexpected registry preload: ${path}`)
  })
  const collections = await import("@/lib/community-db/collections")
  registry = collections.createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
  unregister = collections.registerCommunityDbRegistry(registry)
  apiFetch.mockReset()
  apiFetch.mockImplementation(async (path: string) => (
    path === "/api/community/users/me/notifications" ? [] : undefined
  ))
})

afterEach(async () => {
  unregister()
  await registry.cleanup()
  queryClient.clear()
})

function seedSetting(target: { serverId: string | null; channelId: string | null }, level: string) {
  const id = notificationSettingKey(target)
  registry.collections.notificationSettings.utils.writeUpsert({ id, ...target, level })
  return id
}

describe("notification mutation cache refresh", () => {
  it("changes only reversible eligibility and restores it on failure", async () => {
    seedSetting({ serverId: "server_1", channelId: null }, "all")
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

  it("rolls back a newly-created canonical server setting", async () => {
    const { getActiveAccountUnreadProjection } = await import("../account-unread-projection")
    const projection = getActiveAccountUnreadProjection(queryClient)
    projection.setNotificationPolicy({})
    projection.recordArrival({ channelId: "channel_1", serverId: "server_1", seq: 2 })
    const { useSetServerNotifLevel } = await import("./notifications")
    useSetServerNotifLevel()

    const args = { serverId: "server_1", level: "Nothing" }
    const context = await config!.onMutate?.(args)

    const id = notificationSettingKey({ serverId: "server_1", channelId: null })
    expect(registry.collections.notificationSettings.get(id)?.level).toBe("nothing")
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(false)
    config!.onError?.(new Error("failed"), args, context)
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(true)
    expect(registry.collections.notificationSettings.get(id)).toBeUndefined()
  })

  it("rolls back one server field without clobbering a concurrent success", async () => {
    const firstId = seedSetting({ serverId: "server_1", channelId: null }, "all")
    const secondId = seedSetting({ serverId: "server_2", channelId: null }, "all")
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

    expect(registry.collections.notificationSettings.get(firstId)?.level).toBe("all")
    expect(registry.collections.notificationSettings.get(secondId)?.level).toBe("nothing")
  })

  it("refreshes settings, inbox, and all read-state snapshots after a server change", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { useSetServerNotifLevel } = await import("./notifications")
    useSetServerNotifLevel()
    config!.onSuccess?.(undefined, { serverId: "server_1", level: "Nothing" })

    expect(invalidate).toHaveBeenCalledWith({
      queryKey: notificationSettingsResourceKey("viewer"),
      exact: true,
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: serversCollectionQueryKey(), exact: true })
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ predicate: expect.any(Function) }))
  })

  it("refreshes every read-state snapshot after a parent channel change", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()
    config!.onSuccess?.(undefined, { channelId: "parent_1", level: "Nothing" })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inbox() })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: serversCollectionQueryKey(), exact: true })
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
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()

    const args = { channelId: "channel_1", level: "Nothing" }
    const context = await config!.onMutate?.(args)
    const id = notificationSettingKey({ serverId: null, channelId: "channel_1" })
    expect(registry.collections.notificationSettings.get(id)?.level).toBe("nothing")
    await config!.mutationFn?.(args)
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/users/me/notifications/channel/channel_1",
      { method: "PUT", body: JSON.stringify({ level: "nothing" }) },
    )

    config!.onError?.(new Error("failed"), args, context)
    expect(registry.collections.notificationSettings.get(id)).toBeUndefined()
  })

  it("DELETEs and restores an inherited channel override", async () => {
    const id = seedSetting({ serverId: null, channelId: "channel_1" }, "nothing")
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()

    const args = { channelId: "channel_1", level: USE_SERVER_DEFAULT }
    const context = await config!.onMutate?.(args)
    expect(registry.collections.notificationSettings.get(id)).toBeUndefined()
    await config!.mutationFn?.(args)
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/community/users/me/notifications/channel/channel_1",
      { method: "DELETE" },
    )

    config!.onError?.(new Error("failed"), args, context)
    expect(registry.collections.notificationSettings.get(id)?.level).toBe("nothing")
  })

  it("does not let a failed channel override clobber a concurrent value", async () => {
    const { useSetChannelNotif } = await import("./notifications")
    useSetChannelNotif()
    const args = { channelId: "channel_1", level: "Nothing" }
    const context = await config!.onMutate?.(args)
    const id = notificationSettingKey({ serverId: null, channelId: "channel_1" })
    registry.collections.notificationSettings.utils.writeUpdate({ id, level: "all" })

    config!.onError?.(new Error("failed"), args, context)

    expect(registry.collections.notificationSettings.get(id)?.level).toBe("all")
  })
})

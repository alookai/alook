import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { USE_SERVER_DEFAULT } from "@alook/shared"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import type { CommunityDbRegistry } from "@/lib/community-db/collections"
import { notificationSettingKey } from "@/lib/community-db/schema"
import { captureCommunityLiveSnapshotToken, publishCommunityNotificationSetting } from "@/lib/community-db/sync"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
import { useNotificationSettings } from "../use-notification-settings"
import { useSetChannelNotif, useSetServerNotifLevel } from "./notifications"

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch }))

function deferred() {
  let resolve!: (value: undefined) => void
  let reject!: (error: Error) => void
  const promise = new Promise<undefined>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function setup(kind: "server" | "channel" = "server", seed: Array<{ serverId: string | null; channelId: string | null; level: string }> = []) {
  const owner = await createCommunityQueryOwner()
  for (const row of seed) owner.registry.collections.notificationSettings.utils.writeUpsert({ id: notificationSettingKey(row), ...row })
  apiFetch.mockImplementation(async (_path: string, options?: { method?: string }) => {
    if (!options?.method) return [...owner.registry.collections.notificationSettings.values()]
    return undefined
  })
  function Wrapper({ children }: PropsWithChildren) {
    return createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry }, children)
  }
  const rendered = renderHook(() => {
    const settings = useNotificationSettings()
    const server = useSetServerNotifLevel(), channel = useSetChannelNotif()
    return { settings, command: kind === "server" ? server : channel }
  }, { wrapper: Wrapper })
  await waitFor(() => expect(rendered.result.current.settings.isSuccess).toBe(true))
  return { ...owner, rendered }
}
function holdWrites(held: ReturnType<typeof deferred>, registry: CommunityDbRegistry) {
  const remote = [...registry.collections.notificationSettings.values()].map((row) => ({ ...row }))
  apiFetch.mockImplementation((_path: string, options?: { method?: string }) => options?.method ? held.promise : Promise.resolve(remote))
}
const serverSetting = (id = "server_1", level = "all") => ({ serverId: id, channelId: null, level })
const channelSetting = (level = "nothing") => ({ serverId: null, channelId: "channel_1", level })
beforeEach(() => { apiFetch.mockReset() })

describe("notification mutation cache refresh", () => {
  it("changes only reversible eligibility and restores it on failure", async () => {
    const view = await setup("server", [serverSetting()])
    const projection = getActiveAccountUnreadProjection(view.client)
    projection.recordArrival({ channelId: "channel_1", serverId: "server_1", seq: 2 })
    const before = projection.inspectForTests(), held = deferred()
    holdWrites(held, view.registry)
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.command.mutateAsync({ serverId: "server_1", level: "Nothing" }).catch((error) => error) })
    await waitFor(() => expect(projection.projectUnread("servers", "channel_1", false)).toBe(false))
    expect(projection.inspectForTests().sourceCount).toBe(before.sourceCount)
    expect(projection.inspectForTests().readState).toEqual(before.readState)
    await act(async () => { held.reject(new Error("failed")); await request })
    await waitFor(() => expect(projection.projectUnread("servers", "channel_1", false)).toBe(true))
  })

  it("keeps absent canonical settings absent after a reversible server overlay fails", async () => {
    const view = await setup(), held = deferred()
    const projection = getActiveAccountUnreadProjection(view.client)
    projection.recordArrival({ channelId: "channel_1", serverId: "server_1", seq: 2 })
    view.client.removeQueries({ queryKey: communityKeys.notificationSettings(), exact: true })
    holdWrites(held, view.registry)
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.command.mutateAsync({ serverId: "server_1", level: "Nothing" }).catch((error) => error) })
    await waitFor(() => expect(view.registry.collections.notificationSettings.get("server:server_1")?.level).toBe("nothing"))
    expect(view.registry.collections.notificationSettings.size).toBe(1)
    await act(async () => { held.reject(new Error("failed")); await request })
    await waitFor(() => expect(view.registry.collections.notificationSettings.size).toBe(0))
    expect(projection.projectUnread("servers", "channel_1", false)).toBe(true)
  })

  it("rolls back one server field without clobbering a concurrent success", async () => {
    const view = await setup("server", [serverSetting(), serverSetting("server_2")]), held = deferred()
    holdWrites(held, view.registry)
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.command.mutateAsync({ serverId: "server_1", level: "Nothing" }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.settings.server.server_1).toBe("Nothing"))
    act(() => publishCommunityNotificationSetting(view.client, { serverId: "server_2", channelId: null }, "nothing", { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined }))
    await act(async () => { held.reject(new Error("first failed")); await request })
    await waitFor(() => expect(view.rendered.result.current.settings.server).toMatchObject({ server_1: "All Messages", server_2: "Nothing" }))
  })

  it("refreshes settings, inbox, and all read-state snapshots after a server change", async () => {
    const view = await setup()
    const keys = [communityKeys.inbox(), communityKeys.servers(), communityKeys.channelReadStateSnapshot("parent_1"), communityKeys.channelReadStateSnapshot("child_1"), communityKeys.dmReadStateSnapshot("dm_1")]
    for (const key of keys) view.client.setQueryData(key, { ids: [] })
    await act(async () => { await view.rendered.result.current.command.mutateAsync({ serverId: "server_1", level: "Nothing" }) })
    for (const key of keys) expect(view.client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it("refreshes every read-state snapshot after a parent channel change", async () => {
    const view = await setup("channel")
    const keys = [communityKeys.inbox(), communityKeys.servers(), communityKeys.channelReadStateSnapshot("parent_1"), communityKeys.channelReadStateSnapshot("child_1"), communityKeys.dmReadStateSnapshot("dm_1")]
    const unrelated = ["application", "unrelated"]
    for (const key of [...keys, unrelated]) view.client.setQueryData(key, { ids: [] })
    await act(async () => { await view.rendered.result.current.command.mutateAsync({ channelId: "parent_1", level: "Nothing" }) })
    for (const key of keys) expect(view.client.getQueryState(key)?.isInvalidated).toBe(true)
    expect(view.client.getQueryState(unrelated)?.isInvalidated).toBe(false)
  })

  it("PUTs and rolls back a new channel override", async () => {
    const view = await setup("channel"), held = deferred()
    holdWrites(held, view.registry)
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.command.mutateAsync({ channelId: "channel_1", level: "Nothing" }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.settings.channel).toMatchObject({ channel_1: "Nothing" }))
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/notifications/channel/channel_1", expect.objectContaining({ method: "PUT", body: JSON.stringify({ level: "nothing" }), authenticationAccount: "viewer", signal: expect.any(AbortSignal) }))
    await act(async () => { held.reject(new Error("failed")); await request })
    await waitFor(() => expect(view.rendered.result.current.settings.channel).toEqual({}))
  })

  it("DELETEs and restores an inherited channel override", async () => {
    const view = await setup("channel", [channelSetting()]), held = deferred()
    holdWrites(held, view.registry)
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.command.mutateAsync({ channelId: "channel_1", level: USE_SERVER_DEFAULT }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.settings.channel).toEqual({}))
    expect(apiFetch).toHaveBeenCalledWith("/api/community/users/me/notifications/channel/channel_1", expect.objectContaining({ method: "DELETE", authenticationAccount: "viewer", signal: expect.any(AbortSignal) }))
    await act(async () => { held.reject(new Error("failed")); await request })
    await waitFor(() => expect(view.rendered.result.current.settings.channel).toMatchObject({ channel_1: "Nothing" }))
  })

  it("does not let a failed channel override clobber a concurrent value", async () => {
    const view = await setup("channel"), held = deferred()
    holdWrites(held, view.registry)
    let request!: Promise<unknown>
    act(() => { request = view.rendered.result.current.command.mutateAsync({ channelId: "channel_1", level: "Nothing" }).catch((error) => error) })
    await waitFor(() => expect(view.rendered.result.current.settings.channel.channel_1).toBe("Nothing"))
    act(() => publishCommunityNotificationSetting(view.client, { serverId: null, channelId: "channel_1" }, "all", { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined }))
    await act(async () => { held.reject(new Error("failed")); await request })
    await waitFor(() => expect(view.rendered.result.current.settings.channel.channel_1).toBe("All Messages"))
  })
})

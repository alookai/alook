import { createElement, type PropsWithChildren } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@/test/react-dom-harness"
import { communityKeys } from "@/lib/query-keys"
import { createCommunityDbRegistry, type CommunityDbRegistry } from "@/lib/community-db/collections"
import { CommunityDbProvider } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, ingestServerDetail, publishCommunityForumSidebar } from "@/lib/community-db/sync"
import { getAccountUnreadProjection } from "./account-unread-projection"
import { getForumSidebarBase } from "./use-forum-sidebar-threads"
import { useAddThreadParticipant, useRemoveThreadParticipant } from "./use-thread-participants"

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }))
let client: QueryClient, registry: CommunityDbRegistry
beforeEach(async () => {
  apiFetchMock.mockReset().mockResolvedValue(undefined)
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  registry = createCommunityDbRegistry(client, "viewer_1")
  await registry.preload()
})
afterEach(async () => {
  await act(async () => {
    await client.cancelQueries(); await registry.cleanup(); client.clear()
  })
})
function Owner({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, createElement(CommunityDbProvider, { registry }, children))
}
function seedSidebar() {
  ingestServerDetail(registry, { id: "server_1", name: "Server", discriminator: "0001", description: "", icon: null, ownerId: "viewer_1", categories: [{ id: "category", name: "Channels", channels: [{ id: "forum_1", name: "Forum", type: "forum", active: false, unread: false }] }] })
  const key = communityKeys.forumSidebarThreads("server_1")
  client.setQueryData(key, { ids: ["post_1"], serverNow: "2026-08-08T00:00:00.000Z", serverClockOffsetMs: 0 })
  publishCommunityForumSidebar(client, {
    serverId: "server_1",
    channels: [{ id: "post_1", name: "Post", parentChannelId: "forum_1", parentMessageId: "opener_1", activityAt: "2026-08-08T00:00:00.000Z", unread: false, type: "thread", participating: true }],
    openers: [{ id: "opener_1", channelId: "forum_1", content: "Post", type: "chat" }],
    proof: { token: captureCommunityLiveSnapshotToken(client) },
  })
  return key
}
async function command<T>(run: () => Promise<T>) {
  let value!: T
  await act(async () => { value = await run() })
  return value
}
describe("useRemoveThreadParticipant", () => {
  it("removes the child from every sidebar view when the viewer leaves", async () => {
    seedSidebar()
    const metaKey = communityKeys.channelMeta("server_1", "post_1")
    client.setQueryData(metaKey, { id: "post_1", parentChannelId: "forum_1" })
    const projection = getAccountUnreadProjection(client, "viewer_1")
    projection.recordArrival({ channelId: "post_1", serverId: "server_1", seq: 7 })
    const rendered = renderHook(() => useRemoveThreadParticipant("post_1", "server_1", "viewer_1"), { wrapper: Owner })
    await command(() => rendered.result.current.mutateAsync("viewer_1"))
    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/post_1/participants/viewer_1", expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal), assertActive: expect.any(Function) }))
    expect(getForumSidebarBase(client, "server_1").threads).toHaveLength(0)
    expect(registry.collections.channelMemberships.get("post_1:viewer_1:access")).toBeDefined()
    expect(registry.collections.channelMemberships.get("post_1:viewer_1:notify")).toBeUndefined()
    expect(client.getQueryData(metaKey)).toEqual({ id: "post_1", parentChannelId: "forum_1" })
    expect(projection.projectUnread("inbox-unreads", "post_1", false, 7)).toBe(false)
  })

  it("does not retire viewer unread scope when participant removal fails", async () => {
    seedSidebar()
    const projection = getAccountUnreadProjection(client, "viewer_1")
    projection.recordArrival({ channelId: "post_1", serverId: "server_1", seq: 7 })
    apiFetchMock.mockRejectedValueOnce(new Error("failed"))
    const rendered = renderHook(() => useRemoveThreadParticipant("post_1", "server_1", "viewer_1"), { wrapper: Owner })
    await act(async () => { await expect(rendered.result.current.mutateAsync("viewer_1")).rejects.toThrow("failed") })
    expect(projection.projectUnread("inbox-unreads", "post_1", false, 7)).toBe(true)
    expect(getForumSidebarBase(client, "server_1").threads).toHaveLength(1)
    expect(registry.collections.channelMemberships.get("post_1:viewer_1:notify")).toBeDefined()
  })

  it("keeps the viewer's sidebar row when the creator removes someone else", async () => {
    seedSidebar()
    const projection = getAccountUnreadProjection(client, "viewer_1")
    projection.recordArrival({ channelId: "post_1", serverId: "server_1", seq: 7 })
    const rendered = renderHook(() => useRemoveThreadParticipant("post_1", "server_1", "viewer_1"), { wrapper: Owner })
    await command(() => rendered.result.current.mutateAsync("other_1"))
    expect(getForumSidebarBase(client, "server_1").threads).toHaveLength(1)
    expect(projection.projectUnread("inbox-unreads", "post_1", false, 7)).toBe(true)
  })

  it("does not revalidate the viewer's forum access when adding someone else", async () => {
    const key = seedSidebar()
    const rendered = renderHook(() => useAddThreadParticipant("post_1", "server_1", "viewer_1"), { wrapper: Owner })
    await command(() => rendered.result.current.mutateAsync("other_1"))
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    expect(getForumSidebarBase(client, "server_1").threads).toHaveLength(1)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(registry.collections.channelMemberships.get("post_1:other_1:notify")).toBeDefined()
  })

  it("contains a failed retained-authority fetch after the viewer is re-added", async () => {
    apiFetchMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline"))
    const rendered = renderHook(() => useAddThreadParticipant("post_1", "server_1", "viewer_1"), { wrapper: Owner })
    await act(async () => { await expect(rendered.result.current.mutateAsync("viewer_1")).rejects.toThrow("offline") })
    expect(apiFetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/community/servers/server_1/channels?"), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(client.getQueryState(communityKeys.forumSidebarRetained("server_1", "post_1"))?.status).toBe("error")
    expect(getForumSidebarBase(client, "server_1").threads).toHaveLength(0)
  })

  it("does not touch forum sidebar resources for an ordinary text thread", async () => {
    const baseKey = seedSidebar(), retainedKey = communityKeys.forumSidebarRetained("server_1", "forum_post")
    const metaKey = communityKeys.channelMeta("server_1", "text_thread"), hintKey = communityKeys.forumOpenerHint("server_1", "opener_1")
    client.setQueryData(retainedKey, { id: "forum_post" })
    client.setQueryData(metaKey, { id: "text_thread", parentChannelId: "text_parent" })
    client.setQueryData(hintKey, { id: "opener_1" })
    const before = [baseKey, retainedKey, metaKey, hintKey].map((key) => client.getQueryData(key))
    const rendered = renderHook(() => ({ add: useAddThreadParticipant("text_thread", undefined, "viewer_1"), remove: useRemoveThreadParticipant("text_thread", "server_1", "viewer_1", false) }), { wrapper: Owner })
    await command(() => rendered.result.current.add.mutateAsync("viewer_1"))
    await command(() => rendered.result.current.remove.mutateAsync("viewer_1"))
    for (const [index, key] of [baseKey, retainedKey, metaKey, hintKey].entries()) expect(client.getQueryData(key)).toBe(before[index])
    expect(client.getQueryState(baseKey)?.isInvalidated).toBe(false)
    expect(getForumSidebarBase(client, "server_1").threads).toHaveLength(1)
  })
})

import { createElement, useLayoutEffect, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { skipToken, useQuery, type InfiniteData } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { getMessageOverlay } from "@/stores/community/message-stream"
import { useCanonicalChannelsById, useCanonicalMessagesById, useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import { captureCommunityLiveSnapshotToken, projectCommunityWsEventToDb, publishCommunityForumSidebar, publishCommunityForumFeed, publishCommunityForumTags, getCanonicalCommunityChannelMemberships, removeCanonicalCommunityChannelMembership } from "@/lib/community-db/sync"
import { mapForumFeedPages } from "../use-forum-feed"
import { forumFeedWindow, forumFeedMatchesTags, type ForumFeedPage, type ForumFeedTransportPage } from "../forum-feed-window"
import { getForumSidebarBase } from "../use-forum-sidebar-threads"
import { getActiveAccountUnreadProjection } from "../account-unread-projection"
import { applyForumPostUnitClientEffects } from "../community-ws/channel-scope-projection"
import { useCreateForumThread, useUpdatePostTags, useDeleteForumThread } from "./forum"

const mocks = vi.hoisted(() => ({ api: vi.fn(), clearLastChannel: vi.fn() }))
vi.mock("@/lib/api/client", () => ({ apiFetch: mocks.api, toastApiError: vi.fn() }))
vi.mock("@/lib/community/last-channel", () => ({ clearLastChannel: mocks.clearLastChannel, getLastChannel: () => null }))
beforeEach(() => { mocks.api.mockReset(); mocks.clearLastChannel.mockReset() })

function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: Error) => void
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
function wire(ids: string[]): ForumFeedTransportPage {
  return {
    serverId: "server_1", parentType: "forum", hasMore: false,
    threads: ids.map((id, index) => ({ id, name: id, creatorId: `author_${id}`, messageCount: 1, parentMessageId: `opener_${id}`, createdAt: new Date(Date.now() - index * 1000).toISOString(), lastMessageAt: new Date().toISOString(), activityAt: new Date().toISOString() })),
    included: {
      parentMessages: ids.map((id, index) => ({ id: `opener_${id}`, channelId: "forum_1", seq: index + 1, content: id, authorId: `author_${id}`, authorName: id, authorImage: null, authorAvatarVersion: 0 })),
      firstMessages: ids.map((id) => ({ channelId: id, content: `body ${id}` })),
      tags: ids.map((id) => ({ messageId: `opener_${id}`, tag: "bug" })),
      participants: [],
    },
  }
}
const tagInput = { serverId: "server_1", forumChannelId: "forum_1", threadId: "p2", openerMessageId: "opener_p2", previousTags: ["bug"], tags: ["bug", "archived"] }
const deleteInput = { serverId: "server_1", forumChannelId: "forum_1", threadId: "p2", openerMessageId: "opener_p2" }
async function setup(ids = ["before", "p2", "after"]) {
  const owner = await createCommunityQueryOwner(), navigate = vi.fn()
  const frames: Array<{ pending: boolean; all: string[]; archived: string[] }> = []
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const view = renderHook(() => {
    const create = useCreateForumThread(), tags = useUpdatePostTags(), remove = useDeleteForumThread()
    const channels = useCanonicalChannelsById(), messages = useCanonicalMessagesById(), profiles = useCanonicalProfilesByUserId()
    const all = useQuery<InfiniteData<ForumFeedPage>>({ queryKey: communityKeys.forumFeed("forum_1", null), queryFn: skipToken, enabled: false }).data
    const bug = useQuery<InfiniteData<ForumFeedPage>>({ queryKey: communityKeys.forumFeed("forum_1", "bug"), queryFn: skipToken, enabled: false }).data
    const archived = useQuery<InfiniteData<ForumFeedPage>>({ queryKey: communityKeys.forumFeed("forum_1", "archived"), queryFn: skipToken, enabled: false }).data
    const windows = new Map<string | null, InfiniteData<ForumFeedPage> | undefined>([[null, all], ["bug", bug], ["archived", archived]])
    const posts = (filter: string | null) => mapForumFeedPages(windows.get(filter)?.pages ?? [], messages ?? new Map(), channels, profiles, filter)
    const result = { create, tags, remove, channels, messages, all: posts(null), bug: posts("bug"), archived: posts("archived") }
    useLayoutEffect(() => { frames.push({ pending: tags.isPending, all: result.all.map(({ id }) => id), archived: result.archived.map(({ id }) => id) }) })
    return result
  }, { wrapper })
  function seed(rows: string[], append = false) {
    const page = wire(rows), token = captureCommunityLiveSnapshotToken(owner.client)
    publishCommunityForumSidebar(owner.client, { serverId: "server_1", channels: page.threads.map((row) => ({ ...row, name: row.name!, unread: false, parentChannelId: "forum_1", type: "thread", archived: false })), openers: page.included.parentMessages, proof: { token, signal: undefined } })
    publishCommunityForumFeed(owner.client, "forum_1", page, { token: captureCommunityLiveSnapshotToken(owner.client), signal: undefined })
    for (const filter of [null, "bug", "archived"]) owner.client.setQueryData<InfiniteData<ForumFeedPage>>(communityKeys.forumFeed("forum_1", filter), (current) => ({ pages: append && current ? [{ ...current.pages[0], threads: [...current.pages[0].threads, ...forumFeedWindow(page).threads] }] : [forumFeedWindow(page)], pageParams: [null] }))
  }
  act(() => {
    projectCommunityWsEventToDb(owner.client, { type: "community:channel.create", serverId: "server_1", channel: { id: "forum_1", name: "Forum", type: "forum", categoryId: null, position: 0, createdAt: new Date().toISOString() } })
    seed(ids)
    owner.client.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [{ messages: ids.map((id) => ({ id: `opener_${id}` })) }], pageParams: [null] })
    owner.client.setQueryData([...communityKeys.channelMessages("forum_1"), "tag", "bug"], { pages: [], pageParams: [null] })
    owner.client.setQueryData(communityKeys.forumTags("forum_1"), { tags: ["bug"] })
    owner.client.setQueryData(communityKeys.forumSidebarThreads("server_1"), { serverNow: new Date().toISOString(), serverClockOffsetMs: 0, threads: [] })
  })
  await waitFor(() => expect(view.result.current.all).toHaveLength(ids.length))
  const memberships = () => getCanonicalCommunityChannelMemberships(owner.client).filter((row) => row.channelId === "p2").map((row) => row.relation).sort()
  return { ...owner, view, seed, memberships, navigate, frames }
}
type View = Awaited<ReturnType<typeof setup>>
async function begin(view: View, command: "tags" | "remove", input = command === "tags" ? tagInput : deleteInput) {
  const held = deferred(); mocks.api.mockReturnValueOnce(held.promise)
  let request!: Promise<unknown>
  act(() => { request = command === "tags" ? view.view.result.current.tags.mutateAsync(input as typeof tagInput).catch((error) => error) : view.view.result.current.remove.mutateAsync(input).catch((error) => error) })
  await waitFor(() => expect(mocks.api.mock.calls.some(([, options]) => options?.method === (command === "tags" ? "PUT" : "DELETE"))).toBe(true))
  return { held, request }
}

describe("Native forum creation", () => {
  it("POSTs opener and reply with exact nonce suffixes and optional fields omitted", async () => {
    const view = await setup()
    mocks.api.mockResolvedValueOnce({ threadId: "p_new" }).mockResolvedValueOnce({})
    await act(async () => { await view.view.result.current.create.mutateAsync({ nonce: "command_1", channelId: "forum_1", name: "hi", content: "body" }) })
    expect(mocks.api).toHaveBeenCalledTimes(2)
    expect(mocks.api.mock.calls[0][0]).toBe("/api/community/channels/forum_1/messages")
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({ content: "hi", nonce: "command_1:opener" })
    expect(mocks.api.mock.calls[1][0]).toBe("/api/community/channels/p_new/messages")
    expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toEqual({ content: "body", nonce: "command_1:reply" })
  })
  it("reserves attachment IDs for both messages and broadcasts mentionType on the opener", async () => {
    const view = await setup(), attachments = [{ id: "att_1", filename: "abc.png", contentType: "image/png", size: 100, width: 10, height: 10 }]
    mocks.api.mockResolvedValueOnce({ threadId: "p_new" }).mockResolvedValueOnce({})
    await act(async () => { await view.view.result.current.create.mutateAsync({ nonce: "command_1", channelId: "forum_1", name: "heads up", content: "Heads up @everyone", attachments, mentionType: "everyone" }) })
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({ content: "heads up", attachments: ["att_1"], mentionType: "everyone", nonce: "command_1:opener" })
    expect(JSON.parse(mocks.api.mock.calls[1][1].body).attachments).toEqual(["att_1"])
  })
  it("invalidates the original composed forum list on success", async () => {
    const view = await setup()
    mocks.api.mockResolvedValueOnce({ threadId: "p_new" }).mockResolvedValueOnce({})
    await act(async () => { await view.view.result.current.create.mutateAsync({ nonce: "command_1", channelId: "forum_1", name: "n", content: "c" }) })
    expect(view.client.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(view.client.getQueryState(communityKeys.forumFeed("forum_1", null))?.isInvalidated).toBe(true)
  })
})

describe("Native forum tag transactions", () => {
  it("does not publish an old opener ACK onto a reused child identity", async () => {
    const view = await setup(["p2"]), { held, request } = await begin(view, "tags", { ...tagInput, openerMessageId: "retired_opener" })
    expect(view.registry.collections.channels.get("p2")).toMatchObject({ parentMessageId: "opener_p2", tags: ["bug"] })
    await act(async () => { held.resolve({ tags: ["bug", "archived"] }); await request })
    await waitFor(() => expect(view.registry.collections.channels.get("p2")).toMatchObject({ parentMessageId: "opener_p2", tags: ["bug"], archived: false }))
    expect(view.memberships()).toContain("notify")
  })
  it("PUTs normalized tags and invalidates every original message/feed variant and tag list", async () => {
    const view = await setup(); mocks.api.mockResolvedValueOnce({ tags: ["bug", "p0"] })
    await act(async () => { await view.view.result.current.tags.mutateAsync({ ...tagInput, tags: [" Bug ", "P0", "bug"] }) })
    expect(mocks.api).toHaveBeenCalledWith("/api/community/messages/opener_p2/tags", expect.objectContaining({ method: "PUT", body: JSON.stringify({ tags: ["bug", "p0"] }), authenticationAccount: "viewer", signal: expect.any(AbortSignal) }))
    for (const key of [communityKeys.channelMessages("forum_1"), [...communityKeys.channelMessages("forum_1"), "tag", "bug"], communityKeys.forumFeed("forum_1", null), communityKeys.forumFeed("forum_1", "bug"), communityKeys.forumTags("forum_1")]) expect(view.client.getQueryState(key)?.isInvalidated).toBe(true)
  })
  it("hides the exact canonical post before archive PUT settles and retains siblings", async () => {
    const view = await setup(), { held, request } = await begin(view, "tags")
    await waitFor(() => expect(view.view.result.current.all.map(({ id }) => id)).toEqual(["before", "after"]))
    expect(view.view.result.current.archived.map(({ id }) => id)).toEqual(["p2"])
    await act(async () => { held.resolve({ tags: ["bug", "archived"] }); await request })
    expect(view.view.result.current.all.map(({ id }) => id)).toEqual(["before", "after"])
  })
  it("restores only the failed canonical slice while preserving updated and inserted siblings", async () => {
    const view = await setup(), { held, request } = await begin(view, "tags")
    act(() => {
      publishCommunityForumTags(view.client, "before", ["updated"], { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined })
      view.seed(["concurrent"], true)
    })
    await act(async () => { held.reject(new Error("403")); await request })
    await waitFor(() => expect(new Set(view.view.result.current.all.map(({ id }) => id))).toEqual(new Set(["before", "p2", "after", "concurrent"])))
    expect(view.view.result.current.channels.get("before")?.tags).toEqual(["updated"])
    expect(view.view.result.current.channels.get("p2")?.tags).toEqual(["bug"])
  })
  it("keeps a newer confirmed archive through older failure and a concurrent unarchive rollback", async () => {
    const view = await setup(["p2"]), { held, request } = await begin(view, "tags"), newer = deferred()
    act(() => publishCommunityForumTags(view.client, "p2", ["bug", "archived"], { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined }))
    mocks.api.mockReturnValueOnce(newer.promise)
    let newerRequest!: Promise<unknown>
    act(() => { newerRequest = view.view.result.current.tags.mutateAsync({ ...tagInput, previousTags: ["bug", "archived"], tags: ["bug"] }).catch((error) => error) })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2))
    await act(async () => { held.reject(new Error("older failed")); await request })
    await waitFor(() => { expect(mocks.api).toHaveBeenCalledTimes(2); expect(view.view.result.current.archived).toEqual([]); expect(view.view.result.current.all.map(({ id }) => id)).toEqual(["p2"]) })
    await act(async () => { newer.reject(new Error("newer failed")); await newerRequest })
    await waitFor(() => { expect(view.view.result.current.archived.map(({ id }) => id)).toEqual(["p2"]); expect(view.view.result.current.all).toEqual([]) })
  })
  it("removes notify membership after archive success while retaining access", async () => {
    const view = await setup(); mocks.api.mockResolvedValueOnce({ tags: ["bug", "archived"] })
    await act(async () => { await view.view.result.current.tags.mutateAsync(tagInput) })
    expect(getForumSidebarBase(view.client, "server_1").threads.map(({ id }) => id).sort()).toEqual(["after", "before"])
    expect(view.memberships()).toEqual(["access"])
    expect(view.registry.collections.channels.get("p2")?.archived).toBe(false)
  })
  it("restores notify on unarchive and derives ranking from current canonical activity", async () => {
    const view = await setup()
    act(() => { publishCommunityForumTags(view.client, "p2", ["bug", "archived"], { token: captureCommunityLiveSnapshotToken(view.client), signal: undefined }); removeCanonicalCommunityChannelMembership(view.client, "p2", "notify") })
    mocks.api.mockResolvedValueOnce({ tags: ["bug"] })
    await act(async () => { await view.view.result.current.tags.mutateAsync({ ...tagInput, previousTags: ["bug", "archived"], tags: ["bug"] }) })
    expect(getForumSidebarBase(view.client, "server_1").threads.map(({ id }) => id).sort()).toEqual(["after", "before", "p2"])
    expect(view.memberships()).toEqual(["access", "notify"])
  })
  it("uses normalized returned tags and leaves sidebar neutral without an authoritative transition", async () => {
    const view = await setup(), before = getForumSidebarBase(view.client, "server_1"), memberships = view.memberships()
    mocks.api.mockResolvedValueOnce({ tags: [" BUG "] })
    let result!: unknown
    await act(async () => { result = await view.view.result.current.tags.mutateAsync({ ...tagInput, tags: ["archived"] }) })
    expect(result).toEqual({ tags: ["bug"] })
    expect(getForumSidebarBase(view.client, "server_1")).toEqual(before)
    expect(view.memberships()).toEqual(memberships)
    expect(view.client.getQueryState(communityKeys.forumSidebarThreads("server_1"))?.isInvalidated).toBe(false)
  })
  it("leaves original message windows, tag list and sidebar intact when PUT fails", async () => {
    const view = await setup(), keys = [communityKeys.channelMessages("forum_1"), communityKeys.forumFeed("forum_1", null), communityKeys.forumTags("forum_1"), communityKeys.forumSidebarThreads("server_1")]
    const before = keys.map((key) => view.client.getQueryData(key)), sidebar = getForumSidebarBase(view.client, "server_1")
    mocks.api.mockRejectedValueOnce(new Error("500"))
    await act(async () => { await view.view.result.current.tags.mutateAsync({ ...tagInput, tags: [] }).catch(() => undefined) })
    keys.forEach((key, index) => { expect(view.client.getQueryData(key)).toEqual(before[index]); expect(view.client.getQueryState(key)?.isInvalidated).toBe(false) })
    expect(getForumSidebarBase(view.client, "server_1")).toEqual(sidebar)
  })
})

describe("Native forum post deletion", () => {
  it("clears local stream, unread and active route once without requiring a self WS frame", async () => {
    const view = await setup(), projection = getActiveAccountUnreadProjection(view.client)
    act(() => {
      projection.recordArrival({ channelId: "p2", serverId: "server_1", seq: 1 })
      view.runtime.ui.actions.setCurrentServerId("server_1"); view.runtime.ui.actions.setCurrentChannelId("p2")
      view.runtime.ui.actions.registerUiHandlers({ replacePath: view.navigate })
      const message = { id: "opener_p2", seq: 1, type: "chat" as const, authorId: "u1", authorName: "Alice", content: "Post" }
      view.runtime.messageStream.actions.dispatch({ kind: "channel", id: "forum_1", serverId: "server_1" }, { type: "wsMessage", message })
      view.runtime.messageStream.actions.dispatch({ kind: "channel", id: "p2", serverId: "server_1" }, { type: "wsMessage", message: { ...message, id: "reply_1" } })
    })
    const { held, request } = await begin(view, "remove")
    await act(async () => { held.resolve(); await request })
    expect(view.runtime.messageStream.get().entries.has("channel:p2")).toBe(false)
    expect(getMessageOverlay(view.client, { kind: "channel", id: "forum_1", serverId: "server_1" }).liveById.has("opener_p2")).toBe(false)
    expect(view.runtime.ui.get()).toMatchObject({ currentChannelId: "forum_1" })
    expect(view.registry.collections.channels.has("p2")).toBe(false)
    expect(mocks.clearLastChannel).toHaveBeenCalledOnce()
    expect(view.navigate).toHaveBeenCalledOnce()
    expect(view.navigate).toHaveBeenCalledWith("/c/channels/server_1/forum_1")
    expect(projection.projectUnread("servers", "p2", false)).toBe(false)
    expect(projection.projectUnread("inbox-unreads", "p2", true, 1)).toBe(false)
    act(() => applyForumPostUnitClientEffects(view.client, { serverId: "server_1", forumChannelId: "forum_1", childChannelId: "p2", openerMessageId: "opener_p2" }))
    expect(mocks.clearLastChannel).toHaveBeenCalledOnce(); expect(view.navigate).toHaveBeenCalledOnce()
  })
  it("optimistically hides both canonical post identities and DELETEs the exact opener", async () => {
    const view = await setup(), { held, request } = await begin(view, "remove")
    await waitFor(() => { expect(view.view.result.current.all.map(({ id }) => id)).toEqual(["before", "after"]); expect(view.view.result.current.messages?.has("opener_p2")).toBe(false) })
    await act(async () => { held.resolve(); await request })
    expect(mocks.api).toHaveBeenCalledWith("/api/community/messages/opener_p2", expect.objectContaining({ method: "DELETE", authenticationAccount: "viewer", signal: expect.any(AbortSignal) }))
    expect(view.view.result.current.channels.has("p2")).toBe(false)
    expect(getForumSidebarBase(view.client, "server_1").threads.some(({ id }) => id === "p2")).toBe(false)
    expect(view.client.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(view.client.getQueryState(communityKeys.forumFeed("forum_1", null))?.isInvalidated).toBe(true)
  })
  it("restores canonical post/sidebar and exact original ID windows on DELETE failure", async () => {
    const view = await setup(), projection = getActiveAccountUnreadProjection(view.client)
    projection.recordArrival({ channelId: "p2", serverId: "server_1", seq: 1 })
    view.client.setQueryData(communityKeys.channelMeta("server_1", "p2"), { id: "p2" })
    const keys = [communityKeys.channelMessages("forum_1"), communityKeys.forumFeed("forum_1", null), communityKeys.forumSidebarThreads("server_1"), communityKeys.channelMeta("server_1", "p2")], before = keys.map((key) => view.client.getQueryData(key)), sidebar = getForumSidebarBase(view.client, "server_1")
    const { held, request } = await begin(view, "remove")
    await waitFor(() => expect(view.view.result.current.channels.has("p2")).toBe(false))
    await act(async () => { held.reject(new Error("500")); await request })
    await waitFor(() => expect(view.view.result.current.all.map(({ id }) => id)).toEqual(["before", "p2", "after"]))
    keys.forEach((key, index) => expect(view.client.getQueryData(key)).toEqual(before[index]))
    expect(getForumSidebarBase(view.client, "server_1")).toEqual(sidebar)
    expect(projection.projectUnread("servers", "p2", false)).toBe(true)
    expect(projection.projectUnread("inbox-unreads", "p2", true, 1)).toBe(true)
  })
})

describe("Native forum partition and transaction controls", () => {
  const ids = (view: View, filter: "all" | "bug" | "archived" = "all") => view.view.result.current[filter].map(({ id }) => id)
  function window(view: View, filter: string | null, pages: string[][], pageParams: (string | null)[] = pages.map((_, index) => index ? `cursor_${index}` : null)) {
    act(() => view.client.setQueryData(communityKeys.forumFeed("forum_1", filter), { pages: pages.map((rows) => forumFeedWindow(wire(rows))), pageParams }))
  }
  function wsTags(view: View, tags: string[], id = "p2") {
    act(() => projectCommunityWsEventToDb(view.client, { type: "community:channel.update", serverId: "server_1", channelId: id, changes: { tags } }))
  }
  async function second(view: View, input = { ...tagInput, tags: ["help"] }) {
    const held = deferred(), count = mocks.api.mock.calls.length
    mocks.api.mockReturnValueOnce(held.promise)
    let request!: Promise<unknown>
    act(() => { request = view.view.result.current.tags.mutateAsync(input).catch((error) => error) })
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(count + 1))
    return { held, request }
  }
  it("matches the authoritative All, ordinary, and Archived partitions", () => {
    for (const [filter, tags, matches] of [[null, ["bug"], true], ["bug", ["bug"], true], ["help", ["bug"], false], [null, ["bug", "archived"], false], ["bug", ["bug", "archived"], false], ["archived", ["bug", "archived"], true]] as const) {
      expect(forumFeedMatchesTags(filter, tags)).toBe(matches)
    }
  })
  it("removes Archive and Unarchive source rows without inserting a destination rank", async () => {
    const view = await setup(["p2"])
    window(view, "archived", [[]])
    const first = await begin(view, "tags")
    await waitFor(() => expect(ids(view)).toEqual([]))
    expect(ids(view, "archived")).toEqual([])
    await act(async () => { first.held.resolve({ tags: ["bug", "archived"] }); await first.request })
    window(view, null, [[]]); window(view, "archived", [["p2"]])
    await waitFor(() => expect(ids(view, "archived")).toEqual(["p2"]))
    const next = await second(view, { ...tagInput, previousTags: ["bug", "archived"], tags: ["bug"] })
    await waitFor(() => expect(ids(view, "archived")).toEqual([]))
    await act(async () => { next.held.resolve({ tags: ["bug"] }); await next.request })
    expect(ids(view)).toEqual([])
  })
  it("patches authoritative tags on an already warm destination row", async () => {
    const view = await setup(["p2"]), pending = await begin(view, "tags")
    await waitFor(() => expect(ids(view, "archived")).toEqual(["p2"]))
    await act(async () => { pending.held.resolve({ tags: ["archived", "p0"] }); await pending.request })
    expect(view.registry.collections.channels.get("p2")?.tags).toEqual(["archived", "p0"])
    expect(ids(view, "archived")).toEqual(["p2"])
  })
  it("merges only the rolled-back canonical slice and preserves concurrent siblings", async () => {
    const view = await setup(), pending = await begin(view, "tags")
    act(() => view.seed(["concurrent"], true))
    wsTags(view, ["help"], "before")
    await act(async () => { pending.held.reject(new Error("denied")); await pending.request })
    await waitFor(() => expect(ids(view)).toEqual(["concurrent", "before", "p2", "after"]))
    expect(view.registry.collections.channels.get("before")?.tags).toEqual(["help"])
  })
  it("prevents an older command from rolling back a newer exact intent", async () => {
    const view = await setup(["p2"]), first = await begin(view, "tags"), next = await second(view)
    await waitFor(() => expect(view.registry.collections.channels.get("p2")?.tags).toEqual(["help"]))
    await act(async () => { first.held.reject(new Error("old failure")); await first.request })
    expect(view.registry.collections.channels.get("p2")?.tags).toEqual(["help"])
    await act(async () => { next.held.resolve({ tags: ["help"] }); await next.request })
    expect(ids(view)).toEqual(["p2"])
  })
  it("carries the original canonical rollback through a repeated programmatic intent", async () => {
    const view = await setup(["p2"]), first = await begin(view, "tags"), next = await second(view)
    await act(async () => { first.held.reject(new Error("old failure")); await first.request })
    await act(async () => { next.held.reject(new Error("new failure")); await next.request })
    await waitFor(() => expect(view.registry.collections.channels.get("p2")?.tags).toEqual(["bug"]))
    expect(ids(view, "bug")).toEqual(["p2"])
  })
  it("retains an authoritative non-archive response in its moved cursor page", async () => {
    const view = await setup(), pending = await begin(view, "tags")
    window(view, null, [["before"], ["p2", "after"]], [null, "moved_cursor"])
    await act(async () => { pending.held.resolve({ tags: ["bug"] }); await pending.request })
    await waitFor(() => expect(ids(view)).toEqual(["before", "p2", "after"]))
    expect(view.client.getQueryData<InfiniteData<ForumFeedPage>>(communityKeys.forumFeed("forum_1", null))?.pageParams).toEqual([null, "moved_cursor"])
  })
  it("leaves non-partition cache data intact and never restores a replaced cursor window", async () => {
    const view = await setup(["p2"]), other = { value: "outside partition" }
    view.client.setQueryData(communityKeys.forumFeeds("forum_1"), other)
    const pending = await begin(view, "tags")
    window(view, null, [[]], ["replacement_cursor"])
    await act(async () => { pending.held.reject(new Error("denied")); await pending.request })
    await waitFor(() => expect(ids(view)).toEqual([]))
    expect(view.client.getQueryData(communityKeys.forumFeeds("forum_1"))).toBe(other)
    expect(view.client.getQueryData<InfiniteData<ForumFeedPage>>(communityKeys.forumFeed("forum_1", null))?.pageParams).toEqual(["replacement_cursor"])
  })
  it("ignores an older success while a newer exact command is active", async () => {
    const view = await setup(["p2"]), first = await begin(view, "tags"), next = await second(view, { ...tagInput, tags: ["bug"] })
    await act(async () => { first.held.resolve({ tags: ["bug", "archived"] }); await first.request })
    expect(view.registry.collections.channels.get("p2")?.tags).toEqual(["bug"])
    expect(ids(view, "archived")).toEqual([])
    await act(async () => { next.held.resolve({ tags: ["bug"] }); await next.request })
    expect(ids(view)).toEqual(["p2"])
  })
  it("settles different posts independently", async () => {
    const view = await setup(["p2", "other"]), first = await begin(view, "tags")
    const next = await second(view, { ...tagInput, threadId: "other", openerMessageId: "opener_other" })
    await waitFor(() => expect(ids(view)).toEqual([]))
    await act(async () => { first.held.reject(new Error("first denied")); await first.request })
    expect(ids(view)).toEqual(["p2"])
    await act(async () => { next.held.resolve({ tags: ["bug", "archived"] }); await next.request })
    expect(ids(view)).toEqual(["p2"])
  })
  it("requires the canonical opener and never hides a reused child identity", async () => {
    const view = await setup(["p2"]), pending = await begin(view, "tags", { ...tagInput, openerMessageId: "retired_opener" })
    expect(ids(view)).toEqual(["p2"])
    await act(async () => { pending.held.resolve({ tags: ["archived"] }); await pending.request })
    expect(ids(view)).toEqual(["p2"])
    expect(view.registry.collections.channels.get("p2")?.parentMessageId).toBe("opener_p2")
  })
  it("projects WS membership only through the canonical opener identity", async () => {
    const view = await setup(["p2"])
    const invalid = forumFeedWindow(wire(["p2"]))
    invalid.threads[0].openerMessageId = "retired_opener"
    act(() => view.client.setQueryData(communityKeys.forumFeed("forum_1", "bug"), { pages: [invalid], pageParams: [null] }))
    await waitFor(() => expect(ids(view, "bug")).toEqual([]))
    wsTags(view, ["archived"])
    await waitFor(() => expect(ids(view)).toEqual([]))
    expect(ids(view, "archived")).toEqual(["p2"])
  })
  it("does not manufacture opener evidence for a malformed transport window", async () => {
    const view = await setup(["p2"]), invalid = forumFeedWindow(wire(["p2"]))
    invalid.threads[0].openerMessageId = null
    act(() => view.client.setQueryData(communityKeys.forumFeed("forum_1", null), { pages: [invalid], pageParams: ["invalid_cursor"] }))
    await waitFor(() => expect(ids(view)).toEqual([]))
    wsTags(view, ["archived"])
    expect(view.client.getQueryData<InfiniteData<ForumFeedPage>>(communityKeys.forumFeed("forum_1", null))?.pages[0].threads[0].openerMessageId).toBeNull()
  })
  it("keeps a local optimistic intent dominant over an intervening WS frame", async () => {
    const view = await setup(["p2"]), pending = await begin(view, "tags")
    wsTags(view, ["help"])
    expect(ids(view)).toEqual([])
    await act(async () => { pending.held.reject(new Error("denied")); await pending.request })
    await waitFor(() => expect(view.registry.collections.channels.get("p2")?.tags).toEqual(["help"]))
    expect(ids(view)).toEqual(["p2"])
  })
  it("removes a WS Unarchive from Archived without inventing an All rank", async () => {
    const view = await setup(["p2"])
    wsTags(view, ["bug", "archived"]); window(view, null, [[]])
    await waitFor(() => expect(ids(view, "archived")).toEqual(["p2"]))
    wsTags(view, ["bug"])
    await waitFor(() => expect(ids(view, "archived")).toEqual([]))
    expect(ids(view)).toEqual([])
  })
  it("keeps every success notification frame removed through native transaction settlement", async () => {
    const view = await setup(["p2"]), pending = await begin(view, "tags")
    await waitFor(() => expect(ids(view)).toEqual([]))
    const removed = view.frames.findIndex((frame) => frame.pending && frame.all.length === 0)
    await act(async () => { pending.held.resolve({ tags: ["bug", "archived"] }); await pending.request })
    await waitFor(() => expect(view.view.result.current.tags.isPending).toBe(false))
    expect(removed).toBeGreaterThanOrEqual(0)
    expect(view.frames.slice(removed).every((frame) => !frame.all.includes("p2"))).toBe(true)
  })
  it("publishes rollback membership with the native terminal failure frame", async () => {
    const view = await setup(["p2"]), pending = await begin(view, "tags")
    await waitFor(() => expect(ids(view)).toEqual([]))
    const index = view.frames.length
    await act(async () => { pending.held.reject(new Error("denied")); await pending.request })
    await waitFor(() => expect(view.view.result.current.tags.isPending).toBe(false))
    const terminal = view.frames.slice(index).filter((frame) => !frame.pending)
    expect(terminal.length).toBeGreaterThan(0)
    expect(terminal.every((frame) => frame.all.includes("p2"))).toBe(true)
  })
})

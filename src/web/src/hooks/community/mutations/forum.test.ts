/**
 * Forum-mutation tests. Same shim pattern as channels.test.ts — the
 * `useMutation` config is captured and driven through React Query's lifecycle
 * order so we can assert the cache patches without a real query client loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

const { clearLastChannelMock } = vi.hoisted(() => ({
  clearLastChannelMock: vi.fn(),
}))
vi.mock("@/lib/community/last-channel", () => ({
  clearLastChannel: (...args: unknown[]) => clearLastChannelMock(...args),
}))

vi.mock("react", () => ({
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useEffect: () => {},
  useState: (initial: unknown) => [initial, () => {}],
}))

const apiFetchMock = vi.fn()
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

type MutConfig<Args> = {
  mutationFn?: (args: Args) => unknown
  onMutate?: (args: Args) => unknown
  onSuccess?: (data: unknown, args: Args, context?: unknown) => unknown
  onError?: (err: unknown, args: Args, context?: unknown) => unknown
  onSettled?: (data: unknown, err: unknown, args: Args, context?: unknown) => unknown
}
let capturedConfig: MutConfig<unknown> | null = null
let capturedQc: QueryClient
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query")
  return {
    ...actual,
    useQueryClient: () => capturedQc,
    useMutation: (config: MutConfig<unknown>) => {
      capturedConfig = config
      return {}
    },
  }
})

async function runMutation<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args>
  const context = cfg.onMutate ? await cfg.onMutate(args) : undefined
  const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
  cfg.onSuccess?.(data, args, context)
  cfg.onSettled?.(data, null, args, context)
  return data
}

async function runMutationExpectError<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args>
  const context = cfg.onMutate ? await cfg.onMutate(args) : undefined
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    cfg.onSuccess?.(data, args, context)
    cfg.onSettled?.(data, null, args, context)
    throw new Error("expected mutationFn to reject")
  } catch (err) {
    cfg.onError?.(err, args, context)
    cfg.onSettled?.(undefined, err, args, context)
    return err
  }
}

async function load() {
  vi.resetModules()
  return await import("./forum")
}

beforeEach(() => {
  apiFetchMock.mockReset()
  capturedConfig = null
  capturedQc = new QueryClient()
  clearLastChannelMock.mockClear()
})

describe("useCreateForumThread", () => {
  it("POSTs JSON with name + content only when no attachments/mentionType are provided", async () => {
    const { useCreateForumThread } = await load()
    useCreateForumThread()
    apiFetchMock.mockResolvedValueOnce({ threadId: "p_new" })

    await runMutation({ nonce: "command_1", channelId: "forum_1", name: "hi", content: "body" })

    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    const [path, init] = apiFetchMock.mock.calls[0]
    expect(path).toBe("/api/community/channels/forum_1/messages")
    expect((init as { method?: string }).method).toBe("POST")
    const body = JSON.parse((init as { body: string }).body)
    expect(body.content).toBe("hi")
    expect(body.nonce).toBe("command_1:opener")
    expect(body.attachments).toBeUndefined()
    expect(body.mentionType).toBeUndefined()
    const [replyPath, replyInit] = apiFetchMock.mock.calls[1]
    expect(replyPath).toBe("/api/community/channels/p_new/messages")
    const replyBody = JSON.parse((replyInit as { body: string }).body)
    expect(replyBody.content).toBe("body")
    expect(replyBody.nonce).toBe("command_1:reply")
  })

  it("threads attachment IDS + mentionType through to the request body (reserve-by-id)", async () => {
    const { useCreateForumThread } = await load()
    useCreateForumThread()
    apiFetchMock.mockResolvedValueOnce({ threadId: "p_new" })

    // Reserve-by-id: the client holds full upload descriptors but sends only
    // the pending-row ids; dimensions already rode the upload (single source).
    const attachments = [{
      id: "att_1",
      filename: "abc.png",
      contentType: "image/png",
      size: 100,
      width: 10,
      height: 10,
    }]
    await runMutation({
      nonce: "command_1",
      channelId: "forum_1",
      name: "heads up",
      content: "Heads up @everyone",
      attachments,
      mentionType: "everyone",
    })

    const [, init] = apiFetchMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body)
    expect(body.attachments).toEqual(["att_1"])
    expect(body.mentionType).toBe("everyone")
    const [, replyInit] = apiFetchMock.mock.calls[1]
    const replyBody = JSON.parse((replyInit as { body: string }).body)
    expect(replyBody.attachments).toEqual(["att_1"])
  })

  it("invalidates the composed forum list on success", async () => {
    const { useCreateForumThread } = await load()
    useCreateForumThread()
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [], pageParams: [] })
    capturedQc.setQueryData(communityKeys.forumFeed("forum_1", null), { pages: [], pageParams: [] })
    apiFetchMock.mockResolvedValueOnce({ threadId: "p_new" })

    await runMutation({ nonce: "command_1", channelId: "forum_1", name: "n", content: "c" })

    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumFeed("forum_1", null))?.isInvalidated).toBe(true)
  })
})

describe("useUpdatePostTags", () => {
  const sidebar = (ids: string[]) => ({
    threads: ids.map((id) => ({
      id,
      parentChannelId: "forum_1",
      parentMessageId: `opener_${id}`,
      title: id,
      activityAt: "2026-08-28T00:00:00.000Z",
      expiresAt: "2026-08-31T00:00:00.000Z",
      unread: id === "p2",
    })),
    verifiedEpoch: 1,
    serverNow: "2026-08-28T00:00:00.000Z",
    serverClockOffsetMs: 0,
  })

  it("PUTs normalized tags and invalidates every message-feed variant plus the forum tag list", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [], pageParams: [] })
    const bugKey = [...communityKeys.channelMessages("forum_1"), "tag", "bug"] as const
    const feedAllKey = communityKeys.forumFeed("forum_1", null)
    const feedBugKey = communityKeys.forumFeed("forum_1", "bug")
    capturedQc.setQueryData(bugKey, { pages: [], pageParams: [] })
    capturedQc.setQueryData(feedAllKey, { pages: [], pageParams: [] })
    capturedQc.setQueryData(feedBugKey, { pages: [], pageParams: [] })
    capturedQc.setQueryData(communityKeys.forumTags("forum_1"), { tags: ["bug", "p0"] })
    apiFetchMock.mockResolvedValueOnce({ tags: ["bug", "p0"] })

    await runMutation({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
      previousTags: ["bug"],
      tags: [" Bug ", "P0", "bug"],
    })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m_p2/tags", {
      method: "PUT",
      body: JSON.stringify({ tags: ["bug", "p0"] }),
    })
    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(bugKey)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(feedAllKey)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(feedBugKey)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumTags("forum_1"))?.isInvalidated).toBe(true)
  })

  it("evicts only the archived sidebar projection after the successful PUT", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    const baseKey = communityKeys.forumSidebarThreads("server_1")
    const retainedKey = communityKeys.forumSidebarRetained("server_1", "p2")
    const metaKey = communityKeys.channelMeta("server_1", "p2")
    const hintKey = communityKeys.forumOpenerHint("server_1", "opener_p2")
    capturedQc.setQueryData(baseKey, sidebar(["p1", "p2", "p3"]))
    capturedQc.setQueryData(retainedKey, sidebar(["p2"]).threads[0])
    capturedQc.setQueryData(metaKey, { id: "p2", parentMessageId: "opener_p2" })
    capturedQc.setQueryData(hintKey, { id: "opener_p2", content: "p2" })
    apiFetchMock.mockResolvedValueOnce({ tags: ["bug", "archived"] })

    await runMutation({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "opener_p2",
      previousTags: ["bug"],
      tags: ["bug", "archived"],
    })

    expect(capturedQc.getQueryData<ReturnType<typeof sidebar>>(baseKey)?.threads.map(({ id }) => id))
      .toEqual(["p1", "p3"])
    expect(capturedQc.getQueryState(retainedKey)).toBeUndefined()
    expect(capturedQc.getQueryData(metaKey)).toEqual({ id: "p2", parentMessageId: "opener_p2" })
    expect(capturedQc.getQueryData(hintKey)).toEqual({ id: "opener_p2", content: "p2" })
    await vi.waitFor(() => {
      expect(capturedQc.getQueryState(baseKey)?.isInvalidated).toBe(true)
    })
  })

  it("waits for authoritative ranking on unarchive without speculative insertion", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    const baseKey = communityKeys.forumSidebarThreads("server_1")
    const retainedKey = communityKeys.forumSidebarRetained("server_1", "p2")
    capturedQc.setQueryData(baseKey, sidebar(["p1", "p3"]))
    capturedQc.setQueryData(retainedKey, null)
    apiFetchMock.mockResolvedValueOnce({ tags: ["bug"] })

    await runMutation({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "opener_p2",
      previousTags: ["archived", "bug"],
      tags: ["bug"],
    })
    expect(capturedQc.getQueryData<ReturnType<typeof sidebar>>(baseKey)?.threads.map(({ id }) => id))
      .toEqual(["p1", "p3"])
    await vi.waitFor(() => {
      expect(capturedQc.getQueryState(retainedKey)).toBeUndefined()
      expect(capturedQc.getQueryState(baseKey)?.isInvalidated).toBe(true)
    })
  })

  it("uses normalized returned tags and leaves the sidebar neutral without a transition", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    const baseKey = communityKeys.forumSidebarThreads("server_1")
    const before = sidebar(["p1", "p2"])
    capturedQc.setQueryData(baseKey, before)
    apiFetchMock.mockResolvedValueOnce({ tags: [" BUG "] })

    const result = await runMutation({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "opener_p2",
      previousTags: ["bug"],
      tags: ["archived"],
    })

    expect(result).toEqual({ tags: ["bug"] })
    expect(capturedQc.getQueryData(baseKey)).toEqual(before)
    expect(capturedQc.getQueryState(baseKey)?.isInvalidated).toBe(false)
  })

  it("leaves both the message feeds and forum tag list untouched when the PUT fails", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    const feedBefore = { pages: [{ messages: [{ id: "m_p2" }] }], pageParams: [null] }
    const tagsBefore = { tags: ["bug"] }
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), feedBefore)
    capturedQc.setQueryData(communityKeys.forumFeed("forum_1", null), feedBefore)
    capturedQc.setQueryData(communityKeys.forumTags("forum_1"), tagsBefore)
    capturedQc.setQueryData(communityKeys.forumSidebarThreads("server_1"), sidebar(["p2"]))
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await runMutationExpectError({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
      previousTags: ["bug"],
      tags: [],
    })

    expect(capturedQc.getQueryData(communityKeys.channelMessages("forum_1"))).toEqual(feedBefore)
    expect(capturedQc.getQueryData(communityKeys.forumTags("forum_1"))).toEqual(tagsBefore)
    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryState(communityKeys.forumFeed("forum_1", null))?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryState(communityKeys.forumTags("forum_1"))?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryData<ReturnType<typeof sidebar>>(
      communityKeys.forumSidebarThreads("server_1"),
    )?.threads.map(({ id }) => id)).toEqual(["p2"])
  })
})

describe("useDeleteForumThread", () => {
  it("applies full local success effects without self-WS and remains idempotent when it arrives", async () => {
    const { useDeleteForumThread } = await load()
    const { useCommunityStore } = await import("@/stores/community")
    const { getMessageOverlay, useMessageStreamStore } = await import("@/stores/community/message-stream")
    const { applyForumPostUnitClientEffects } = await import("@/hooks/community/community-ws/channel-scope-projection")
    useCommunityStore.getState().reset()
    useMessageStreamStore.getState().resetAll()
    const replacePath = vi.fn()
    useCommunityStore.getState().registerUiHandlers({ replacePath })
    useCommunityStore.getState().setCurrentServerId("server_1")
    useCommunityStore.getState().setCurrentChannelId("p2")
    useCommunityStore.getState().setCurrentChannelMeta({
      name: "Post",
      parentChannelId: "forum_1",
      parentMessageId: "m_p2",
    })
    const opener = {
      id: "m_p2",
      seq: 1,
      type: "chat" as const,
      authorId: "u1",
      authorName: "Alice",
      content: "Post",
      createdAt: "2026-08-23T00:00:00.000Z",
    }
    useMessageStreamStore.getState().dispatch(
      { kind: "channel", id: "forum_1", serverId: "server_1" },
      { type: "wsMessage", message: opener },
    )
    useMessageStreamStore.getState().dispatch(
      { kind: "channel", id: "p2", serverId: "server_1" },
      { type: "wsMessage", message: { ...opener, id: "reply_1" } },
    )
    useDeleteForumThread()
    apiFetchMock.mockResolvedValueOnce(undefined)
    const args = {
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
    }

    await runMutation(args)

    expect(useMessageStreamStore.getState().entries.has("channel:p2")).toBe(false)
    expect(getMessageOverlay({ kind: "channel", id: "forum_1", serverId: "server_1" })
      .liveById.has("m_p2")).toBe(false)
    expect(useCommunityStore.getState().currentChannelId).toBe("forum_1")
    expect(useCommunityStore.getState().currentChannelMeta).toBeNull()
    expect(clearLastChannelMock).toHaveBeenCalledOnce()
    expect(replacePath).toHaveBeenCalledOnce()
    expect(replacePath).toHaveBeenCalledWith("/c/channels/server_1/forum_1")

    applyForumPostUnitClientEffects(capturedQc, {
      serverId: "server_1",
      forumChannelId: "forum_1",
      childChannelId: "p2",
      openerMessageId: "m_p2",
    })
    expect(clearLastChannelMock).toHaveBeenCalledOnce()
    expect(replacePath).toHaveBeenCalledOnce()
  })

  it("optimistically evicts the post unit and DELETEs the canonical opener", async () => {
    const { useDeleteForumThread } = await load()
    useDeleteForumThread()

    const feed = {
      pages: [{ messages: [{ id: "m_p2", thread: { id: "p2" } }, { id: "m_keep", thread: { id: "keep" } }] }],
      pageParams: [null],
    }
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), feed)
    const forumFeed = {
      pages: [{
        serverId: "server_1",
        parentType: "forum",
        threads: [
          { id: "p2", parentMessageId: "m_p2" },
          { id: "keep", parentMessageId: "m_keep" },
        ],
        included: {
          parentMessages: [{ id: "m_p2" }, { id: "m_keep" }],
          firstMessages: [{ channelId: "p2" }, { channelId: "keep" }],
          tags: [{ messageId: "m_p2" }, { messageId: "m_keep" }],
          participants: [{ channelId: "p2" }, { channelId: "keep" }],
        },
        hasMore: false,
      }],
      pageParams: [null],
    }
    capturedQc.setQueryData(communityKeys.forumFeed("forum_1", null), forumFeed)
    const sidebarKey = communityKeys.forumSidebarThreads("server_1")
    capturedQc.setQueryData(sidebarKey, {
      channels: [], included: { parentMessages: [] }, serverNow: "2026-08-08T00:00:00.000Z",
      serverClockOffsetMs: 0,
      threads: [{ id: "p2", parentChannelId: "forum_1" }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)

    await runMutation({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
    })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m_p2", { method: "DELETE" })
    expect(capturedQc.getQueryData<typeof feed>(communityKeys.channelMessages("forum_1"))
      ?.pages[0].messages.map((message) => message.id)).toEqual(["m_keep"])
    const projectedFeed = capturedQc.getQueryData<typeof forumFeed>(communityKeys.forumFeed("forum_1", null))
    expect(projectedFeed?.pages[0].threads.map((thread) => thread.id)).toEqual(["keep"])
    expect(projectedFeed?.pages[0].included).toEqual({
      parentMessages: [{ id: "m_keep" }],
      firstMessages: [{ channelId: "keep" }],
      tags: [{ messageId: "m_keep" }],
      participants: [{ channelId: "keep" }],
    })
    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumFeed("forum_1", null))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryData<{ threads: unknown[] }>(sidebarKey)?.threads).toEqual([])
  })

  it("restores exact feed/sidebar/meta snapshots when the DELETE fails", async () => {
    const { useDeleteForumThread } = await load()
    useDeleteForumThread()

    const before = { pages: [{ messages: [{ id: "m_p2" }] }], pageParams: [null] }
    const feedBefore = {
      pages: [{
        serverId: "server_1",
        parentType: "forum",
        threads: [{ id: "p2", parentMessageId: "m_p2" }],
        included: {
          parentMessages: [{ id: "m_p2" }],
          firstMessages: [{ channelId: "p2" }],
          tags: [{ messageId: "m_p2" }],
          participants: [{ channelId: "p2" }],
        },
        hasMore: false,
      }],
      pageParams: [null],
    }
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), before)
    capturedQc.setQueryData(communityKeys.forumFeed("forum_1", null), feedBefore)
    const sidebarKey = communityKeys.forumSidebarThreads("server_1")
    const sidebarBefore = {
      channels: [], included: { parentMessages: [] }, serverNow: "2026-08-08T00:00:00.000Z",
      serverClockOffsetMs: 0,
      threads: [{ id: "p2", parentChannelId: "forum_1", parentMessageId: "m_p2" }],
    }
    const metaKey = communityKeys.channelMeta("server_1", "p2")
    capturedQc.setQueryData(sidebarKey, sidebarBefore)
    capturedQc.setQueryData(metaKey, { id: "p2", parentMessageId: "m_p2" })
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await runMutationExpectError({
      serverId: "server_1",
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
    })

    expect(capturedQc.getQueryData(communityKeys.channelMessages("forum_1"))).toEqual(before)
    expect(capturedQc.getQueryData(communityKeys.forumFeed("forum_1", null))).toEqual(feedBefore)
    expect(capturedQc.getQueryData(sidebarKey)).toEqual(sidebarBefore)
    expect(capturedQc.getQueryData(metaKey)).toEqual({ id: "p2", parentMessageId: "m_p2" })
  })
})

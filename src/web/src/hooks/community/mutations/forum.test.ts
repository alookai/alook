/**
 * Forum-mutation tests. Same shim pattern as channels.test.ts — the
 * `useMutation` config is captured and driven through React Query's lifecycle
 * order so we can assert the cache patches without a real query client loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"

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
  onSuccess?: (data: unknown, args: Args) => unknown
  onError?: (err: unknown, args: Args) => unknown
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
  const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
  cfg.onSuccess?.(data, args)
  return data
}

async function runMutationExpectError<Args>(args: Args) {
  const cfg = capturedConfig as MutConfig<Args>
  try {
    const data = cfg.mutationFn ? await cfg.mutationFn(args) : undefined
    cfg.onSuccess?.(data, args)
    throw new Error("expected mutationFn to reject")
  } catch (err) {
    cfg.onError?.(err, args)
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
  })

  it("invalidates the composed forum list on success", async () => {
    const { useCreateForumThread } = await load()
    useCreateForumThread()
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [], pageParams: [] })
    capturedQc.setQueryData(communityKeys.forumActivityFeed("forum_1", null), { pages: [], pageParams: [] })
    apiFetchMock.mockResolvedValueOnce({ threadId: "p_new" })

    await runMutation({ nonce: "command_1", channelId: "forum_1", name: "n", content: "c" })

    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumActivityFeed("forum_1", null))?.isInvalidated).toBe(true)
  })
})

describe("useUpdatePostTags", () => {
  it("PUTs normalized tags and invalidates every message-feed variant plus the forum tag list", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [], pageParams: [] })
    const bugKey = [...communityKeys.channelMessages("forum_1"), "tag", "bug"] as const
    const activityAllKey = communityKeys.forumActivityFeed("forum_1", null)
    const activityBugKey = communityKeys.forumActivityFeed("forum_1", "bug")
    capturedQc.setQueryData(bugKey, { pages: [], pageParams: [] })
    capturedQc.setQueryData(activityAllKey, { pages: [], pageParams: [] })
    capturedQc.setQueryData(activityBugKey, { pages: [], pageParams: [] })
    capturedQc.setQueryData(communityKeys.forumTags("forum_1"), { tags: ["bug", "p0"] })
    apiFetchMock.mockResolvedValueOnce({ tags: ["bug", "p0"] })

    await runMutation({
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
      tags: [" Bug ", "P0", "bug"],
    })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/messages/m_p2/tags", {
      method: "PUT",
      body: JSON.stringify({ tags: ["bug", "p0"] }),
    })
    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(bugKey)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(activityAllKey)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(activityBugKey)?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumTags("forum_1"))?.isInvalidated).toBe(true)
  })

  it("leaves both the message feeds and forum tag list untouched when the PUT fails", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    const feedBefore = { pages: [{ messages: [{ id: "m_p2" }] }], pageParams: [null] }
    const tagsBefore = { tags: ["bug"] }
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), feedBefore)
    capturedQc.setQueryData(communityKeys.forumActivityFeed("forum_1", null), feedBefore)
    capturedQc.setQueryData(communityKeys.forumTags("forum_1"), tagsBefore)
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await runMutationExpectError({
      forumChannelId: "forum_1",
      threadId: "p2",
      openerMessageId: "m_p2",
      tags: [],
    })

    expect(capturedQc.getQueryData(communityKeys.channelMessages("forum_1"))).toEqual(feedBefore)
    expect(capturedQc.getQueryData(communityKeys.forumTags("forum_1"))).toEqual(tagsBefore)
    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryState(communityKeys.forumActivityFeed("forum_1", null))?.isInvalidated).toBe(false)
    expect(capturedQc.getQueryState(communityKeys.forumTags("forum_1"))?.isInvalidated).toBe(false)
  })
})

describe("useDeleteForumThread", () => {
  it("DELETEs the post channel and invalidates the canonical feed on success", async () => {
    const { useDeleteForumThread } = await load()
    useDeleteForumThread()

    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), { pages: [], pageParams: [] })
    capturedQc.setQueryData(communityKeys.forumActivityFeed("forum_1", null), { pages: [], pageParams: [] })
    const sidebarKey = communityKeys.forumSidebarThreadsView("server_1", "p2")
    capturedQc.setQueryData(sidebarKey, {
      channels: [], included: { parentMessages: [] }, serverNow: "2026-08-08T00:00:00.000Z",
      serverClockOffsetMs: 0,
      threads: [{ id: "p2", parentChannelId: "forum_1" }],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)

    await runMutation({ serverId: "server_1", forumChannelId: "forum_1", threadId: "p2" })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/p2", { method: "DELETE" })
    expect(capturedQc.getQueryState(communityKeys.channelMessages("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumActivityFeed("forum_1", null))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryData<{ threads: unknown[] }>(sidebarKey)?.threads).toEqual([])
  })

  it("leaves the cache untouched when the DELETE fails", async () => {
    const { useDeleteForumThread } = await load()
    useDeleteForumThread()

    const before = { pages: [{ messages: [{ id: "m_p2" }] }], pageParams: [null] }
    capturedQc.setQueryData(communityKeys.channelMessages("forum_1"), before)
    capturedQc.setQueryData(communityKeys.forumActivityFeed("forum_1", null), before)
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await runMutationExpectError({ serverId: "server_1", forumChannelId: "forum_1", threadId: "p2" })

    expect(capturedQc.getQueryData(communityKeys.channelMessages("forum_1"))).toEqual(before)
    expect(capturedQc.getQueryData(communityKeys.forumActivityFeed("forum_1", null))).toEqual(before)
  })
})

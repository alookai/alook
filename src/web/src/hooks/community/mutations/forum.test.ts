/**
 * Forum-mutation tests. Same shim pattern as channels.test.ts — the
 * `useMutation` config is captured and driven through React Query's lifecycle
 * order so we can assert the cache patches without a real query client loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ForumThreadsResponse } from "@/hooks/community/use-channel-panels"
import type { ForumThread } from "@/components/community/_types"

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

function makePost(id: string): ForumThread {
  return {
    id,
    name: `post ${id}`,
    messageCount: 1,
    lastMessageAt: "2026-07-03T00:00:00.000Z",
    parent: { authorName: "Alice", text: "root" },
    authorId: "usr_alice",
    authorAvatar: "A",
    openerMessageId: `m_${id}`,
    tags: [],
    preview: "preview",
    participants: [{ id: "usr_alice", name: "Alice", avatar: "A" }],
  }
}

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
    capturedQc.setQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"), {
      threads: [makePost("p_old")],
    })
    apiFetchMock.mockResolvedValueOnce({ threadId: "p_new" })

    await runMutation({ nonce: "command_1", channelId: "forum_1", name: "n", content: "c" })

    expect(capturedQc.getQueryState(communityKeys.forumThreads("forum_1"))?.isInvalidated).toBe(true)
  })
})

describe("useUpdatePostTags", () => {
  it("PUTs normalized tags on the opener message and patches the post cache", async () => {
    const { useUpdatePostTags } = await load()
    useUpdatePostTags()
    capturedQc.setQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"), {
      threads: [makePost("p1"), makePost("p2")],
    })
    capturedQc.setQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1", "bug"), {
      threads: [makePost("p2")],
    })
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
    const cache = capturedQc.getQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"))
    expect(cache?.threads.find((post) => post.id === "p2")?.tags).toEqual(["bug", "p0"])
    expect(capturedQc.getQueryState(communityKeys.forumThreads("forum_1"))?.isInvalidated).toBe(true)
    expect(capturedQc.getQueryState(communityKeys.forumThreads("forum_1", "bug"))?.isInvalidated).toBe(true)
  })
})

describe("useDeleteForumThread", () => {
  it("DELETEs the post channel and removes it from the forum's cached list on success", async () => {
    const { useDeleteForumThread } = await load()
    useDeleteForumThread()

    capturedQc.setQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"), {
      threads: [makePost("p1"), makePost("p2"), makePost("p3")],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)

    await runMutation({ forumChannelId: "forum_1", threadId: "p2" })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/p2", { method: "DELETE" })
    const cache = capturedQc.getQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"))
    expect(cache?.threads.map((p) => p.id)).toEqual(["p1", "p3"])
  })

  it("leaves the cache untouched when the DELETE fails", async () => {
    const { useDeleteForumThread } = await load()
    useDeleteForumThread()

    capturedQc.setQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"), {
      threads: [makePost("p1"), makePost("p2")],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await runMutationExpectError({ forumChannelId: "forum_1", threadId: "p2" })

    const cache = capturedQc.getQueryData<ForumThreadsResponse>(communityKeys.forumThreads("forum_1"))
    expect(cache?.threads.map((p) => p.id)).toEqual(["p1", "p2"])
  })
})

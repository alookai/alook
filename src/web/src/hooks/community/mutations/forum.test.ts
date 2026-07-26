/**
 * Forum-mutation tests. Same shim pattern as channels.test.ts — the
 * `useMutation` config is captured and driven through React Query's lifecycle
 * order so we can assert the cache patches without a real query client loop.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import type { ForumPostsResponse } from "@/hooks/community/use-channel-panels"
import type { ForumPost } from "@/components/community/_types"

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

function makePost(id: string): ForumPost {
  return {
    id,
    name: `post ${id}`,
    messageCount: 1,
    lastMessageAt: "2026-07-03T00:00:00.000Z",
    parent: { authorName: "Alice", text: "root" },
    authorId: "usr_alice",
    authorAvatar: "A",
    tags: [],
    preview: "preview",
    participants: [{ id: "usr_alice", name: "Alice", avatar: "A" }],
  }
}

describe("useCreateForumPost", () => {
  it("POSTs JSON with name + content only when no attachments/mentionType are provided", async () => {
    const { useCreateForumPost } = await load()
    useCreateForumPost()
    const created = makePost("p_new")
    apiFetchMock.mockResolvedValueOnce({ channel: created })

    await runMutation({ channelId: "forum_1", name: "hi", content: "body" })

    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, init] = apiFetchMock.mock.calls[0]
    expect(path).toBe("/api/community/channels")
    expect((init as { method?: string }).method).toBe("POST")
    const body = JSON.parse((init as { body: string }).body)
    expect(body.type).toBe("post")
    expect(body.parentChannelId).toBe("forum_1")
    expect(body.name).toBe("hi")
    expect(body.content).toBe("body")
    // Non-present fields serialize as `undefined` → dropped by JSON.stringify.
    expect(body.attachments).toBeUndefined()
    expect(body.mentionType).toBeUndefined()
  })

  it("threads attachments + mentionType through to the request body", async () => {
    const { useCreateForumPost } = await load()
    useCreateForumPost()
    apiFetchMock.mockResolvedValueOnce({ channel: makePost("p_new") })

    const attachments = [{
      url: "/api/community/media/abc.png",
      filename: "abc.png",
      contentType: "image/png",
      size: 100,
      width: 10,
      height: 10,
    }]
    await runMutation({
      channelId: "forum_1",
      name: "heads up",
      content: "Heads up @everyone",
      attachments,
      mentionType: "everyone",
    })

    const [, init] = apiFetchMock.mock.calls[0]
    const body = JSON.parse((init as { body: string }).body)
    expect(body.attachments).toEqual(attachments)
    expect(body.mentionType).toBe("everyone")
  })

  it("prepends the fresh post to the forum's cached list on success", async () => {
    const { useCreateForumPost } = await load()
    useCreateForumPost()
    capturedQc.setQueryData<ForumPostsResponse>(communityKeys.forumPosts("forum_1"), {
      children: [makePost("p_old")],
    })
    const fresh = makePost("p_new")
    apiFetchMock.mockResolvedValueOnce({ channel: fresh })

    await runMutation({ channelId: "forum_1", name: "n", content: "c" })

    const cache = capturedQc.getQueryData<ForumPostsResponse>(communityKeys.forumPosts("forum_1"))
    expect(cache?.children.map((p) => p.id)).toEqual(["p_new", "p_old"])
  })
})

describe("useDeleteForumPost", () => {
  it("DELETEs the post channel and removes it from the forum's cached list on success", async () => {
    const { useDeleteForumPost } = await load()
    useDeleteForumPost()

    capturedQc.setQueryData<ForumPostsResponse>(communityKeys.forumPosts("forum_1"), {
      children: [makePost("p1"), makePost("p2"), makePost("p3")],
    })
    apiFetchMock.mockResolvedValueOnce(undefined)

    await runMutation({ forumChannelId: "forum_1", postId: "p2" })

    expect(apiFetchMock).toHaveBeenCalledWith("/api/community/channels/p2", { method: "DELETE" })
    const cache = capturedQc.getQueryData<ForumPostsResponse>(communityKeys.forumPosts("forum_1"))
    expect(cache?.children.map((p) => p.id)).toEqual(["p1", "p3"])
  })

  it("leaves the cache untouched when the DELETE fails", async () => {
    const { useDeleteForumPost } = await load()
    useDeleteForumPost()

    capturedQc.setQueryData<ForumPostsResponse>(communityKeys.forumPosts("forum_1"), {
      children: [makePost("p1"), makePost("p2")],
    })
    apiFetchMock.mockRejectedValueOnce(new Error("500"))

    await runMutationExpectError({ forumChannelId: "forum_1", postId: "p2" })

    const cache = capturedQc.getQueryData<ForumPostsResponse>(communityKeys.forumPosts("forum_1"))
    expect(cache?.children.map((p) => p.id)).toEqual(["p1", "p2"])
  })
})

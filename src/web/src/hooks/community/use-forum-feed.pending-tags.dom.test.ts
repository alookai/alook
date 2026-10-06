import { createElement, type PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { CommunityTestProvider } from "@/test/community-owner-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { communityKeys } from "@/lib/query-keys"
import { useForumFeed } from "./use-forum-feed"
import { useUpdatePostTags } from "./mutations/forum"
import type { ForumFeedTransportPage } from "./forum-feed-window"

const api = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api/client", () => ({ apiFetch: api, toastApiError: vi.fn() }))
beforeEach(() => { api.mockReset(); localStorage.clear() })

async function setup(selected = "archived") {
  const owner = await createCommunityQueryOwner()
  let backendTags = ["bug", selected]
  let resolve!: (value: { tags: string[] }) => void, reject!: (error: Error) => void
  const held = new Promise<{ tags: string[] }>((done, fail) => { resolve = done; reject = fail })
  const page = (): ForumFeedTransportPage => ({
    serverId: "server_1", parentType: "forum", hasMore: false,
    threads: [{ id: "post", name: "Post", creatorId: "author", messageCount: 1, parentMessageId: "opener", createdAt: "2026-10-04T00:00:00Z", activityAt: "2026-10-04T00:00:00Z", lastMessageAt: null }],
    included: { parentMessages: [{ id: "opener", channelId: "forum_1", seq: 1, content: "Post", authorId: "author", authorName: "Author", authorImage: null, authorAvatarVersion: 0 }], firstMessages: [], participants: [], tags: backendTags.map((tag) => ({ messageId: "opener", tag })) },
  })
  api.mockImplementation((path: string, options?: { method?: string }) => {
    if (options?.method === "PUT") return held
    if (path.endsWith("/messages/tags")) return Promise.resolve({ tags: [...backendTags] })
    if (path.includes("/threads?")) return Promise.resolve(page())
    throw new Error(`Unexpected request: ${path}`)
  })
  localStorage.setItem("alook:forum-tag:forum_1", selected)
  const wrapper = ({ children }: PropsWithChildren) => createElement(CommunityTestProvider, { client: owner.client, registry: owner.registry, retainOwner: true }, children)
  const view = renderHook(() => ({ feed: useForumFeed("server_1", "forum_1"), command: useUpdatePostTags() }), { wrapper })
  await waitFor(() => expect(view.result.current.feed.posts.map(({ id }) => id)).toEqual(["post"]))
  const refreshCatalog = () => owner.client.refetchQueries({ queryKey: communityKeys.forumTags("forum_1"), exact: true })
  const setTags = (tags: string[]) => { backendTags = tags }
  const begin = async (forumChannelId = "forum_1") => {
    let request!: Promise<unknown>
    act(() => { request = view.result.current.command.mutateAsync({ serverId: "server_1", forumChannelId, threadId: "post", openerMessageId: "opener", previousTags: ["bug", selected], tags: ["bug"] }).catch((error) => error) })
    await waitFor(() => expect(api.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true))
    return { request }
  }
  return { ...owner, view, refreshCatalog, setTags, resolve, reject, begin }
}

describe("Forum selection during native tag commands", () => {
  it.each(["success", "rollback"] as const)("keeps Archived selected while its last post is pending, then handles %s", async (outcome) => {
    const h = await setup()
    const { request } = await h.begin()
    await waitFor(() => expect(h.view.result.current.command.isPending).toBe(true))
    await waitFor(() => expect(h.view.result.current.feed.posts).toEqual([]))
    h.setTags(["bug"])
    await act(async () => { await h.refreshCatalog() })
    await waitFor(() => expect(h.view.result.current.feed.availableTags).toEqual(["bug"]))
    expect(h.view.result.current.feed.tag).toBe("archived")
    expect(h.view.result.current.feed.posts).toEqual([])
    expect(api.mock.calls.filter(([path]) => path.includes("/threads?")).every(([path]) => new URL(path, "https://local").searchParams.get("tag") === "archived")).toBe(true)
    if (outcome === "success") {
      await act(async () => { h.resolve({ tags: ["bug"] }); await request })
      await waitFor(() => expect(h.view.result.current.feed.tag).toBe("All"))
      await waitFor(() => expect(h.view.result.current.feed.posts.map(({ id }) => id)).toEqual(["post"]))
      expect(localStorage.getItem("alook:forum-tag:forum_1")).toBeNull()
    } else {
      h.setTags(["bug", "archived"])
      await act(async () => { await h.refreshCatalog(); h.reject(new Error("403")); await request })
      await waitFor(() => expect(h.view.result.current.command.isPending).toBe(false))
      expect(h.view.result.current.feed.tag).toBe("archived")
      await waitFor(() => expect(h.view.result.current.feed.posts.map(({ id }) => id)).toEqual(["post"]))
    }
  })

  it("still recovers a missing ordinary tag while another forum's command is pending", async () => {
    const h = await setup("removed")
    const { request } = await h.begin("forum_2")
    await waitFor(() => expect(h.view.result.current.command.isPending).toBe(true))
    h.setTags(["bug"])
    await act(async () => { await h.refreshCatalog() })
    await waitFor(() => expect(h.view.result.current.feed.tag).toBe("All"))
    await act(async () => { h.resolve({ tags: ["bug"] }); await request })
  })
})

import { CommunityTestProvider as QueryClientProvider } from "@/test/community-owner-fixture"
import { createElement, type PropsWithChildren } from "react"
import { type QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@/test/react-dom-harness"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { normalizeThreadResources, type ForumFeedTransportPage } from "./forum-feed-window"
import { communityKeys } from "@/lib/query-keys"
import { forumConversationEntryFixture } from "@/test/conversation-entry-fixtures"
import { conversationEntryOptions, publishConversationEntry } from "@/lib/community/conversation-entry"
import { captureCommunityLiveSnapshotToken, publishCommunityForumFeed } from "@/lib/community-db/sync"
import { handleChildChannelCreate } from "./community-ws/structure-tree-events"
import { runCommunityWsProjectionTransaction } from "./community-ws/projection-transaction"

const apiFetchMock = vi.fn()
const useForumTagsMock = vi.fn(() => ({
  data: { tags: ["bug"] },
  isSuccess: true,
}))
vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))
vi.mock("./use-conversation-entry", async (original) => ({
  ...await original<typeof import("./use-conversation-entry")>(),
  useConversationResource: () => ({ canRead: true }),
}))
vi.mock("./use-channel-panels", () => ({
  useForumTags: (...args: unknown[]) => useForumTagsMock(...args),
}))

import { useForumFeed } from "./use-forum-feed"

let client: QueryClient
beforeEach(async () => { localStorage.clear(); client = (await createCommunityQueryOwner()).client; apiFetchMock.mockReset() })

const emptyIncluded = { parentMessages: [], firstMessages: [], tags: [], participants: [] }

describe("useForumFeed", () => {
  it.each([null, "bug"])("refreshes a pending first list after child_create for tag %s", async (tag) => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
    const target = { channelId: "forum_one", serverId: "server_one", tag }
    client.setQueryData(conversationEntryOptions(client, target).queryKey, publishConversationEntry(client, target, forumConversationEntryFixture("forum_one", "server_one", true), { token: captureCommunityLiveSnapshotToken(client, "forum_one") }))
    const page = (ids: string[]): ForumFeedTransportPage => ({
      serverId: "server_one", parentType: "forum", hasMore: false,
      threads: ids.map((id) => ({ id, name: id, creatorId: "author", messageCount: 1, parentMessageId: `opener_${id}`, createdAt: "2026-10-26T00:00:00Z", activityAt: "2026-10-26T00:00:00Z", lastMessageAt: null })),
      included: { ...emptyIncluded,
        parentMessages: ids.map((id) => ({ id: `opener_${id}`, channelId: "forum_one", seq: 1, content: id, authorId: "author", authorName: "Author", authorImage: null, authorAvatarVersion: 0 })),
        tags: ids.map((id) => ({ messageId: `opener_${id}`, tag: "bug" })),
      },
    })
    client.removeQueries({ queryKey: communityKeys.threads("forum_one") })
    let release!: (value: ForumFeedTransportPage) => void
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve })).mockResolvedValue(page(["old", "new"]))
    const rendered = renderHook(() => useForumFeed("server_one", "forum_one", { routeTag: tag ?? "" }), {
      wrapper: ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    act(() => {
      publishCommunityForumFeed(client, "forum_one", normalizeThreadResources("forum_one", page(["new"])), { token: captureCommunityLiveSnapshotToken(client, "forum_one") })
      runCommunityWsProjectionTransaction(client, (projection) => handleChildChannelCreate({ type: "community:channel.child_create", parentChannelId: "forum_one", channel: { id: "new", name: "new", type: "thread", createdAt: "2026-10-26T00:00:00Z" }, parentMessageId: "opener_new" }, { queryClient: client, projection }))
      release(page(["old"]))
    })
    await waitFor(() => expect(rendered.result.current.posts.map((post) => post.id)).toContain("new"))
    expect(apiFetchMock).toHaveBeenCalledTimes(2)
    expect(new URL(apiFetchMock.mock.calls[1]![0], "http://localhost").searchParams.get("tag")).toBe(tag)
    rendered.unmount()
  })

  it("does not restart a pending forum list removed during child_create", async () => {
    client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
    const target = { channelId: "forum_one", serverId: "server_one" }
    client.setQueryData(conversationEntryOptions(client, target).queryKey, publishConversationEntry(client, target, forumConversationEntryFixture("forum_one", "server_one", true), { token: captureCommunityLiveSnapshotToken(client, "forum_one") }))
    client.removeQueries({ queryKey: communityKeys.threads("forum_one") })
    let release!: (value: ForumFeedTransportPage) => void
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const rendered = renderHook(() => useForumFeed("server_one", "forum_one"), {
      wrapper: ({ children }: PropsWithChildren) => createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      runCommunityWsProjectionTransaction(client, (projection) => handleChildChannelCreate({ type: "community:channel.child_create", parentChannelId: "forum_one", channel: { id: "new", name: "new", type: "thread", createdAt: "2026-10-26T00:00:00Z" }, parentMessageId: "opener_new" }, { queryClient: client, projection }))
      rendered.unmount()
      client.removeQueries({ queryKey: communityKeys.threads("forum_one") })
      release({ serverId: "server_one", parentType: "forum", threads: [], included: emptyIncluded, hasMore: false })
    })
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    expect(client.getQueryCache().findAll({ queryKey: communityKeys.threads("forum_one") })).toEqual([])
  })

})

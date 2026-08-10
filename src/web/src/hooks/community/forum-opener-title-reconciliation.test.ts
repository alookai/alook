import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { reconcileForumOpenerTitle } from "./forum-opener-title-reconciliation"

const identity = {
  serverId: "server_1",
  forumChannelId: "forum_1",
  childChannelId: "post_1",
  openerMessageId: "opener_1",
  content: "Full new title",
}

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient()
})

function seedCanonicalCaches() {
  queryClient.setQueryData(communityKeys.message("opener_1"), {
    id: "opener_1", type: "chat", content: "Old title",
  })
  const messagePage = {
    pages: [{ messages: [{ id: "opener_1", type: "chat", content: "Old title" }], hasMore: false }],
    pageParams: [null],
  }
  queryClient.setQueryData(communityKeys.channelMessages("forum_1"), messagePage)
  queryClient.setQueryData(communityKeys.channelMessages("post_1"), messagePage)
  queryClient.setQueryData(communityKeys.inboxUnreads(), {
    servers: [{
      serverId: "server_1",
      serverName: "Server",
      channels: [{
        channelId: "forum_1",
        channelName: "Forum",
        lastMessageAt: "now",
        mentionCount: 0,
        children: [{
          channelId: "post_1",
          channelName: "Old title",
          lastMessageAt: "now",
          mentionCount: 0,
          openerMessageId: "opener_1",
        }],
      }],
    }],
    dms: [],
  })
  queryClient.setQueryData(communityKeys.threads("forum_1"), {
    parentType: "forum",
    serverId: "server_1",
    parentChannelId: "forum_1",
    threads: [{
      id: "post_1",
      name: "Old title",
      openerMessageId: "opener_1",
      messageCount: 1,
      lastMessageAt: "now",
      parent: { authorName: "A", text: "Old title" },
    }],
  })
  queryClient.setQueryData(communityKeys.forumActivityFeed("forum_1", null), {
    pages: [{
      parentType: "forum",
      serverId: "server_1",
      threads: [{ id: "post_1", parentMessageId: "opener_1" }],
      included: {
        parentMessages: [{ id: "opener_1", channelId: "forum_1", content: "Old title" }],
        firstMessages: [], tags: [], participants: [],
      },
      hasMore: false,
    }],
    pageParams: [null],
  })
  queryClient.setQueryData(communityKeys.forumSidebarThreads("server_1"), {
    threads: [{
      id: "post_1",
      parentChannelId: "forum_1",
      parentMessageId: "opener_1",
      title: "Old title",
      activityAt: "now",
      expiresAt: "later",
      unread: false,
    }],
    verifiedEpoch: 0,
    serverNow: "now",
    serverClockOffsetMs: 0,
  })
  queryClient.setQueryData(communityKeys.forumOpenerHint("server_1", "opener_1"), {
    id: "opener_1", content: "Old title",
  })
}

describe("reconcileForumOpenerTitle", () => {
  it("patches every exact forum title read model and repairs only exact network reads", async () => {
    seedCanonicalCaches()
    const activityKey = communityKeys.forumActivityFeed("forum_1", null)
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    await reconcileForumOpenerTitle(queryClient, identity)

    expect(cancel).toHaveBeenCalledWith({ queryKey: communityKeys.inboxUnreads(), exact: true })
    expect(cancel).toHaveBeenCalledWith({ queryKey: communityKeys.threads("forum_1"), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inboxUnreads(), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.threads("forum_1"), exact: true })
    expect(queryClient.getQueryState(activityKey)?.isInvalidated).toBe(false)

    expect(queryClient.getQueryData<any>(communityKeys.message("opener_1")).content).toBe("Full new title")
    expect(queryClient.getQueryData<any>(communityKeys.channelMessages("forum_1")).pages[0].messages[0].content).toBe("Full new title")
    expect(queryClient.getQueryData<any>(communityKeys.channelMessages("post_1")).pages[0].messages[0].content).toBe("Full new title")
    expect(queryClient.getQueryData<any>(communityKeys.inboxUnreads()).servers[0].channels[0].children[0].channelName).toBe("Full new title")
    expect(queryClient.getQueryData<any>(communityKeys.threads("forum_1")).threads[0].name).toBe("Full new title")
    expect(queryClient.getQueryData<any>(activityKey).pages[0].included.parentMessages[0].content).toBe("Full new title")
    expect(queryClient.getQueryData<any>(communityKeys.forumSidebarThreads("server_1")).threads[0].title).toBe("Full new title")
    expect(queryClient.getQueryData<any>(communityKeys.forumOpenerHint("server_1", "opener_1")).content).toBe("Full new title")
  })

  it("is idempotent and leaves title caches unchanged for every mismatched identity", async () => {
    seedCanonicalCaches()
    const mismatches = [
      { ...identity, serverId: "wrong" },
      { ...identity, forumChannelId: "wrong" },
      { ...identity, childChannelId: "wrong" },
      { ...identity, openerMessageId: "wrong" },
    ]
    for (const mismatch of mismatches) {
      await reconcileForumOpenerTitle(queryClient, mismatch)
      await reconcileForumOpenerTitle(queryClient, mismatch)
    }

    expect(queryClient.getQueryData<any>(communityKeys.inboxUnreads()).servers[0].channels[0].children[0].channelName).toBe("Old title")
    expect(queryClient.getQueryData<any>(communityKeys.threads("forum_1")).threads[0].name).toBe("Old title")
    expect(queryClient.getQueryData<any>(communityKeys.forumSidebarThreads("server_1")).threads[0].title).toBe("Old title")
  })

  it("never rewrites a text-thread name", async () => {
    queryClient.setQueryData(communityKeys.threads("forum_1"), {
      parentType: "text",
      serverId: "server_1",
      parentChannelId: "forum_1",
      threads: [{ id: "post_1", name: "Custom thread", openerMessageId: "opener_1" }],
    })
    await reconcileForumOpenerTitle(queryClient, identity)
    expect(queryClient.getQueryData<any>(communityKeys.threads("forum_1")).threads[0].name).toBe("Custom thread")
  })
})

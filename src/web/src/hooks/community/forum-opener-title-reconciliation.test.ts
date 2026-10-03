import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { communityKeys } from "@/lib/query-keys"
import { reconcileForumOpenerTitle } from "./forum-opener-title-reconciliation"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  captureCommunityLiveSnapshotToken,
  getCanonicalCommunityMessages,
  publishCommunityForumSidebar,
  projectCommunityWsEventToDb,
} from "@/lib/community-db/sync"
import { getForumSidebarBase } from "./use-forum-sidebar-threads"

const identity = {
  serverId: "server_1",
  forumChannelId: "forum_1",
  childChannelId: "post_1",
  openerMessageId: "opener_1",
  content: "Full new title",
}

let queryClient: QueryClient
let registry: CommunityDbRegistry
let unregister: () => void

beforeEach(async () => {
  queryClient = new QueryClient()
  registry = createCommunityDbRegistry(queryClient, "viewer")
  await registry.preload()
  unregister = registerCommunityDbRegistry(registry)
})

afterEach(async () => {
  unregister()
  await registry.cleanup()
})

function seedCanonicalCaches() {
  publishCommunityForumSidebar(queryClient, {
    serverId: "server_1",
    channels: [{
      id: "post_1", name: "Post", parentChannelId: "forum_1",
      parentMessageId: "opener_1", activityAt: "2026-09-26T00:00:00.000Z",
      unread: false, type: "thread",
    }],
    openers: [{ id: "opener_1", channelId: "forum_1", content: "Old title", type: "chat" }],
    proof: {
      token: captureCommunityLiveSnapshotToken(queryClient),
      signal: undefined,
    },
  })
  for (const id of ["forum_1", "post_1"]) queryClient.setQueryData(communityKeys.channelMessages(id), {
    pages: [{ messages: [{ id: "opener_1" }], hasMore: false }], pageParams: [null],
  })
  queryClient.setQueryData(communityKeys.inboxUnreads(), { servers: [], dms: [] })
  queryClient.setQueryData(communityKeys.threads("forum_1"), ["post_1"])
  queryClient.setQueryData(communityKeys.forumFeed("forum_1", null), {
    pages: [{ serverId: "server_1", parentType: "forum", threads: [{ id: "post_1", openerMessageId: "opener_1", participantIds: [] }], hasMore: false }], pageParams: [null],
  })
}

describe("reconcileForumOpenerTitle", () => {
  it("uses the already published canonical opener and repairs only exact network reads", async () => {
    seedCanonicalCaches()
    const feedKey = communityKeys.forumFeed("forum_1", null)
    const cancel = vi.spyOn(queryClient, "cancelQueries")
    const invalidate = vi.spyOn(queryClient, "invalidateQueries")

    const windows = [communityKeys.channelMessages("forum_1"), communityKeys.channelMessages("post_1"), feedKey].map((key) => queryClient.getQueryData(key))
    projectCommunityWsEventToDb(queryClient, { type: "community:message.edited", channelId: "forum_1", messageId: "opener_1", content: identity.content })
    await reconcileForumOpenerTitle(queryClient, identity)

    expect(cancel).not.toHaveBeenCalled()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.inboxUnreads(), exact: true })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: communityKeys.threads("forum_1"), exact: true })
    expect(queryClient.getQueryState(feedKey)?.isInvalidated).toBe(false)

    ;[communityKeys.channelMessages("forum_1"), communityKeys.channelMessages("post_1"), feedKey].forEach((key, index) => expect(queryClient.getQueryData(key)).toBe(windows[index]))
    expect(invalidate.mock.calls).toHaveLength(2)
    expect(getForumSidebarBase(queryClient, "server_1").threads[0]?.title).toBe("Full new title")
    expect(getCanonicalCommunityMessages(queryClient)
      .find(({ id }) => id === "opener_1")?.content).toBe("Full new title")
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

    expect(getCanonicalCommunityMessages(queryClient).find(({ id }) => id === "opener_1")?.content).toBe("Old title")
    expect(getForumSidebarBase(queryClient, "server_1").threads[0]?.title).toBe("Old title")
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

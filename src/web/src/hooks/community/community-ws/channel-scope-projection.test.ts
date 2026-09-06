import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { CommunityWsEvent } from "@alook/shared"
import type { ThreadsResponse } from "@/hooks/community/use-channel-panels"
import type { ForumFeedPage } from "@/hooks/community/use-forum-feed"
import { communityKeys } from "@/lib/query-keys"
import { useCommunityWsStore } from "@/stores/community/ws"
import {
  capturedOnMessage,
  capturedQueryClient,
  cleanupCommunityWsHarness,
  getCommunityApiFetchMock,
  mountHook,
  resetCommunityWsHarness,
} from "./test-harness"

beforeEach(resetCommunityWsHarness)
afterEach(cleanupCommunityWsHarness)

function seedThreads(serverId: string, parentId: string, children: string[], shape: "text" | "forum") {
  if (shape === "text") {
    const data: ThreadsResponse = {
      serverId,
      parentChannelId: parentId,
      parentType: "text",
      threads: children.map((id) => ({
        id, name: id, messageCount: 1, lastMessageAt: "2026-09-06T00:00:00Z",
        parent: { authorName: "Author", text: "Opener" },
        parentSeq: 1, openerMessageId: `opener_${id}`,
      })),
    }
    capturedQueryClient.setQueryData(communityKeys.threads(parentId), data)
  } else {
    const pages: ForumFeedPage[] = children.map((id) => ({
      serverId,
      parentType: "forum",
      threads: [{
        id, name: id, creatorId: "author", messageCount: 1,
        parentMessageId: `opener_${id}`, lastMessageAt: "2026-09-06T00:00:00Z",
        createdAt: "2026-09-06T00:00:00Z", activityAt: "2026-09-06T00:00:00Z",
      }],
      included: { parentMessages: [], firstMessages: [], tags: [], participants: [] },
      hasMore: true,
      nextCursor: id,
    }))
    capturedQueryClient.setQueryData(communityKeys.forumFeed(parentId, null), {
      pages, pageParams: children.map((_, index) => index === 0 ? null : children[index - 1]),
    })
  }
}

const preview = {
  notFound: false,
  anchorId: "sensitive_message",
  messages: [{ id: "sensitive_message", content: "Private preview", reactions: [{ emoji: "👍", count: 1 }] }],
}

const controls: CommunityWsEvent[] = [
  { type: "community:channel.member_remove", serverId: "server", channelId: "parent", userId: "u_me" },
  { type: "community:channel.delete", serverId: "server", channelId: "parent" },
  { type: "community:member.leave", serverId: "server", userId: "u_me" },
  { type: "community:server.delete", serverId: "server" },
]

describe.each(["text", "forum"] as const)("%s canonical thread scope eviction", (shape) => {
  it.each(controls)("evicts preview-only descendants on $type and rejects a late preview response", async (event) => {
    await mountHook({ viewerUserId: "u_me" })
    const parentControl = "channelId" in event
    if (parentControl) {
      capturedQueryClient.setQueryData(communityKeys.channelMeta("server", "parent"), {
        id: "parent", type: shape, verifiedEpoch: useCommunityWsStore.getState().accessEpoch,
      })
    }
    seedThreads("server", "parent", ["active_child", "preview_child"], shape)
    seedThreads("server", "other_parent", ["other_child"], shape)
    seedThreads("other_server", "foreign_parent", ["foreign_child"], shape)
    const contextKey = communityKeys.messageContext("channel", "preview_child", 1)
    const pendingKey = communityKeys.messageContext("channel", "preview_child", 2)
    const otherKey = communityKeys.messageContext("channel", "other_child", 1)
    const foreignKey = communityKeys.messageContext("channel", "foreign_child", 1)
    const dmKey = communityKeys.messageContext("dm", "preview_child", 1)
    for (const key of [contextKey, otherKey, foreignKey, dmKey]) capturedQueryClient.setQueryData(key, preview)
    capturedQueryClient.setQueryData(communityKeys.channelMessages("preview_child"), { pages: [{ messages: preview.messages }] })
    capturedQueryClient.setQueryData(communityKeys.pins("preview_child"), { pins: preview.messages })
    capturedQueryClient.setQueryData(communityKeys.reactionDetails("sensitive_message"), {
      scope: { channelId: "preview_child", serverId: "server" }, actors: [{ id: "author" }],
    })
    let release!: (value: typeof preview) => void
    let requestSignal!: AbortSignal
    const pending = capturedQueryClient.fetchQuery({
      queryKey: pendingKey,
      queryFn: ({ signal }) => {
        requestSignal = signal
        return new Promise<typeof preview>((resolve) => { release = resolve })
      },
    }).catch(() => undefined)
    expect(capturedQueryClient.getQueryState(communityKeys.channelMeta("server", "preview_child"))).toBeUndefined()
    expect(useCommunityWsStore.getState().channelAccessScopes.has("preview_child")).toBe(false)
    const apiCalls = getCommunityApiFetchMock().mock.calls.length

    capturedOnMessage!(event)

    expect(capturedQueryClient.getQueryState(contextKey)).toBeUndefined()
    expect(capturedQueryClient.getQueryState(pendingKey)).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.channelMessages("preview_child"))).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.pins("preview_child"))).toBeUndefined()
    expect(capturedQueryClient.getQueryState(communityKeys.reactionDetails("sensitive_message"))).toBeUndefined()
    expect(capturedQueryClient.getQueriesData({ queryKey: communityKeys.threads("parent") })).toEqual([])
    expect(requestSignal.aborted).toBe(true)
    expect(useCommunityWsStore.getState().isChannelAccessRevoked("preview_child", "server")).toBe(true)
    expect(capturedQueryClient.getQueryData(otherKey)).toEqual(parentControl ? preview : undefined)
    expect(capturedQueryClient.getQueryData(foreignKey)).toEqual(preview)
    expect(capturedQueryClient.getQueryData(dmKey)).toEqual(preview)
    expect(getCommunityApiFetchMock()).toHaveBeenCalledTimes(apiCalls)

    release(preview)
    await pending
    await Promise.resolve()
    expect(capturedQueryClient.getQueryState(contextKey)).toBeUndefined()
    expect(capturedQueryClient.getQueryState(pendingKey)).toBeUndefined()
  })
})

it("cancels an unresolved parent thread list before its child rows can arrive", async () => {
  await mountHook({ viewerUserId: "u_me" })
  const key = communityKeys.threads("parent")
  let release!: (value: ThreadsResponse) => void
  let requestSignal!: AbortSignal
  const pending = capturedQueryClient.fetchQuery({
    queryKey: key,
    queryFn: ({ signal }) => {
      requestSignal = signal
      return new Promise<ThreadsResponse>((resolve) => { release = resolve })
    },
  }).catch(() => undefined)

  capturedOnMessage!({ type: "community:channel.delete", serverId: "server", channelId: "parent" })

  expect(requestSignal.aborted).toBe(true)
  expect(capturedQueryClient.getQueryState(key)).toBeUndefined()
  release({ serverId: "server", parentChannelId: "parent", parentType: "text", threads: [] })
  await pending
  expect(capturedQueryClient.getQueryState(key)).toBeUndefined()
})

it("preserves readable previews when leaving only a thread's notify membership", async () => {
  await mountHook({ viewerUserId: "u_me" })
  seedThreads("server", "parent", ["preview_child"], "text")
  capturedQueryClient.setQueryData(communityKeys.channelMeta("server", "preview_child"), {
    id: "preview_child", type: "thread", parentChannelId: "parent",
    verifiedEpoch: useCommunityWsStore.getState().accessEpoch,
  })
  const key = communityKeys.messageContext("channel", "preview_child", 1)
  capturedQueryClient.setQueryData(key, preview)

  capturedOnMessage!({
    type: "community:channel.member_remove", serverId: "server", channelId: "preview_child", userId: "u_me",
  })

  expect(capturedQueryClient.getQueryData(key)).toEqual(preview)
  expect(useCommunityWsStore.getState().isChannelAccessRevoked("preview_child", "server")).toBe(false)
})

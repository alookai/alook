import { QueryClient } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"
import type { CommunityWsEvent } from "@alook/shared"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"
import {
  materializeCanonicalMessages,
} from "@/lib/community-db/projections"
import {
  captureCommunityLiveSnapshotToken,
  getCanonicalCommunityMessages,
  getCanonicalCommunityChannels,
  projectCommunityWsEventToDb,
  publishCommunityEmbeddedMessages,
  publishCommunityCreatedChannel,
} from "@/lib/community-db/sync"
import type { Msg } from "@/lib/community/models/message"
import { mapForumFeedPages } from "./use-forum-feed"
import { forumFeedWindow, type ForumFeedTransportPage } from "./forum-feed-window"
import { materializeThreadsResponse, type ThreadsResponse } from "./use-channel-panels"

let registry: CommunityDbRegistry | undefined
let unregister: (() => void) | undefined

afterEach(async () => {
  unregister?.()
  unregister = undefined
  if (registry) await registry.cleanup()
  registry = undefined
})

describe("embedded message surface ownership", () => {
  it("publishes an empty first load once and projects WS edit/delete across every surface", async () => {
    const queryClient = new QueryClient()
    registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    unregister = registerCommunityDbRegistry(registry)
    const transport: Msg = {
      id: "m1",
      type: "chat",
      seq: 1,
      authorId: "author",
      authorName: "Author",
      content: "initial",
      createdAt: "2026-09-26T00:00:00.000Z",
    }
    const transportSurfaces = {
      mentions: [transport],
      marked: [transport],
      pins: [transport],
      context: [transport],
    }
    const forumPage: ForumFeedTransportPage = {
      serverId: "s1",
      parentType: "forum",
      threads: [{
        id: "post-1",
        name: "transport",
        creatorId: "author",
        messageCount: 1,
        parentMessageId: "m1",
        lastMessageAt: transport.createdAt!,
        createdAt: transport.createdAt!,
        activityAt: transport.createdAt!,
      }],
      included: {
        parentMessages: [{
          id: "m1",
          channelId: "c1",
          seq: 1,
          createdAt: transport.createdAt,
          content: "transport",
          authorId: "author",
          authorName: "Author",
          authorImage: null,
          authorAvatarVersion: 0,
        }],
        firstMessages: [],
        tags: [],
        participants: [],
      },
      hasMore: false,
    }
    const threads: ThreadsResponse = {
      threads: [{
        id: "post-1",
        openerMessageId: "m1",
      }],
      serverId: "s1",
      parentType: "forum",
      parentChannelId: "c1",
    }
    const canonical = () => new Map(
      getCanonicalCommunityMessages(queryClient).map((message) => [message.id, message as Msg]),
    )
    const channels = () => new Map(getCanonicalCommunityChannels(queryClient).map((row) => [row.id, row]))
    const projectEverySurface = () => ({
      rows: Object.fromEntries(Object.entries(transportSurfaces).map(([surface, messages]) => [
        surface,
        materializeCanonicalMessages(messages, canonical()).map((message) => message.content),
      ])),
      forum: mapForumFeedPages([forumFeedWindow(forumPage)], canonical(), channels(), new Map()).map((post) => post.name),
      threads: materializeThreadsResponse(threads, canonical(), channels()).map((thread) => thread.name),
    })

    expect(getCanonicalCommunityMessages(queryClient)).toEqual([])
    publishCommunityCreatedChannel(queryClient, {
      id: "post-1", serverId: "s1", parentChannelId: "c1", parentMessageId: "m1", name: "transport", type: "thread", position: 0,
      archived: false, muted: false, unread: false, tags: [], pending: false, createdAt: transport.createdAt,
    }, { token: captureCommunityLiveSnapshotToken(queryClient), signal: undefined })
    publishCommunityEmbeddedMessages(queryClient, {
      entries: [{ channelId: "c1", message: transport }],
      proof: {
        token: captureCommunityLiveSnapshotToken(queryClient),
        signal: undefined,
      },
    })
    expect(projectEverySurface()).toEqual({
      rows: {
        mentions: ["initial"], marked: ["initial"], pins: ["initial"], context: ["initial"],
      },
      forum: ["initial"],
      threads: ["initial"],
    })

    projectCommunityWsEventToDb(queryClient, {
      type: "community:message.edited",
      serverId: "s1",
      channelId: "c1",
      messageId: "m1",
      content: "edited",
    } as CommunityWsEvent)
    expect(projectEverySurface()).toEqual({
      rows: {
        mentions: ["edited"], marked: ["edited"], pins: ["edited"], context: ["edited"],
      },
      forum: ["edited"],
      threads: ["edited"],
    })

    projectCommunityWsEventToDb(queryClient, {
      type: "community:channel.delete",
      serverId: "s1",
      channelId: "c1",
    } as CommunityWsEvent)
    expect(projectEverySurface()).toEqual({
      rows: { mentions: [], marked: [], pins: [], context: [] },
      forum: [],
      threads: [],
    })
  })

  it("normalizes legacy embedded messages that omit the transport type", async () => {
    const queryClient = new QueryClient()
    registry = createCommunityDbRegistry(queryClient, "viewer")
    await registry.preload()
    unregister = registerCommunityDbRegistry(registry)
    const transport = {
      id: "legacy-mention-message",
      seq: 1,
      content: "legacy embedded payload",
      createdAt: "2026-09-26T00:00:00.000Z",
    } as Msg

    expect(publishCommunityEmbeddedMessages(queryClient, {
      entries: [{ channelId: "c1", message: transport }],
      proof: {
        token: captureCommunityLiveSnapshotToken(queryClient),
        signal: undefined,
      },
    })).toBe("published")
    expect(getCanonicalCommunityMessages(queryClient)).toEqual([
      expect.objectContaining({ id: transport.id, type: "chat" }),
    ])
  })
})

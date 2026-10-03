import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import type { InfiniteData } from "@tanstack/react-query"

export type ForumFeedTransportPage = {
  serverId: string
  parentType: string
  threads: Array<{
    id: string
    name: string | null
    creatorId: string | null
    messageCount: number | null
    parentMessageId: string | null
    lastMessageAt: string | null
    createdAt: string
    activityAt: string
  }>
  included: {
    parentMessages: Array<{ id: string; channelId: string; seq: number; createdAt?: string; content: string; authorId: string; authorName: string; authorImage: string | null; authorAvatarVersion: number }>
    firstMessages: Array<{ channelId: string; content: string }>
    tags: Array<{ messageId: string; tag: string }>
    participants: Array<{ channelId: string; userId: string; userName: string | null; userImage: string | null; userAvatarVersion: number; participantCount?: number }>
  }
  hasMore: boolean
  nextCursor?: string
}

export type ForumFeedPage = {
  serverId: string
  parentType: string
  threads: Array<{ id: string; openerMessageId: string | null; participantIds: string[] }>
  hasMore: boolean
  nextCursor?: string
}

export function forumFeedWindow(page: ForumFeedTransportPage): ForumFeedPage {
  return {
    serverId: page.serverId,
    parentType: page.parentType,
    threads: page.threads.map((thread) => ({ id: thread.id, openerMessageId: thread.parentMessageId, participantIds: page.included.participants.filter((participant) => participant.channelId === thread.id).map((participant) => participant.userId) })),
    hasMore: page.hasMore,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
}

export function forumFeedMatchesTags(filter: string | null, tags: readonly string[]) {
  const archived = tags.includes(FORUM_ARCHIVE_TAG)
  return filter === FORUM_ARCHIVE_TAG ? archived : !archived && (filter === null || tags.includes(filter))
}

export function removeForumPostFromFeed(data: InfiniteData<ForumFeedPage> | undefined, childChannelId: string, openerMessageId: string) {
  if (!data) return data
  return { ...data, pages: data.pages.map((page) => ({ ...page, threads: page.threads.filter((thread) => thread.id !== childChannelId && thread.openerMessageId !== openerMessageId) })) }
}

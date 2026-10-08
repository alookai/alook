import { FORUM_ARCHIVE_TAG, normalizeCommunityChannelResource, normalizeCommunityMessageResource, type CommunityChannelResource, type CommunityThreadsRead } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import { canonicalUserImage } from "@/lib/community/storage"
import type { InfiniteData } from "@tanstack/react-query"
import { resourceProfile, threadParticipantResources } from "@/lib/community/participant-resources"
import type { Msg, Thread } from "@/lib/community/models/message"
import type { ChannelRow } from "@/lib/community-db/schema"

export function projectThread(thread: ChannelRow, opener: Msg | undefined, parentType: string): Thread {
  return {
    id: thread.id,
    name: parentType === "forum" ? (opener?.content?.trim() ? opener.content : thread.name || "Post") : thread.name,
    messageCount: thread.messageCount ?? 0,
    lastMessageAt: thread.lastMessageAt ?? "",
    parent: { authorId: opener?.authorId, authorName: opener?.authorName ?? "", text: parentType === "forum" ? thread.preview ?? "" : opener?.content ?? thread.preview ?? "" },
    ...(opener?.seq === undefined ? {} : { parentSeq: opener.seq }),
  }
}

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

export type CommunityThreadResources = {
  channel: Pick<CommunityChannelResource, "id" | "serverId" | "type">
  threads: Array<Pick<CommunityChannelResource, "id" | "name" | "creatorId" | "parentMessageId" | "createdAt" | "lastMessageAt" | "messageCount"> & Partial<Omit<CommunityChannelResource, "id" | "name" | "creatorId" | "parentMessageId" | "createdAt" | "lastMessageAt" | "messageCount">>>
  included: CommunityThreadsRead["included"] & { previews: Array<Pick<CommunityThreadsRead["included"]["messages"][number], "channelId" | "content">> }
  page: CommunityThreadsRead["page"]
}

export function normalizeThreadResources(channelId: string, value: ForumFeedTransportPage | CommunityThreadsRead): CommunityThreadResources {
  if ("contractVersion" in value) return { ...value, included: { ...value.included, previews: value.included.messages.filter((message) => message.channelId !== channelId) } }
  const participants = threadParticipantResources(value.included.participants.map((participant) => ({
    channelId: participant.channelId, userId: participant.userId, participantCount: participant.participantCount,
    isCreator: value.threads.some((thread) => thread.id === participant.channelId && thread.creatorId === participant.userId),
    profile: resourceProfile({ id: participant.userId, name: participant.userName ?? "Deleted user", avatar: canonicalUserImage(participant.userId, participant.userImage, participant.userAvatarVersion), avatarVersion: participant.userAvatarVersion }),
  })))
  return {
    channel: { id: channelId, serverId: value.serverId, type: value.parentType === "forum" ? "forum" : "text" },
    threads: value.threads.map((thread) => {
      const channel = normalizeCommunityChannelResource({ ...thread, type: "thread", serverId: value.serverId, parentChannelId: channelId, topic: "", position: 0, archived: false })
      const { archived: _archived, ...identity } = channel
      return identity
    }),
    included: {
      messages: value.included.parentMessages.map((message) => normalizeCommunityMessageResource({ ...message, type: "chat", createdAt: message.createdAt ?? "", authorAvatar: canonicalUserImage(message.authorId, message.authorImage, message.authorAvatarVersion) ?? avatarInitial(message.authorName) }, channelId)),
      previews: value.included.firstMessages, tags: value.included.tags, ...participants,
    },
    page: { hasMore: value.hasMore, nextCursor: value.nextCursor ?? null },
  }
}

export type ForumFeedPage = {
  serverId: string
  parentType: string
  threads: Array<{ id: string; openerMessageId: string | null; participantIds: string[] }>
  hasMore: boolean
  nextCursor?: string
}

export function forumFeedWindow(page: CommunityThreadResources): ForumFeedPage {
  return {
    serverId: page.channel.serverId ?? "", parentType: page.channel.type,
    threads: page.threads.map((thread) => ({ id: thread.id, openerMessageId: thread.parentMessageId, participantIds: page.included.members.filter((member) => member.channelId === thread.id).map((member) => member.userId) })),
    hasMore: page.page.hasMore, ...(page.page.nextCursor ? { nextCursor: page.page.nextCursor } : {}),
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

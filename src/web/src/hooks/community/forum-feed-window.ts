import { FORUM_ARCHIVE_TAG, CommunityChannelResourceSchema, CommunityMessagePreviewSchema, CommunityMessageResourceSchema, communityReadSchemas, communityMessagePreviewFromLegacy, type CommunityLegacyThreadsRead, type CommunityChannelResource, type CommunityThreadsRead, type CommunityMessageResource, type CommunityResourceProfile, type CommunityMemberRelation } from "@alook/shared"
import { canonicalUserImage } from "@/lib/community/storage"
import type { InfiniteData } from "@tanstack/react-query"
import { threadParticipantResources } from "@/lib/community/participant-resources"
import type { MessageInput, Msg, Thread } from "@/lib/community/models/message"
import type { ChannelRow } from "@/lib/community-db/schema"

export function projectThread(thread: ChannelRow, opener: Msg | undefined, parentType: string): Thread {
  return {
    id: thread.id,
    name: parentType === "forum" ? (opener?.content?.trim() ? opener.content : thread.name || "Post") : thread.name ?? "",
    messageCount: thread.messageCount ?? 0,
    lastMessageAt: thread.lastMessageAt ?? "",
    parent: { authorId: opener?.authorId, authorName: opener?.authorName ?? "", text: parentType === "forum" ? thread.preview ?? "" : opener?.content ?? thread.preview ?? "" },
    ...(opener?.seq === undefined ? {} : { parentSeq: opener.seq }),
  }
}

export type ForumFeedTransportPage = Pick<CommunityThreadsRead["page"], "hasMore"> & {
  serverId: NonNullable<CommunityChannelResource["serverId"]>
  parentType: string
  threads: Array<Pick<CommunityChannelResource, "id" | "name" | "creatorId" | "parentMessageId" | "lastMessageAt" | "createdAt"> & {
    messageCount: CommunityChannelResource["messageCount"] | null
    activityAt: string
  }>
  included: {
    parentMessages: Array<Required<Pick<CommunityMessageResource, "id" | "channelId" | "seq" | "content" | "authorId" | "authorName" | "authorAvatarVersion">> & Partial<Pick<CommunityMessageResource, "createdAt">> & { authorImage: CommunityResourceProfile["avatar"] }>
    firstMessages: Array<Pick<CommunityMessageResource, "channelId" | "content">>
    tags: CommunityThreadsRead["included"]["tags"]
    participants: Array<Pick<CommunityMemberRelation, "channelId" | "userId"> & { userName: CommunityResourceProfile["name"] | null; discriminator?: CommunityResourceProfile["discriminator"]; userImage: CommunityResourceProfile["avatar"]; userAvatarVersion: CommunityResourceProfile["avatarVersion"]; participantCount?: number }>
  }
  nextCursor?: NonNullable<CommunityThreadsRead["page"]["nextCursor"]>
}

export type CommunityThreadResources = {
  channel: Pick<CommunityChannelResource, "id" | "serverId" | "type">
  threads: Array<Pick<CommunityChannelResource, "id"> & Partial<Omit<CommunityChannelResource, "id">> & { resourceComplete?: boolean }>
  included: Omit<CommunityThreadsRead["included"], "messages" | "profiles"> & { profiles: Array<Pick<CommunityResourceProfile, "id"> & Partial<Omit<CommunityResourceProfile, "id">>>; messages: Array<MessageInput & { channelId: string }>; previews: Array<Pick<CommunityMessageResource, "channelId" | "content">> }
  page: CommunityThreadsRead["page"]
}

export function normalizeThreadResources(channelId: string, value: ForumFeedTransportPage | CommunityThreadsRead | CommunityLegacyThreadsRead): CommunityThreadResources {
  if ("contractVersion" in value) {
    if (value.contractVersion !== 2 && value.contractVersion !== 3) throw new Error("Unknown thread resource contract")
    const data = communityReadSchemas(value.contractVersion).threads.parse(value)
    return {
    ...data, threads: data.threads.map((thread) => ({ ...CommunityChannelResourceSchema.parse(thread), resourceComplete: true })),
    included: { ...data.included,
      messages: data.included.messages.map((message) => data.contractVersion === 3
        ? { ...CommunityMessageResourceSchema.parse(message), channelId: message.channelId, resourceComplete: true }
        : { ...communityMessagePreviewFromLegacy(message, message.channelId), channelId: message.channelId, resourceComplete: false }),
      profiles: data.contractVersion === 3 ? data.included.profiles : data.included.profiles.map(({ statusEmoji: _emoji, statusText: _text, ...identity }) => identity),
      previews: data.included.messages.filter((message) => message.channelId !== channelId),
    },
  }
  }
  const participants = threadParticipantResources(value.included.participants.map((participant) => ({
    channelId: participant.channelId, userId: participant.userId, participantCount: participant.participantCount,
    isCreator: value.threads.some((thread) => thread.id === participant.channelId && thread.creatorId === participant.userId),
    profile: { id: participant.userId, ...(participant.userName !== null ? { name: participant.userName } : {}), ...(participant.discriminator ? { discriminator: participant.discriminator } : {}), avatar: canonicalUserImage(participant.userId, participant.userImage, participant.userAvatarVersion), avatarVersion: participant.userAvatarVersion },
  })))
  return {
    channel: { id: channelId, serverId: value.serverId, type: value.parentType === "forum" ? "forum" : "text" },
    threads: value.threads.map(({ activityAt: _activity, messageCount, ...thread }) => ({
      ...thread, type: "thread", serverId: value.serverId, parentChannelId: channelId,
      ...(messageCount === null ? {} : { messageCount }), resourceComplete: false,
    })),
    included: {
      messages: value.included.parentMessages.map(({ authorImage, ...message }) => ({
        ...CommunityMessagePreviewSchema.partial({ type: true }).parse({ ...message, channelId, authorAvatar: canonicalUserImage(message.authorId, authorImage, message.authorAvatarVersion) }), channelId, resourceComplete: false,
      })),
      previews: value.included.firstMessages, tags: value.included.tags, ...participants,
    },
    page: { hasMore: value.hasMore, nextCursor: value.nextCursor ?? null },
  }
}

export type ForumFeedPage = Pick<CommunityThreadsRead["page"], "hasMore"> & {
  serverId: NonNullable<CommunityChannelResource["serverId"]>
  parentType: string
  threads: Array<Pick<CommunityChannelResource, "id"> & { openerMessageId: CommunityChannelResource["parentMessageId"]; participantIds: Array<CommunityMemberRelation["userId"]> }>
  nextCursor?: NonNullable<CommunityThreadsRead["page"]["nextCursor"]>
}

export function forumFeedWindow(page: CommunityThreadResources): ForumFeedPage {
  return {
    serverId: page.channel.serverId ?? "", parentType: page.channel.type,
    threads: page.threads.map((thread) => ({ id: thread.id, openerMessageId: thread.parentMessageId ?? null, participantIds: page.included.members.filter((member) => member.channelId === thread.id).map((member) => member.userId) })),
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

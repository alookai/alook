import { FORUM_ARCHIVE_TAG, communityReadSchemas, type CommunityChannelResource, type CommunityThreadsRead, type CommunityMessageResource, type CommunityMemberRelation } from "@alook/shared"
import type { InfiniteData } from "@tanstack/react-query"
import type { Msg, Thread } from "@/lib/community/models/message"
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

export type ForumFeedTransportPage = CommunityThreadsRead

export type CommunityThreadResources = Omit<CommunityThreadsRead, "included"> & {
  included: CommunityThreadsRead["included"] & { previews: CommunityMessageResource[] }
}

export function normalizeThreadResources(channelId: string, value: unknown): CommunityThreadResources {
  const data = communityReadSchemas().threads.parse(value)
  if (data.channelId !== channelId || data.channel.id !== channelId
    || data.threads.some(thread => thread.parentChannelId !== channelId || thread.serverId !== data.channel.serverId)) throw new Error("Thread resource scope mismatch")
  return { ...data, included: { ...data.included, previews: data.included.messages.filter(message => message.channelId !== channelId) } }
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

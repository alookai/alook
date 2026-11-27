import { FORUM_ARCHIVE_TAG, communityReadSchemas, messagePreviewText, type CommunityChannelResource, type CommunityThreadsRead, type CommunityMessageResource, type CommunityMemberRelation } from "@alook/shared"
import type { InfiniteData } from "@tanstack/react-query"
import { avatarInitial } from "@/lib/community/avatar"
import type { ForumThread, Msg, Thread } from "@/lib/community/models/message"
import type { ChannelRow } from "@/lib/community-db/schema"

export function projectThread(thread: ChannelRow, opener: Msg | undefined, parentType: string, first?: Msg): Thread {
  return {
    id: thread.id,
    name: parentType === "forum" ? (opener?.content?.trim() ? opener.content : thread.name || "Post") : thread.name ?? "",
    messageCount: thread.messageCount ?? 0,
    lastMessageAt: thread.lastMessageAt ?? "",
    parent: { authorId: opener?.authorId, authorName: opener?.authorName ?? "", text: parentType === "forum" ? first ? messagePreviewText(first) : "" : opener ? messagePreviewText(opener) : "" },
    ...(opener?.seq === undefined ? {} : { parentSeq: opener.seq }),
  }
}

export function projectForumThread(
  thread: ChannelRow,
  opener: Msg,
  first: Msg | undefined,
  participants: ForumThread["participants"] = [],
): ForumThread {
  const summary = projectThread(thread, opener, "forum", first)
  return {
    ...summary,
    authorId: opener.authorId ?? thread.creatorId ?? "",
    authorAvatar: opener.authorAvatar ?? avatarInitial(opener.authorName ?? ""),
    authorAvatarVersion: opener.authorAvatarVersion ?? 0,
    openerMessageId: opener.id,
    ...(opener.createdAt === undefined ? {} : { openerCreatedAt: opener.createdAt }),
    tags: thread.tags,
    preview: summary.parent.text,
    participants,
    participantCount: thread.participantCount ?? 0,
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
  const firstByChannelId = new Map<string, CommunityMessageResource>()
  for (const message of data.included.messages) {
    const existing = firstByChannelId.get(message.channelId)
    if (!existing || message.seq < existing.seq) firstByChannelId.set(message.channelId, message)
  }
  const previews: CommunityMessageResource[] = []
  for (const thread of data.threads) {
    const first = firstByChannelId.get(thread.id)
    if (first) previews.push(first)
  }
  return { ...data, included: { ...data.included, previews } }
}

export type ForumFeedPage = Pick<CommunityThreadsRead["page"], "hasMore"> & {
  serverId: NonNullable<CommunityChannelResource["serverId"]>
  parentType: string
  threads: Array<Pick<CommunityChannelResource, "id"> & { openerMessageId: CommunityChannelResource["parentMessageId"]; participantIds: Array<CommunityMemberRelation["userId"]> }>
  nextCursor?: NonNullable<CommunityThreadsRead["page"]["nextCursor"]>
}

export function forumFeedWindow(page: CommunityThreadResources): ForumFeedPage {
  const membersByChannelId = new Map<string, Array<CommunityMemberRelation["userId"]>>()
  for (const member of page.included.members) {
    const list = membersByChannelId.get(member.channelId)
    if (list) list.push(member.userId)
    else membersByChannelId.set(member.channelId, [member.userId])
  }
  return {
    serverId: page.channel.serverId ?? "", parentType: page.channel.type,
    threads: page.threads.map((thread) => ({ id: thread.id, openerMessageId: thread.parentMessageId ?? null, participantIds: membersByChannelId.get(thread.id) ?? [] })),
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

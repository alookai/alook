import { compareAsciiSqliteBinary, FORUM_ARCHIVE_TAG } from "@alook/shared"
import type { ChannelMembershipRow, ChannelRow, MessageRow } from "@/lib/community-db/schema"

export type ForumSidebarThread = Pick<ChannelRow, "id" | "unread"> & {
  parentChannelId: string
  parentMessageId: string
  title: string
  activityAt: string
  expiresAt: string
}

export const FORUM_SIDEBAR_ACTIVITY_WINDOW_MS = 72 * 60 * 60 * 1000

export function viewerNotifyChannelIds(memberships: readonly ChannelMembershipRow[], viewerId: string | null) {
  return new Set(memberships.filter((row) => row.relation === "notify" && row.userId === viewerId).map((row) => row.channelId))
}

export function compareForumSidebarThreads(left: ForumSidebarThread, right: ForumSidebarThread) {
  return compareAsciiSqliteBinary(left.parentChannelId, right.parentChannelId)
    || compareAsciiSqliteBinary(right.activityAt, left.activityAt)
    || compareAsciiSqliteBinary(right.id, left.id)
}

export function forumSidebarCandidates(
  channels: readonly ChannelRow[], memberships: readonly ChannelMembershipRow[], messages: readonly MessageRow[],
  viewerId: string | null, serverId: string,
) {
  const participating = viewerNotifyChannelIds(memberships, viewerId)
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const parents = channels.filter((channel) => channel.serverId === serverId && channel.type === "forum")
  const parentIds = new Set(parents.map((channel) => channel.id))
  return channels.flatMap((channel) => {
    if (channel.serverId !== serverId || channel.type !== "thread" || channel.archived
      || channel.tags.includes(FORUM_ARCHIVE_TAG) || !participating.has(channel.id)
      || !channel.parentChannelId || !parentIds.has(channel.parentChannelId) || !channel.parentMessageId) return []
    const activityAt = channel.lastMessageAt ?? "", activityMs = Date.parse(activityAt)
    const expiresAt = Number.isFinite(activityMs) ? new Date(activityMs + FORUM_SIDEBAR_ACTIVITY_WINDOW_MS).toISOString() : activityAt
    return [{ id: channel.id, parentChannelId: channel.parentChannelId, parentMessageId: channel.parentMessageId,
      title: messageById.get(channel.parentMessageId)?.content ?? channel.name, activityAt, expiresAt, unread: channel.unread }]
  }).sort(compareForumSidebarThreads)
}

export function projectForumSidebar(
  channels: readonly ChannelRow[], memberships: readonly ChannelMembershipRow[], messages: readonly MessageRow[],
  viewerId: string | null, serverId: string, retainId: string | null, serverNowMs: number,
) {
  const parents = channels.filter((channel) => channel.serverId === serverId && channel.type === "forum")
  const parentIds = new Set(parents.map((channel) => channel.id))
  const candidates = forumSidebarCandidates(channels, memberships, messages, viewerId, serverId)
    .filter((thread) => thread.id === retainId || !Number.isFinite(Date.parse(thread.expiresAt)) || Date.parse(thread.expiresAt) > serverNowMs)
  const byParent = new Map<string, ForumSidebarThread[]>()
  for (const thread of candidates) {
    const siblings = byParent.get(thread.parentChannelId) ?? []
    siblings.push(thread)
    byParent.set(thread.parentChannelId, siblings)
  }
  const threads = [...byParent.values()].flatMap((siblings) => {
    const retained = retainId ? siblings.find((thread) => thread.id === retainId) : undefined
    if (!retained || siblings.slice(0, 5).some((thread) => thread.id === retainId)) return siblings.slice(0, 5)
    return [...siblings.filter((thread) => thread.id !== retainId).slice(0, 4), retained].sort(compareForumSidebarThreads)
  })
  const renderedIds = new Set(threads.map((thread) => thread.id))
  const parentUnread: Record<string, boolean> = {}
  for (const parent of parents) parentUnread[parent.id] = parent.baseUnread ?? parent.unread
  for (const child of channels) {
    if (child.serverId === serverId && child.type === "thread" && child.unread && child.parentChannelId
      && parentIds.has(child.parentChannelId) && !renderedIds.has(child.id)) parentUnread[child.parentChannelId] = true
  }
  return { threads, parentUnread }
}

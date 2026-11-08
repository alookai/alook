import { compareAsciiSqliteBinary, FORUM_ARCHIVE_TAG, FORUM_SIDEBAR_MAX_PER_PARENT, FORUM_SIDEBAR_ACTIVITY_WINDOW_MS } from "@alook/shared"
import type { AttentionScopeRow, ChannelMembershipRow, ChannelRow, MessageRow } from "@/lib/community-db/schema"

export type ForumSidebarThread = Pick<ChannelRow, "id"> & { unread: boolean } & {
  parentChannelId: string
  parentMessageId: string
  title: string
  activityAt: string
  expiresAt: string
}

export function supportsSidebarThreads(type: string | null | undefined) {
  return type === "forum" || type === "text"
}


type AttentionProjection = {
  servers: Map<string, { unread: boolean; mentions: number }>
  channels: Map<string, Set<string>>
  parents: Map<string, Set<string>>
  scopes: Set<string>
}
const attentionProjections = new WeakMap<readonly AttentionScopeRow[], AttentionProjection>()

export function projectCommunityAttention(attention: readonly AttentionScopeRow[]) {
  const previous = attentionProjections.get(attention)
  if (previous) return previous
  const result: AttentionProjection = { servers: new Map(), channels: new Map(), parents: new Map(), scopes: new Set() }
  for (const scope of attention) {
    const unread = scope.ordinaryUnread || scope.attentionCount > 0
    if (unread) result.scopes.add(scope.scopeId)
    if (!scope.serverId) continue
    const server = result.servers.get(scope.serverId) ?? { unread: false, mentions: 0 }
    server.unread ||= scope.ordinaryUnread
    server.mentions += scope.attentionCount
    result.servers.set(scope.serverId, server)
    if (!unread) continue
    const channels = result.channels.get(scope.serverId) ?? new Set<string>()
    channels.add(scope.channelId)
    if (scope.parentChannelId) channels.add(scope.parentChannelId)
    result.channels.set(scope.serverId, channels)
    const parents = result.parents.get(scope.serverId) ?? new Set<string>()
    parents.add(scope.parentChannelId ?? scope.channelId)
    result.parents.set(scope.serverId, parents)
  }
  attentionProjections.set(attention, result)
  return result
}

export function viewerNotifyChannelIds(memberships: readonly ChannelMembershipRow[], viewerId: string | null) {
  return new Set(memberships.filter((row) => row.relation === "notify" && row.userId === viewerId).map((row) => row.channelId))
}

export function forumSidebarActivityAt(channel: Pick<ChannelRow, "lastMessageAt" | "createdAt">) {
  return channel.lastMessageAt ?? channel.createdAt
}

export function compareForumSidebarThreads(left: ForumSidebarThread, right: ForumSidebarThread) {
  return compareAsciiSqliteBinary(left.parentChannelId, right.parentChannelId)
    || compareAsciiSqliteBinary(right.activityAt, left.activityAt)
    || compareAsciiSqliteBinary(right.id, left.id)
}

export function forumSidebarCandidates(
  channels: readonly ChannelRow[], memberships: readonly ChannelMembershipRow[], messages: readonly MessageRow[],
  viewerId: string | null, serverId: string, attention: readonly AttentionScopeRow[] = [],
) {
  const participating = viewerNotifyChannelIds(memberships, viewerId)
  const messageById = new Map(messages.map((message) => [message.id, message]))
  const parents = channels.filter((channel) => channel.serverId === serverId && supportsSidebarThreads(channel.type))
  const parentIds = new Set(parents.map((channel) => channel.id))
  return channels.flatMap((channel) => {
    if (channel.serverId !== serverId || channel.type !== "thread" || channel.archived
      || channel.tags.includes(FORUM_ARCHIVE_TAG) || !participating.has(channel.id)
      || !channel.parentChannelId || !parentIds.has(channel.parentChannelId) || !channel.parentMessageId) return []
    const activityAt = forumSidebarActivityAt(channel), activityMs = Date.parse(activityAt)
    const expiresAt = Number.isFinite(activityMs) ? new Date(activityMs + FORUM_SIDEBAR_ACTIVITY_WINDOW_MS).toISOString() : activityAt
    return [{ id: channel.id, parentChannelId: channel.parentChannelId, parentMessageId: channel.parentMessageId,
      title: messageById.get(channel.parentMessageId)?.content ?? channel.name ?? "", activityAt, expiresAt, unread: attention.some((scope) => scope.scopeId === channel.id && (scope.ordinaryUnread || scope.attentionCount > 0)) }]
  }).sort(compareForumSidebarThreads)
}

export function projectForumSidebarStructure(
  channels: readonly ChannelRow[], memberships: readonly ChannelMembershipRow[], messages: readonly MessageRow[],
  viewerId: string | null, serverId: string, retainId: string | null, serverNowMs: number,
) {
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
    if (!retained || siblings.slice(0, FORUM_SIDEBAR_MAX_PER_PARENT).some((thread) => thread.id === retainId)) return siblings.slice(0, FORUM_SIDEBAR_MAX_PER_PARENT)
    return [...siblings.filter((thread) => thread.id !== retainId).slice(0, FORUM_SIDEBAR_MAX_PER_PARENT - 1), retained].sort(compareForumSidebarThreads)
  })
  return { threads, parentIds: channels.filter(channel => channel.serverId === serverId && channel.type !== "thread").map(channel => channel.id) }
}

export function applyForumSidebarAttention(structure: ReturnType<typeof projectForumSidebarStructure>, serverId: string, attention: readonly AttentionScopeRow[]) {
  const projected = projectCommunityAttention(attention)
  const parentUnread: Record<string, boolean> = Object.fromEntries(structure.parentIds.map(id => [id, false]))
  for (const id of projected.parents.get(serverId) ?? []) parentUnread[id] = true
  return { threads: structure.threads.map(thread => projected.scopes.has(thread.id) ? { ...thread, unread: true } : thread), parentUnread }
}

export function projectForumSidebar(
  channels: readonly ChannelRow[], memberships: readonly ChannelMembershipRow[], messages: readonly MessageRow[],
  viewerId: string | null, serverId: string, retainId: string | null, serverNowMs: number, attention: readonly AttentionScopeRow[] = [],
) {
  return applyForumSidebarAttention(projectForumSidebarStructure(channels, memberships, messages, viewerId, serverId, retainId, serverNowMs), serverId, attention)
}

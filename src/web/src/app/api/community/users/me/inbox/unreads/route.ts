import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  readOrStale,
  withD1Retry,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { parseBoundedInt } from "@/lib/community/messages"
import { avatarInitial } from "@/lib/community/avatar"

function notificationMuteSets(
  settings: Array<{ level: string; serverId: string | null; channelId: string | null }>,
) {
  const mutedServers = new Set<string>()
  const mutedChannels = new Set<string>()
  for (const setting of settings) {
    if (setting.level !== "nothing") continue
    if (setting.channelId) mutedChannels.add(setting.channelId)
    else if (setting.serverId) mutedServers.add(setting.serverId)
  }
  return { mutedServers, mutedChannels }
}

export const GET = withAuth(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )

  // Resolve the viewer's visible channels once (top-level + child threads,
  // parent-climbed) and thread the id set into BOTH consumers so neither
  // recomputes it. Private threads under an invisible parent are excluded.
  type UnreadRow = Awaited<ReturnType<typeof queries.communityInbox.listUnreadChannels>>[number]
  type SettingRow = Awaited<ReturnType<typeof queries.communityNotificationSetting.getSettings>>[number]
  type MentionRow = Awaited<ReturnType<typeof queries.communityMention.listUnreadMentions>>[number]
  type UnreadDmRow = Awaited<ReturnType<typeof queries.communityInbox.listUnreadDms>>[number]
  type ForumOpenerRow = Awaited<ReturnType<typeof queries.communityInbox.listUnreadForumOpeners>>[number]
  const { value: fetched, stale } = await readOrStale<{
    unread: UnreadRow[]
    settings: SettingRow[]
    mentions: MentionRow[]
    unreadDms: UnreadDmRow[]
    forumOpeners: ForumOpenerRow[]
  }>(
    async () => {
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
      const [unread, settings, mentions, unreadDms] = await Promise.all([
        queries.communityInbox.listUnreadChannels(db, ctx.userId, visibleChannelIds),
        queries.communityNotificationSetting.getSettings(db, ctx.userId),
        queries.communityMention.listUnreadMentions(db, ctx.userId, { visibleChannelIds }),
        queries.communityInbox.listUnreadDms(db, ctx.userId),
      ])
      // Expand only top-level forum parents that have already passed the
      // visibility and notification-mute gates. The shared query receives no
      // global discovery surface — just this bounded parent id set.
      const { mutedServers, mutedChannels } = notificationMuteSets(settings)
      const forumParentIds = [...new Set(
        unread
          .filter(
            (row) =>
              !row.parentChannelId &&
              row.type === "forum" &&
              !mutedServers.has(row.serverId) &&
              !mutedChannels.has(row.channelId),
          )
          .map((row) => row.channelId),
      )]
      const forumOpeners = await queries.communityInbox.listUnreadForumOpeners(
        db,
        ctx.userId,
        forumParentIds,
      )
      return { unread, settings, mentions, unreadDms, forumOpeners }
    },
    { unread: [], settings: [], mentions: [], unreadDms: [], forumOpeners: [] },
    { route: "community/inbox/unreads" },
  )
  if (stale) {
    return writeJSON({ servers: [], dms: [], limit, truncated: false, stale: true })
  }
  const { unread, settings, mentions, unreadDms, forumOpeners } = fetched

  const { mutedServers, mutedChannels } = notificationMuteSets(settings)

  const mentionCountByChannel = new Map<string, number>()
  for (const m of mentions) {
    const cid = m.message.channelId
    if (!cid) continue
    mentionCountByChannel.set(cid, (mentionCountByChannel.get(cid) ?? 0) + 1)
  }

  // Split unread rows into top-level channels and child threads.
  // A child nests under its `parentChannelId`; a parent surfaces in the tree
  // even when it has no direct unread of its own (only unread children).
  type UnreadChild = {
    channelId: string
    channelName: string
    type: string | null
    lastMessageAt: string
    mentionCount: number
    openerMessageId?: string
    // Private stable-order fields. They are removed from the response below.
    sortSeq: number
    sortId: string
  }
  type ParentNode = {
    channelId: string
    channelName: string
    type: string | null
    serverId: string
    serverName: string
    lastMessageAt: string
    mentionCount: number
    hasDirectUnread: boolean
    children: UnreadChild[]
  }

  const parents = new Map<string, ParentNode>()
  const childrenByParent = new Map<string, Map<string, UnreadChild>>()

  for (const row of unread) {
    if (!row.serverId || !row.channelId || !row.serverName || !row.channelName) continue
    if (mutedServers.has(row.serverId)) continue
    if (row.parentChannelId) {
      // Child thread. Skip if the child itself is muted; the
      // parent-mute cascade is applied later (once we know which parents are
      // muted) so a child under a muted parent is dropped even if it isn't
      // individually muted.
      if (mutedChannels.has(row.channelId)) continue
      const children = childrenByParent.get(row.parentChannelId) ?? new Map<string, UnreadChild>()
      children.set(row.channelId, {
        channelId: row.channelId,
        channelName: row.channelName,
        type: row.type,
        lastMessageAt: row.lastMessageAt,
        mentionCount: mentionCountByChannel.get(row.channelId) ?? 0,
        sortSeq: 0,
        sortId: row.channelId,
      })
      childrenByParent.set(row.parentChannelId, children)
    } else {
      if (mutedChannels.has(row.channelId)) continue
      parents.set(row.channelId, {
        channelId: row.channelId,
        channelName: row.channelName,
        type: row.type,
        serverId: row.serverId,
        serverName: row.serverName,
        lastMessageAt: row.lastMessageAt,
        mentionCount: mentionCountByChannel.get(row.channelId) ?? 0,
        hasDirectUnread: true,
        children: [],
      })
    }
  }

  // Project unread parent openers as post rows. An opener and unread replies
  // for the same post share one childChannelId, so merge them into one row
  // while retaining the opener id as the parent forum's progressive-read
  // target. The authoritative title is supplied by the opener query.
  for (const opener of forumOpeners) {
    if (mutedChannels.has(opener.childChannelId)) continue
    const parent = parents.get(opener.forumChannelId)
    if (!parent || mutedServers.has(parent.serverId) || mutedChannels.has(parent.channelId)) continue

    const children = childrenByParent.get(opener.forumChannelId) ?? new Map<string, UnreadChild>()
    const existing = children.get(opener.childChannelId)
    if (existing) {
      existing.channelName = opener.title
      existing.type = existing.type ?? "thread"
      existing.openerMessageId = opener.openerMessageId
      if (opener.createdAt >= existing.lastMessageAt) {
        existing.lastMessageAt = opener.createdAt
        existing.sortSeq = opener.openerSeq
        existing.sortId = opener.openerMessageId
      }
    } else {
      children.set(opener.childChannelId, {
        channelId: opener.childChannelId,
        channelName: opener.title,
        type: "thread",
        lastMessageAt: opener.createdAt,
        mentionCount: mentionCountByChannel.get(opener.childChannelId) ?? 0,
        openerMessageId: opener.openerMessageId,
        sortSeq: opener.openerSeq,
        sortId: opener.openerMessageId,
      })
    }
    childrenByParent.set(opener.forumChannelId, children)
  }

  // Parents that have an unread child but no direct unread aren't in `unread`,
  // so their name isn't available — batch-resolve them. `getChannelsByIds` has
  // no visibility filter, but that's fine: the child already passed visibility,
  // which implies the parent is visible. serverId/serverName come from the
  // child rows (they joined `communityServer`).
  const missingParentIds = [...childrenByParent.keys()].filter((pid) => !parents.has(pid) && !mutedChannels.has(pid))
  if (missingParentIds.length > 0) {
    const resolved = await withD1Retry(
      () => queries.communityChannel.getChannelsByIds(db, missingParentIds),
      { route: "community/inbox/unreads:missing-parents" },
    )
    const resolvedById = new Map(resolved.map((c) => [c.id, c]))
    for (const pid of missingParentIds) {
      const ch = resolvedById.get(pid)
      if (!ch) continue
      if (mutedServers.has(ch.serverId)) continue
      parents.set(pid, {
        channelId: pid,
        channelName: ch.name,
        type: ch.type,
        serverId: ch.serverId,
        // serverName + a sort timestamp are backfilled from the child rows
        // below (those rows carry serverName via the communityServer join).
        serverName: "",
        lastMessageAt: "",
        mentionCount: mentionCountByChannel.get(pid) ?? 0,
        hasDirectUnread: false,
        children: [],
      })
    }
  }

  // Attach children to their parents (dropping children whose parent is muted
  // — the mute cascade — or whose parent couldn't be resolved).
  for (const [pid, kids] of childrenByParent) {
    const parent = parents.get(pid)
    if (!parent) continue // parent muted or unresolved → drop the subtree
    parent.children.push(...kids.values())
  }

  // Resolved-only parents (unread child, no direct unread) need serverName + a
  // sort timestamp. Backfill from the child rows, which carry both.
  for (const row of unread) {
    if (!row.parentChannelId) continue
    const parent = parents.get(row.parentChannelId)
    if (!parent || parent.hasDirectUnread) continue
    if (!parent.serverName && row.serverName) parent.serverName = row.serverName
    if (row.lastMessageAt > parent.lastMessageAt) parent.lastMessageAt = row.lastMessageAt
  }

  // Drop any parent that ended up with neither a direct unread nor a surviving
  // child (e.g. all children muted), or that never got a serverName.
  const grouped = new Map<
    string,
    { serverId: string; serverName: string; channels: Array<ParentNode & { children: UnreadChild[] }> }
  >()
  for (const parent of parents.values()) {
    if (!parent.hasDirectUnread && parent.children.length === 0) continue
    if (!parent.serverName) continue
    parent.children.sort(
      (a, b) =>
        b.lastMessageAt.localeCompare(a.lastMessageAt) ||
        b.sortSeq - a.sortSeq ||
        b.sortId.localeCompare(a.sortId),
    )
    let bucket = grouped.get(parent.serverId)
    if (!bucket) {
      bucket = { serverId: parent.serverId, serverName: parent.serverName, channels: [] }
      grouped.set(parent.serverId, bucket)
    }
    bucket.channels.push(parent)
  }

  const allServers = Array.from(grouped.values()).map((g) => ({
    serverId: g.serverId,
    serverName: g.serverName,
    channels: g.channels
      .sort(
        (a, b) =>
          b.lastMessageAt.localeCompare(a.lastMessageAt) ||
          b.channelId.localeCompare(a.channelId),
      )
      .map((c) => ({
        channelId: c.channelId,
        channelName: c.channelName,
        type: c.type ?? undefined,
        lastMessageAt: c.lastMessageAt,
        mentionCount: c.mentionCount,
        hasDirectUnread: c.hasDirectUnread,
        children: c.children.map((k) => ({
          channelId: k.channelId,
          channelName: k.channelName,
          type: k.type ?? undefined,
          lastMessageAt: k.lastMessageAt,
          mentionCount: k.mentionCount,
          ...(k.openerMessageId ? { openerMessageId: k.openerMessageId } : {}),
        })),
      })),
  }))
  allServers.sort((a, b) => {
    const aLatest = a.channels[0]?.lastMessageAt ?? ""
    const bLatest = b.channels[0]?.lastMessageAt ?? ""
    return aLatest < bLatest ? 1 : aLatest > bLatest ? -1 : 0
  })

  // Cap by total row count — each parent AND each child counts as one row, so a
  // single very active server (or one channel with many unread threads) can't
  // drown out the rest of the inbox payload.
  const nodeWeight = (c: { children: unknown[] }) => 1 + c.children.length
  const grandTotal = allServers.reduce((n, s) => n + s.channels.reduce((m, c) => m + nodeWeight(c), 0), 0)
  const servers: typeof allServers = []
  let total = 0
  for (const s of allServers) {
    if (total >= limit) break
    const keptChannels: typeof s.channels = []
    for (const c of s.channels) {
      const remaining = limit - total
      if (remaining <= 0) break
      const weight = nodeWeight(c)
      if (weight <= remaining) {
        keptChannels.push(c)
        total += weight
      } else {
        // Parent takes one slot; the rest go to children (may be zero).
        keptChannels.push({ ...c, children: c.children.slice(0, remaining - 1) })
        total = limit
        break
      }
    }
    if (keptChannels.length > 0) servers.push({ ...s, channels: keptChannels })
  }
  const truncated = total < grandTotal

  // DMs are a flat list sorted most-recent first. DM notification settings
  // don't exist today (`communityNotificationSetting` scopes are server/channel
  // only), so no muting pass — every unread DM the viewer participates in
  // surfaces. Blocked-user filtering intentionally stays off: DM messages
  // route gates on `requireDMAccess`; an unread from a blocked user is still
  // the viewer's DM and should appear here.
  const dms = unreadDms
    .map((d) => ({
      channelId: d.channelId,
      otherUserId: d.otherUserId,
      otherUserName: d.otherUserName,
      otherUserAvatar: d.otherUserImage ?? avatarInitial(d.otherUserName),
      lastMessageAt: d.lastMessageAt,
    }))
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))

  return writeJSON({ servers, dms, limit, truncated })
})

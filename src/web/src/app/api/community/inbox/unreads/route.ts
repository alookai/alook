import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { parseBoundedInt } from "@/lib/community/messages"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )

  // Resolve the viewer's visible channels once (top-level + threads/forum-posts,
  // parent-climbed) and thread the id set into BOTH consumers so neither
  // recomputes it. Private threads under an invisible parent are excluded.
  const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
  const [unread, settings, mentions, unreadDms] = await Promise.all([
    queries.communityInbox.listUnreadChannels(db, ctx.userId, visibleChannelIds),
    queries.communityNotificationSetting.getSettings(db, ctx.userId),
    queries.communityMention.listUnreadMentions(db, ctx.userId, { visibleChannelIds }),
    queries.communityInbox.listUnreadDms(db, ctx.userId),
  ])

  const mutedServers = new Set<string>()
  const mutedChannels = new Set<string>()
  for (const s of settings) {
    if (s.level !== "nothing") continue
    if (s.channelId) mutedChannels.add(s.channelId)
    else if (s.serverId) mutedServers.add(s.serverId)
  }

  const mentionCountByChannel = new Map<string, number>()
  for (const m of mentions) {
    const cid = m.message.channelId
    if (!cid) continue
    mentionCountByChannel.set(cid, (mentionCountByChannel.get(cid) ?? 0) + 1)
  }

  // Split unread rows into top-level channels and child threads/forum-posts.
  // A child nests under its `parentChannelId`; a parent surfaces in the tree
  // even when it has no direct unread of its own (only unread children).
  type UnreadChild = { channelId: string; channelName: string; lastMessageAt: string; mentionCount: number }
  type ParentNode = {
    channelId: string
    channelName: string
    serverId: string
    serverName: string
    lastMessageAt: string
    mentionCount: number
    hasDirectUnread: boolean
    children: UnreadChild[]
  }

  const parents = new Map<string, ParentNode>()
  const childrenByParent = new Map<string, UnreadChild[]>()

  for (const row of unread) {
    if (!row.serverId || !row.channelId || !row.serverName || !row.channelName) continue
    if (mutedServers.has(row.serverId)) continue
    if (row.parentChannelId) {
      // Child (thread / forum-post). Skip if the child itself is muted; the
      // parent-mute cascade is applied later (once we know which parents are
      // muted) so a child under a muted parent is dropped even if it isn't
      // individually muted.
      if (mutedChannels.has(row.channelId)) continue
      const list = childrenByParent.get(row.parentChannelId) ?? []
      list.push({
        channelId: row.channelId,
        channelName: row.channelName,
        lastMessageAt: row.lastMessageAt,
        mentionCount: mentionCountByChannel.get(row.channelId) ?? 0,
      })
      childrenByParent.set(row.parentChannelId, list)
    } else {
      if (mutedChannels.has(row.channelId)) continue
      parents.set(row.channelId, {
        channelId: row.channelId,
        channelName: row.channelName,
        serverId: row.serverId,
        serverName: row.serverName,
        lastMessageAt: row.lastMessageAt,
        mentionCount: mentionCountByChannel.get(row.channelId) ?? 0,
        hasDirectUnread: true,
        children: [],
      })
    }
  }

  // Parents that have an unread child but no direct unread aren't in `unread`,
  // so their name isn't available — batch-resolve them. `getChannelsByIds` has
  // no visibility filter, but that's fine: the child already passed visibility,
  // which implies the parent is visible. serverId/serverName come from the
  // child rows (they joined `communityServer`).
  const missingParentIds = [...childrenByParent.keys()].filter((pid) => !parents.has(pid) && !mutedChannels.has(pid))
  if (missingParentIds.length > 0) {
    const resolved = await queries.communityChannel.getChannelsByIds(db, missingParentIds)
    const resolvedById = new Map(resolved.map((c) => [c.id, c]))
    for (const pid of missingParentIds) {
      const ch = resolvedById.get(pid)
      if (!ch) continue
      if (mutedServers.has(ch.serverId)) continue
      parents.set(pid, {
        channelId: pid,
        channelName: ch.name,
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
    parent.children.push(...kids)
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
    parent.children.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
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
      .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
      .map((c) => ({
        channelId: c.channelId,
        channelName: c.channelName,
        lastMessageAt: c.lastMessageAt,
        mentionCount: c.mentionCount,
        children: c.children,
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
  // route gates on `requireDMParticipant`; an unread from a blocked user is
  // still the viewer's DM and should appear here.
  const dms = unreadDms
    .map((d) => ({
      dmConversationId: d.dmConversationId,
      otherUserId: d.otherUserId,
      otherUserName: d.otherUserName,
      otherUserAvatar: d.otherUserImage ?? avatarInitial(d.otherUserName),
      lastMessageAt: d.lastMessageAt,
    }))
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))

  return writeJSON({ servers, dms, limit, truncated })
})

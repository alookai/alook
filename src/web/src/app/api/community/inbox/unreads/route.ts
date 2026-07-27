import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
  readOrStale,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { parseBoundedInt } from "@/lib/community/messages"
import { avatarInitial } from "@/lib/community/avatar"

// Whether a channel's unread badge survives the viewer's effective notification
// level. `all` always badges; `nothing` never does; `mentions` badges only when
// the unread includes an @-mention (the non-@ badge is suppressed while the
// mention row still surfaces in the mention inbox).
function shouldBadge(level: string, hasMention: boolean): boolean {
  if (level === "nothing") return false
  if (level === "mentions") return hasMention
  return true
}

export const GET = withCommunityActor(async (req, ctx) => {
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
  type UnreadRow = Awaited<ReturnType<typeof queries.communityInbox.listUnreadChannels>>[number]
  type SettingRow = Awaited<ReturnType<typeof queries.communityNotificationSetting.getSettings>>[number]
  type MentionRow = Awaited<ReturnType<typeof queries.communityMention.listUnreadMentions>>[number]
  type UnreadDmRow = Awaited<ReturnType<typeof queries.communityInbox.listUnreadDms>>[number]
  const { value: fetched, stale } = await readOrStale<{
    unread: UnreadRow[]
    settings: SettingRow[]
    mentions: MentionRow[]
    unreadDms: UnreadDmRow[]
  }>(
    async () => {
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
      const [unread, settings, mentions, unreadDms] = await Promise.all([
        queries.communityInbox.listUnreadChannels(db, ctx.userId, visibleChannelIds),
        queries.communityNotificationSetting.getSettings(db, ctx.userId),
        queries.communityMention.listUnreadMentions(db, ctx.userId, { visibleChannelIds }),
        queries.communityInbox.listUnreadDms(db, ctx.userId),
      ])
      return { unread, settings, mentions, unreadDms }
    },
    { unread: [], settings: [], mentions: [], unreadDms: [] },
    { route: "community/inbox/unreads" },
  )
  if (stale) {
    return writeJSON({ servers: [], dms: [], limit, truncated: false, stale: true })
  }
  const { unread, settings, mentions, unreadDms } = fetched

  const mentionCountByChannel = new Map<string, number>()
  for (const m of mentions) {
    const cid = m.message.channelId
    if (!cid) continue
    mentionCountByChannel.set(cid, (mentionCountByChannel.get(cid) ?? 0) + 1)
  }

  // A channel's unread badge survives only if the viewer's EFFECTIVE level
  // (sub-channel override → parent channel → server → global "all") allows it.
  // This climbs in memory off the single `getSettings` fetch — no per-channel
  // query — so a child under a muted parent (or muted server) is suppressed by
  // the climb, and a `mentions`-level channel badges only when the unread
  // carries an @-mention.
  const badgeAllowed = (channel: {
    id: string
    serverId: string
    parentChannelId: string | null
  }) => {
    // A bot has no notification-level concept — it consumes every unread scope,
    // so the mute cascade doesn't apply. Humans climb their effective level.
    if (ctx.isBot) return true
    const level = queries.communityNotificationSetting.computeEffectiveLevel(settings, channel)
    return shouldBadge(level, (mentionCountByChannel.get(channel.id) ?? 0) > 0)
  }

  // Split unread rows into top-level channels and child threads/forum-posts.
  // A child nests under its `parentChannelId`; a parent surfaces in the tree
  // even when it has no direct unread of its own (only unread children).
  type UnreadChild = { channelId: string; channelName: string; type: string | null; lastMessageAt: string; lastMessageSeq: number; lastReadSeq: number | null; mentionCount: number }
  type ParentNode = {
    channelId: string
    channelName: string
    type: string | null
    serverId: string
    serverName: string
    lastMessageAt: string
    lastMessageSeq: number
    lastReadSeq: number | null
    mentionCount: number
    hasDirectUnread: boolean
    children: UnreadChild[]
  }

  const parents = new Map<string, ParentNode>()
  const childrenByParent = new Map<string, UnreadChild[]>()

  for (const row of unread) {
    if (!row.serverId || !row.channelId || !row.serverName || !row.channelName) continue
    if (row.parentChannelId) {
      // Child (thread / forum-post). Its effective level climbs
      // child → parent channel → server → global "all", so a child under a
      // muted parent (or muted server) is suppressed here, while a child with
      // its own `all` override survives even under a muted parent.
      if (!badgeAllowed({ id: row.channelId, serverId: row.serverId, parentChannelId: row.parentChannelId })) continue
      const list = childrenByParent.get(row.parentChannelId) ?? []
      list.push({
        channelId: row.channelId,
        channelName: row.channelName,
        type: row.type,
        lastMessageAt: row.lastMessageAt,
        lastMessageSeq: row.lastMessageSeq,
        lastReadSeq: row.lastReadSeq,
        mentionCount: mentionCountByChannel.get(row.channelId) ?? 0,
      })
      childrenByParent.set(row.parentChannelId, list)
    } else {
      if (!badgeAllowed({ id: row.channelId, serverId: row.serverId, parentChannelId: null })) continue
      parents.set(row.channelId, {
        channelId: row.channelId,
        channelName: row.channelName,
        type: row.type,
        serverId: row.serverId,
        serverName: row.serverName,
        lastMessageAt: row.lastMessageAt,
        lastMessageSeq: row.lastMessageSeq,
        lastReadSeq: row.lastReadSeq,
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
  // Structural resolution only: any parent with a surviving child needs a node
  // to hold it. The child already cleared its own effective-level climb (which
  // accounts for the parent and server), so a surviving child under a muted
  // parent (its own `all` override beating the parent) must still surface — no
  // parent-level mute filter here.
  const missingParentIds = [...childrenByParent.keys()].filter((pid) => !parents.has(pid))
  if (missingParentIds.length > 0) {
    const resolved = await queries.communityChannel.getChannelsByIds(db, missingParentIds)
    const resolvedById = new Map(resolved.map((c) => [c.id, c]))
    for (const pid of missingParentIds) {
      const ch = resolvedById.get(pid)
      if (!ch) continue
      parents.set(pid, {
        channelId: pid,
        channelName: ch.name,
        type: ch.type,
        serverId: ch.serverId,
        // serverName + a sort timestamp are backfilled from the child rows
        // below (those rows carry serverName via the communityServer join).
        serverName: "",
        lastMessageAt: "",
        // No direct unread on this parent — its own seq is irrelevant (a bot
        // pages each unread child by the child's own cursor).
        lastMessageSeq: 0,
        lastReadSeq: null,
        mentionCount: mentionCountByChannel.get(pid) ?? 0,
        hasDirectUnread: false,
        children: [],
      })
    }
  }

  // Attach children to their parents. Structural: a parent node exists for
  // every surviving child (direct-unread parents from the loop above,
  // child-only parents backfilled just above), so this only drops a subtree
  // when the parent couldn't be resolved. The mute cascade already happened in
  // each child's effective-level climb, not here.
  for (const [pid, kids] of childrenByParent) {
    const parent = parents.get(pid)
    if (!parent) continue // parent unresolved → drop the subtree
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
        type: c.type ?? undefined,
        lastMessageAt: c.lastMessageAt,
        lastMessageSeq: c.lastMessageSeq,
        lastReadSeq: c.lastReadSeq,
        mentionCount: c.mentionCount,
        children: c.children.map((k) => ({ ...k, type: k.type ?? undefined })),
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
      lastMessageSeq: d.lastMessageSeq,
      lastReadSeq: d.lastReadSeq,
    }))
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))

  return writeJSON({ servers, dms, limit, truncated })
})

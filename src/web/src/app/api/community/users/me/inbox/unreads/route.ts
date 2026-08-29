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
import { canonicalUserImage } from "@/lib/community/storage"

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
  type UnreadRow = Awaited<ReturnType<typeof queries.communityInbox.listEligibleUnreadChannels>>[number]
  type UnreadDmRow = Awaited<ReturnType<typeof queries.communityInbox.listEligibleUnreadDms>>[number]
  type ForumOpenerRow = Awaited<ReturnType<typeof queries.communityInbox.listUnreadForumOpeners>>[number]
  type ThreadOpenerRow = Awaited<ReturnType<typeof queries.communityInbox.listThreadOpenersByChildIds>>[number]
  const { value: fetched, stale } = await readOrStale<{
    unread: UnreadRow[]
    unreadDms: UnreadDmRow[]
    threadOpeners: Array<ThreadOpenerRow>
  }>(
    async () => {
      const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
      const [unread, unreadDms] = await Promise.all([
        queries.communityInbox.listEligibleUnreadChannels(db, ctx.userId, visibleChannelIds),
        queries.communityInbox.listEligibleUnreadDms(db, ctx.userId),
      ])
      // Expand only top-level forum parents that already have eligible unread.
      // The opener query applies the same current readability, cursor, policy,
      // and persisted-attention gate before returning individual post rows.
      const forumParentIds = [...new Set(
        unread
          .filter(
            (row) =>
              !row.parentChannelId &&
              row.type === "forum",
          )
          .map((row) => row.channelId),
      )]
      const unreadChildIds = [...new Set(
        unread
          .filter(
            (row) =>
              !!row.parentChannelId,
          )
          .map((row) => row.channelId),
      )]
      const [directForumOpeners, childThreadOpeners] = await Promise.all([
        queries.communityInbox.listUnreadForumOpeners(db, ctx.userId, forumParentIds),
        queries.communityInbox.listThreadOpenersByChildIds(db, ctx.userId, unreadChildIds),
      ])
      const directThreadOpeners: ThreadOpenerRow[] = directForumOpeners.map(
        (row: ForumOpenerRow) => ({
          parentChannelId: row.forumChannelId,
          parentType: "forum",
          openerMessageId: row.openerMessageId,
          childChannelId: row.childChannelId,
          title: row.title,
          createdAt: row.createdAt,
          openerSeq: row.openerSeq,
          openerUnread: true,
        }),
      )
      const threadOpeners = [...new Map(
        [...childThreadOpeners, ...directThreadOpeners].map((row) => [row.childChannelId, row]),
      ).values()]
      const forumParentsWithUnread = new Set([
        ...directForumOpeners.map((row) => row.forumChannelId),
        ...unread.flatMap((row) => row.parentChannelId ? [row.parentChannelId] : []),
      ])
      const withoutPhantomForumParents = unread.filter(
        (row) =>
          row.parentChannelId ||
          row.type !== "forum" ||
          forumParentsWithUnread.has(row.channelId),
      )
      return { unread: withoutPhantomForumParents, unreadDms, threadOpeners }
    },
    { unread: [], unreadDms: [], threadOpeners: [] },
    { route: "community/inbox/unreads" },
  )
  if (stale) {
    return writeJSON({ servers: [], dms: [], limit, truncated: false, stale: true })
  }
  const { unread, unreadDms, threadOpeners } = fetched

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
    parentChannelId?: string
    openerSeq?: number
    openerUnread?: boolean
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
  const unreadByChannelId = new Map(unread.map((row) => [row.channelId, row]))

  for (const row of unread) {
    if (!row.serverId || !row.channelId || !row.serverName || !row.channelName) continue
    if (row.parentChannelId) {
      const children = childrenByParent.get(row.parentChannelId) ?? new Map<string, UnreadChild>()
      children.set(row.channelId, {
        channelId: row.channelId,
        channelName: row.channelName,
        type: row.type,
        lastMessageAt: row.lastMessageAt,
        mentionCount: row.mentionCount,
        sortSeq: 0,
        sortId: row.channelId,
      })
      childrenByParent.set(row.parentChannelId, children)
    } else {
      parents.set(row.channelId, {
        channelId: row.channelId,
        channelName: row.channelName,
        type: row.type,
        serverId: row.serverId,
        serverName: row.serverName,
        lastMessageAt: row.lastMessageAt,
        mentionCount: row.mentionCount,
        hasDirectUnread: true,
        children: [],
      })
    }
  }

  // Enrich already-eligible child rows with their canonical parent opener.
  // Forum opener-only rows retain their existing nested presentation; text
  // opener-only unread remains represented by its parent channel row.
  for (const opener of threadOpeners) {
    const parent = parents.get(opener.parentChannelId)
    const unreadChild = unreadByChannelId.get(opener.childChannelId)
    if (!parent && unreadChild?.parentChannelId !== opener.parentChannelId) continue
    const serverId = parent?.serverId ?? unreadChild?.serverId
    if (!serverId) continue

    const children = childrenByParent.get(opener.parentChannelId) ?? new Map<string, UnreadChild>()
    const existing = children.get(opener.childChannelId)
    if (existing) {
      if (opener.parentType === "forum") existing.channelName = opener.title
      existing.type = existing.type ?? "thread"
      existing.parentChannelId = opener.parentChannelId
      existing.openerMessageId = opener.openerMessageId
      existing.openerSeq = opener.openerSeq
      existing.openerUnread = opener.openerUnread
      if (opener.createdAt >= existing.lastMessageAt) {
        existing.lastMessageAt = opener.createdAt
        existing.sortSeq = opener.openerSeq
        existing.sortId = opener.openerMessageId
      }
    } else {
      if (opener.parentType !== "forum" || !opener.openerUnread) continue
      children.set(opener.childChannelId, {
        channelId: opener.childChannelId,
        channelName: opener.title,
        type: "thread",
        lastMessageAt: opener.createdAt,
        mentionCount: unreadChild?.mentionCount ?? 0,
        parentChannelId: opener.parentChannelId,
        openerMessageId: opener.openerMessageId,
        openerSeq: opener.openerSeq,
        openerUnread: opener.openerUnread,
        sortSeq: opener.openerSeq,
        sortId: opener.openerMessageId,
      })
    }
    childrenByParent.set(opener.parentChannelId, children)
  }

  // Parents that have an unread child but no direct unread aren't in `unread`,
  // so their name isn't available — batch-resolve them. `getChannelsByIds` has
  // no visibility filter, but that's fine: the child already passed visibility,
  // which implies the parent is visible. serverId/serverName come from the
  // child rows (they joined `communityServer`).
  const missingParentIds = [...childrenByParent.keys()].filter((pid) => !parents.has(pid))
  if (missingParentIds.length > 0) {
    const resolved = await withD1Retry(
      () => queries.communityChannel.getChannelsByIds(db, missingParentIds),
      { route: "community/inbox/unreads:missing-parents" },
    )
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
        mentionCount: 0,
        hasDirectUnread: false,
        children: [],
      })
    }
  }

  // Attach children to their parents. Parent/server policy inheritance was
  // already resolved in SQL for each child's eligible message set.
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
          ...(k.parentChannelId ? { parentChannelId: k.parentChannelId } : {}),
          ...(k.openerMessageId ? { openerMessageId: k.openerMessageId } : {}),
          ...(k.openerSeq !== undefined ? { openerSeq: k.openerSeq } : {}),
          ...(k.openerMessageId ? { openerUnread: k.openerUnread === true } : {}),
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

  // DMs are a flat list sorted most-recent first. A DM is a channel-scoped
  // notification unit, so `listEligibleUnreadDms` has already applied current
  // participation, cursor, policy, and attention. Blocked-user filtering stays
  // off intentionally: DM messages
  // route gates on `requireDMAccess`; an unread from a blocked user is still
  // the viewer's DM and should appear here.
  const dms = unreadDms
    .map((d) => ({
      channelId: d.channelId,
      otherUserId: d.otherUserId,
      otherUserName: d.otherUserName,
      otherUserDiscriminator: d.otherUserDiscriminator,
      otherUserAvatar: canonicalUserImage(
        d.otherUserId,
        d.otherUserImage,
        d.otherUserAvatarVersion,
      ) ?? avatarInitial(d.otherUserName),
      otherUserAvatarVersion: d.otherUserAvatarVersion,
      lastMessageAt: d.lastMessageAt,
    }))
    .sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))

  return writeJSON({ servers, dms, limit, truncated })
})

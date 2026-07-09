import {
  queries,
  DEFAULT_INBOX_PAGE_SIZE,
  MAX_INBOX_PAGE_SIZE,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { parseBoundedInt } from "@/lib/community/messages"

export const GET = withAuth(async (req, ctx) => {
  const db = getDb(ctx.env.DB)
  const url = new URL(req.url)
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    DEFAULT_INBOX_PAGE_SIZE,
    MAX_INBOX_PAGE_SIZE,
  )

  const [unread, settings, mentions] = await Promise.all([
    queries.communityInbox.listUnreadChannels(db, ctx.userId),
    queries.communityNotificationSetting.getSettings(db, ctx.userId),
    queries.communityMention.listUnreadMentions(db, ctx.userId),
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

  const grouped = new Map<
    string,
    { serverId: string; serverName: string; channels: Array<{ channelId: string; channelName: string; lastMessageAt: string; mentionCount: number }> }
  >()
  for (const row of unread) {
    // Skip orphan rows where the server/channel was deleted between fetch
    // and join — the UI can't render them anyway.
    if (!row.serverId || !row.channelId || !row.serverName || !row.channelName) continue
    if (mutedServers.has(row.serverId)) continue
    if (mutedChannels.has(row.channelId)) continue
    let bucket = grouped.get(row.serverId)
    if (!bucket) {
      bucket = { serverId: row.serverId, serverName: row.serverName, channels: [] }
      grouped.set(row.serverId, bucket)
    }
    bucket.channels.push({
      channelId: row.channelId,
      channelName: row.channelName,
      lastMessageAt: row.lastMessageAt,
      mentionCount: mentionCountByChannel.get(row.channelId) ?? 0,
    })
  }

  const allServers = Array.from(grouped.values()).map((g) => ({
    ...g,
    channels: g.channels.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1)),
  }))
  allServers.sort((a, b) => {
    const aLatest = a.channels[0]?.lastMessageAt ?? ""
    const bLatest = b.channels[0]?.lastMessageAt ?? ""
    return aLatest < bLatest ? 1 : aLatest > bLatest ? -1 : 0
  })

  // Cap by channel count rather than server count — a single very active
  // server shouldn't be able to drown out the rest of the inbox payload.
  const servers: typeof allServers = []
  let total = 0
  for (const s of allServers) {
    const remaining = limit - total
    if (remaining <= 0) break
    if (s.channels.length <= remaining) {
      servers.push(s)
      total += s.channels.length
    } else {
      servers.push({ ...s, channels: s.channels.slice(0, remaining) })
      total = limit
    }
  }
  const truncated = total < allServers.reduce((n, s) => n + s.channels.length, 0)

  return writeJSON({ servers, limit, truncated })
})

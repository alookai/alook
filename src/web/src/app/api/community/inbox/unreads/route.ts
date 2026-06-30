import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)

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

  const servers = Array.from(grouped.values()).map((g) => ({
    ...g,
    channels: g.channels.sort((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1)),
  }))
  servers.sort((a, b) => {
    const aLatest = a.channels[0]?.lastMessageAt ?? ""
    const bLatest = b.channels[0]?.lastMessageAt ?? ""
    return aLatest < bLatest ? 1 : aLatest > bLatest ? -1 : 0
  })

  return writeJSON({ servers })
})

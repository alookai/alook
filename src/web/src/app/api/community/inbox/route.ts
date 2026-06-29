import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)

  const servers = await queries.communityServer.listUserServers(db, ctx.userId)

  // Get the latest lastMessageAt per server from channels
  const serverActivity = await queries.communityChannel.getServersLastActivity(
    db,
    servers.map((s) => s.id)
  )

  // Unread mentions to determine the unread badge
  const unreadMentions = await queries.communityMention.listUnreadMentions(db, ctx.userId)
  const unreadServerIds = new Set<string>()
  const channelIds = [...new Set(unreadMentions.filter((r) => r.message.channelId).map((r) => r.message.channelId!))]
  if (channelIds.length > 0) {
    const channels = await queries.communityChannel.getChannelsByIds(db, channelIds)
    for (const ch of channels) {
      unreadServerIds.add(ch.serverId)
    }
  }

  const items = servers.map((s) => ({
    id: s.id,
    server: s.name,
    initial: s.name.charAt(0).toUpperCase(),
    lastActivityAt: serverActivity.get(s.id) ?? s.createdAt,
    unread: unreadServerIds.has(s.id),
  }))

  return writeJSON({ items })
})

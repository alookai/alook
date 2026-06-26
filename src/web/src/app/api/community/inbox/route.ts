import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)

  const servers = await queries.communityServer.listUserServers(db, ctx.userId)

  // Get unread mentions to determine which servers have unread activity
  const unreadMentions = await queries.communityMention.listUnreadMentions(db, ctx.userId)

  // Build a set of serverIds that have unread mentions
  const unreadServerIds = new Set<string>()
  for (const row of unreadMentions) {
    if (row.message.channelId) {
      const ch = await queries.communityChannel.getChannel(db, row.message.channelId)
      if (ch) unreadServerIds.add(ch.serverId)
    }
  }

  const items = servers.map((s) => ({
    id: s.id,
    server: s.name,
    initial: s.name.charAt(0).toUpperCase(),
    lastActivityAt: s.createdAt,
    unread: unreadServerIds.has(s.id),
  }))

  return writeJSON({ items })
})

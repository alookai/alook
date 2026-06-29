import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityMention.listUnreadMentions(db, ctx.userId)

  // Batch fetch all channels and servers
  const channelIds = [...new Set(rows.filter((r) => r.message.channelId).map((r) => r.message.channelId!))]
  const channels = channelIds.length > 0 ? await queries.communityChannel.getChannelsByIds(db, channelIds) : []
  const channelMap = new Map(channels.map((ch) => [ch.id, ch]))

  const serverIds = [...new Set(channels.map((ch) => ch.serverId))]
  const servers = serverIds.length > 0 ? await queries.communityServer.getServersByIds(db, serverIds) : []
  const serverMap = new Map(servers.map((s) => [s.id, s]))

  const mentions = rows.map((row) => {
    const ch = row.message.channelId ? channelMap.get(row.message.channelId) : undefined
    const srv = ch ? serverMap.get(ch.serverId) : undefined
    return {
      id: row.mention.id,
      server: srv?.name ?? "Unknown",
      serverId: ch?.serverId,
      channel: ch?.name ?? "Unknown",
      channelId: row.message.channelId,
      m: {
        id: row.message.id,
        authorName: row.author.name ?? row.author.email ?? "Unknown",
        authorAvatar: row.author.image ?? (row.author.name ?? "?").charAt(0).toUpperCase(),
        content: row.message.content,
        createdAt: row.message.createdAt,
      },
    }
  })

  return writeJSON({ mentions })
})

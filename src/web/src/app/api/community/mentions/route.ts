import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityMention.listUnreadMentions(db, ctx.userId)

  // Resolve channel + server names for each mention
  const mentions = await Promise.all(
    rows.map(async (row) => {
      let server = "Unknown"
      let serverId: string | undefined
      let channel = "Unknown"
      let channelId: string | undefined
      if (row.message.channelId) {
        channelId = row.message.channelId
        const ch = await queries.communityChannel.getChannel(db, row.message.channelId)
        if (ch) {
          channel = ch.name
          serverId = ch.serverId
          const srv = await queries.communityServer.getServer(db, ch.serverId)
          if (srv) server = srv.name
        }
      }
      return {
        id: row.mention.id,
        server,
        serverId,
        channel,
        channelId,
        m: {
          id: row.message.id,
          authorName: row.author.name ?? row.author.email ?? "Unknown",
          authorAvatar: row.author.image ?? (row.author.name ?? "?").charAt(0).toUpperCase(),
          content: row.message.content,
          createdAt: row.message.createdAt,
        },
      }
    })
  )

  return writeJSON({ mentions })
})

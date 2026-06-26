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
      let channel = "Unknown"
      if (row.message.channelId) {
        const ch = await queries.communityChannel.getChannel(db, row.message.channelId)
        if (ch) {
          channel = ch.name
          const srv = await queries.communityServer.getServer(db, ch.serverId)
          if (srv) server = srv.name
        }
      }
      return {
        id: row.mention.id,
        server,
        channel,
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

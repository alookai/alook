import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)

  // Get user's servers with basic info.
  // Unread computation requires comparing read_state vs lastMessageAt per channel;
  // for now return a placeholder unreadCount of 0 (to be refined later).
  const servers = await queries.communityServer.listUserServers(db, ctx.userId)

  return writeJSON(
    servers.map((s) => ({
      ...s,
      unreadCount: 0,
    }))
  )
})

import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)

  const servers = await queries.communityServer.listUserServers(db, ctx.userId)

  const items = servers.map((s) => ({
    id: s.id,
    server: s.name,
    initial: s.name.charAt(0).toUpperCase(),
    lastActivityAt: s.createdAt,
    unread: false,
  }))

  return writeJSON({ items })
})

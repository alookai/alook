import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityFriendship.listPending(db, ctx.userId)
  const pending = rows.map((r) => ({
    id: r.id,
    name: r.name,
    avatar: r.image ?? r.name?.charAt(0).toUpperCase() ?? "?",
    kind: r.kind,
  }))
  return writeJSON({ pending })
})

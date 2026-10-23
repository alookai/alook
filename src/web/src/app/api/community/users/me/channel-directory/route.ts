import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  const directory = await queries.communityChannel.listChannelRefDirectoryForUser(
    db,
    ctx.userId,
  )
  return writeJSON({ directory })
})

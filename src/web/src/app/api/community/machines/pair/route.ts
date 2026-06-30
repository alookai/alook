import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const { tokenId, expiresAt } = await queries.communityMachine.createPairingToken(db, ctx.userId)
  return writeJSON({ tokenId, expiresAt })
})

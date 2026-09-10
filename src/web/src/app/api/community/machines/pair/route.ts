import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  try {
    const { tokenId, expiresAt } = await queries.communityMachine.createPairingToken(db, ctx.userId)
    return writeJSON({ tokenId, expiresAt })
  } catch (error) {
    if (error instanceof queries.productPlan.MachineLimitReachedError) {
      return writeJSON({ error: "MACHINE_LIMIT_REACHED", machineCapacity: error.capacity }, 409)
    }
    if (error instanceof queries.productPlan.ProductEntitlementUnavailableError) {
      return writeJSON({ error: "MACHINE_LIMIT_UNAVAILABLE" }, 503)
    }
    throw error
  }
})

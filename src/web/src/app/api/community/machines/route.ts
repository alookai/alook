import { readCommunityMachines, readCommunityMachineList, readCommunityMachineObservations } from "@/lib/community/machines.server"
import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withAuth(async (req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  try {
    const view = new URL(req.url).searchParams.get("view")
    return writeJSON(await (view === "list" ? readCommunityMachineList(db, ctx.userId) : view === "observations" ? readCommunityMachineObservations(db, ctx.userId) : readCommunityMachines(db, ctx.userId)))
  } catch (error) {
    if (error instanceof queries.productPlan.ProductEntitlementUnavailableError) {
      return writeJSON({ error: "MACHINE_LIMIT_UNAVAILABLE" }, 503)
    }
    throw error
  }
})

import { readCommunityMachines, readCommunityMachineList, readCommunityMachineObservations } from "@/lib/community/machines.server"
import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { readPlatformMachines } from "@/lib/community/machine-options.server"
import { writeJSON } from "@/lib/middleware/helpers"

export const GET = withCommunityActor(async (req, ctx) => {
  const db = getPrimaryDb(ctx.env.DB)
  if (ctx.actor.kind === "bot") return writeJSON(await readPlatformMachines(db, ctx.actor.ownerUserId, ctx.actor.machineId))
  try {
    const view = new URL(req.url).searchParams.get("view")
    return writeJSON(await (view === "list" ? readCommunityMachineList(db, ctx.actor.userId) : view === "observations" ? readCommunityMachineObservations(db, ctx.actor.userId) : readCommunityMachines(db, ctx.actor.userId)))
  } catch (error) {
    if (error instanceof queries.productPlan.ProductEntitlementUnavailableError) {
      return writeJSON({ error: "MACHINE_LIMIT_UNAVAILABLE" }, 503)
    }
    throw error
  }
})

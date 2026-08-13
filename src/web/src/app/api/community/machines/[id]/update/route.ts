import {
  SELF_UPDATE_MIN_DAEMON_VERSION,
  queries,
  releaseVersionGte,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { pushMachineUpdate } from "@/lib/community/bot-push"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_request, ctx) => {
  const machineId = ctx.params?.id as string
  if (!machineId) return writeError("machine id is required", 400)

  const db = getDb(ctx.env.DB)
  const machine = await queries.communityMachine.getMachineByIdForUser(
    db,
    ctx.userId,
    machineId,
  )
  if (!machine) return writeError("machine not found", 404)
  if (machine.status !== "online") {
    return writeError("machine is offline — bring its daemon online before updating", 409)
  }
  if (!releaseVersionGte(machine.daemonVersion, SELF_UPDATE_MIN_DAEMON_VERSION)) {
    return writeError("daemon must be updated manually before remote updates are available", 409)
  }

  const result = await pushMachineUpdate(ctx.env, machineId)
  if (result.deliveryError) {
    return writeError("could not deliver the daemon update", 503)
  }
  if (result.sent === 0) {
    return writeError("machine is offline — bring its daemon online before updating", 409)
  }
  return writeJSON({ dispatched: true })
})

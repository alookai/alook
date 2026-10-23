import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { pushMachineStop } from "@/lib/community/bot-push"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(async (_request, ctx) => {
  const machineId = ctx.params?.id as string
  if (!machineId) return writeError("machine id is required", 400)
  const machine = await queries.communityMachine.getMachineByIdForUser(getDb(ctx.env.DB), ctx.userId, machineId)
  if (!machine) return writeError("machine not found", 404)
  if (machine.status !== "online") return writeError("machine is offline", 409)

  const result = await pushMachineStop(ctx.env, machineId)
  if (result.deliveryError) return writeError("could not deliver the daemon stop command", 503)
  if (result.sent === 0) {
    return result.unsupported > 0
      ? writeError("update this daemon before remote Stop is available", 409)
      : writeError("machine is offline", 409)
  }
  return writeJSON({ dispatched: true })
})

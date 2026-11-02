import { withAuth } from "@/lib/middleware/auth-policy"
import { MachineRefreshRequestSchema, readBoundedJsonRequest, queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { pushMachineRefresh } from "@/lib/community/bot-push"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(humanAuthPolicy, async (request, ctx) => {
  const machineId = ctx.params?.id as string
  if (!machineId) return writeError("machine id is required", 400)
  const input = await readBoundedJsonRequest(request, 1024)
  const parsed = MachineRefreshRequestSchema.safeParse(input.ok ? input.value : null)
  if (!parsed.success) return writeError("invalid refresh request", 400)
  const machine = await queries.communityMachine.getMachineByIdForUser(getDb(ctx.env.DB), ctx.userId, machineId)
  if (!machine) return writeError("machine not found", 404)
  if (machine.status !== "online") return writeError("machine is offline", 409)
  const { requestId } = parsed.data
  const result = await pushMachineRefresh(ctx.env, machineId, requestId)
  if (result.deliveryError) return writeError("could not deliver the daemon refresh command", 503)
  if (result.sent === 0) return result.unsupported > 0
    ? writeError("update this daemon before remote Refresh is available", 409)
    : writeError("machine is offline", 409)
  return writeJSON({ dispatched: true, requestId })
})

import { queries, readBoundedJsonRequest, RuntimeModelDiscoveryRequestSchema } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { wsDoFetch } from "@/lib/broadcast"

export const POST = withAuth(async (req, ctx) => {
  const id = ctx.params?.id as string
  const machine = await queries.communityMachine.getMachineByIdForUser(getDb(ctx.env.DB), ctx.userId, id)
  if (!machine) return writeError("machine not found", 404)
  if (machine.status !== "online") return writeError("MACHINE_OFFLINE", 409)
  const input = await readBoundedJsonRequest(req, 4096)
  const payload = RuntimeModelDiscoveryRequestSchema.safeParse(input.ok ? input.value : null)
  if (!payload.success) return writeError("invalid request", 400)
  if (!machine.availableRuntimes.some((runtime) => runtime.id === payload.data.runtimeId)) {
    return writeError("runtime not found", 400)
  }
  try {
    const response = await wsDoFetch(ctx.env, `/community-machine/by-id/${encodeURIComponent(id)}/discover-models`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload.data),
    })
    if (!response.ok) return writeError("model discovery unavailable", 503)
    const receipt = await response.json() as { sent?: unknown; unsupported?: unknown }
    if (typeof receipt.sent !== "number" || !Number.isSafeInteger(receipt.sent) || receipt.sent < 0) {
      return writeError("model discovery unavailable", 503)
    }
    if (receipt.sent > 0) return writeJSON({ dispatched: true, requestId: payload.data.requestId }, 202)
    return writeError(typeof receipt.unsupported === "number" && receipt.unsupported > 0 ? "UPGRADE_REQUIRED" : "MACHINE_OFFLINE", 409)
  } catch {
    return writeError("model discovery unavailable", 503)
  }
})

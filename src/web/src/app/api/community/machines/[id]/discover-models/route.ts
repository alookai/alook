import { queries, readBoundedJsonRequest, RuntimeModelDiscoveryRequestSchema } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { wsDoFetch } from "@/lib/broadcast"

export const POST = withCommunityActor(async (req, ctx) => {
  const id = ctx.params?.id as string
  const failure = (message: string, status: number) => {
    if (ctx.actor.kind === "human") return writeError(message, status)
    const code = message === "MACHINE_OFFLINE" || message === "UPGRADE_REQUIRED" ? message
      : message === "machine not found" ? "MACHINE_NOT_FOUND" : message === "runtime not found" ? "BACKEND_NOT_FOUND"
        : message === "invalid request" ? "INVALID_DISCOVERY_REQUEST" : "DISCOVERY_UNAVAILABLE"
    const text = code === "MACHINE_OFFLINE" ? "Target machine is offline" : code === "UPGRADE_REQUIRED" ? "Target daemon must be upgraded to discover models" : message
    return writeJSON({ error: text, code, machineId: id }, status)
  }
  const machine = await queries.communityMachine.getMachineByIdForUser(getPrimaryDb(ctx.env.DB), ctx.actor.kind === "bot" ? ctx.actor.ownerUserId : ctx.actor.userId, id)
  if (!machine) return failure("machine not found", 404)
  if (machine.status !== "online") return failure("MACHINE_OFFLINE", 409)
  const input = await readBoundedJsonRequest(req, 4096)
  const payload = RuntimeModelDiscoveryRequestSchema.safeParse(input.ok ? input.value : null)
  if (!payload.success) return failure("invalid request", 400)
  if (!machine.availableRuntimes.some((runtime) => runtime.id === payload.data.runtimeId)) {
    return failure("runtime not found", 400)
  }
  try {
    const response = await wsDoFetch(ctx.env, `/community-machine/by-id/${encodeURIComponent(id)}/discover-models`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload.data),
    })
    if (!response.ok) return failure("model discovery unavailable", 503)
    const receipt = await response.json() as { sent?: unknown; unsupported?: unknown }
    if (typeof receipt.sent !== "number" || !Number.isSafeInteger(receipt.sent) || receipt.sent < 0) {
      return failure("model discovery unavailable", 503)
    }
    if (receipt.sent > 0) return writeJSON({ dispatched: true, requestId: payload.data.requestId }, 202)
    return failure(typeof receipt.unsupported === "number" && receipt.unsupported > 0 ? "UPGRADE_REQUIRED" : "MACHINE_OFFLINE", 409)
  } catch {
    return failure("model discovery unavailable", 503)
  }
})

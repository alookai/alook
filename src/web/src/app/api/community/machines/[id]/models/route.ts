import { queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { projectModelOptions } from "@/lib/community/machine-options.server"

export const GET = withCommunityActor(async (req, ctx) => {
  const ownerId = ctx.actor.kind === "bot" ? ctx.actor.ownerUserId : ctx.actor.userId
  const machine = await queries.communityBot.getMachineForOwner(getPrimaryDb(ctx.env.DB), ctx.params?.id as string, ownerId)
  if (!machine) return writeJSON({ error: "machine not found", code: "MACHINE_NOT_FOUND", machineId: ctx.params?.id }, 404)
  if (machine.status !== "online") return writeJSON({ error: "Target machine is offline", code: "MACHINE_OFFLINE", machineId: machine.id }, 409)
  const query = new URL(req.url).searchParams
  const runtime = machine.availableRuntimes.find((runtime) => runtime.id === query.get("backend"))
  if (!runtime) return writeJSON({ error: "backend not found", code: "BACKEND_NOT_FOUND", machineId: machine.id, backendId: query.get("backend") }, 404)
  return writeJSON(projectModelOptions(machine.id, runtime, query.get("model")))
})

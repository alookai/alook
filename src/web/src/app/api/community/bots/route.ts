import { NextRequest } from "next/server"
import {
  queries,
  CommunityBotCreateRequestSchema,
  COMMUNITY_BOT_LIMIT_PER_OWNER,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
import { pushBotEventToMachine } from "@/lib/community/bot-push"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const bots = await queries.communityBot.listBotsForOwner(db, ctx.userId)
  return writeJSON({ bots })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const [body, err] = await parseBody(req, CommunityBotCreateRequestSchema)
  if (err) return err

  const db = getDb(ctx.env.DB)

  // Cap check — anti-abuse floor, not a UX cap.
  const n = await queries.communityBot.countLiveBotsForOwner(db, ctx.userId)
  if (n >= COMMUNITY_BOT_LIMIT_PER_OWNER) {
    return writeError("BOT_LIMIT_REACHED", 409)
  }

  // Machine must be owned by caller AND runtime must be in its availableRuntimes
  // AND currently healthy. Unhealthy runtimes (e.g. broken binary caught by
  // spawn ENOENT and marked by the daemon) are rejected here so a UX picker
  // race doesn't create a bot bound to something that will always fail.
  const machine = await queries.communityBot.getMachineForOwner(
    db,
    body.machineId,
    ctx.userId,
  )
  if (!machine) return writeError("machine not found", 404)
  // getMachineForOwner canonicalizes `availableRuntimes` to include status/lastError
  // via the shared schema, so we can consult status here directly.
  const runtime = machine.availableRuntimes.find((r) => r.id === body.runtime)
  if (!runtime) {
    return writeError(
      `runtime ${body.runtime} not available on this machine`,
      400,
    )
  }
  if (runtime.status === "unhealthy") {
    return writeError(
      `runtime ${body.runtime} is currently unavailable on this machine — check the daemon logs`,
      400,
    )
  }

  const created = await queries.communityBot.createBot(db, {
    ownerId: ctx.userId,
    name: body.name,
    description: body.description,
    machineId: body.machineId,
    runtime: body.runtime,
    image: body.image ?? null,
  })

  // Audit — no serverId context (bot is created out-of-server). Queryable
  // via idx_audit_log_actor_created.
  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_CREATED,
    targetType: "user",
    targetId: created.botId,
    changes: JSON.stringify({
      botId: created.botId,
      machineId: body.machineId,
      runtime: body.runtime,
    }),
  })

  // Best-effort WS push — daemon may be offline. Cold-start warmup re-syncs
  // authoritative state on reconnect.
  await pushBotEventToMachine(ctx.env, body.machineId, {
    type: "bot:added",
    botId: created.botId,
    name: created.name,
    discriminator: created.discriminator,
    description: created.description || undefined,
  })

  return writeJSON(
    {
      bot: {
        id: created.botId,
        name: created.name,
        description: created.description,
        image: created.image,
        machineId: body.machineId,
        runtime: body.runtime,
      },
    },
    201,
  )
})

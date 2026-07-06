import { NextRequest, NextResponse } from "next/server"
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

  // Machine must be owned by caller AND runtime must be in its availableRuntimes.
  const machine = await queries.communityBot.getMachineForOwner(
    db,
    body.machineId,
    ctx.userId,
  )
  if (!machine) return writeError("machine not found", 404)
  const runtimes = (machine.availableRuntimes ?? []) as Array<
    string | { id?: string }
  >
  // availableRuntimes may be either string[] (legacy) or { id, version, ... }[].
  const runtimeIds = runtimes.map((r) => (typeof r === "string" ? r : r.id ?? ""))
  if (!runtimeIds.includes(body.runtime)) {
    return writeError(
      `runtime ${body.runtime} not available on this machine`,
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

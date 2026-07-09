import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { queries, CommunityBotPatchRequestSchema, WS_EVENTS } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError, parseBody } from "@/lib/middleware/helpers"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
import { pushBotEventToMachine } from "@/lib/community/bot-push"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const id = ctx.params?.id as string
  const bot = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!bot) return writeError("bot not found", 404)
  return writeJSON({ bot })
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const id = ctx.params?.id as string
  const [body, err] = await parseBody(req, CommunityBotPatchRequestSchema)
  if (err) return err
  const db = getDb(ctx.env.DB)

  const before = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!before) return writeError("bot not found", 404)

  const updated = await queries.communityBot.updateBot(db, id, ctx.userId, {
    name: body.name,
    description: body.description,
    image: body.image ?? undefined,
  })
  if (!updated) return writeError("bot not found", 404)

  const nameChanged = body.name !== undefined && body.name !== before.name
  const descriptionChanged =
    body.description !== undefined && body.description !== before.description
  // Emit bot:updated to the daemon iff name or description changed. Image-only
  // is display-only and does not affect the daemon's system-prompt assembly.
  if ((nameChanged || descriptionChanged) && before.machineId) {
    await pushBotEventToMachine(ctx.env, before.machineId, {
      type: "bot:updated",
      botId: id,
      name: updated.name,
      discriminator: updated.discriminator,
      description: updated.description || undefined,
    })
  }

  const changedFields: string[] = []
  if (body.name !== undefined) changedFields.push("name")
  if (body.description !== undefined) changedFields.push("description")
  if (body.image !== undefined) changedFields.push("image")
  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_UPDATED,
    targetType: "user",
    targetId: id,
    changes: JSON.stringify({ botId: id, fields: changedFields }),
  })

  return writeJSON({
    bot: {
      id,
      name: updated.name,
      description: updated.description,
      image: updated.image,
    },
  })
})

export const DELETE = withAuth(async (_req, ctx) => {
  const id = ctx.params?.id as string
  const db = getDb(ctx.env.DB)

  // Fetch binding first so we can push bot:removed to the daemon after the
  // delete commits. If ownership check fails, softDeleteBot returns false and
  // this data is untouched — no cross-owner leak.
  const before = await queries.communityBot.getBotOwnedBy(db, id, ctx.userId)
  if (!before) return writeError("bot not found", 404)

  // Snapshot server memberships BEFORE the delete removes them, so we can fan
  // out MEMBER_LEAVE per (server, botId) after the delete commits.
  const priorMemberships = await queries.communityBot.listBotServerMemberships(
    db,
    id,
    ctx.userId,
  )

  const ok = await queries.communityBot.softDeleteBot(db, id, ctx.userId)
  if (!ok) return writeError("bot not found", 404)

  for (const serverId of priorMemberships) {
    fanOutToServerMembers(serverId, {
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: id,
    })
  }

  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_DELETED,
    targetType: "user",
    targetId: id,
    changes: JSON.stringify({ botId: id }),
  })

  if (before.machineId) {
    await pushBotEventToMachine(ctx.env, before.machineId, {
      type: "bot:removed",
      botId: id,
    })
  }

  return new NextResponse(null, { status: 204 })
})

import { NextRequest } from "next/server"
import { queries, NOTIFICATION_LEVEL_VALUES, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { broadcastToUserSafe } from "@/lib/community/fanout"

async function broadcastRevision(userId: string, revision: number) {
  await broadcastToUserSafe(userId, {
    type: WS_EVENTS.READ_STATE_ADVANCED,
    revision,
    inboxChanged: true,
  })
}

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const auth = await requireMessageSurfaceAccess(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { level: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.level || !(NOTIFICATION_LEVEL_VALUES as readonly string[]).includes(body.level)) {
    return writeError(`level must be one of: ${NOTIFICATION_LEVEL_VALUES.join(", ")}`, 400)
  }

  const result = await queries.communityNotificationSetting.setChannelLevel(db, {
    userId: ctx.userId,
    channelId,
    level: body.level,
    actorKind: "human",
  })
  if (result.readStateRevision !== null) await broadcastRevision(ctx.userId, result.readStateRevision)

  return writeJSON(result.setting)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const auth = await requireMessageSurfaceAccess(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const result = await queries.communityNotificationSetting.removeChannelOverride(db, {
    userId: ctx.userId,
    channelId,
    actorKind: "human",
  })
  if (result.readStateRevision !== null) await broadcastRevision(ctx.userId, result.readStateRevision)

  return new Response(null, { status: 204 })
})

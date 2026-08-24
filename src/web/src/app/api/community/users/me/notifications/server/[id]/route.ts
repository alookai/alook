import { NextRequest } from "next/server"
import { queries, NOTIFICATION_LEVEL_VALUES, WS_EVENTS } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember } from "@/lib/community/permissions"
import { broadcastToUserSafe } from "@/lib/community/fanout"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
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

  const result = await queries.communityNotificationSetting.setServerLevel(db, {
    userId: ctx.userId,
    serverId,
    level: body.level,
    actorKind: "human",
  })
  if (result.readStateSnapshot) {
    await broadcastToUserSafe(ctx.userId, {
      type: WS_EVENTS.READ_STATE_ADVANCED,
      revision: result.readStateSnapshot.revision,
      readStates: result.readStateSnapshot.readStates,
      inboxChanged: true,
    })
  }

  return writeJSON(result.setting)
})

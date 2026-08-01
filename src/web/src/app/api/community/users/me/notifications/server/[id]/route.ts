import { NextRequest } from "next/server"
import { queries, withD1Retry, NOTIFICATION_LEVEL_VALUES } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember } from "@/lib/community/permissions"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
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

  // `withD1Retry` (D1-armor state 3): set-level is idempotent (upsert to value).
  const setting = await withD1Retry(
    () =>
      queries.communityNotificationSetting.setServerLevel(db, {
        userId: ctx.userId,
        serverId,
        level: body.level,
      }),
    { route: "users/me/notifications/server/set" },
  )

  return writeJSON(setting)
})

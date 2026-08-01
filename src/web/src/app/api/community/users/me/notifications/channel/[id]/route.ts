import { NextRequest } from "next/server"
import { queries, withD1Retry, NOTIFICATION_LEVEL_VALUES } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireChannelMember } from "@/lib/community/permissions"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
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

  // `withD1Retry` (D1-armor state 3): set-level is idempotent (upsert to a
  // value), safe to retry on a transient.
  const setting = await withD1Retry(
    () =>
      queries.communityNotificationSetting.setChannelLevel(db, {
        userId: ctx.userId,
        channelId,
        level: body.level,
      }),
    { route: "users/me/notifications/channel/set" },
  )

  return writeJSON(setting)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // `withD1Retry` (D1-armor state 3): remove-override by key is idempotent.
  await withD1Retry(
    () =>
      queries.communityNotificationSetting.removeChannelOverride(db, {
        userId: ctx.userId,
        channelId,
      }),
    { route: "users/me/notifications/channel/remove" },
  )

  return new Response(null, { status: 204 })
})

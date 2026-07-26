import { NextRequest } from "next/server"
import { queries, NOTIFICATION_LEVEL_VALUES } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { requireServerMember, requireChannelMember } from "@/lib/community/permissions"

/**
 * Unified notification-settings endpoint — read and write share one path.
 *
 * GET    → every setting row for the caller (`getSettings`).
 * PUT    → set a level. `{ scope: "server" | "channel", id, level }`.
 *          server → `setServerLevel` (server-member gate);
 *          channel → `setChannelLevel` (`requireChannelMember` — the access
 *          climb, so it works for ANY channelType: text/forum/post/thread).
 * DELETE → channel scope only = "Use Server Default": drop the override row so
 *          the effective level falls back to the parent/server default.
 */

function validLevel(level: unknown): level is string {
  return typeof level === "string" && (NOTIFICATION_LEVEL_VALUES as readonly string[]).includes(level)
}

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const settings = await queries.communityNotificationSetting.getSettings(db, ctx.userId)
  return writeJSON(settings)
})

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { scope?: string; id?: string; level?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const { scope, id, level } = body
  if (!id) return writeError("missing id", 400)
  if (!validLevel(level)) {
    return writeError(`level must be one of: ${NOTIFICATION_LEVEL_VALUES.join(", ")}`, 400)
  }

  if (scope === "server") {
    const auth = await requireServerMember(db, id, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
    const setting = await queries.communityNotificationSetting.setServerLevel(db, {
      userId: ctx.userId,
      serverId: id,
      level,
    })
    return writeJSON(setting)
  }

  if (scope === "channel") {
    const auth = await requireChannelMember(db, id, ctx.userId)
    if (!auth.ok) return writeError(auth.error, auth.status)
    const setting = await queries.communityNotificationSetting.setChannelLevel(db, {
      userId: ctx.userId,
      channelId: id,
      level,
    })
    return writeJSON(setting)
  }

  return writeError('scope must be "server" or "channel"', 400)
})

export const DELETE = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { scope?: string; id?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const { scope, id } = body
  if (scope !== "channel") return writeError('scope must be "channel"', 400)
  if (!id) return writeError("missing id", 400)

  const auth = await requireChannelMember(db, id, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  await queries.communityNotificationSetting.removeChannelOverride(db, {
    userId: ctx.userId,
    channelId: id,
  })

  return new Response(null, { status: 204 })
})

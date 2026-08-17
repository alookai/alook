import { NextRequest } from "next/server"
import { NOTIFICATION_LEVEL_VALUES, queries } from "@alook/shared"
import { requireMessageSurfaceAccess } from "@/lib/community/permissions"
import { getDb } from "@/lib/db"
import { withAuth, type AuthContext } from "@/lib/middleware/auth"
import { writeError, writeJSON } from "@/lib/middleware/helpers"

async function authorize(ctx: AuthContext & { params?: Record<string, string> }) {
  const botId = ctx.params?.id
  const channelId = ctx.params?.scopeId
  if (!botId || !channelId) return { ok: false as const, response: writeError("missing scope id", 400) }
  const db = getDb(ctx.env.DB)
  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return { ok: false as const, response: writeError("bot not found", 404) }
  const access = await requireMessageSurfaceAccess(db, channelId, bot.id)
  if (!access.ok) return { ok: false as const, response: writeError(access.error, access.status) }
  return { ok: true as const, db, botId: bot.id, channelId }
}

export const GET = withAuth(async (_req, ctx) => {
  const auth = await authorize(ctx)
  if (!auth.ok) return auth.response
  const setting = await queries.communityNotificationSetting.getChannelSetting(
    auth.db, auth.botId, auth.channelId,
  )
  return writeJSON({ level: setting?.level ?? null })
})

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const auth = await authorize(ctx)
  if (!auth.ok) return auth.response
  let body: { level?: string }
  try { body = await req.json() } catch { return writeError("invalid request body", 400) }
  if (!body.level || !(NOTIFICATION_LEVEL_VALUES as readonly string[]).includes(body.level)) {
    return writeError(`level must be one of: ${NOTIFICATION_LEVEL_VALUES.join(", ")}`, 400)
  }
  const setting = await queries.communityNotificationSetting.setChannelLevel(auth.db, {
    userId: auth.botId,
    channelId: auth.channelId,
    level: body.level,
  })
  return writeJSON(setting)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const auth = await authorize(ctx)
  if (!auth.ok) return auth.response
  await queries.communityNotificationSetting.removeChannelOverride(auth.db, {
    userId: auth.botId,
    channelId: auth.channelId,
  })
  return new Response(null, { status: 204 })
})

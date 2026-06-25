import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

const VALID_LEVELS = ["all", "mentions", "nothing"] as const

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify membership
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  let body: { level: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.level || !VALID_LEVELS.includes(body.level as typeof VALID_LEVELS[number])) {
    return writeError("level must be one of: all, mentions, nothing", 400)
  }

  const setting = await queries.communityNotificationSetting.setServerLevel(db, {
    userId: ctx.userId,
    serverId,
    level: body.level,
  })

  return writeJSON(setting)
})

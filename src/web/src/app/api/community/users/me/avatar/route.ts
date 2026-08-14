import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { handleBotAvatarUpload, handleUserAvatarUpload } from "@/lib/community/upload"
import { botAvatarUrl, userAvatarUrl } from "@/lib/community/storage"

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const userId = ctx.actor.userId
  const result = ctx.actor.kind === "bot"
    ? await handleBotAvatarUpload(req, ctx.env, userId)
    : await handleUserAvatarUpload(req, ctx.env, userId)
  if (!result.ok) return result.response

  const db = getDb(ctx.env.DB)
  const url = ctx.actor.kind === "bot" ? botAvatarUrl(userId) : userAvatarUrl(userId)
  await queries.user.updateUser(db, userId, { image: url })

  return writeJSON({ url })
})

import { NextRequest, NextResponse } from "next/server"
import { queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeError, writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
import { handleBotAvatarUpload, handleUserAvatarUpload } from "@/lib/community/upload"
import { botAvatarUrl, userAvatarUrl } from "@/lib/community/storage"
import { persistUploadedBotAvatar } from "@/lib/community/bot-avatar-persistence"

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const userId = ctx.actor.userId
  const db = getDb(ctx.env.DB)

  if (ctx.actor.kind === "bot") {
    const before = await queries.communityBot.getBotOwnedBy(
      db,
      userId,
      ctx.actor.ownerUserId,
    )
    if (!before) return writeError("bot not found", 404)

    const upload = await handleBotAvatarUpload(req, ctx.env, userId)
    if (!upload.ok) return upload.response

    const persisted = await persistUploadedBotAvatar(db, ctx.env.COMMUNITY_MEDIA, {
      botId: userId,
      ownerId: ctx.actor.ownerUserId,
    })
    if (persisted.kind === "not_found") return writeError("bot not found", 404)
    if (persisted.kind === "failed") return writeError("internal error", 500)
    return writeJSON({ url: botAvatarUrl(userId) })
  }

  const result = await handleUserAvatarUpload(req, ctx.env, userId)
  if (!result.ok) return result.response

  const url = userAvatarUrl(userId)
  // Better Auth updates the row and re-signs its cached session payload.
  // Without forwarding that cookie, a full /c remount starts from the old
  // session image and briefly paints a generated avatar until the canonical
  // profile request finishes.
  const auth = createAuth(ctx.env)
  const authResult = (await auth.api.updateUser({
    body: { image: url },
    headers: req.headers,
    returnHeaders: true,
  })) as { headers: Headers }

  const res = writeJSON({ url })
  const setCookies = authResult.headers.getSetCookie()
  if (setCookies.length === 0) return res

  const response = new NextResponse(res.body, res)
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie)
  return response
})

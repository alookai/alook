import { NextRequest, NextResponse } from "next/server"
import { queries } from "@alook/shared"
import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { createAuth } from "@/lib/auth"
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
  let sessionHeaders: Headers | undefined
  if (ctx.actor.kind === "bot") {
    await queries.user.updateUser(db, userId, { image: url })
  } else {
    // Better Auth updates the row and re-signs its cached session payload.
    // Without forwarding that cookie, a full /c remount starts from the old
    // session image and briefly paints a generated avatar until the canonical
    // profile request finishes.
    const auth = createAuth(ctx.env)
    const result = (await auth.api.updateUser({
      body: { image: url },
      headers: req.headers,
      returnHeaders: true,
    })) as { headers: Headers }
    sessionHeaders = result.headers
  }

  const res = writeJSON({ url })
  const setCookies = sessionHeaders?.getSetCookie() ?? []
  if (setCookies.length === 0) return res

  const response = new NextResponse(res.body, res)
  for (const cookie of setCookies) response.headers.append("Set-Cookie", cookie)
  return response
})

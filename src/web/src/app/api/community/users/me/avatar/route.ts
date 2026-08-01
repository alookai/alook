import { NextRequest } from "next/server"
import { queries, withD1Retry } from "@alook/shared"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { handleUserAvatarUpload } from "@/lib/community/upload"
import { userAvatarUrl } from "@/lib/community/storage"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const result = await handleUserAvatarUpload(req, ctx.env, ctx.userId)
  if (!result.ok) return result.response

  const db = getDb(ctx.env.DB)
  const url = userAvatarUrl(ctx.userId)
  // `withD1Retry` (D1-armor state 3): set-image is idempotent (same url), retry.
  await withD1Retry(() => queries.user.updateUser(db, ctx.userId, { image: url }), {
    route: "users/me/avatar",
  })

  return writeJSON({ url })
})

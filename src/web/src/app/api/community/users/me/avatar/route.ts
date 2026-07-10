import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
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
  await queries.user.updateUser(db, ctx.userId, { image: url })

  return writeJSON({ url })
})

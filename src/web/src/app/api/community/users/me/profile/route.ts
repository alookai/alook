import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { aboutMe?: string; bannerColor?: string | null }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (body.aboutMe === undefined && body.bannerColor === undefined) {
    return writeError("no changes provided", 400)
  }

  const data: { aboutMe?: string; bannerColor?: string | null } = {}
  if (body.aboutMe !== undefined) data.aboutMe = body.aboutMe
  if (body.bannerColor !== undefined) data.bannerColor = body.bannerColor

  const updated = await queries.communityUserProfile.updateProfile(
    db,
    ctx.userId,
    data
  )

  return writeJSON(updated)
})

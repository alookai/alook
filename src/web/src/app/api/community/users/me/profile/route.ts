import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const profile = await queries.communityUserProfile.getProfile(db, ctx.userId)
  return writeJSON({ aboutMe: profile?.aboutMe ?? "", bannerColor: profile?.bannerColor ?? null })
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { name?: string; aboutMe?: string; bannerColor?: string | null }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (body.aboutMe === undefined && body.bannerColor === undefined && body.name === undefined) {
    return writeError("no changes provided", 400)
  }

  // Update user name if provided
  if (body.name !== undefined) {
    const trimmed = body.name.trim()
    if (!trimmed) return writeError("name cannot be empty", 400)
    const existing = await queries.user.getUser(db, ctx.userId)
    await queries.user.updateUser(db, ctx.userId, { name: trimmed, image: existing?.image ?? null })
  }

  const data: { aboutMe?: string; bannerColor?: string | null } = {}
  if (body.aboutMe !== undefined) data.aboutMe = body.aboutMe
  if (body.bannerColor !== undefined) data.bannerColor = body.bannerColor

  let updated = null
  if (data.aboutMe !== undefined || data.bannerColor !== undefined) {
    updated = await queries.communityUserProfile.updateProfile(db, ctx.userId, data)
  }

  return writeJSON(updated ?? { aboutMe: "", bannerColor: null })
})

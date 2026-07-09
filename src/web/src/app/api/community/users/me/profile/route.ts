import { NextRequest } from "next/server"
import {
  queries,
  MAX_PROFILE_NAME_LENGTH,
  MAX_PROFILE_ABOUT_LENGTH,
  BANNER_COLOR_REGEX,
} from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const [profile, viewer] = await Promise.all([
    queries.communityUserProfile.getProfile(db, ctx.userId),
    queries.user.getUser(db, ctx.userId),
  ])
  return writeJSON({
    aboutMe: profile?.aboutMe ?? "",
    bannerColor: profile?.bannerColor ?? null,
    discriminator: viewer?.discriminator ?? "0000",
  })
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

  if (body.name !== undefined) {
    if (typeof body.name !== "string") return writeError("name must be a string", 400)
    const trimmed = body.name.trim()
    if (!trimmed) return writeError("name cannot be empty", 400)
    if (trimmed.length > MAX_PROFILE_NAME_LENGTH) {
      return writeError(`name must be ≤ ${MAX_PROFILE_NAME_LENGTH} characters`, 400)
    }
    await queries.user.updateUser(db, ctx.userId, { name: trimmed })
  }

  const data: { aboutMe?: string; bannerColor?: string | null } = {}
  if (body.aboutMe !== undefined) {
    if (typeof body.aboutMe !== "string") return writeError("aboutMe must be a string", 400)
    if (body.aboutMe.length > MAX_PROFILE_ABOUT_LENGTH) {
      return writeError(`aboutMe must be ≤ ${MAX_PROFILE_ABOUT_LENGTH} characters`, 400)
    }
    data.aboutMe = body.aboutMe
  }
  if (body.bannerColor !== undefined) {
    if (body.bannerColor !== null) {
      // Hex-only allowlist prevents CSS injection if the value is ever
      // rendered into a style attribute.
      if (typeof body.bannerColor !== "string" || !BANNER_COLOR_REGEX.test(body.bannerColor.trim())) {
        return writeError("bannerColor must be a hex color like #aabbcc", 400)
      }
      data.bannerColor = body.bannerColor.trim()
    } else {
      data.bannerColor = null
    }
  }

  let updated: { aboutMe: string | null; bannerColor: string | null } | null = null
  if (data.aboutMe !== undefined || data.bannerColor !== undefined) {
    updated = await queries.communityUserProfile.updateProfile(db, ctx.userId, data)
  }

  // Normalise the response shape — same as GET — so callers don't see
  // `userId` leak through on PATCH.
  return writeJSON({
    aboutMe: updated?.aboutMe ?? "",
    bannerColor: updated?.bannerColor ?? null,
  })
})

import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const dms = await queries.communityDm.listDMs(db, ctx.userId)
  return writeJSON(dms)
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { userId: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.userId) return writeError("userId is required", 400)
  if (body.userId === ctx.userId) return writeError("cannot DM yourself", 400)

  // Check if either user has blocked the other
  const blocked = await queries.communityFriendship.isBlocked(db, ctx.userId, body.userId)
  if (blocked) return writeError("forbidden", 403)

  const dm = await queries.communityDm.createOrGetDM(db, {
    userId1: ctx.userId,
    userId2: body.userId,
  })

  return writeJSON(dm)
})

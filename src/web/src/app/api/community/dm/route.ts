import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { guardDmOpen } from "@/lib/community/dm-guard"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityDm.listDMs(db, ctx.userId)
  const conversations = rows.map((r) => ({
    id: r.id,
    userId: r.otherUserId,
    name: r.otherUserName,
    discriminator: r.otherUserDiscriminator,
    avatar: r.otherUserImage ?? avatarInitial(r.otherUserName),
    status: "offline" as const,
    preview: "",
  }))
  return writeJSON({ conversations })
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

  // Default callerKind ("human") — 404-on-friend-failure / pass-as-human
  // preserved exactly as this route's pre-extraction behavior.
  const guard = await guardDmOpen(db, ctx.userId, body.userId)
  if (!guard.ok) return writeError(guard.error, guard.status)

  const dm = await queries.communityDm.createOrGetDM(db, {
    userId1: ctx.userId,
    userId2: body.userId,
  })

  return writeJSON({ conversation: dm })
})

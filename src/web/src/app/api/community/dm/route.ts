import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireNotBlocked } from "@/lib/community/permissions"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityDm.listDMs(db, ctx.userId)
  const conversations = rows.map((r) => ({
    id: r.id,
    userId: r.otherUserId,
    name: r.otherUserName ?? r.otherUserEmail ?? "Unknown",
    avatar: r.otherUserImage ?? (r.otherUserName ?? "?").charAt(0).toUpperCase(),
    status: "offline" as const,
    preview: "",
    messages: [],
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
  if (body.userId === ctx.userId) return writeError("cannot DM yourself", 400)

  // Make sure the target user exists — otherwise we silently create an
  // orphan DM row that the recipient never sees.
  const target = await queries.user.getUser(db, body.userId)
  if (!target) return writeError("user not found", 404)

  const blocked = await requireNotBlocked(db, ctx.userId, body.userId)
  if (!blocked.ok) return writeError(blocked.error, blocked.status)

  const dm = await queries.communityDm.createOrGetDM(db, {
    userId1: ctx.userId,
    userId2: body.userId,
  })

  return writeJSON({ conversation: dm })
})

import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"
import { createDmForUser } from "@/lib/community/create-channels"

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

  // Single-source creation core (route/disc create-door step): shares the same
  // createDmForUser the `POST /channels` door dispatches for the DM type. DM is
  // get-or-create by peer identity (createOrGetDM), a different key space than the
  // by-name collision policy — the helper keeps that boundary. Kept alive through
  // deploy; deleted at the flat-delete step.
  const result = await createDmForUser(db, { actorUserId: ctx.userId, peerUserId: body.userId })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ conversation: result.value })
})

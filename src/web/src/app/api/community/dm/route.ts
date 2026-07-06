import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireNotBlocked } from "@/lib/community/permissions"
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
  if (body.userId === ctx.userId) return writeError("cannot DM yourself", 400)

  // Make sure the target user exists — otherwise we silently create an
  // orphan DM row that the recipient never sees. Use `getUserInternal` so we
  // can gate bot targets on owner ↔ bot relationship.
  const target = await queries.user.getUserInternal(db, body.userId)
  if (!target || target.deletedAt !== null) return writeError("user not found", 404)

  // Bot-target gating: caller must be either the bot's owner OR in an
  // accepted friendship with the bot. Otherwise 404 — indistinguishable from
  // "user not found" to preserve pass-as-human.
  if (target.isBot === true) {
    const isOwner = target.ownerUserId === ctx.userId
    if (!isOwner) {
      const areFriends = await queries.communityFriendship.areFriends(
        db,
        ctx.userId,
        body.userId,
      )
      if (!areFriends) return writeError("user not found", 404)
    }
    // Owners: skip block-check with their own bot (self-block doesn't exist,
    // but skip the round-trip regardless).
    if (!isOwner) {
      const blocked = await requireNotBlocked(db, ctx.userId, body.userId)
      if (!blocked.ok) return writeError(blocked.error, blocked.status)
    }
  } else {
    const blocked = await requireNotBlocked(db, ctx.userId, body.userId)
    if (!blocked.ok) return writeError(blocked.error, blocked.status)
  }

  const dm = await queries.communityDm.createOrGetDM(db, {
    userId1: ctx.userId,
    userId2: body.userId,
  })

  return writeJSON({ conversation: dm })
})

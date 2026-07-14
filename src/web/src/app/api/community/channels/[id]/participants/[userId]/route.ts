import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireChannelAccess } from "@/lib/community/permissions"

/**
 * Leave a thread (remove a participant row). The viewer may remove THEMSELVES;
 * the thread creator may remove anyone. Thread-only. A later mention/speak
 * re-adds a user who left.
 */
export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const targetUserId = ctx.params?.userId
  if (!channelId || !targetUserId) return writeError("missing params", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (access.value.channel.type !== "thread") return writeError("not a thread", 400)

  const isSelf = targetUserId === ctx.userId
  if (!isSelf && !access.value.isCreator) return writeError("forbidden", 403)

  const removed = await queries.communityThread.removeThreadParticipant(db, channelId, targetUserId)
  if (!removed) return writeError("participant not found", 404)
  return new Response(null, { status: 204 })
})

/**
 * Mute / unmute the viewer's OWN thread notifications (keeps the participant
 * row, toggles `muted`). Only the viewer may change their own mute state.
 * Thread-only.
 */
export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  const targetUserId = ctx.params?.userId
  if (!channelId || !targetUserId) return writeError("missing params", 400)
  if (targetUserId !== ctx.userId) return writeError("can only change your own mute state", 403)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (access.value.channel.type !== "thread") return writeError("not a thread", 400)

  let body: { muted?: boolean }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  if (typeof body.muted !== "boolean") return writeError("muted (boolean) is required", 400)

  const updated = await queries.communityThread.setThreadParticipantMuted(
    db,
    channelId,
    targetUserId,
    body.muted,
  )
  if (!updated) return writeError("participant not found", 404)
  return writeJSON({ ok: true, muted: body.muted })
})

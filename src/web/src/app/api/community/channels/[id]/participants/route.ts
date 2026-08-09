import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS, isThread, PARTICIPANT_SOURCE } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireChannelAccess } from "@/lib/community/permissions"

// GET (the participant-list READ) was retired: the unified `/members` endpoint
// now serves the notify set in the canonical `MappedMember` shape, and the
// thread panel reads that. Only the participant WRITE endpoints remain here
// (POST add + DELETE in `[userId]/route.ts`).

/**
 * Add a participant to a thread — the "add from channel" flow. ANY current
 * viewer with access may add (passing `requireChannelAccess` means the
 * caller can see the unit — i.e. is a member of the parent channel/forum).
 * Other joins happen automatically via mention/speak. The target must be a
 * member of the PARENT's access audience (you can only pull in people who can
 * already see the channel/forum the unit lives in).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const channel = access.value.channel
  if (!isThread(channel.type)) {
    return writeError("not a thread", 400)
  }

  let body: { userId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }
  const targetUserId = body.userId
  if (!targetUserId || typeof targetUserId !== "string") {
    return writeError("userId is required", 400)
  }

  // The target must be able to see the parent channel. Resolve its audience via
  // the SAME source fan-out/read-gate uses (`resolveScopeMemberUserIds`), so the
  // "can this user see the parent" definition can't drift between add-validation
  // and who-actually-gets-messages (public → all server members; private → the
  // channel roster).
  const parentId = channel.parentChannelId
  if (!parentId) return writeError("thread has no parent channel", 400)
  const parentAudience = new Set(
    await queries.communityMembersResolver.resolveScopeMemberUserIds(db, {
      scope: "channel",
      scopeId: parentId,
    })
  )
  if (!parentAudience.has(targetUserId)) {
    return writeError("user is not a member of the parent channel", 400)
  }

  const created = await queries.communityThread.addThreadParticipant(db, {
    threadChannelId: channelId,
    userId: targetUserId,
    source: PARTICIPANT_SOURCE.ADDED,
  })

  // Notify the full participant set so every open Members drawer refreshes,
  // not just the target and the actor's optimistic mutation. Only on a
  // genuinely-new row (null = already a participant).
  if (created) {
    const event = {
      type: WS_EVENTS.CHANNEL_MEMBER_ADD,
      serverId: channel.serverId,
      channelId,
      userId: targetUserId,
    } as const
    const recipients = await queries.communityThread.listThreadParticipantUserIds(db, channelId)
    await Promise.all(
      [...new Set(recipients)].map((userId) => broadcastToUserSafe(userId, event)),
    )
  }

  return writeJSON({ ok: true }, 201)
})

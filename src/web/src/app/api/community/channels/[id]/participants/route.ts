import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { requireChannelAccess } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"

/**
 * List a thread's participants — the NOTIFY set (incl. muted rows, so the
 * viewer's own muted state shows). Thread-only. Any member of the parent
 * channel (who therefore passes the thread access gate) may read the list.
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (access.value.channel.type !== "thread") {
    return writeError("not a thread", 400)
  }

  const rows = await queries.communityThread.listThreadParticipants(db, channelId)
  const participants = rows.map((r) => ({
    userId: r.userId,
    name: r.userName ?? null,
    discriminator: r.discriminator ?? null,
    avatar: r.userImage ?? avatarInitial(r.userName ?? ""),
    source: r.source,
    muted: r.muted === 1,
  }))
  return writeJSON({ participants })
})

/**
 * Add a participant to a thread — the owner "add from channel" flow. Only the
 * thread CREATOR may add (mirrors the roster-remove "creator only" rule; other
 * joins happen automatically via mention/speak). The target must be a member of
 * the thread's PARENT CHANNEL audience (a thread can only pull in people who can
 * already see the channel it lives in).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const channel = access.value.channel
  if (channel.type !== "thread") return writeError("not a thread", 400)
  if (!access.value.isCreator) return writeError("forbidden", 403)

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
    source: "added",
  })

  // Notify the added user so their inbox/thread view reflects the new
  // participation. Only on a genuinely-new row (null = already a participant).
  if (created) {
    void broadcastToUserSafe(targetUserId, {
      type: WS_EVENTS.CHANNEL_MEMBER_ADD,
      serverId: channel.serverId,
      channelId,
      userId: targetUserId,
    })
  }

  return writeJSON({ ok: true }, 201)
})

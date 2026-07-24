import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS, isForum, isForumPost, isThread } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireChannelAccess } from "@/lib/community/permissions"
import { mapMemberForApi } from "@/lib/community/member-payload"

/**
 * List the full resolved audience of a channel — the canonical "who is in this
 * channel" endpoint. For a private-category channel that's admins ∪ creator ∪
 * explicit members; for a public/uncategorized channel it's every server
 * member. Each row carries `role`, `source` ("explicit" | "inherited" |
 * "admin"), and `isCreator` so the drawer can group and the manage-members
 * dialog can decide which rows are removable. Any caller with access may read.
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const { anchor, channel } = access.value

  // Thread / forum-post: the NOTIFY dimension. The panel == the participant set
  // (not the access audience), so a public forum post lists only its
  // participants, never the whole server. The row's `isCreator` locks the
  // UNIT's own author (`channel.creatorId`), NOT the access anchor. NOTE: the
  // live /c UI reads `/participants` for these units; this branch is API/agent
  // parity so a direct GET of a post's `/members` agrees.
  if (isThread(channel.type) || isForumPost(channel.type)) {
    const participants = await queries.communityThread.listThreadParticipants(db, channelId)
    const userIds = participants.map((p) => p.userId)
    const rows = await queries.communityMember.getMembersByUserIds(db, channel.serverId, userIds)
    const rowByUser = new Map(rows.map((r) => [r.userId, r]))
    const members = participants
      .map((p) => {
        const row = rowByUser.get(p.userId)
        if (!row) return null
        return mapMemberForApi(row, ctx.userId, {
          isCreator: p.userId === channel.creatorId,
          source: p.source,
        })
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
    return writeJSON({ members })
  }

  // Channel / forum: the ACCESS dimension. Resolve the audience (public → all
  // server members; private → own roster ∪ creator). The anchor IS the roster
  // for these top-level units, so the roster creator is `anchor.creatorId`.
  const scopeMembers = await queries.communityMembersResolver.resolveScopeMembers(db, {
    scope: isForum(channel.type) ? "forum" : "channel",
    scopeId: channelId,
  })
  const rows = await queries.communityMember.getMembersByUserIds(
    db,
    anchor.serverId,
    scopeMembers.map((m) => m.userId),
  )
  const rowByUser = new Map(rows.map((r) => [r.userId, r]))

  // `resolveScopeMembers` order is the source of truth for membership; hydrate
  // display via the server-member rows (soft-deleted users drop out — expected).
  const members = scopeMembers
    .map((sm) => {
      const row = rowByUser.get(sm.userId)
      if (!row) return null
      return mapMemberForApi(row, ctx.userId, {
        isCreator: sm.userId === anchor.creatorId,
        source: sm.source,
      })
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)

  return writeJSON({ members })
})

/**
 * Add a member to a private ACCESS unit — a top-level text channel OR a forum
 * (both own their roster; a forum resolves access like a channel). ANY current
 * member (or the creator) may add — passing `requireChannelAccess` for a private
 * unit already means the caller is the creator or an added member (admins have
 * no implicit access). The target must be an existing server member. Threads AND
 * forum posts are rejected — they're the NOTIFY dimension, inherit the parent's
 * roster, and take PARTICIPANTS (via the participants route), not access members.
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const channel = access.value.channel
  // Threads AND forum posts are the NOTIFY dimension — they inherit their parent
  // channel/forum's access roster and store their own set in the participant
  // table. You add PARTICIPANTS to them (via the participants route), not access
  // members. A thread has a `parentMessageId`; a forum post has a
  // `parentChannelId` but no `parentMessageId`.
  if (isThread(channel.type) || isForumPost(channel.type) || channel.parentMessageId) {
    return writeError("threads and forum posts inherit their parent's members — add participants instead", 400)
  }
  // `isPrivate` from requireChannelAccess reflects the category. A public
  // channel/forum has no explicit roster (everyone can access it).
  if (!access.value.isPrivate) {
    return writeError("channel is not in a private category", 400)
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

  const targetMember = await queries.communityMember.getMember(db, channel.serverId, targetUserId)
  if (!targetMember) return writeError("user is not a member of this server", 400)

  await queries.communityChannel.createChannelMember(db, {
    channelId,
    userId: targetUserId,
    addedBy: ctx.userId,
  })

  const event = {
    type: WS_EVENTS.CHANNEL_MEMBER_ADD,
    serverId: channel.serverId,
    channelId,
    userId: targetUserId,
  } as const
  const recipients = await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
  await Promise.all([...new Set([...recipients, targetUserId])].map((uid) => broadcastToUserSafe(uid, event)))

  logAudit(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "channel_member_add",
    targetType: "channel",
    targetId: channelId,
    changes: JSON.stringify({ userId: targetUserId }),
  })

  return writeJSON({ ok: true }, 201)
})

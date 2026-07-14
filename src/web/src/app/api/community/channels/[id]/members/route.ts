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

  const { anchor } = access.value
  const scopeMembers = await queries.communityMembersResolver.resolveScopeMembers(db, {
    scope: "channel",
    scopeId: channelId,
  })
  const rows = await queries.communityMember.getMembersByUserIds(
    db,
    anchor.serverId,
    scopeMembers.map((m) => m.userId),
  )
  const rowByUser = new Map(rows.map((r) => [r.userId, r]))

  // The roster creator is the UNIT's own creator: a forum post owns its roster,
  // so its creator is the post's `channel.creatorId` — NOT `anchor.creatorId`,
  // which for a post is the forum owner. For a thread/channel the anchor IS the
  // roster, so both agree. Mirrors the `rosterCreatorId` split in
  // `resolveChannelAccessContext`.
  const rosterCreatorId =
    isForumPost(access.value.channel.type)
      ? access.value.channel.creatorId
      : anchor.creatorId

  // `resolveScopeMembers` order is the source of truth for membership; hydrate
  // display via the server-member rows (soft-deleted users drop out — expected).
  const members = scopeMembers
    .map((sm) => {
      const row = rowByUser.get(sm.userId)
      if (!row) return null
      return mapMemberForApi(row, ctx.userId, {
        isCreator: sm.userId === rosterCreatorId,
        source: sm.source,
      })
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)

  return writeJSON({ members })
})

/**
 * Add a member to a private access unit — a top-level channel OR a forum post
 * (both own their roster in the nested-membership model). ANY current member
 * (or the creator) may add — passing `requireChannelAccess` for a private unit
 * already means the caller is the creator or an added member (admins have no
 * implicit access). The target must be an existing server member. Threads are
 * rejected — they're the notification dimension and inherit the parent
 * channel's roster (participants join via mention/speak/owner-add, not here).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const channel = access.value.channel
  // Threads are notify-only (roster lives on the participant table); a thread
  // has a `parentMessageId`. A forum post also has a `parentChannelId` but NO
  // `parentMessageId` and IS its own access unit, so it's allowed.
  if (isThread(channel.type) || channel.parentMessageId) {
    return writeError("threads inherit their parent channel's members", 400)
  }
  // A FORUM's membership is DERIVED from its posts (the union) — it has no roster
  // of its own, so a member row on the forum would never be read. Reject: add
  // people to individual posts, not the forum.
  if (isForum(channel.type)) {
    return writeError("forum membership is derived from its posts — add members to a post", 400)
  }
  // `isPrivate` from requireChannelAccess reflects the (climbed) category — for
  // a post that's the forum's category. Public units have no explicit roster.
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

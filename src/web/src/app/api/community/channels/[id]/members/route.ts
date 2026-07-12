import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, WS_EVENTS } from "@alook/shared"
import { broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireChannelAccess } from "@/lib/community/permissions"
import { avatarInitial } from "@/lib/community/avatar"

/**
 * List the explicit members of a private-category channel. Any caller with
 * access to the channel may read the roster (creator, added members, admins).
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)

  const rows = await queries.communityChannel.listChannelMembers(db, channelId)
  const users = await queries.user.getUsersByIds(db, rows.map((r) => r.userId))
  const byId = new Map(users.map((u) => [u.id, u]))
  const creatorId = access.value.channel.creatorId

  const members = rows.map((r) => {
    const u = byId.get(r.userId)
    return {
      userId: r.userId,
      name: u?.name ?? null,
      discriminator: u?.discriminator ?? null,
      avatar: u?.image ?? avatarInitial(u?.name ?? ""),
      addedAt: r.addedAt,
      isCreator: r.userId === creatorId,
    }
  })

  return writeJSON({ members })
})

/**
 * Add a server member to a private-category channel. Only the creator/admins
 * (canManage) may add. The target must be an existing server member, and the
 * channel must be a top-level channel in a PRIVATE category (threads inherit
 * their parent's roster — their own `categoryId` is NULL — so they're rejected).
 */
export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (!access.value.canManage) return writeError("forbidden", 403)

  const channel = access.value.channel
  if (channel.parentChannelId) {
    return writeError("threads inherit their parent channel's members", 400)
  }
  // Top-level channel → its anchor is itself, so `isPrivate` reflects its own
  // category. Public/uncategorized channels have no explicit roster.
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

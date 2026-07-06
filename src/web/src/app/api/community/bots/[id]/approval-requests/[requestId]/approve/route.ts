import { queries, ROLES, WS_EVENTS } from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { fanOutToServerMembers, broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * Approve a pending bot approval request. Two kinds:
 *   - "join_server": insert communityServerMember (skip if already there),
 *                    fan out MEMBER_JOIN.
 *   - "friend": insert accepted communityFriendship, broadcast FRIEND_ACCEPT
 *               to the requester (same event a human accept sends — Bob
 *               cannot tell this came from a bot).
 */
export const POST = withAuth(async (_req, ctx) => {
  const botId = ctx.params?.id as string
  const requestId = ctx.params?.requestId as string
  const db = getDb(ctx.env.DB)

  const bot = await queries.communityBot.getBotOwnedBy(db, botId, ctx.userId)
  if (!bot) return writeError("bot not found", 404)

  const request = await queries.communityBot.getApprovalRequest(db, requestId)
  if (!request || request.botId !== botId) {
    return writeError("approval request not found", 404)
  }
  if (request.status !== "pending") {
    return writeError("request already resolved", 400)
  }

  if (request.kind === "join_server") {
    if (!request.serverId) return writeError("malformed request", 400)
    const alreadyMember = await queries.communityMember.getMember(
      db,
      request.serverId,
      botId,
    )
    if (!alreadyMember) {
      const added = await queries.communityMember.addMember(db, {
        serverId: request.serverId,
        userId: botId,
        role: ROLES.MEMBER,
      })
      const joinEvent: CommunityMemberJoin = {
        type: WS_EVENTS.MEMBER_JOIN,
        serverId: request.serverId,
        member: {
          id: added.id,
          userId: botId,
          name: bot.name,
          avatar: bot.image ?? undefined,
          role: added.role ?? ROLES.MEMBER,
          joinedAt: added.joinedAt,
        },
      }
      fanOutToServerMembers(request.serverId, joinEvent)
    }
    await queries.communityBot.resolveApprovalRequest(db, requestId, "approved")
    logAudit(db, {
      serverId: request.serverId,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_JOIN_APPROVED,
      targetType: "user",
      targetId: botId,
      changes: JSON.stringify({ botId, serverId: request.serverId }),
    })
    logAudit(db, {
      serverId: request.serverId,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_ADDED_TO_SERVER,
      targetType: "user",
      targetId: botId,
      changes: JSON.stringify({
        botId,
        serverId: request.serverId,
        kind: "friend_of_bot_added",
      }),
    })
    return writeJSON({ status: "approved", kind: "join_server" })
  }

  // kind === "friend"
  const friendship = await queries.communityFriendship.createAcceptedFriendship(db, {
    requesterId: request.requestedByUserId,
    addresseeId: botId,
  })
  await queries.communityBot.resolveApprovalRequest(db, requestId, "approved")
  logAudit(db, {
    serverId: null,
    actorId: ctx.userId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_FRIEND_APPROVED,
    targetType: "user",
    targetId: botId,
    changes: JSON.stringify({
      botId,
      requestedByUserId: request.requestedByUserId,
    }),
  })
  if (friendship) {
    // Requester sees zoe pop into their friend list — same event a human
    // accepting would emit.
    broadcastToUserSafe(request.requestedByUserId, {
      type: WS_EVENTS.FRIEND_ACCEPT,
      friendshipId: friendship.id,
    })
  }
  return writeJSON({ status: "approved", kind: "friend" })
})

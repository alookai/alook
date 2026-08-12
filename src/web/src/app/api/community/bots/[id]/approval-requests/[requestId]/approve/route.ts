import { queries, ROLES, WS_EVENTS } from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { fanOutToServerMembers } from "@/lib/community/fanout"

/**
 * Approve a pending bot approval request. After migration 0065 only the
 * "join_server" kind survives (friend requests moved to community_friendship /
 * the owner-decision route). A row of any other kind 404s — such rows were
 * removed by the migration; this is a defensive path.
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
  if (request.kind !== "join_server") {
    return writeError("approval request not found", 404)
  }
  if (request.status !== "pending") {
    return writeError("request already resolved", 400)
  }

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
        discriminator: bot.discriminator,
        avatar: bot.image ?? undefined,
        role: added.role ?? ROLES.MEMBER,
        joinedAt: added.joinedAt,
      },
    }
    fanOutToServerMembers(request.serverId, joinEvent)
  }
  await queries.communityBot.resolveApprovalRequest(db, requestId, "approved")
  return writeJSON({ status: "approved", kind: "join_server" })
})

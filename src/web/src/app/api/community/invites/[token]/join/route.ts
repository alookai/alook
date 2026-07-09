import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, ROLES, WS_EVENTS, isUniqueConstraintError } from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"

export const POST = withAuth(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("invite token is required", 400)

  const db = getDb(ctx.env.DB)

  let result: Awaited<ReturnType<typeof queries.communityInvite.useInvite>>
  try {
    result = await queries.communityInvite.useInvite(db, token, ctx.userId)
  } catch (err: unknown) {
    if (isUniqueConstraintError(err)) {
      return writeError("Already a member", 400)
    }
    throw err
  }

  if (!result) {
    return writeError("Invalid or expired invite", 400)
  }

  logAudit(db, {
    serverId: result.invite.serverId,
    actorId: ctx.userId,
    action: "member_join",
    targetType: "invite",
    targetId: result.invite.id,
  })

  const memberEvent: CommunityMemberJoin = {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: result.invite.serverId,
    member: {
      id: result.member.id,
      userId: result.member.userId,
      name: result.member.nickname ?? result.member.userName,
      avatar: result.member.userImage ?? undefined,
      role: result.member.role ?? ROLES.MEMBER,
      joinedAt: result.member.joinedAt,
    },
  }

  fanOutToServerMembers(
    result.invite.serverId,
    memberEvent,
    { excludeUserId: ctx.userId },
  )

  return writeJSON({ member: result.member, serverId: result.invite.serverId })
})

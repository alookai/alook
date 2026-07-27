import { withCommunityActor } from "@/lib/middleware/community-actor"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, ROLES, WS_EVENTS, isUniqueConstraintError } from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { fanOutToServerMembers, broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
import { memberDisplay } from "@/lib/community/member-payload"

export const POST = withCommunityActor(async (_req, ctx) => {
  const token = ctx.params?.token
  if (!token) return writeError("invite token is required", 400)

  const db = getDb(ctx.env.DB)

  // Bot owner-gate: a bot may only join via an invite created by its OWNER, so
  // an owner can hand their bot any link they pasted without the bot having to
  // reason about who sent it. `createdBy === null` (creator account gone) is
  // the generic "invalid" case, not an owner mismatch. Both checks run BEFORE
  // useInvite so a foreign/dead-creator invite is never consumed by a rejected
  // bot attempt. Humans skip this gate entirely.
  if (ctx.isBot) {
    const invite = await queries.communityInvite.getInviteByToken(db, token)
    if (!invite || invite.createdBy === null) {
      return writeError("Invalid or expired invite", 400)
    }
    if (invite.createdBy !== ctx.ownerUserId) {
      return writeError("This invite was not created by your owner — refusing to join.", 403)
    }
  }

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
    action: ctx.isBot ? COMMUNITY_AUDIT_ACTIONS.BOT_JOINED_VIA_INVITE : "member_join",
    targetType: "invite",
    targetId: result.invite.id,
  })

  const memberEvent: CommunityMemberJoin = {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: result.invite.serverId,
    member: {
      id: result.member.id,
      userId: result.member.userId,
      name: memberDisplay(result.member.nickname, result.member.userName),
      discriminator: result.member.discriminator ?? undefined,
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

  // A bot's owner isn't necessarily a member of the server the bot just
  // joined, so the member-scoped fan-out above never reaches them. Send the
  // join directly to the owner so their bot-list / server-rail updates without
  // a refresh. If the owner IS a member, the client dedupes by userId, so the
  // double-delivery is a no-op.
  if (ctx.isBot && ctx.ownerUserId) {
    broadcastToUserSafe(ctx.ownerUserId, memberEvent)
  }

  return writeJSON({ member: result.member, serverId: result.invite.serverId })
})

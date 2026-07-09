import { NextResponse, type NextRequest } from "next/server"
import { queries, ROLES, WS_EVENTS, isUniqueConstraintError, CommunityAgentJoinServerRequestSchema } from "@alook/shared"
import type { CommunityMemberJoin } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { fanOutToServerMembers, broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"

/**
 * POST /api/community/agent/joinServer — `alook server join --invite <link>`.
 * Body `{ invite }` (bare token — the CLI extracts it client-side). Enforces
 * an owner-only check: the invite must have been created by THIS bot's
 * owner, so an owner can safely tell their bot to join any invite the owner
 * pastes without the bot reasoning about who sent it.
 *
 * `invite.createdBy === null` (the original creator's account no longer
 * exists) is treated as the generic "Invalid or expired invite" case, NOT an
 * owner mismatch — checked before the real-mismatch branch (see plan's
 * "Nullable createdBy" design note). Both rejection branches run BEFORE
 * `useInvite`, so a foreign/dead-creator invite is never consumed by a
 * rejected attempt.
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentJoinServerRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }

  const invite = await queries.communityInvite.getInviteByToken(db, parsed.data.invite)
  if (!invite) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 })
  }
  if (invite.createdBy === null) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 })
  }
  if (invite.createdBy !== ctx.ownerUserId) {
    return NextResponse.json(
      {
        error: "This invite was not created by your owner — refusing to join.",
        hint: "Ask your owner to send an invite link they created themselves.",
      },
      { status: 403 },
    )
  }

  let result: Awaited<ReturnType<typeof queries.communityInvite.useInvite>>
  try {
    result = await queries.communityInvite.useInvite(db, parsed.data.invite, ctx.botUserId)
  } catch (err: unknown) {
    if (isUniqueConstraintError(err)) {
      return NextResponse.json({ error: "Already a member" }, { status: 400 })
    }
    throw err
  }
  if (!result) {
    return NextResponse.json({ error: "Invalid or expired invite" }, { status: 400 })
  }

  logAudit(db, {
    serverId: result.invite.serverId,
    actorId: ctx.botUserId,
    action: COMMUNITY_AUDIT_ACTIONS.BOT_JOINED_VIA_INVITE,
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
      discriminator: result.member.discriminator ?? undefined,
      avatar: result.member.userImage ?? undefined,
      role: result.member.role ?? ROLES.MEMBER,
      joinedAt: result.member.joinedAt,
    },
  }

  fanOutToServerMembers(result.invite.serverId, memberEvent, { excludeUserId: ctx.botUserId })

  // The bot's OWNER isn't necessarily a member of the server the bot just
  // joined, so `fanOutToServerMembers` (scoped to existing members) will
  // never reach them. Send the same event directly to the owner so their
  // bot-list / server-rail reflects the join without a hard refresh. If
  // the owner IS also a member, `patchCacheJoin` in
  // `use-server-members.ts` dedupes by userId (`total` bump is a no-op on
  // re-delivery), so double-delivery is safe.
  broadcastToUserSafe(ctx.ownerUserId, memberEvent)

  const server = await queries.communityServer.getServer(db, result.invite.serverId)
  return NextResponse.json({ server: { id: server!.id, name: server!.name } })
})

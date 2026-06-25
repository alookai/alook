import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import type { CommunityInviteCreate } from "@/lib/community/ws-events"

export const GET = withAuth(async (req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) {
    return writeError("server id is required", 400)
  }

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) {
    return writeError("not a member of this server", 403)
  }

  const invites = await queries.communityInvite.listServerInvites(db, serverId)
  return writeJSON({ invites })
})

export const POST = withAuth(async (req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) {
    return writeError("server id is required", 400)
  }

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) {
    return writeError("not a member of this server", 403)
  }

  let body: { maxUses?: number; expiresAt?: string } = {}
  try {
    body = await req.json()
  } catch {
    // empty body is fine — all fields are optional
  }

  const invite = await queries.communityInvite.createInvite(db, {
    serverId,
    createdBy: ctx.userId,
    maxUses: body.maxUses,
    expiresAt: body.expiresAt,
  })

  await queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "invite_create",
    targetType: "invite",
    targetId: invite.id,
  })

  const event: CommunityInviteCreate = {
    type: "community:invite.create",
    serverId,
    invite: {
      id: invite.id,
      token: invite.token,
      maxUses: invite.maxUses,
      uses: invite.uses,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    },
  }

  fanOutToServerMembers(serverId, event, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON({ invite }, 201)
})

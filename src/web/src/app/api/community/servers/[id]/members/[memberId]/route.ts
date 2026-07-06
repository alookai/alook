import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  isServerOwner,
  isAssignableRole,
  ASSIGNABLE_ROLES,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit, COMMUNITY_AUDIT_ACTIONS } from "@/lib/community/audit"
import { requireServerAdmin } from "@/lib/community/permissions"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  const memberId = ctx.params?.memberId
  if (!serverId) return writeError("missing server id", 400)
  if (!memberId) return writeError("missing member id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const caller = auth.value!

  let body: { role?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!isAssignableRole(body.role)) {
    return writeError(`role must be one of: ${ASSIGNABLE_ROLES.join(", ")}`, 400)
  }

  if (memberId === caller.id) {
    return writeError("cannot change your own role", 400)
  }

  // Scope to the target server's members so cross-server memberId can never
  // be modified through this endpoint.
  const target = await queries.communityMember.getMemberById(db, memberId, { serverId })
  if (!target) return writeError("member not found", 404)

  if (isServerOwner(target.role) && !isServerOwner(caller.role)) {
    return writeError("cannot change the owner's role", 403)
  }

  const updated = await queries.communityMember.updateRole(db, memberId, body.role)
  if (!updated) return writeError("member not found", 404)

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "member_role_update",
    targetType: "member",
    targetId: memberId,
    changes: JSON.stringify({ role: body.role }),
  })

  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.MEMBER_UPDATE,
    serverId,
    memberId,
    changes: { role: body.role },
  })

  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  const memberId = ctx.params?.memberId
  if (!serverId) return writeError("missing server id", 400)
  if (!memberId) return writeError("missing member id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const caller = auth.value!

  if (memberId === caller.id) {
    return writeError("cannot kick yourself, use leave instead", 400)
  }

  const target = await queries.communityMember.getMemberById(db, memberId, { serverId })
  if (!target) return writeError("member not found", 404)

  if (isServerOwner(target.role)) {
    return writeError("cannot kick the server owner", 403)
  }
  // An admin cannot kick another admin unless they are the owner.
  if (canManageServer(target.role) && !isServerOwner(caller.role)) {
    return writeError("only the owner can remove an admin", 403)
  }

  // Kick semantics differ by target type:
  //   - Kicking a bot: remove ONLY that bot's member row. No owner cascade.
  //   - Kicking a human: cascade removes owner's live bots that are members.
  const targetInternal = await queries.user.getUserInternal(db, target.userId)
  const targetIsBot = targetInternal?.isBot === true

  let botIdsToCascade: string[] = []
  if (!targetIsBot) {
    botIdsToCascade = await queries.communityMember.listOwnerBotsInServer(
      db,
      serverId,
      target.userId,
    )
  }

  const removed = await queries.communityMember.removeMember(db, memberId)
  if (!removed) return writeError("member not found", 404)

  for (const botId of botIdsToCascade) {
    const bmember = await queries.communityMember.getMember(db, serverId, botId)
    if (bmember) {
      await queries.communityMember.removeMember(db, bmember.id)
    }
  }

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: targetIsBot ? COMMUNITY_AUDIT_ACTIONS.BOT_REMOVED_FROM_SERVER : "member_kick",
    targetType: targetIsBot ? "user" : "member",
    targetId: targetIsBot ? target.userId : memberId,
    changes: JSON.stringify(
      targetIsBot
        ? { botId: target.userId, serverId, kind: "kicked" }
        : { userId: target.userId },
    ),
  })
  for (const botId of botIdsToCascade) {
    logAudit(db, {
      serverId,
      actorId: ctx.userId,
      action: COMMUNITY_AUDIT_ACTIONS.BOT_REMOVED_FROM_SERVER,
      targetType: "user",
      targetId: botId,
      changes: JSON.stringify({ botId, serverId, kind: "owner_left_cascade" }),
    })
  }

  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.MEMBER_LEAVE,
    serverId,
    userId: target.userId,
  })
  for (const botId of botIdsToCascade) {
    fanOutToServerMembers(serverId, {
      type: WS_EVENTS.MEMBER_LEAVE,
      serverId,
      userId: botId,
    })
  }

  return new Response(null, { status: 204 })
})

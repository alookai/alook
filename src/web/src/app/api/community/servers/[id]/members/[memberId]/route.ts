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
import { logAudit } from "@/lib/community/audit"
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
  // Keep `listMembers` here pending #9 — role check needs the full row (role/userName) for downstream ownership + audit.
  const members = await queries.communityMember.listMembers(db, serverId)
  const target = members.find((m) => m.id === memberId)
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

  // Keep `listMembers` here pending #9 — kick needs the full row (role/userId) for owner-check + broadcast payload.
  const members = await queries.communityMember.listMembers(db, serverId)
  const target = members.find((m) => m.id === memberId)
  if (!target) return writeError("member not found", 404)

  if (isServerOwner(target.role)) {
    return writeError("cannot kick the server owner", 403)
  }
  // An admin cannot kick another admin unless they are the owner.
  if (canManageServer(target.role) && !isServerOwner(caller.role)) {
    return writeError("only the owner can remove an admin", 403)
  }

  const removed = await queries.communityMember.removeMember(db, memberId)
  if (!removed) return writeError("member not found", 404)

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "member_kick",
    targetType: "member",
    targetId: memberId,
    changes: JSON.stringify({ userId: target.userId }),
  })

  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.MEMBER_LEAVE,
    serverId,
    userId: target.userId,
  })

  return new Response(null, { status: 204 })
})

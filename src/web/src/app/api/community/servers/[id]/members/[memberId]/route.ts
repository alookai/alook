import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  const memberId = ctx.params?.memberId
  if (!serverId) return writeError("missing server id", 400)
  if (!memberId) return writeError("missing member id", 400)

  const db = getDb(ctx.env.DB)

  // Verify caller is owner or admin
  const caller = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!caller || (caller.role !== "owner" && caller.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  let body: { role?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.role || (body.role !== "admin" && body.role !== "member")) {
    return writeError("role must be 'admin' or 'member'", 400)
  }

  // Can't change own role
  if (memberId === caller.id) {
    return writeError("cannot change your own role", 400)
  }

  // Fetch target member to check constraints
  const members = await queries.communityMember.listMembers(db, serverId)
  const target = members.find((m) => m.id === memberId)
  if (!target) return writeError("member not found", 404)

  // Can't change owner's role unless you're the owner
  if (target.role === "owner" && caller.role !== "owner") {
    return writeError("cannot change the owner's role", 403)
  }

  const updated = await queries.communityMember.updateRole(db, memberId, body.role)
  if (!updated) return writeError("member not found", 404)

  queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "member_role_update",
    targetType: "member",
    targetId: memberId,
    changes: JSON.stringify({ role: body.role }),
  }).catch(() => {})

  fanOutToServerMembers(serverId, {
    type: "community:member.update",
    serverId,
    memberId,
    changes: { role: body.role },
  }).catch(() => {})

  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  const memberId = ctx.params?.memberId
  if (!serverId) return writeError("missing server id", 400)
  if (!memberId) return writeError("missing member id", 400)

  const db = getDb(ctx.env.DB)

  // Verify caller is owner or admin
  const caller = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!caller || (caller.role !== "owner" && caller.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  // Can't kick self (use /leave)
  if (memberId === caller.id) {
    return writeError("cannot kick yourself, use leave instead", 400)
  }

  // Fetch target member
  const members = await queries.communityMember.listMembers(db, serverId)
  const target = members.find((m) => m.id === memberId)
  if (!target) return writeError("member not found", 404)

  // Can't kick owner
  if (target.role === "owner") {
    return writeError("cannot kick the server owner", 403)
  }

  const removed = await queries.communityMember.removeMember(db, memberId)
  if (!removed) return writeError("member not found", 404)

  queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "member_kick",
    targetType: "member",
    targetId: memberId,
    changes: JSON.stringify({ userId: target.userId }),
  }).catch(() => {})

  fanOutToServerMembers(serverId, {
    type: "community:member.leave",
    serverId,
    userId: target.userId,
  }).catch(() => {})

  return new Response(null, { status: 204 })
})

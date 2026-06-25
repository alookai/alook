import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const serverId = channel.serverId
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  let body: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null } = {}
  if (body.name !== undefined) changes.name = body.name
  if (body.topic !== undefined) changes.topic = body.topic
  if (body.categoryId !== undefined) changes.categoryId = body.categoryId
  if (body.forumTags !== undefined) changes.forumTags = body.forumTags

  const updated = await queries.communityChannel.updateChannel(db, channelId, changes)
  if (!updated) return writeError("channel not found", 404)

  await fanOutToServerMembers(serverId, {
    type: "community:channel.update",
    serverId,
    channelId,
    changes,
  })

  await queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "channel_update",
    targetType: "channel",
    targetId: channelId,
    changes: JSON.stringify(changes),
  })

  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const serverId = channel.serverId
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  const deleted = await queries.communityChannel.deleteChannel(db, channelId)
  if (!deleted) return writeError("channel not found", 404)

  await fanOutToServerMembers(serverId, {
    type: "community:channel.delete",
    serverId,
    channelId,
  })

  await queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "channel_delete",
    targetType: "channel",
    targetId: channelId,
  })

  return new Response(null, { status: 204 })
})

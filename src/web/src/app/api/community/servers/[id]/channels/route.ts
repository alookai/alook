import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return writeError("forbidden", 403)
  }

  let body: { name?: string; type?: string; categoryId?: string; topic?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }

  const row = await queries.communityChannel.createChannel(db, {
    serverId,
    categoryId: body.categoryId,
    name: body.name,
    type: body.type,
    topic: body.topic,
  })

  const channel = {
    id: row.id,
    name: row.name,
    type: row.type as "text" | "forum",
    categoryId: row.categoryId,
    topic: row.topic ?? undefined,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  }

  await fanOutToServerMembers(serverId, {
    type: "community:channel.create",
    serverId,
    channel,
  })

  await queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "channel_create",
    targetType: "channel",
    targetId: channel.id,
  })

  return writeJSON(channel, 201)
})

import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  isChannelType,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  type ChannelType,
} from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireServerMember } from "@/lib/community/permissions"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const member = auth.value!

  let body: { name?: string; type?: string; categoryId?: string; topic?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }
  const name = body.name.trim()
  if (!name || name.length > MAX_CHANNEL_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
  }
  if (body.type !== undefined && !isChannelType(body.type)) {
    return writeError("type must be 'text' or 'forum'", 400)
  }
  if (body.topic !== undefined) {
    if (typeof body.topic !== "string") return writeError("topic must be a string", 400)
    if (body.topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
      return writeError(`topic must be ≤ ${MAX_CHANNEL_TOPIC_LENGTH} characters`, 400)
    }
  }

  const isAdmin = canManageServer(member.role)
  if (body.categoryId) {
    const category = await queries.communityCategory.getCategory(db, body.categoryId)
    if (!category || category.serverId !== serverId) {
      return writeError("category not found", 404)
    }
    if (category.private && !isAdmin) {
      return writeError("only admins can create channels in private categories", 403)
    }
  }

  const row = await queries.communityChannel.createChannel(db, {
    serverId,
    categoryId: body.categoryId,
    name,
    type: body.type,
    topic: body.topic,
    creatorId: ctx.userId,
  })

  const channel = {
    id: row.id,
    name: row.name,
    type: row.type as ChannelType,
    categoryId: row.categoryId,
    topic: row.topic ?? undefined,
    position: row.position ?? 0,
    createdAt: row.createdAt,
  }

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.CHANNEL_CREATE,
    serverId,
    channel,
  })

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "channel_create",
    targetType: "channel",
    targetId: channel.id,
  })

  return writeJSON({ channel }, 201)
})

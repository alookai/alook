import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
} from "@alook/shared"
import type { Database } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"

type ChannelRow = NonNullable<
  Awaited<ReturnType<typeof queries.communityChannel.getChannel>>
>

/**
 * Resolve the channel + verify the caller can modify it.
 * - Admin/owner of the server can edit any channel.
 * - Channel creator can edit their own (unless it sits in a private category).
 */
async function loadChannelForMutation(
  db: Database,
  channelId: string,
  userId: string,
): Promise<{ ok: true; channel: ChannelRow } | { ok: false; status: 403 | 404; error: string }> {
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return { ok: false, status: 404, error: "channel not found" }

  const member = await queries.communityMember.getMember(db, channel.serverId, userId)
  if (!member) return { ok: false, status: 403, error: "forbidden" }

  const isAdmin = canManageServer(member.role)
  const isCreator = channel.creatorId === userId
  if (!isAdmin && !isCreator) return { ok: false, status: 403, error: "forbidden" }

  if (!isAdmin && channel.categoryId) {
    const category = await queries.communityCategory.getCategory(db, channel.categoryId)
    if (category?.private) return { ok: false, status: 403, error: "forbidden" }
  }
  return { ok: true, channel }
}

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const check = await loadChannelForMutation(db, channelId, ctx.userId)
  if (!check.ok) return writeError(check.error, check.status)
  const channel = check.channel

  let body: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return writeError("name must be a string", 400)
    const trimmed = body.name.trim()
    if (!trimmed || trimmed.length > MAX_CHANNEL_NAME_LENGTH) {
      return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
    }
    changes.name = trimmed
  }
  if (body.topic !== undefined) {
    if (typeof body.topic !== "string") return writeError("topic must be a string", 400)
    if (body.topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
      return writeError(`topic must be ≤ ${MAX_CHANNEL_TOPIC_LENGTH} characters`, 400)
    }
    changes.topic = body.topic
  }
  if (body.categoryId !== undefined) {
    if (body.categoryId !== null) {
      const category = await queries.communityCategory.getCategory(db, body.categoryId)
      if (!category || category.serverId !== channel.serverId) {
        return writeError("category not found", 404)
      }
    }
    changes.categoryId = body.categoryId
  }
  if (body.forumTags !== undefined) changes.forumTags = body.forumTags

  if (Object.keys(changes).length === 0) {
    return writeError("no changes provided", 400)
  }

  const updated = await queries.communityChannel.updateChannel(db, channelId, changes)
  if (!updated) return writeError("channel not found", 404)

  await fanOutToServerMembers(channel.serverId, {
    type: WS_EVENTS.CHANNEL_UPDATE,
    serverId: channel.serverId,
    channelId,
    changes,
  })

  logAudit(db, {
    serverId: channel.serverId,
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
  const check = await loadChannelForMutation(db, channelId, ctx.userId)
  if (!check.ok) return writeError(check.error, check.status)
  const channel = check.channel

  const deleted = await queries.communityChannel.deleteChannel(db, channelId)
  if (!deleted) return writeError("channel not found", 404)

  await fanOutToServerMembers(channel.serverId, {
    type: WS_EVENTS.CHANNEL_DELETE,
    serverId: channel.serverId,
    channelId,
  })

  logAudit(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "channel_delete",
    targetType: "channel",
    targetId: channelId,
  })

  return new Response(null, { status: 204 })
})

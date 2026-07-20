import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  isUniqueConstraintError,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  slugify,
} from "@alook/shared"
import { fanOutToServerMembers, fanOutToChannel, broadcastToUserSafe } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireChannelAccess } from "@/lib/community/permissions"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const channel = access.value.channel
  const isAdmin = canManageServer(access.value.member.role)
  // A forum post's creator may edit that post's tags even without full
  // `canManage` (a PUBLIC post's creator has `canManage === false`; a private
  // post's creator already passes it via `isPrivate && isCreator`). Scoped to
  // the `forumTags` field only below — every other field still requires
  // `canManage`. `access.value.isCreator` is the vetted post-own-creator flag
  // (NOT the forum creator), so we don't re-derive it from `channel.creatorId`.
  const canEditPostTags =
    channel.type === "forum_post" && access.value.isCreator
  if (!access.value.canManage && !canEditPostTags) return writeError("forbidden", 403)

  let body: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  // A creator-without-canManage reached here only for the tag carve-out — they
  // may edit forumTags and nothing else. Reject any other field explicitly
  // rather than silently ignoring it.
  if (!access.value.canManage) {
    const nonTagField =
      body.name !== undefined || body.topic !== undefined || body.categoryId !== undefined
    if (nonTagField) return writeError("forbidden", 403)
  }

  const changes: { name?: string; topic?: string; categoryId?: string | null; forumTags?: string | null } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string") return writeError("name must be a string", 400)
    const trimmed = body.name.trim()
    if (!trimmed || trimmed.length > MAX_CHANNEL_NAME_LENGTH) {
      return writeError(`name must be 1-${MAX_CHANNEL_NAME_LENGTH} characters`, 400)
    }
    const normalized = slugify(trimmed)
    if (!normalized) {
      return writeError("name is required", 400)
    }
    changes.name = normalized
  }
  if (body.topic !== undefined) {
    if (typeof body.topic !== "string") return writeError("topic must be a string", 400)
    if (body.topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
      return writeError(`topic must be ≤ ${MAX_CHANNEL_TOPIC_LENGTH} characters`, 400)
    }
    changes.topic = body.topic
  }
  if (body.categoryId !== undefined) {
    // Moving a channel between categories is admin-only AND may not cross a
    // public↔private boundary (that would silently widen/tighten visibility
    // without member reconciliation).
    if (!isAdmin) return writeError("admin permission required", 403)
    let targetPrivate = false
    if (body.categoryId !== null) {
      const category = await queries.communityCategory.getCategory(db, body.categoryId)
      if (!category || category.serverId !== channel.serverId) {
        return writeError("category not found", 404)
      }
      targetPrivate = !!category.private
    }
    const currentPrivate = access.value.anchor.categoryId
      ? await queries.communityChannel.isChannelPrivate(db, channelId)
      : false
    if (targetPrivate !== currentPrivate) {
      return writeError("Can't move a channel across a public/private boundary", 400)
    }
    changes.categoryId = body.categoryId
  }
  if (body.forumTags !== undefined) {
    // Tags are a per-post concept: only a forum_post carries a selected-tag
    // list (a forum's tag vocabulary is now derived as the union of its posts).
    if (channel.type !== "forum_post") {
      return writeError("only forum posts can have tags", 400)
    }
    // Validate the shape the read side (`safeParseForumTags`) expects: a JSON
    // array of strings, stored as its stringified form. Reject anything else so
    // a malformed value can't poison the parse.
    if (body.forumTags !== null) {
      let parsed: unknown
      try {
        parsed = JSON.parse(body.forumTags)
      } catch {
        return writeError("forumTags must be a JSON array of strings", 400)
      }
      if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== "string")) {
        return writeError("forumTags must be a JSON array of strings", 400)
      }
      const normalized = [...new Set(parsed.map((t) => t.trim().toLowerCase()).filter(Boolean))]
      changes.forumTags = JSON.stringify(normalized)
    } else {
      changes.forumTags = null
    }
  }

  if (Object.keys(changes).length === 0) {
    return writeError("no changes provided", 400)
  }

  let updated
  try {
    updated = await queries.communityChannel.updateChannel(db, channelId, changes)
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      return writeError("a channel with this name already exists", 409)
    }
    throw err
  }
  if (!updated) return writeError("channel not found", 404)

  const isPrivate = await queries.communityChannel.isChannelPrivate(db, channelId)
  if (isPrivate) {
    await fanOutToChannel(channelId, {
      type: WS_EVENTS.CHANNEL_UPDATE,
      serverId: channel.serverId,
      channelId,
      changes,
    })
  } else {
    await fanOutToServerMembers(channel.serverId, {
      type: WS_EVENTS.CHANNEL_UPDATE,
      serverId: channel.serverId,
      channelId,
      changes,
    })
  }

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
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  if (!access.value.canManage) return writeError("forbidden", 403)
  const channel = access.value.channel

  // Resolve the private-channel audience BEFORE deleting (the member rows
  // cascade away with the channel row), so the delete event still reaches
  // exactly the people who could see it.
  const isPrivate = await queries.communityChannel.isChannelPrivate(db, channelId)
  const audience = isPrivate
    ? await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
    : null

  const deleted = await queries.communityChannel.deleteChannel(db, channelId)
  if (!deleted) return writeError("channel not found", 404)

  const event = {
    type: WS_EVENTS.CHANNEL_DELETE,
    serverId: channel.serverId,
    channelId,
  } as const
  if (audience) {
    await Promise.all(audience.map((userId) => broadcastToUserSafe(userId, event)))
  } else {
    await fanOutToServerMembers(channel.serverId, event)
  }

  logAudit(db, {
    serverId: channel.serverId,
    actorId: ctx.userId,
    action: "channel_delete",
    targetType: "channel",
    targetId: channelId,
  })

  return new Response(null, { status: 204 })
})

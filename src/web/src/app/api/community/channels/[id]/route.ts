import { NextRequest } from "next/server"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb, getPrimaryDb } from "@/lib/db"
import {
  queries,
  canManageServer,
  isForum,
  isThread,
  isUniqueConstraintError,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  WS_EVENTS,
  slugify,
} from "@alook/shared"
import { fanOutToServerMembers, fanOutToChannel, broadcastToUserSafe } from "@/lib/community/fanout"
import { requireChannelAccess, requireChannelMember } from "@/lib/community/permissions"
import { scheduleCommunityMediaCleanup } from "@/lib/community/community-media-cleanup"

/**
 * GET /api/community/channels/[id] — single channel metadata (the
 * `getChannelForMember` row: id, name, type, parentChannelId, parentMessageId,
 * creatorId, …). The canonical home for reading ANY channel's meta — a
 * top-level channel, a thread, or a forum post (a DM's meta is not read this
 * way; DMs surface through the DM list). Folds the old `threads/[id]` GET, which
 * only ever served child-thread metadata but was channel metadata by another
 * name (a thread IS a channel row). The thread-view opener + child-channel
 * bootstrap read it.
 *
 * Two-step check preserves the 404-vs-403 contract sibling channel routes honor:
 * unknown channel → 404, known channel + non-member → 403 (`requireChannelMember`
 * alone collapses both to 403 because the membership JOIN can't tell them apart).
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  return writeJSON(auth.value)
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const channel = access.value.channel
  const isAdmin = canManageServer(access.value.member.role)
  if (!access.value.canManage) return writeError("forbidden", 403)

  let body: { name?: string; topic?: string; categoryId?: string | null }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string; topic?: string; categoryId?: string | null } = {}
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

  let broadcastChanges = changes
  if (isThread(channel.type) && channel.parentChannelId) {
    if (changes.name !== undefined) {
      await fanOutToChannel(channel.parentChannelId, {
        type: WS_EVENTS.CHILD_CHANNEL_UPDATE,
        parentChannelId: channel.parentChannelId,
        channelId,
        changes: { name: changes.name },
      })
    }
    const remainingChanges = { ...changes }
    delete remainingChanges.name
    if (Object.keys(remainingChanges).length === 0) return writeJSON(updated)
    broadcastChanges = remainingChanges
  }

  const isPrivate = await queries.communityChannel.isChannelPrivate(db, channelId)
  if (isPrivate) {
    await fanOutToChannel(channelId, {
      type: WS_EVENTS.CHANNEL_UPDATE,
      serverId: channel.serverId,
      channelId,
      changes: broadcastChanges,
    })
  } else {
    await fanOutToServerMembers(channel.serverId, {
      type: WS_EVENTS.CHANNEL_UPDATE,
      serverId: channel.serverId,
      channelId,
      changes: broadcastChanges,
    })
  }


  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getPrimaryDb(ctx.env.DB)
  const access = await requireChannelAccess(db, channelId, ctx.userId)
  if (!access.ok) return writeError(access.error, access.status)
  const channel = access.value.channel
  if (isThread(channel.type) && channel.parentChannelId) {
    const parentType = await queries.communityChannel.getChannelType(db, channel.parentChannelId)
    if (isForum(parentType)) {
      return writeError("delete the forum opener message instead", 409)
    }
  }
  // Forum posts are deleted only through DELETE /messages/{openerId}. The
  // remaining channel route is manager-only; never widen ordinary thread
  // creators into whole-thread deletion authority.
  if (!access.value.canManage) return writeError("forbidden", 403)

  // Resolve the private-channel audience BEFORE deleting (the member rows
  // cascade away with the channel row), so the delete event still reaches
  // exactly the people who could see it.
  const isPrivate = await queries.communityChannel.isChannelPrivate(db, channelId)
  const audience = isPrivate
    ? await queries.communityChannel.getPrivateChannelAudienceUserIds(db, channelId)
    : null

  let executionContext: ExecutionContext
  try {
    ({ ctx: executionContext } = await getCloudflareContext({ async: true }))
  } catch {
    return writeError("internal error", 500)
  }

  const result = await queries.communityDeleteMedia.deleteChannelWithMedia(db, {
    channelId,
    serverId: channel.serverId,
  })
  if (!result.deleted) return writeError("channel not found", 404)

  await Promise.all((result.readStateSnapshots ?? []).map((snapshot) => broadcastToUserSafe(snapshot.userId, {
    type: WS_EVENTS.READ_STATE_ADVANCED,
    revision: snapshot.revision,
    readStates: snapshot.readStates,
    inboxChanged: true,
  })))

  if (result.mediaKeys.length > 0) {
    scheduleCommunityMediaCleanup(ctx.env.COMMUNITY_MEDIA, executionContext, {
      keys: result.mediaKeys,
      warning: {
        event: "community_channel_media_cleanup_failed",
        fields: { serverId: channel.serverId, channelId },
      },
    })
  }

  const event = {
    type: WS_EVENTS.CHANNEL_DELETE,
    serverId: channel.serverId,
    channelId,
    parentChannelId: channel.parentChannelId,
  } as const
  if (audience) {
    await Promise.all(audience.map((userId) => broadcastToUserSafe(userId, event)))
  } else {
    await fanOutToServerMembers(channel.serverId, event)
  }


  return new Response(null, { status: 204 })
})

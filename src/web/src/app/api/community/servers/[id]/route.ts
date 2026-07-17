import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  isServerOwner,
  MAX_SERVER_NAME_LENGTH,
  MAX_SERVER_DESCRIPTION_LENGTH,
  UNCATEGORIZED_CATEGORY_ID,
  WS_EVENTS,
  slugify,
} from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { logAudit } from "@/lib/community/audit"
import { requireServerAdmin, requireServerMember } from "@/lib/community/permissions"
import { serverIconUrl } from "@/lib/community/storage"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const visibleChannelIds = await queries.communityChannel.listVisibleChannelIdsForUser(db, ctx.userId)
  const [server, rawChannels, categories, unreadRows] = await Promise.all([
    queries.communityServer.getServer(db, serverId),
    // Viewer-scoped: private-category channels are only returned if the viewer
    // is the channel creator or an added member (admins get NO special
    // visibility). Private category HEADERS still appear (below) so members can
    // create channels in them.
    queries.communityChannel.listServerChannelsForViewer(db, serverId, ctx.userId),
    db.query.communityCategory.findMany({
      where: (t, { eq }) => eq(t.serverId, serverId),
      orderBy: (t, { asc }) => [asc(t.position)],
    }),
    queries.communityInbox.listUnreadChannels(db, ctx.userId, visibleChannelIds),
  ])

  if (!server) return writeError("server not found", 404)

  // Project the viewer's per-channel unread state onto the shared `channels`
  // array once, before splitting into categorized/uncategorized — so both
  // branches inherit `unread` from the same source instead of two separate
  // maps. `listUnreadChannels` scans all of the viewer's servers; scope it
  // down to this one via the Set.
  const unreadIds = new Set(
    unreadRows.filter((r) => r.serverId === serverId).map((r) => r.channelId),
  )
  const channels = rawChannels.map((ch) => ({ ...ch, unread: unreadIds.has(ch.id) }))

  const categoriesWithChannels = categories.map((c) => ({
    ...c,
    channels: channels.filter((ch) => ch.categoryId === c.id),
  }))
  const uncategorized = channels.filter((ch) => !ch.categoryId)
  if (uncategorized.length > 0) {
    categoriesWithChannels.push({
      id: UNCATEGORIZED_CATEGORY_ID,
      serverId: server.id,
      // Empty name is load-bearing: the sidebar detects the uncategorized
      // bucket by `name === ""` (renders its channels as the bare top list, and
      // maps a drag INTO it back to `categoryId: null`).
      name: "",
      position: -1,
      private: 0,
      channels: uncategorized,
    } as (typeof categoriesWithChannels)[number])
  }
  return writeJSON({
    id: server.id,
    name: server.name,
    description: server.description ?? "",
    icon: serverIconUrl(server),
    ownerId: server.ownerId,
    categories: categoriesWithChannels,
  })
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireServerAdmin(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: { name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string; description?: string } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      return writeError("name must be a string", 400)
    }
    const trimmed = body.name.trim()
    if (!trimmed || trimmed.length > MAX_SERVER_NAME_LENGTH) {
      return writeError(`name must be 1-${MAX_SERVER_NAME_LENGTH} characters`, 400)
    }
    const normalized = slugify(trimmed)
    if (!normalized) {
      return writeError("name is required", 400)
    }
    changes.name = normalized
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return writeError("description must be a string", 400)
    }
    if (body.description.length > MAX_SERVER_DESCRIPTION_LENGTH) {
      return writeError(`description must be ≤ ${MAX_SERVER_DESCRIPTION_LENGTH} characters`, 400)
    }
    changes.description = body.description
  }

  if (Object.keys(changes).length === 0) {
    return writeError("no changes provided", 400)
  }

  const updated = await queries.communityServer.updateServer(db, serverId, changes)
  if (!updated) return writeError("server not found", 404)

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "server_update",
    targetType: "server",
    targetId: serverId,
    changes: JSON.stringify(changes),
  })

  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.SERVER_UPDATE,
    serverId,
    changes,
  }, { excludeUserId: ctx.userId })

  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)
  if (!isServerOwner(member.role)) {
    return writeError("only the owner can delete the server", 403)
  }

  await fanOutToServerMembers(serverId, {
    type: WS_EVENTS.SERVER_DELETE,
    serverId,
  }, { excludeUserId: ctx.userId })

  const deleted = await queries.communityServer.deleteServer(db, serverId)
  if (!deleted) return writeError("server not found", 404)

  logAudit(db, {
    serverId,
    actorId: ctx.userId,
    action: "server_delete",
    targetType: "server",
    targetId: serverId,
  })

  return new Response(null, { status: 204 })
})

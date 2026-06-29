import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, canManageServer, isServerOwner } from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"

export const GET = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify membership
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)

  const [server, channels, categories] = await Promise.all([
    queries.communityServer.getServer(db, serverId),
    queries.communityChannel.listServerChannels(db, serverId),
    db.query.communityCategory.findMany({
      where: (t, { eq }) => eq(t.serverId, serverId),
      orderBy: (t, { asc }) => [asc(t.position)],
    }),
  ])

  if (!server) return writeError("server not found", 404)

  // Merge into a flat ServerDetail shape with categories embedding their channels
  const categoriesWithChannels = categories.map((c) => ({
    ...c,
    channels: channels.filter((ch) => ch.categoryId === c.id),
  }))
  // Include uncategorized channels as a virtual category
  const uncategorized = channels.filter((ch) => !ch.categoryId)
  if (uncategorized.length > 0) {
    categoriesWithChannels.push({
      id: "__uncategorized__",
      serverId: server.id,
      name: "Channels",
      position: -1,
      private: 0,
      channels: uncategorized,
    } as (typeof categoriesWithChannels)[number])
  }
  return writeJSON({
    id: server.id,
    name: server.name,
    description: server.description ?? "",
    icon: server.icon,
    ownerId: server.ownerId,
    categories: categoriesWithChannels,
  })
})

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify caller is owner or admin
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member || !canManageServer(member.role)) {
    return writeError("forbidden", 403)
  }

  let body: { name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const changes: { name?: string; description?: string } = {}
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return writeError("name must be a non-empty string", 400)
    }
    changes.name = body.name.trim()
  }
  if (body.description !== undefined) {
    changes.description = body.description
  }

  if (Object.keys(changes).length === 0) {
    return writeError("no changes provided", 400)
  }

  const updated = await queries.communityServer.updateServer(db, serverId, changes)
  if (!updated) return writeError("server not found", 404)

  queries.communityAuditLog.logAction(db, {
    serverId,
    actorId: ctx.userId,
    action: "server_update",
    targetType: "server",
    targetId: serverId,
    changes: JSON.stringify(changes),
  }).catch(() => {})

  fanOutToServerMembers(serverId, {
    type: "community:server.update",
    serverId,
    changes,
  }, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON(updated)
})

export const DELETE = withAuth(async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)

  const db = getDb(ctx.env.DB)

  // Verify caller is owner
  const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
  if (!member) return writeError("not a member of this server", 403)
  if (!isServerOwner(member.role)) {
    return writeError("only the owner can delete the server", 403)
  }

  // Fan out before deletion so members still exist for recipient resolution
  await fanOutToServerMembers(serverId, {
    type: "community:server.delete",
    serverId,
  }, { excludeUserId: ctx.userId })

  const deleted = await queries.communityServer.deleteServer(db, serverId)
  if (!deleted) return writeError("server not found", 404)

  return new Response(null, { status: 204 })
})

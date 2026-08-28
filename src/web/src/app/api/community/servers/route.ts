import { NextRequest } from "next/server"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MAX_SERVER_NAME_LENGTH,
  MAX_SERVER_DESCRIPTION_LENGTH,
  ROLES,
  WS_EVENTS,
  slugify,
  withD1Retry,
} from "@alook/shared"
import { withCommunityActor, rejectBot } from "@/lib/middleware/community-actor"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { serverIconUrl } from "@/lib/community/storage"

export const GET = withCommunityActor(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await withD1Retry(
    () => queries.communityServer.listUserServers(db, ctx.actor.userId),
    { route: "community/servers:list" },
  )
  const servers = rows.map((row) => ({ ...row, icon: serverIconUrl(row) }))
  if (ctx.actor.kind === "bot") return writeJSON({ servers })

  const unreadServerIds = new Set(await withD1Retry(
    () => queries.communityInbox.listEligibleUnreadServerIds(db, ctx.actor.userId),
    { route: "community/servers:unread" },
  ))
  return writeJSON({
    servers: servers.map((server) => ({
      ...server,
      unread: unreadServerIds.has(server.id),
    })),
  })
})

/**
 * POST — create a server. Human-only: there is no bot create-server verb today,
 * so a bot actor is rejected 403 (`rejectBot`) rather than silently granted a
 * new capability by the actor unification (plan §5 — capabilities are explicit,
 * not "whatever the route happens to accept").
 */
export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const denied = rejectBot(ctx.actor)
  if (denied) return denied

  const db = getDb(ctx.env.DB)

  let body: { name?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name || typeof body.name !== "string") {
    return writeError("name is required", 400)
  }
  const trimmed = body.name.trim()
  if (!trimmed || trimmed.length > MAX_SERVER_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_SERVER_NAME_LENGTH} characters`, 400)
  }
  const name = slugify(trimmed)
  if (!name) {
    return writeError("name is required", 400)
  }

  let description: string | undefined
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return writeError("description must be a string", 400)
    }
    if (body.description.length > MAX_SERVER_DESCRIPTION_LENGTH) {
      return writeError(`description must be ≤ ${MAX_SERVER_DESCRIPTION_LENGTH} characters`, 400)
    }
    description = body.description
  }

  const { server, ownerMember } = await queries.communityServer.createServer(db, {
    name,
    description,
    ownerId: ctx.actor.userId,
  })

  fanOutToServerMembers(server.id, {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: server.id,
    member: {
      id: ownerMember.id,
      userId: ctx.actor.userId,
      name: ownerMember.userName,
      discriminator: ownerMember.userDiscriminator,
      avatar: ownerMember.userImage ?? undefined,
      role: ROLES.OWNER,
      joinedAt: ownerMember.joinedAt,
    },
  })

  return writeJSON({ server }, 201)
})

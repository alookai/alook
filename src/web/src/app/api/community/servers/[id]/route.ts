import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  isServerOwner,
  MAX_SERVER_NAME_LENGTH,
  MAX_SERVER_DESCRIPTION_LENGTH,
  WS_EVENTS,
  slugify,
} from "@alook/shared"
import { fanOutToServerMembers, fanOutToUsers } from "@/lib/community/fanout"
import { requireServerAdmin } from "@/lib/community/permissions"

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


  fanOutToServerMembers(serverId, {
    type: WS_EVENTS.SERVER_UPDATE,
    serverId,
    changes,
  })

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

  const recipients = await queries.communityMember.listMemberUserIds(db, serverId)

  const deleted = await queries.communityServer.deleteServer(db, serverId)
  if (!deleted) return writeError("server not found", 404)

  await fanOutToUsers(recipients, {
    type: WS_EVENTS.SERVER_DELETE,
    serverId,
  })

  return new Response(null, { status: 204 })
})

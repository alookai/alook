import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MAX_SERVER_NAME_LENGTH,
  MAX_SERVER_DESCRIPTION_LENGTH,
  ROLES,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToServerMembers } from "@/lib/community/fanout"
import { serverIconUrl } from "@/lib/community/storage"

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityServer.listUserServers(db, ctx.userId)
  const servers = rows.map((row) => ({ ...row, icon: serverIconUrl(row) }))
  return writeJSON({ servers })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
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
  const name = body.name.trim()
  if (!name || name.length > MAX_SERVER_NAME_LENGTH) {
    return writeError(`name must be 1-${MAX_SERVER_NAME_LENGTH} characters`, 400)
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
    ownerId: ctx.userId,
  })

  fanOutToServerMembers(server.id, {
    type: WS_EVENTS.MEMBER_JOIN,
    serverId: server.id,
    member: {
      id: ownerMember.id,
      userId: ctx.userId,
      name: ownerMember.userName,
      avatar: ownerMember.userImage ?? undefined,
      role: ROLES.OWNER,
      joinedAt: ownerMember.joinedAt,
    },
  })

  return writeJSON({ server }, 201)
})

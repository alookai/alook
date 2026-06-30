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

export const GET = withAuth(async (_req, ctx) => {
  const db = getDb(ctx.env.DB)
  const servers = await queries.communityServer.listUserServers(db, ctx.userId)
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

  const server = await queries.communityServer.createServer(db, {
    name,
    description,
    ownerId: ctx.userId,
  })

  const members = await queries.communityMember.listMembers(db, server.id)
  const ownerMember = members.find((m) => m.userId === ctx.userId)

  if (ownerMember) {
    fanOutToServerMembers(server.id, {
      type: WS_EVENTS.MEMBER_JOIN,
      serverId: server.id,
      member: {
        id: ownerMember.id,
        userId: ctx.userId,
        name: ownerMember.userName ?? ctx.email,
        role: ROLES.OWNER,
        joinedAt: ownerMember.joinedAt,
      },
    }).catch(() => {})
  }

  return writeJSON({ server }, 201)
})

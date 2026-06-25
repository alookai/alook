import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
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
  if (!name || name.length > 100) {
    return writeError("name must be 1-100 characters", 400)
  }

  const server = await queries.communityServer.createServer(db, {
    name,
    description: body.description,
    ownerId: ctx.userId,
  })

  // Fetch the owner membership (with user info) to include in the fanout event
  const members = await queries.communityMember.listMembers(db, server.id)
  const ownerMember = members.find((m) => m.userId === ctx.userId)

  if (ownerMember) {
    fanOutToServerMembers(server.id, {
      type: "community:member.join",
      serverId: server.id,
      member: {
        id: ownerMember.id,
        userId: ctx.userId,
        name: ownerMember.userName ?? ctx.email,
        role: "owner",
        joinedAt: ownerMember.joinedAt,
      },
    }).catch(() => {})
  }

  return writeJSON({ server }, 201)
})

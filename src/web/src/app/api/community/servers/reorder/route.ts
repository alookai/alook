import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const PATCH = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { serverIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!Array.isArray(body.serverIds) || body.serverIds.length === 0) {
    return writeError("serverIds must be a non-empty array", 400)
  }

  // Verify user is a member of each server (scope check)
  for (const serverId of body.serverIds) {
    const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
    if (!member) {
      return writeError(`not a member of server ${serverId}`, 403)
    }
  }

  // Update railOrder for each server membership
  for (let i = 0; i < body.serverIds.length; i++) {
    await queries.communityMember.updateRailOrder(db, body.serverIds[i]!, ctx.userId, i)
  }

  return writeJSON({ ok: true })
})

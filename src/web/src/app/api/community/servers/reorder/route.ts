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

  const unique = new Set(body.serverIds)
  if (unique.size !== body.serverIds.length) {
    return writeError("serverIds must be unique", 400)
  }

  const memberships = await queries.communityMember.getMemberships(db, ctx.userId, body.serverIds)
  if (memberships.length !== body.serverIds.length) {
    return writeError("not a member of all servers", 403)
  }

  await queries.communityMember.bulkUpdateRailOrder(db, ctx.userId, body.serverIds)

  return writeJSON({ ok: true })
})

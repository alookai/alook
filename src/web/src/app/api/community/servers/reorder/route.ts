import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"

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
  // Capture the narrowed value — inside the withD1Retry closure TS widens
  // `body.serverIds` back to `string[] | undefined`.
  const serverIds = body.serverIds

  const unique = new Set(serverIds)
  if (unique.size !== body.serverIds.length) {
    return writeError("serverIds must be unique", 400)
  }

  const memberships = await queries.communityMember.getMemberships(db, ctx.userId, serverIds)
  if (memberships.length !== serverIds.length) {
    return writeError("not a member of all servers", 403)
  }

  // `withD1Retry` (state 3): reorder sets positions to values, idempotent.
  await withD1Retry(() => queries.communityMember.bulkUpdateRailOrder(db, ctx.userId, serverIds), {
    route: "servers/reorder",
  })

  return writeJSON({ ok: true })
})

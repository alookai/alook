import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  MIN_SEARCH_LENGTH,
  MAX_SEARCH_LENGTH,
  DEFAULT_USER_SEARCH_LIMIT,
} from "@alook/shared"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const url = new URL(req.url)
  const q = url.searchParams.get("q")?.trim()

  if (!q) return writeError("query parameter q is required", 400)
  if (q.length < MIN_SEARCH_LENGTH) {
    return writeError(`query must be at least ${MIN_SEARCH_LENGTH} characters`, 400)
  }
  if (q.length > MAX_SEARCH_LENGTH) {
    return writeError(`query must be ≤ ${MAX_SEARCH_LENGTH} characters`, 400)
  }

  const db = getDb(ctx.env.DB)
  const users = await queries.user.searchUsersByName(db, q, {
    excludeUserId: ctx.userId,
    limit: DEFAULT_USER_SEARCH_LIMIT,
  })

  return writeJSON({
    users: users.map((u) => ({ id: u.id, name: u.name, image: u.image })),
  })
})

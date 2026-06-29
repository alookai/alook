import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const url = new URL(req.url)
  const q = url.searchParams.get("q")

  if (!q || q.trim().length === 0) {
    return writeError("query parameter q is required", 400)
  }

  const db = getDb(ctx.env.DB)
  const users = await queries.user.searchUsersByName(db, q.trim())

  return writeJSON({
    users: users
      .filter((u) => u.id !== ctx.userId)
      .map((u) => ({ id: u.id, name: u.name, image: u.image })),
  })
})

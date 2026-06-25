import { NextRequest } from "next/server"
import { queries } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { broadcastToUser } from "@/lib/broadcast"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let body: { userId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.userId) {
    return writeError("userId is required", 400)
  }

  if (body.userId === ctx.userId) {
    return writeError("cannot send friend request to yourself", 400)
  }

  try {
    const friendship = await queries.communityFriendship.sendRequest(db, {
      requesterId: ctx.userId,
      addresseeId: body.userId,
    })

    // Cast to any because community events aren't in the WsMessage union
    broadcastToUser(body.userId, { type: "community:friend.request", friendship } as any).catch(() => {})

    return writeJSON(friendship, 201)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("UNIQUE constraint")) {
      return writeError("friend request already sent", 409)
    }
    throw err
  }
})

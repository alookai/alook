import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const PUT = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  let body: { lastReadMessageId?: string } = {}
  try {
    body = await req.json()
  } catch {
    // Body is optional
  }

  const result = await queries.communityReadState.markRead(db, {
    userId: ctx.userId,
    dmConversationId: dmId,
    lastReadAt: new Date().toISOString(),
    lastReadMessageId: body.lastReadMessageId,
  })

  return writeJSON(result)
})

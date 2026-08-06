import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)
  const rows = await queries.communityDm.listDMs(db, ctx.userId)
  const conversations = rows.map((r) => ({
    id: r.id,
    userId: r.otherUserId,
    name: r.otherUserName,
    discriminator: r.otherUserDiscriminator,
    avatar: r.otherUserImage ?? avatarInitial(r.otherUserName),
    status: "offline" as const,
    preview: "",
  }))
  return writeJSON({ conversations })
})

import { withAuth } from "@/lib/middleware/auth-policy"
import { humanAuthPolicy } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { requireServerMember } from "@/lib/community/permissions"
import { readCommunityServerChannelRows } from "@/lib/community/server-directory.server"

export const GET = withAuth(humanAuthPolicy, async (_req, ctx) => {
  const serverId = ctx.params?.id
  if (!serverId) return writeError("missing server id", 400)
  const db = getDb(ctx.env.DB)
  const auth = await requireServerMember(db, serverId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channels = await readCommunityServerChannelRows(db, serverId, ctx.userId)
  const counts = await queries.communityThread.countUnarchivedForumPosts(db, serverId,
    channels.filter(channel => channel.type === "forum").map(channel => channel.id))
  const response = writeJSON({ serverId, counts })
  response.headers.set("Cache-Control", "private, no-store")
  return response
})

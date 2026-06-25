import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const url = new URL(req.url)
  const q = url.searchParams.get("q")
  const serverId = url.searchParams.get("serverId")
  const channelId = url.searchParams.get("channelId")
  const dmConversationId = url.searchParams.get("dmConversationId")

  if (!q || q.trim().length === 0) {
    return writeError("query parameter q is required", 400)
  }

  const db = getDb(ctx.env.DB)

  // Search within a server — verify membership
  if (serverId) {
    const member = await queries.communityMember.getMember(db, serverId, ctx.userId)
    if (!member) return writeError("forbidden", 403)

    const results = await queries.communitySearch.searchMessagesInServer(db, {
      query: q,
      serverId,
    })
    return writeJSON(results)
  }

  // Search within a channel — verify membership via channel's server
  if (channelId) {
    const channel = await queries.communityChannel.getChannel(db, channelId)
    if (!channel) return writeError("channel not found", 404)

    const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
    if (!member) return writeError("forbidden", 403)

    const results = await queries.communitySearch.searchMessages(db, {
      query: q,
      channelId,
    })
    return writeJSON(results)
  }

  // Search within a DM — verify participant
  if (dmConversationId) {
    const dm = await queries.communityDm.getDM(db, dmConversationId)
    if (!dm) return writeError("dm not found", 404)
    if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
      return writeError("forbidden", 403)
    }

    const results = await queries.communitySearch.searchMessages(db, {
      query: q,
      dmConversationId,
    })
    return writeJSON(results)
  }

  // General search (no scope filter)
  const results = await queries.communitySearch.searchMessages(db, { query: q })
  return writeJSON(results)
})

import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  const archivedParam = req.nextUrl.searchParams.get("archived")
  const archived = archivedParam === "true" ? true : archivedParam === "false" ? false : undefined

  const childChannels = await queries.communityChannel.listChildChannels(db, channelId, {
    archived,
    type: "thread",
  })

  // Resolve parent message or creator for each thread
  const threads = await Promise.all(
    childChannels.map(async (t) => {
      let parent = { authorName: "", text: "" }
      if (t.parentMessageId) {
        const msg = await queries.communityMessage.getMessage(db, t.parentMessageId)
        if (msg) {
          parent = { authorName: msg.authorName ?? msg.authorEmail ?? "Unknown", text: (msg.content ?? "").slice(0, 100) }
        }
      } else if (t.creatorId) {
        const creator = await queries.user.getUser(db, t.creatorId)
        if (creator) parent = { authorName: creator.name ?? "Unknown", text: "" }
        const msgs = await queries.communityMessage.listMessages(db, { channelId: t.id, limit: 1 })
        if (msgs.length > 0) parent = { ...parent, text: (msgs[0].content ?? "").slice(0, 100) }
      }
      return {
        id: t.id,
        name: t.name,
        kind: t.type,
        messageCount: t.messageCount ?? 0,
        lastMessageAt: t.lastMessageAt ?? t.createdAt,
        parent,
        messages: [],
      }
    })
  )

  return writeJSON({ threads })
})

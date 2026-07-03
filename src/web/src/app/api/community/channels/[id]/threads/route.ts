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

  // Collect id sets up front so we can resolve parent-message / creator /
  // first-message previews in three parallel batches instead of 1+2N calls.
  const parentIds = [
    ...new Set(childChannels.filter((r) => r.parentMessageId).map((r) => r.parentMessageId!)),
  ]
  const creatorIds = [
    ...new Set(
      childChannels
        .filter((r) => !r.parentMessageId && r.creatorId)
        .map((r) => r.creatorId!),
    ),
  ]
  const firstMessageChannelIds = [
    ...new Set(childChannels.filter((r) => !r.parentMessageId).map((r) => r.id)),
  ]

  const [parentMessages, creators, firstMessages] = await Promise.all([
    queries.communityMessage.getMessagesByIds(db, parentIds),
    queries.user.getUsersByIds(db, creatorIds),
    queries.communityMessage.getFirstMessageByChannelIds(db, firstMessageChannelIds),
  ])

  const parentMessageMap = new Map(parentMessages.map((m) => [m.id, m]))
  const creatorMap = new Map(creators.map((u) => [u.id, u]))
  const firstMessageMap = new Map(
    firstMessages.map((m) => [m.channelId as string, m.content]),
  )

  const threads = childChannels.map((t) => {
    let parent = { authorName: "", text: "" }
    if (t.parentMessageId) {
      const msg = parentMessageMap.get(t.parentMessageId)
      if (msg) {
        parent = {
          authorName: msg.authorName,
          text: (msg.content ?? "").slice(0, 100),
        }
      }
    } else if (t.creatorId) {
      const creator = creatorMap.get(t.creatorId)
      if (creator) parent = { authorName: creator.name, text: "" }
      const firstText = firstMessageMap.get(t.id)
      if (firstText !== undefined) {
        parent = { ...parent, text: (firstText ?? "").slice(0, 100) }
      }
    }
    return {
      id: t.id,
      name: t.name,
      kind: t.type,
      messageCount: t.messageCount ?? 0,
      lastMessageAt: t.lastMessageAt ?? t.createdAt,
      parent,
    }
  })

  return writeJSON({ threads })
})

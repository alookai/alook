import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  if (!messageId) return writeError("missing message id", 400)

  const db = getDb(ctx.env.DB)

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)
  if (!message.channelId) return writeError("message is not in a channel", 400)

  const channel = await queries.communityChannel.getChannel(db, message.channelId)
  if (!channel) return writeError("channel not found", 404)

  const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
  if (!member) return writeError("forbidden", 403)

  let body: { name: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.name) return writeError("name is required", 400)

  const childChannel = await queries.communityChannel.createChannel(db, {
    serverId: channel.serverId,
    parentChannelId: message.channelId,
    parentMessageId: messageId,
    name: body.name,
    type: "thread",
    creatorId: ctx.userId,
  })

  // Copy the original message as the first message in the thread
  await queries.communityMessage.createMessage(db, {
    authorId: message.authorId,
    content: message.content ?? "",
    channelId: childChannel.id,
  })

  fanOutToChannel(message.channelId, {
    type: "community:channel.child_create",
    parentChannelId: message.channelId,
    channel: {
      id: childChannel.id,
      name: childChannel.name,
      type: "thread" as const,
      creatorId: ctx.userId,
      createdAt: childChannel.createdAt,
    },
    parentMessageId: messageId,
  } as never, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON(childChannel, 201)
})

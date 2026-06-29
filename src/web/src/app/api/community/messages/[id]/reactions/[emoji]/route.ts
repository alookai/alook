import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MAX_EMOJI_BYTES } from "@alook/shared"
import { fanOutToChannel, fanOutToDM } from "@/lib/community/fanout"

export const PUT = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  const rawEmoji = ctx.params?.emoji
  if (!messageId || !rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)
  if (Buffer.byteLength(emoji, "utf8") > MAX_EMOJI_BYTES) {
    return writeError("emoji too long", 400)
  }

  const db = getDb(ctx.env.DB)

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)

  // Verify access based on message context
  if (message.channelId) {
    const channel = await queries.communityChannel.getChannel(db, message.channelId)
    if (!channel) return writeError("channel not found", 404)
    const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
    if (!member) return writeError("forbidden", 403)
  } else if (message.dmConversationId) {
    const dm = await queries.communityDm.getDM(db, message.dmConversationId)
    if (!dm) return writeError("dm not found", 404)
    if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
      return writeError("forbidden", 403)
    }
  }

  let reaction
  try {
    reaction = await queries.communityReaction.addReaction(db, {
      messageId,
      userId: ctx.userId,
      emoji,
    })
  } catch {
    // Unique constraint — already reacted
    return writeJSON({ ok: true })
  }

  const event = {
    type: "community:reaction.add" as const,
    messageId,
    userId: ctx.userId,
    emoji,
    ...(message.channelId && { channelId: message.channelId }),
    ...(message.dmConversationId && { dmConversationId: message.dmConversationId }),
  }

  if (message.channelId) {
    fanOutToChannel(message.channelId, event, { excludeUserId: ctx.userId }).catch(() => {})
  } else if (message.dmConversationId) {
    fanOutToDM(message.dmConversationId, event, { excludeUserId: ctx.userId }).catch(() => {})
  }

  return writeJSON(reaction)
})

export const DELETE = withAuth(async (_req: NextRequest, ctx) => {
  const messageId = ctx.params?.id
  const rawEmoji = ctx.params?.emoji
  if (!messageId || !rawEmoji) return writeError("missing params", 400)

  const emoji = decodeURIComponent(rawEmoji)

  const db = getDb(ctx.env.DB)

  const message = await queries.communityMessage.getMessage(db, messageId)
  if (!message) return writeError("message not found", 404)

  // Verify access based on message context
  if (message.channelId) {
    const channel = await queries.communityChannel.getChannel(db, message.channelId)
    if (!channel) return writeError("channel not found", 404)
    const member = await queries.communityMember.getMember(db, channel.serverId, ctx.userId)
    if (!member) return writeError("forbidden", 403)
  } else if (message.dmConversationId) {
    const dm = await queries.communityDm.getDM(db, message.dmConversationId)
    if (!dm) return writeError("dm not found", 404)
    if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
      return writeError("forbidden", 403)
    }
  }

  await queries.communityReaction.removeReaction(db, {
    messageId,
    userId: ctx.userId,
    emoji,
  })

  const event = {
    type: "community:reaction.remove" as const,
    messageId,
    userId: ctx.userId,
    emoji,
    ...(message.channelId && { channelId: message.channelId }),
    ...(message.dmConversationId && { dmConversationId: message.dmConversationId }),
  }

  if (message.channelId) {
    fanOutToChannel(message.channelId, event, { excludeUserId: ctx.userId }).catch(() => {})
  } else if (message.dmConversationId) {
    fanOutToDM(message.dmConversationId, event, { excludeUserId: ctx.userId }).catch(() => {})
  }

  return new Response(null, { status: 204 })
})

import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, extractMentionedUserIds } from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { broadcastToUser } from "@/lib/broadcast"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannelForMember(db, channelId, ctx.userId)
  if (!channel) return writeError("forbidden", 403)

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"))
  const pageSize = parsePageSize(req.nextUrl.searchParams.get("limit"))

  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)

  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  const attachmentsByMessage = groupAttachments(allAttachments)

  const allReactions = messageIds.length > 0
    ? await queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
    : []

  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  const messages = items.map((r) => ({
    id: r.id,
    authorId: r.authorId,
    authorName: r.authorName ?? r.authorEmail ?? "Unknown",
    authorAvatar: r.authorImage ?? (r.authorName ?? "?").charAt(0).toUpperCase(),
    content: r.content,
    type: r.type === "system" ? "system" as const : undefined,
    createdAt: r.createdAt,
    embeds: r.embeds ? JSON.parse(r.embeds) : undefined,
    attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
    reactions: reactionsByMessage[r.id]?.length ? reactionsByMessage[r.id] : undefined,
  }))

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const channel = await queries.communityChannel.getChannelForMember(db, channelId, ctx.userId)
  if (!channel) return writeError("forbidden", 403)

  let body: { content: string; replyToId?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }

  const message = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    channelId,
    replyToId: body.replyToId,
  })

  let createdAttachments: { id: string; filename: string; url: string; contentType: string | null; size: number | null }[] = []
  if (body.attachments?.length) {
    createdAttachments = await Promise.all(
      body.attachments.map((att) =>
        queries.communityAttachment.createAttachment(db, {
          messageId: message.id,
          filename: att.filename,
          url: att.url,
          contentType: att.contentType,
          size: att.size,
        })
      )
    )
  }

  const fullMessage = await queries.communityMessage.getMessage(db, message.id)

  // Collect mention targets, split by kind. See channels/messages route for
  // the same pattern.
  const replyTargets = new Set<string>()
  const mentionTargets = new Set<string>()
  if (body.replyToId) {
    const replyMsg = await queries.communityMessage.getMessage(db, body.replyToId)
    if (replyMsg && replyMsg.authorId && replyMsg.authorId !== ctx.userId) {
      replyTargets.add(replyMsg.authorId)
    }
  }
  if (fullMessage?.content) {
    const members = await queries.communityMember.listMembers(db, channel.serverId)
    const candidates = members
      .filter((m) => m.userId !== ctx.userId && m.userName)
      .map((m) => ({ userId: m.userId, name: m.userName as string }))
    for (const id of extractMentionedUserIds(fullMessage.content, candidates)) {
      mentionTargets.add(id)
    }
  }
  for (const id of mentionTargets) replyTargets.delete(id)

  // See channels/messages route — mute affects Unreads only, never mention/reply.
  const liveMentions = [...mentionTargets]
  const liveReplies = [...replyTargets]
  if (liveMentions.length > 0) {
    await queries.communityMention.createMentions(db, { messageId: message.id, userIds: liveMentions, kind: "mention" })
  }
  if (liveReplies.length > 0) {
    await queries.communityMention.createMentions(db, { messageId: message.id, userIds: liveReplies, kind: "reply" })
  }
  if (liveMentions.length > 0 || liveReplies.length > 0) {
    const authorName = fullMessage!.authorName ?? "Unknown"
    for (const userId of [...liveMentions, ...liveReplies]) {
      broadcastToUser(userId, {
        type: "community:mention.create",
        userId,
        messageId: message.id,
        channelId,
        authorName,
      } as never).catch(() => {})
    }
  }

  fanOutToChannel(channelId, {
    type: "community:message.create",
    channelId,
    message: {
      id: fullMessage!.id,
      authorId: fullMessage!.authorId,
      authorName: fullMessage!.authorName ?? "",
      authorAvatar: fullMessage!.authorImage ?? (fullMessage!.authorName ?? "?").charAt(0).toUpperCase(),
      content: fullMessage!.content,
      type: (fullMessage!.type as "default" | "system" | "thread_created") ?? "default",
      createdAt: fullMessage!.createdAt,
      attachments: createdAttachments.length > 0 ? createdAttachments.map((att) => ({
        id: att.id,
        filename: att.filename,
        url: att.url,
        contentType: att.contentType ?? undefined,
        size: att.size ?? undefined,
      })) : undefined,
    },
  }, { excludeUserId: ctx.userId }).catch(() => {})

  // Notify parent channel watchers that thread messageCount changed
  if (channel.parentChannelId) {
    const updated = await queries.communityChannel.getChannel(db, channelId)
    fanOutToChannel(channel.parentChannelId, {
      type: "community:channel.child_update",
      parentChannelId: channel.parentChannelId,
      channelId,
      changes: { messageCount: updated?.messageCount ?? 1, lastMessageAt: updated?.lastMessageAt ?? new Date().toISOString() },
    } as never, { excludeUserId: ctx.userId }).catch(() => {})
  }

  return writeJSON(message, 201)
})

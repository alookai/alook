import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MESSAGE_PREVIEW_LENGTH } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireChannelMember } from "@/lib/community/permissions"
import { createCommunityMessage } from "@/lib/community/message-handler"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"))
  const pageSize = parsePageSize(req.nextUrl.searchParams.get("limit"))

  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)

  // Fetch attachments for all messages
  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  const attachmentsByMessage = groupAttachments(allAttachments)

  // Fetch reactions for all messages
  const allReactions = messageIds.length > 0
    ? await queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
    : []

  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  // Resolve replyTo references
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]
  const replyMessages = replyToIds.length > 0
    ? await Promise.all(replyToIds.map((id) => queries.communityMessage.getMessage(db, id)))
    : []
  const replyMap = new Map(replyMessages.filter(Boolean).map((m) => [m!.id, m!]))

  // Resolve threads (child channels with parentMessageId matching these messages)
  const childChannels = await queries.communityChannel.listChildChannels(db, channelId)
  const threadByMessageId = new Map(
    childChannels.filter((c) => c.parentMessageId).map((c) => [c.parentMessageId!, c])
  )

  const messages = items.map((r) => {
    const reply = r.replyToId ? replyMap.get(r.replyToId) : null
    const threadChannel = threadByMessageId.get(r.id)
    return {
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName ?? r.authorEmail ?? "Unknown",
      authorAvatar: r.authorImage ?? (r.authorName ?? "?").charAt(0).toUpperCase(),
      content: r.content,
      type: r.type === "system" ? "system" as const : undefined,
      mentionType: r.mentionType,
      replyTo: reply ? { id: reply.id, authorName: reply.authorName ?? "Unknown", text: (reply.content ?? "").slice(0, MESSAGE_PREVIEW_LENGTH) } : r.replyToId ? { id: r.replyToId, authorName: "Unknown", text: "", deleted: true } : undefined,
      createdAt: r.createdAt,
      embeds: r.embeds ? JSON.parse(r.embeds) : undefined,
      attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
      reactions: reactionsByMessage[r.id]?.length ? reactionsByMessage[r.id] : undefined,
      thread: threadChannel ? { id: threadChannel.id, name: threadChannel.name, messageCount: threadChannel.messageCount ?? 0 } : undefined,
    }
  })

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: { kind: "channel", channelId, serverId: channel.serverId },
    body: body as Record<string, unknown>,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ message: result.row }, 201)
})

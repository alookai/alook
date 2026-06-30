import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import {
  queries,
  extractMentionedUserIds,
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MESSAGE_PREVIEW_LENGTH,
  WS_EVENTS,
} from "@alook/shared"
import { fanOutToChannel } from "@/lib/community/fanout"
import { broadcastToUser } from "@/lib/broadcast"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireChannelMember } from "@/lib/community/permissions"

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

  let body: { content?: string; replyToId?: string; mentionType?: string; attachments?: { url: string; filename: string; contentType: string; size: number }[] }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content || typeof body.content !== "string" || body.content.trim().length === 0) {
    return writeError("content is required", 400)
  }
  if (body.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return writeError(`content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters`, 400)
  }
  if (body.attachments && body.attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return writeError(`too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE})`, 400)
  }

  const created = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    channelId,
    replyToId: body.replyToId,
    mentionType: body.mentionType,
  })

  // Create attachment records
  let createdAttachments: { id: string; filename: string; url: string; contentType: string | null; size: number | null }[] = []
  if (body.attachments?.length) {
    createdAttachments = await Promise.all(
      body.attachments.map((att) =>
        queries.communityAttachment.createAttachment(db, {
          messageId: created.id,
          filename: att.filename,
          url: att.url,
          contentType: att.contentType,
          size: att.size,
        })
      )
    )
  }

  const message = await queries.communityMessage.getMessage(db, created.id)

  // Collect mention targets, split by kind:
  //   replyTargets   → kind="reply"   (For You only)
  //   mentionTargets → kind="mention" (For You + Mentions tab)
  let replyTo: { id: string; authorName: string; text: string } | undefined
  const replyTargets = new Set<string>()
  const mentionTargets = new Set<string>()
  if (message!.replyToId) {
    const replyMsg = await queries.communityMessage.getMessage(db, message!.replyToId)
    if (replyMsg) {
      replyTo = { id: replyMsg.id, authorName: replyMsg.authorName ?? "Unknown", text: (replyMsg.content ?? "").slice(0, MESSAGE_PREVIEW_LENGTH) }
      if (replyMsg.authorId && replyMsg.authorId !== ctx.userId) {
        replyTargets.add(replyMsg.authorId)
      }
    }
  }

  // Fetch members once; both @everyone/@here and @username resolution need them.
  const members = await queries.communityMember.listMembers(db, channel.serverId)

  // Create mentions for @everyone/@here
  if (body.mentionType === "everyone" || body.mentionType === "here") {
    for (const m of members) {
      if (m.userId !== ctx.userId) mentionTargets.add(m.userId)
    }
  }

  // Resolve @username tokens in the message body.
  if (message?.content) {
    const candidates = members
      .filter((m) => m.userId !== ctx.userId && m.userName)
      .map((m) => ({ userId: m.userId, name: m.userName as string }))
    for (const id of extractMentionedUserIds(message.content, candidates)) {
      mentionTargets.add(id)
    }
  }

  // A user explicitly @-mentioned should not also be classified as a reply
  // recipient — mention is more specific and should win.
  for (const id of mentionTargets) replyTargets.delete(id)

  // Mentions are always written — being @-mentioned or replied to always
  // surfaces in the user's inbox (For You + Mentions). Channel/server mute
  // only suppresses the channel from the Unreads tab, not direct hits.
  const liveMentions = [...mentionTargets]
  const liveReplies = [...replyTargets]
  if (liveMentions.length > 0) {
    await queries.communityMention.createMentions(db, { messageId: created.id, userIds: liveMentions, kind: "mention" })
  }
  if (liveReplies.length > 0) {
    await queries.communityMention.createMentions(db, { messageId: created.id, userIds: liveReplies, kind: "reply" })
  }
  if (liveMentions.length > 0 || liveReplies.length > 0) {
    const authorName = message!.authorName ?? "Unknown"
    for (const userId of [...liveMentions, ...liveReplies]) {
      broadcastToUser(userId, {
        type: WS_EVENTS.MENTION_CREATE,
        userId,
        messageId: created.id,
        channelId,
        authorName,
      } as never).catch(() => {})
    }
  }

  fanOutToChannel(channelId, {
    type: WS_EVENTS.MESSAGE_CREATE,
    channelId,
    message: {
      id: message!.id,
      authorId: message!.authorId,
      authorName: message!.authorName ?? "",
      authorAvatar: message!.authorImage ?? (message!.authorName ?? "?").charAt(0).toUpperCase(),
      content: message!.content,
      type: (message!.type as "default" | "system" | "thread_created") ?? "default",
      mentionType: message!.mentionType as "everyone" | "here" | null,
      replyTo,
      attachments: createdAttachments.length > 0 ? createdAttachments.map((att) => ({
        id: att.id,
        filename: att.filename,
        url: att.url,
        contentType: att.contentType ?? undefined,
        size: att.size ?? undefined,
      })) : undefined,
      createdAt: message!.createdAt,
    },
  }, { excludeUserId: ctx.userId }).catch(() => {})

  return writeJSON({ message }, 201)
})

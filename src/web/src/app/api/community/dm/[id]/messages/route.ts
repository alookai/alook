import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, MESSAGE_PREVIEW_LENGTH } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireDMParticipant } from "@/lib/community/permissions"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { avatarInitial } from "@/lib/community/avatar"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const cursor = parseCursor(req.nextUrl.searchParams.get("cursor"))
  const pageSize = parsePageSize(req.nextUrl.searchParams.get("limit"))

  const rows = await queries.communityMessage.listMessages(db, {
    dmConversationId: dmId,
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

  // Resolve replyTo references so the client can render the reply preview
  // inline — same shape channels/threads produce. Scope-check the target
  // against this DM so a client can't leak previews of messages from other
  // DMs/channels just by referencing their id.
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]
  const replyMessages = replyToIds.length > 0
    ? await queries.communityMessage.getMessagesByIds(db, replyToIds)
    : []
  const replyMap = new Map(
    replyMessages
      .filter((m) => m.dmConversationId === dmId)
      .map((m) => [m.id, m]),
  )

  const messages = items.map((r) => {
    const reply = r.replyToId ? replyMap.get(r.replyToId) : null
    return {
      id: r.id,
      authorId: r.authorId,
      authorName: r.authorName,
      authorAvatar: r.authorImage ?? avatarInitial(r.authorName),
      content: r.content,
      type: r.type === "system" ? "system" as const : undefined,
      mentionType: r.mentionType,
      replyTo: reply
        ? { id: reply.id, authorName: reply.authorName, text: (reply.content ?? "").slice(0, MESSAGE_PREVIEW_LENGTH) }
        : r.replyToId
          ? { id: r.replyToId, authorName: "Unknown", text: "", deleted: true }
          : undefined,
      createdAt: r.createdAt,
      embeds: r.embeds,
      attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
      reactions: reactionsByMessage[r.id]?.length ? reactionsByMessage[r.id] : undefined,
    }
  })

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: { kind: "dm", dmId, otherUserId: auth.value.otherUserId },
    body: body as Record<string, unknown>,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ message: result.row }, 201)
})

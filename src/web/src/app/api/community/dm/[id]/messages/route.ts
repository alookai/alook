import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import {
  requireDMParticipant,
  requireNotBlocked,
  otherDmParticipant,
} from "@/lib/community/permissions"
import { createCommunityMessage } from "@/lib/community/message-handler"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  // A blocked relationship hides historical messages from the blocked party.
  const other = otherDmParticipant(auth.value, ctx.userId)
  const block = await requireNotBlocked(db, ctx.userId, other)
  if (!block.ok) return writeError(block.error, block.status)

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

  const messages = items.map((r) => ({
    id: r.id,
    authorId: r.authorId,
    authorName: r.authorName ?? r.authorEmail ?? "Unknown",
    authorAvatar: r.authorImage ?? (r.authorName ?? "?").charAt(0).toUpperCase(),
    content: r.content,
    type: r.type === "system" ? "system" as const : undefined,
    mentionType: r.mentionType,
    replyToId: r.replyToId,
    createdAt: r.createdAt,
    embeds: r.embeds ? JSON.parse(r.embeds) : undefined,
    attachments: attachmentsByMessage[r.id]?.length ? attachmentsByMessage[r.id] : undefined,
    reactions: reactionsByMessage[r.id]?.length ? reactionsByMessage[r.id] : undefined,
  }))

  return writeJSON({ messages: messages.reverse(), hasMore, cursor: nextCursor })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const otherUserId = otherDmParticipant(auth.value, ctx.userId)
  const block = await requireNotBlocked(db, ctx.userId, otherUserId)
  if (!block.ok) return writeError(block.error, block.status)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: { kind: "dm", dmId, otherUserId },
    body: body as Record<string, unknown>,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ message: result.row }, 201)
})

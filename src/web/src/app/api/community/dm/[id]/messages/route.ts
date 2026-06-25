import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { fanOutToDM } from "@/lib/community/fanout"
import { broadcastToUser } from "@/lib/broadcast"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const cursorCreatedAt = req.nextUrl.searchParams.get("cursor_created_at")
  const cursorId = req.nextUrl.searchParams.get("cursor_id")
  const limitParam = req.nextUrl.searchParams.get("limit")

  const cursor =
    cursorCreatedAt && cursorId
      ? { createdAt: cursorCreatedAt, id: cursorId }
      : undefined

  const messages = await queries.communityMessage.listMessages(db, {
    dmConversationId: dmId,
    cursor,
    limit: limitParam ? parseInt(limitParam, 10) : undefined,
  })

  return writeJSON(messages)
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)

  const dm = await queries.communityDm.getDM(db, dmId)
  if (!dm) return writeError("dm not found", 404)
  if (dm.user1Id !== ctx.userId && dm.user2Id !== ctx.userId) {
    return writeError("forbidden", 403)
  }

  const otherUserId = dm.user1Id === ctx.userId ? dm.user2Id : dm.user1Id

  // Check if blocked
  const blocked = await queries.communityFriendship.isBlocked(db, ctx.userId, otherUserId!)
  if (blocked) return writeError("forbidden", 403)

  let body: { content: string; replyToId?: string }
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  if (!body.content) return writeError("content is required", 400)

  const created = await queries.communityMessage.createMessage(db, {
    authorId: ctx.userId,
    content: body.content,
    dmConversationId: dmId,
    replyToId: body.replyToId,
  })

  // Fetch with author join for the response
  const row = await queries.communityMessage.getMessage(db, created.id)

  const message = {
    id: row!.id,
    authorId: row!.authorId,
    authorName: row!.authorName ?? "Unknown",
    authorAvatar: row!.authorImage ?? undefined,
    content: row!.content,
    type: row!.type as "default" | "system" | "thread_created" | undefined,
    mentionType: row!.mentionType as "everyone" | "here" | null | undefined,
    replyToId: row!.replyToId,
    embeds: row!.embeds ? JSON.parse(row!.embeds) : undefined,
    createdAt: row!.createdAt,
  }

  fanOutToDM(dmId, {
    type: "community:message.create",
    dmConversationId: dmId,
    message,
  }, { excludeUserId: ctx.userId }).catch(() => {})

  if (otherUserId) {
    broadcastToUser(otherUserId, {
      type: "community:dm.new_message",
      dmConversationId: dmId,
      message,
    } as never).catch(() => {})
  }

  return writeJSON(message, 201)
})

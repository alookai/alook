import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireChannelMember } from "@/lib/community/permissions"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { mapMessageForApi } from "@/lib/community/message-payload"

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

  const messageIds = items.map((m) => m.id)
  const allAttachments = messageIds.length > 0
    ? await queries.communityAttachment.listByMessageIds(db, messageIds)
    : []

  const attachmentsByMessage = groupAttachments(allAttachments)

  const allReactions = messageIds.length > 0
    ? await queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
    : []

  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  // Resolve replyTo references. Scope-check the target against this
  // channel so a caller can't leak previews of messages from other
  // channels/DMs just by referencing their id.
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]
  const replyMessages = replyToIds.length > 0
    ? await queries.communityMessage.getMessagesByIds(db, replyToIds)
    : []
  const replyMap = new Map(
    replyMessages
      .filter((m) => m.channelId === channelId)
      .map((m) => [m.id, m]),
  )

  const messages = items.map((r) =>
    mapMessageForApi(r, { replyMap, attachmentsByMessage, reactionsByMessage }),
  )

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

  // Threads only fire CHILD_CHANNEL_UPDATE when they actually live under a
  // parent channel. A naked channel without a parent shouldn't reach this
  // route in practice, but fall back to the plain channel target so the
  // contract still holds if it ever does.
  const target = channel.parentChannelId
    ? {
        kind: "thread" as const,
        channelId,
        parentChannelId: channel.parentChannelId,
        serverId: channel.serverId,
      }
    : {
        kind: "channel" as const,
        channelId,
        serverId: channel.serverId,
      }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target,
    body: body as Record<string, unknown>,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ message: result.row }, 201)
})

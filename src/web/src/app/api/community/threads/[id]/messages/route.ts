import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireChannelMember } from "@/lib/community/permissions"
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

  // All three follow-up fetches depend only on `items` — no cross-dependency —
  // so run them concurrently to collapse 3 sequential D1 round-trips into one
  // wall-clock hop.
  const messageIds = items.map((m) => m.id)
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]

  const [allAttachments, allReactions, replyMessages] = await Promise.all([
    messageIds.length > 0
      ? queries.communityAttachment.listByMessageIds(db, messageIds)
      : Promise.resolve([]),
    messageIds.length > 0
      ? queries.communityReaction.listReactionsByMessageIds(db, messageIds, ctx.userId)
      : Promise.resolve([]),
    replyToIds.length > 0
      ? queries.communityMessage.getMessagesByIds(db, replyToIds)
      : Promise.resolve([]),
  ])

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, ctx.userId)

  // Scope-check reply targets against this channel so a caller can't leak
  // previews of messages from other channels/DMs just by referencing their id.
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

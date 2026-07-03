import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import { parseCursor, parsePageSize, buildPaginatedResponse, groupAttachments, groupReactions } from "@/lib/community/messages"
import { requireDMParticipant } from "@/lib/community/permissions"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { mapMessageForApi } from "@/lib/community/message-payload"

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

  // Scope-check reply targets against this DM so a client can't leak previews
  // of messages from other DMs/channels just by referencing their id.
  const replyMap = new Map(
    replyMessages
      .filter((m) => m.dmConversationId === dmId)
      .map((m) => [m.id, m]),
  )

  const messages = items.map((r) =>
    mapMessageForApi(r, { replyMap, attachmentsByMessage, reactionsByMessage }),
  )

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

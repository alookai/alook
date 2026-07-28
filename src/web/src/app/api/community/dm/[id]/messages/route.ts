import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries } from "@alook/shared"
import {
  parseCursor,
  parseAnchor,
  parsePageSize,
  buildPaginatedResponse,
  buildAnchorResponse,
  buildSinceResponse,
} from "@/lib/community/messages"
import { enrichMessages } from "@/lib/community/enrich-messages"
import { requireDMAccess } from "@/lib/community/permissions"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage } from "@/lib/community/message-handler"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMAccess(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const params = req.nextUrl.searchParams
  const anchorId = parseAnchor(params.get("anchor"))
  const since = parseCursor(params.get("since"))
  const cursor = parseCursor(params.get("cursor"))
  const pageSize = parsePageSize(params.get("limit"))

  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { channelId: dmId })
    if (!anchor) return writeError("anchor not found", 404)

    const around = await queries.communityMessage.listMessagesAround(db, {
      channelId: dmId,
      anchor: { createdAt: anchor.createdAt, id: anchor.id },
      limit: pageSize,
    })

    const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
      around.older,
      around.newer,
      { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
    )

    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId: dmId, isDm: true }, items)
    return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
  }

  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, {
      channelId: dmId,
      since,
      limit: pageSize,
    })
    const { items, hasMoreNewer, newerCursor } = buildSinceResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId: dmId, isDm: true }, items)
    return writeJSON({ messages, hasMoreNewer, newerCursor, latestSeq })
  }

  const rows = await queries.communityMessage.listMessages(db, {
    channelId: dmId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId: dmId, isDm: true }, items.slice().reverse())
  return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
})

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMAccess(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const rateLimit = await checkRateLimit(ctx.env, "community:msgSend", ctx.userId)
  if (!rateLimit.allowed) {
    return writeError("rate limited", 429, { "Retry-After": String(rateLimit.retryAfterSec) })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return writeError("invalid request body", 400)
  }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: { kind: "dm", channelId: dmId, otherUserId: auth.value.otherUserId },
    body: body as Record<string, unknown>,
  })
  if (!result.ok) return writeError(result.error, result.status)

  return writeJSON({ message: result.row }, 201)
})

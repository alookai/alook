import { NextRequest } from "next/server"
import { withCommunityActor } from "@/lib/middleware/community-actor"
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
import { requireDMParticipant } from "@/lib/community/permissions"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { checkBotAlignment, alignmentBlockedResponse } from "@/lib/community/bot-alignment"

export const GET = withCommunityActor(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const params = req.nextUrl.searchParams
  const anchorId = parseAnchor(params.get("anchor"))
  const since = parseCursor(params.get("since"))
  const cursor = parseCursor(params.get("cursor"))
  const pageSize = parsePageSize(params.get("limit"))

  // Seq-addressed pagination — see the channel messages route for the rationale
  // (seq and createdAt are co-monotonic within a scope, so seq params delegate
  // to the same createdAt-windowed queries). At most one honored (around >
  // after > before).
  const seqParam = (name: string): number | undefined => {
    const v = params.get(name)
    if (!v) return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  const aroundSeq = seqParam("aroundSeq")
  const afterSeq = seqParam("afterSeq")
  const beforeSeq = seqParam("beforeSeq")

  if (aroundSeq !== undefined || afterSeq !== undefined || beforeSeq !== undefined) {
    const targetSeq = aroundSeq ?? afterSeq ?? beforeSeq!
    const at = await queries.communityMessage.getMessageByChannelAndSeq(db, { dmConversationId: dmId }, targetSeq)
    if (!at) return writeError("message not found", 404)
    const anchor = { createdAt: at.createdAt, id: at.id }

    if (aroundSeq !== undefined) {
      const around = await queries.communityMessage.listMessagesAround(db, { dmConversationId: dmId, anchor, limit: pageSize })
      const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
        around.older,
        around.newer,
        { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
      )
      const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { dmConversationId: dmId }, items)
      return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
    }
    if (afterSeq !== undefined) {
      const rows = await queries.communityMessage.listMessagesSince(db, { dmConversationId: dmId, since: anchor, limit: pageSize })
      const { items, hasMoreNewer, newerCursor } = buildSinceResponse(rows, pageSize)
      const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { dmConversationId: dmId }, items)
      return writeJSON({ messages, hasMoreNewer, newerCursor, latestSeq })
    }
    const rows = await queries.communityMessage.listMessages(db, { dmConversationId: dmId, cursor: anchor, limit: pageSize + 1 })
    const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { dmConversationId: dmId }, items.slice().reverse())
    return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
  }

  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { dmConversationId: dmId })
    if (!anchor) return writeError("anchor not found", 404)

    const around = await queries.communityMessage.listMessagesAround(db, {
      dmConversationId: dmId,
      anchor: { createdAt: anchor.createdAt, id: anchor.id },
      limit: pageSize,
    })

    const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
      around.older,
      around.newer,
      { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
    )

    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { dmConversationId: dmId }, items)
    return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
  }

  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, {
      dmConversationId: dmId,
      since,
      limit: pageSize,
    })
    const { items, hasMoreNewer, newerCursor } = buildSinceResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { dmConversationId: dmId }, items)
    return writeJSON({ messages, hasMoreNewer, newerCursor, latestSeq })
  }

  const rows = await queries.communityMessage.listMessages(db, {
    dmConversationId: dmId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { dmConversationId: dmId }, items.slice().reverse())
  return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
})

export const POST = withCommunityActor(async (req: NextRequest, ctx) => {
  const dmId = ctx.params?.id
  if (!dmId) return writeError("missing dm id", 400)

  const db = getDb(ctx.env.DB)
  const auth = await requireDMParticipant(db, dmId, ctx.userId)
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
  const bodyObj = body as Record<string, unknown>

  // A bot must be aligned (caught up on this DM's unread) before it can post.
  // Humans are not gated. On a block, return the envelope verbatim.
  let expectedSeq: number | undefined
  let alignSeen = 0
  if (ctx.isBot) {
    const seenUpToSeq = typeof bodyObj.seenUpToSeq === "number" ? bodyObj.seenUpToSeq : undefined
    const gate = await checkBotAlignment(db, ctx.userId, { dmConversationId: dmId }, seenUpToSeq)
    if (gate.blocked) return gate.blocked
    expectedSeq = gate.latestSeq
    alignSeen = gate.seen
  }

  const result = await createCommunityMessage({
    db,
    authorId: ctx.userId,
    target: { kind: "dm", dmId, otherUserId: auth.value.otherUserId },
    body: bodyObj,
    ...(expectedSeq !== undefined ? { expectedSeq } : {}),
  })
  if (!result.ok) {
    if (ctx.isBot && result.status === 409) {
      const scopeKey = queries.communityMessage.scopeKeyForTarget({ dmConversationId: dmId })
      const fresh = await queries.communityAgentInbox.getLatestSeqForScope(db, scopeKey)
      return alignmentBlockedResponse(fresh, alignSeen)
    }
    return writeError(result.error, result.status)
  }

  return writeJSON({ message: result.row }, 201)
})

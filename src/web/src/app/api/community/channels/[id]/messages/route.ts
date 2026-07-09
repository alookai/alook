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
  groupAttachments,
  groupReactions,
} from "@/lib/community/messages"
import { requireChannelMember } from "@/lib/community/permissions"
import { checkRateLimit } from "@/lib/rate-limit"
import { createCommunityMessage } from "@/lib/community/message-handler"
import { mapMessageForApi } from "@/lib/community/message-payload"

export const GET = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const params = req.nextUrl.searchParams
  const anchorId = parseAnchor(params.get("anchor"))
  const since = parseCursor(params.get("since"))
  const cursor = parseCursor(params.get("cursor"))
  const pageSize = parsePageSize(params.get("limit"))

  // Anchor branch: resolve the target message inside the channel scope first
  // (a scope-first lookup — see AGENTS.md "scope the queries before"), then
  // fetch the centered window and enrich.
  if (anchorId) {
    const anchor = await queries.communityMessage.getMessageInScope(db, anchorId, { channelId })
    if (!anchor) return writeError("anchor not found", 404)

    const around = await queries.communityMessage.listMessagesAround(db, {
      channelId,
      anchor: { createdAt: anchor.createdAt, id: anchor.id },
      limit: pageSize,
    })

    const { items, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor } = buildAnchorResponse(
      around.older,
      around.newer,
      { hasMoreOlder: around.hasMoreOlder, hasMoreNewer: around.hasMoreNewer },
    )

    const { messages, latestSeq } = await enrichAndFinalize(db, ctx.userId, channelId, items)
    return writeJSON({ messages, hasMoreOlder, hasMoreNewer, olderCursor, newerCursor, latestSeq })
  }

  // Since branch: strictly-newer diff for cache hydration & WS-reconnect
  // catch-up. Rows arrive ASC directly from the query; no reverse pass here.
  if (since) {
    const rows = await queries.communityMessage.listMessagesSince(db, {
      channelId,
      since,
      limit: pageSize,
    })
    const { items, hasMoreNewer, newerCursor } = buildSinceResponse(rows, pageSize)
    const { messages, latestSeq } = await enrichAndFinalize(db, ctx.userId, channelId, items)
    return writeJSON({ messages, hasMoreNewer, newerCursor, latestSeq })
  }

  // Legacy branch (unchanged behavior beyond `latestSeq` addition): newest page
  // via DESC + one-extra-row probe, response items reversed to ASC.
  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    cursor,
    limit: pageSize + 1,
  })

  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichAndFinalize(db, ctx.userId, channelId, items.slice().reverse())
  return writeJSON({ messages, hasMore, cursor: nextCursor, latestSeq })
})

// Enrichment shared by all three GET branches — attachments, reactions,
// reply-target previews, child-channel thread indicators, and `latestSeq`.
// `items` is expected in chronological ASC (the wire order). Kept in this
// file (not extracted) so the branching above stays a five-line switch.
async function enrichAndFinalize(
  db: ReturnType<typeof getDb>,
  userId: string,
  channelId: string,
  items: Array<{ id: string; replyToId: string | null } & Record<string, unknown>>,
): Promise<{ messages: unknown[]; latestSeq: number }> {
  const messageIds = items.map((m) => m.id)
  const replyToIds = items.map((r) => r.replyToId).filter(Boolean) as string[]

  const [allAttachments, allReactions, replyMessages, childChannels, latestSeq] = await Promise.all([
    messageIds.length > 0
      ? queries.communityAttachment.listByMessageIds(db, messageIds)
      : Promise.resolve([]),
    messageIds.length > 0
      ? queries.communityReaction.listReactionsByMessageIds(db, messageIds, userId)
      : Promise.resolve([]),
    replyToIds.length > 0
      ? queries.communityMessage.getMessagesByIdsInScope(db, replyToIds, { channelId })
      : Promise.resolve([]),
    queries.communityChannel.listChildChannels(db, channelId),
    queries.communityMessage.getLatestMessageSeq(db, { channelId }),
  ])

  const attachmentsByMessage = groupAttachments(allAttachments)
  const reactionsByMessage = groupReactions(allReactions, userId)

  const replyMap = new Map(replyMessages.map((m) => [m.id, m]))

  const threadByMessageId = new Map(
    childChannels
      .filter((c) => c.parentMessageId)
      .map((c) => [c.parentMessageId!, { id: c.id, name: c.name, messageCount: c.messageCount ?? 0 }] as const),
  )

  const messages = items.map((r) =>
    mapMessageForApi(r as never, { replyMap, attachmentsByMessage, reactionsByMessage, threadByMessageId }),
  )
  return { messages, latestSeq }
}

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)
  const channel = auth.value

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

  // Thread channels (child channels with a parentChannelId) need to fire
  // CHILD_CHANNEL_UPDATE on the parent so its thread indicator ticks. Detect
  // that server-side from the channel row — clients always POST here, never
  // to a separate thread endpoint, which avoided a UI race where a fast user
  // could type before the client-side channel-meta fetch resolved.
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

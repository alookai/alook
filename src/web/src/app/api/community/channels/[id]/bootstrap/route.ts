import { NextRequest } from "next/server"
import { withAuth } from "@/lib/middleware/auth"
import { writeJSON, writeError } from "@/lib/middleware/helpers"
import { getDb } from "@/lib/db"
import { queries, withD1Retry } from "@alook/shared"
import {
  parsePageSize,
  buildPaginatedResponse,
  buildAnchorResponse,
} from "@/lib/community/messages"
import { enrichMessages } from "@/lib/community/enrich-messages"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * GET /api/community/channels/:id/bootstrap
 *
 * The de-serialized channel-open payload. See
 * plans/community-switch-perf-optimization.md (WS2). Instead of the client
 * firing `read-state`, waiting for it, then firing `messages?anchor=` (two
 * serial network round-trips gated client-side), this route does BOTH server
 * side behind ONE `requireChannelMember` preflight and returns them together:
 *
 *   { readState, messages, hasMoreOlder, hasMoreNewer, olderCursor,
 *     newerCursor, latestSeq }
 *
 * The `messages` payload is byte-identical to what the `messages` route's
 * anchor/legacy branch returns (same `enrichMessages`, same anchor-mode
 * envelope with `hasMoreOlder`/`hasMoreNewer`), so the client can seed its
 * existing message cache and let `useMessages` paginate + WS-patch unchanged.
 *
 * Only the INITIAL window lives here; pagination stays on the `messages` route.
 */
export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const channelId = ctx.params?.id
  if (!channelId) return writeError("missing channel id", 400)

  const db = getDb(ctx.env.DB)

  // Preserve the read-state route's 404-vs-403 ordering (unknown channel →
  // 404, known-but-not-a-member → 403).
  const channel = await queries.communityChannel.getChannel(db, channelId)
  if (!channel) return writeError("channel not found", 404)
  const auth = await requireChannelMember(db, channelId, ctx.userId)
  if (!auth.ok) return writeError(auth.error, auth.status)

  const pageSize = parsePageSize(null)

  const readRow = await withD1Retry(
    () => queries.communityReadState.getReadState(db, { userId: ctx.userId, channelId }),
    { route: "community/channels/bootstrap:read-state" },
  )
  const readState = {
    lastReadMessageId: readRow?.lastReadMessageId ?? null,
    lastReadAt: readRow?.lastReadAt ?? null,
    lastReadSeq: readRow?.lastReadSeq ?? 0,
  }

  // Anchor on the read pointer when present AND still resolvable in scope.
  // A stored pointer at a since-deleted / purged message must fall back to the
  // newest page — NOT 404 (that would break channel-open entirely). This is the
  // one behavior the standalone messages route can't safely centralize.
  const anchorId = readState.lastReadMessageId
  const anchor = anchorId
    ? await queries.communityMessage.getMessageInScope(db, anchorId, { channelId })
    : null

  if (anchor) {
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
    const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items)
    return writeJSON({
      readState,
      anchorMode: "anchor" as const,
      anchorMessageId: anchorId,
      messages,
      hasMoreOlder,
      hasMoreNewer,
      olderCursor,
      newerCursor,
      latestSeq,
    })
  }

  // Newest-page fallback: no read pointer, or the pointer's message is gone.
  // Mirrors the messages route's legacy branch (DESC + one-extra-row probe,
  // reversed to ASC) so the seeded page is a trusted newest-tail window.
  const rows = await queries.communityMessage.listMessages(db, {
    channelId,
    limit: pageSize + 1,
  })
  const { items, hasMore, cursor: nextCursor } = buildPaginatedResponse(rows, pageSize)
  const { messages, latestSeq } = await enrichMessages(db, ctx.userId, { channelId }, items.slice().reverse())
  return writeJSON({
    readState,
    anchorMode: "newest" as const,
    anchorMessageId: null,
    messages,
    // Normalize to the anchor-mode envelope so the client seed is uniform:
    // a newest page has no newer side, and `hasMore` is the older side.
    hasMoreOlder: hasMore,
    hasMoreNewer: false,
    olderCursor: nextCursor,
    newerCursor: null,
    latestSeq,
  })
})
